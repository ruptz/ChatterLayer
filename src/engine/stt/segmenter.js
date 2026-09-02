'use strict';
// @ts-check
/**
 * Turns a continuous stream of audio into utterances, for the engines that need
 * whole utterances.
 *
 * Vosk decides for itself where an utterance ends — it is a streaming recogniser
 * and reports that boundary as part of its output. Whisper, Moonshine and
 * Parakeet do not: they transcribe a clip and stop. Something has to decide what
 * a clip is, and that decision is what this class holds.
 *
 * Two things end an utterance in practice. Discord's own `speaking end` event is
 * the reliable one and arrives as an explicit flush. Trailing silence is the
 * other, and matters because someone who talks for a minute straight would
 * otherwise be one enormous clip that no model can transcribe in one pass.
 *
 * The speech/silence test is deliberately cheap — frame energy against a slowly
 * tracked noise floor. It is not trying to be a VAD model; it is trying to know
 * whether there is anything worth spending a decode on. That last part matters
 * more than it sounds: Whisper in particular hallucinates confidently on silence
 * (a stray "Thank you." is the classic), so an utterance that never contained
 * speech must be thrown away rather than transcribed.
 */

/** 20 ms at 16 kHz — one Discord frame's worth. */
const FRAME_MS = 20;

/**
 * Absolute floor, about -50 dBFS. Below this nothing counts as speech however
 * quiet the room is, which stops the noise tracker from adapting its way down
 * into treating hiss as speech.
 */
const ABSOLUTE_FLOOR = 0.003;

/**
 * Ceiling on the tracked noise floor, about -34 dBFS.
 *
 * Energy alone cannot tell a constant tone from constant hiss, so a tracker that
 * adapts upward fast enough for a hissy microphone will also, given a long enough
 * turn of speech, adapt its way up into the speech and stop hearing it. Capping
 * the floor breaks the tie on physical grounds: Discord applies its own noise
 * suppression before we ever see the audio, so a "noise floor" above this is
 * almost certainly speech being mistaken for noise.
 */
const NOISE_CEILING = 0.02;

/** How far above the tracked noise floor a frame has to be. */
const SPEECH_MARGIN = 3.0;

class Segmenter {
  constructor({
    sampleRate = 16000,
    /**
     * Trailing quiet that closes an utterance.
     *
     * This is a fallback: Discord's own `speaking end` is what normally closes a
     * turn, and it arrives first. What this catches is someone talking straight
     * through, where the only clue is a pause. 600 ms turned out to be inside the
     * range of ordinary rhetorical pauses and split sentences in half — and a
     * segment cut mid-phrase loses the context the model needs, which is how
     * "and so my fellow Americans" came back as "and so am I fellow Americans".
     * Anything from 700 ms up leaves real pauses alone; 800 ms buys margin for
     * 200 ms of latency that Discord's signal usually pre-empts anyway.
     */
    silenceMs = 800,
    /** Less speech than this and there is nothing worth transcribing. */
    minSpeechMs = 200,
    /** Hard ceiling on one clip. Whisper cannot encode more than 30 s at all. */
    maxSeconds = 20,
    /** A buffer this long with no speech in it is just noise; drop it. */
    maxSilentSeconds = 3,
    /** Kept before the first speech frame when trimming. */
    leadMs = 200,
    /**
     * Kept after the last speech frame. Deliberately larger than the lead: a
     * word ending in a fricative or a plosive trails off below the energy
     * threshold while still being part of the word, and cutting there costs the
     * final consonant — "Americans" came back as "American" at 120 ms.
     */
    trailMs = 300,
  } = {}) {
    this.sampleRate = sampleRate;
    this.frame = Math.round((sampleRate * FRAME_MS) / 1000);
    this.silenceSamples = Math.round((sampleRate * silenceMs) / 1000);
    this.minSpeechSamples = Math.round((sampleRate * minSpeechMs) / 1000);
    this.maxSamples = Math.round(sampleRate * maxSeconds);
    this.maxSilentSamples = Math.round(sampleRate * maxSilentSeconds);
    this.leadSamples = Math.round((sampleRate * leadMs) / 1000);
    this.trailSamples = Math.round((sampleRate * trailMs) / 1000);

    this.buf = new Float32Array(sampleRate * 4);
    this.len = 0;
    this.reset();
  }

