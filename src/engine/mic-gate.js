'use strict';
// @ts-check
/**
 * Voice gate for the local microphone.
 *
 * Discord runs its own voice detection and sends nothing while someone is
 * quiet, so everything downstream is built around audio that arrives only when
 * there is speech, followed by a clean end. A microphone sends audio all the
 * time. This gate makes the mic behave the same way: it passes audio only while
 * someone is talking and reports when they stop.
 *
 * That matters for more than tidiness. Whisper-family models, given long runs
 * of room tone, invent text ("Thank you.") that would go straight on stream.
 */

const RATE = 16000;
/** 20 ms, the same frame Discord uses. */
const FRAME = 320;

/** Speech has to stand this far above the room's noise floor (~10 dB). */
const OVER_FLOOR = 3.2;
/** Loud frames in a row before it counts as speech, so a desk knock doesn't. */
const ONSET_FRAMES = 3;

/** The sensitivity slider runs 1 (only loud, close speech) to 10 (whispers). */
const SENSITIVITY_MIN = 1;
const SENSITIVITY_MAX = 10;
const SENSITIVITY_DEFAULT = 5;

/**
 * The level below which nothing counts as speech, however quiet the room.
 * The default, 5, is about -44 dBFS: well under normal speech into a headset
 * or desk mic. Each step is 3 dB, so the ends are -32 and -59 dBFS.
 */
function minRmsFor(sensitivity) {
  const s = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, Number(sensitivity) || 0));
  return 200 * Math.pow(2, (SENSITIVITY_DEFAULT - s) / 2);
}

class MicGate {
  /**
   * @param {object} [o]
   * @param {number} [o.preRollMs] audio kept from before speech was detected,
   *   so the first syllable isn't clipped
   * @param {number} [o.hangMs] quiet that ends an utterance
   * @param {number} [o.sensitivity] 1–10, see minRmsFor()
   */
  constructor({ preRollMs = 300, hangMs = 700, sensitivity = SENSITIVITY_DEFAULT } = {}) {
    this.preRollFrames = Math.ceil((preRollMs / 1000) * RATE / FRAME);
    /** Samples left over from the last chunk, short of a whole frame. */
    this.rest = new Int16Array(0);
    /** Recent quiet frames, replayed when speech starts. */
    this.preRoll = [];
    this.configure({ hangMs, sensitivity });
    this.floor = this.minRms / OVER_FLOOR;
    this.speaking = false;
    this.loudRun = 0;
    this.quietRun = 0;
  }

  /**
   * Retune mid-stream, from the sliders. What the gate has learned about the
   * room is kept.
   *
   * @param {{ hangMs?: number, sensitivity?: number }} o
   */
  configure({ hangMs, sensitivity }) {
    if (hangMs !== undefined) this.hangFrames = Math.ceil((hangMs / 1000) * RATE / FRAME);
    if (sensitivity !== undefined) this.minRms = minRmsFor(sensitivity);
  }

  /**
   * @param {Int16Array} pcm 16 kHz mono
   * @returns {{ voiced: Int16Array[], ended: boolean }} audio to recognise, and
   *   whether an utterance finished somewhere in this chunk
   */
  push(pcm) {
    const all = new Int16Array(this.rest.length + pcm.length);
    all.set(this.rest, 0);
    all.set(pcm, this.rest.length);

    const voiced = [];
    let ended = false;
    let at = 0;
    for (; at + FRAME <= all.length; at += FRAME) {
      // A copy, so each frame owns its buffer and can be transferred.
      const frame = all.slice(at, at + FRAME);
      const loud = this.isLoud(frame);

      if (!this.speaking) {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        this.loudRun = loud ? this.loudRun + 1 : 0;
        if (this.loudRun >= ONSET_FRAMES) {
          this.speaking = true;
          this.quietRun = 0;
          voiced.push(...this.preRoll);
          this.preRoll = [];
        }
        continue;
      }

      voiced.push(frame);
      this.quietRun = loud ? 0 : this.quietRun + 1;
      if (this.quietRun >= this.hangFrames) {
        this.speaking = false;
        this.loudRun = 0;
        ended = true;
      }
    }
    this.rest = all.slice(at);
    return { voiced, ended };
  }

  /** @param {Int16Array} frame */
  isLoud(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const loud = rms > Math.max(this.minRms, this.floor * OVER_FLOOR);

    // Follow the room: down quickly when it goes quiet, up slowly, and far more
    // slowly while someone is talking so their voice isn't learned as noise. A
    // fan switching on still gets absorbed, so it can't hold the gate open.
    if (rms < this.floor) this.floor += (rms - this.floor) * 0.2;
    else this.floor += (rms - this.floor) * (loud ? 0.002 : 0.02);
    return loud;
  }
}

module.exports = { MicGate, minRmsFor, MIC_RATE: RATE };