  reset() {
    this.len = 0;
    this.analyzed = 0;
    this.speechSamples = 0;
    this.firstSpeech = -1;
    this.lastSpeech = -1;
    // Deliberately not reset: the noise floor is a property of the speaker's
    // microphone and room, so it should carry across utterances.
    if (this.noise === undefined) this.noise = ABSOLUTE_FLOOR;
  }

  get seconds() {
    return this.len / this.sampleRate;
  }

  get hasSpeech() {
    return this.speechSamples >= this.minSpeechSamples;
  }

  get empty() {
    return this.len === 0;
  }

  /** @param {Float32Array} samples 16 kHz mono */
  push(samples) {
    if (this.len + samples.length > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.len + samples.length) size *= 2;
      const grown = new Float32Array(size);
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(samples, this.len);
    this.len += samples.length;
    this.analyze();
  }

  analyze() {
    while (this.analyzed + this.frame <= this.len) {
      const start = this.analyzed;
      let sum = 0;
      for (let i = start; i < start + this.frame; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.frame);

      const threshold = Math.max(ABSOLUTE_FLOOR, this.noise * SPEECH_MARGIN);
      if (rms > threshold) {
        this.speechSamples += this.frame;
        if (this.firstSpeech < 0) this.firstSpeech = start;
        this.lastSpeech = start + this.frame;
      }

      // Minimum-statistics noise floor: fall towards any frame quieter than the
      // current estimate, rise only gradually. A symmetric average was the
      // obvious thing to write and the wrong one — a long turn of speech dragged
      // the floor up with it until quiet words stopped counting as speech.
      //
      // The rise still has to be quick enough to be useful: at 0.05%/frame it
      // took 54 seconds to notice a hissy microphone, and until it did, the hiss
      // read as continuous speech and utterances only ever closed on the length
      // cap. 2%/frame settles in about a second, and NOISE_CEILING is what keeps
      // that from being dragged into the speech instead.
      if (rms < this.noise) this.noise = this.noise * 0.5 + rms * 0.5;
      else this.noise = Math.min(NOISE_CEILING, this.noise * 1.02 + 1e-6);
      if (this.noise < ABSOLUTE_FLOOR) this.noise = ABSOLUTE_FLOOR;

      this.analyzed = start + this.frame;
    }
  }

  /**
   * @returns {'final'|'discard'|null} what to do with the buffer right now.
   *   'discard' means nothing in it was speech and it is not worth a decode.
   */
  poll() {
    if (this.len === 0) return null;

    if (!this.hasSpeech) {
      return this.len >= this.maxSilentSamples ? 'discard' : null;
    }
    if (this.len >= this.maxSamples) return 'final';
    if (this.len - this.lastSpeech >= this.silenceSamples) return 'final';
    return null;
  }

  /**
   * The speech in the buffer, with a short margin either side, as a copy. Leading
   * and trailing silence is cut: it is pure decode cost, and for Whisper it is
   * also where hallucinations come from.
   *
   * @returns {Float32Array|null} null when there was no speech to take.
   */
  view() {
    if (!this.hasSpeech) return null;
    const from = Math.max(0, this.firstSpeech - this.leadSamples);
    const to = Math.min(this.len, this.lastSpeech + this.trailSamples);
    if (to <= from) return null;
    return this.buf.slice(from, to);
  }

  /** `view()`, then start a new utterance. */
  take() {
    const clip = this.view();
    this.reset();
    return clip;
  }
}

module.exports = { Segmenter, FRAME_MS };
