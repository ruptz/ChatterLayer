'use strict';
/**
 * The speech worker. One per connection, whichever engine is selected.
 *
 * Decoding is CPU-bound. On the same thread as the voice connection it would
 * block the event loop mid-decode and drop inbound UDP packets, so it lives here
 * instead. That was true when this only ran Vosk (synchronous, across an FFI
 * boundary) and it is still true for the ONNX engines: their graph execution
 * happens off-thread, but the mel front end and the token loop around it are JS.
 *
 * The message protocol is unchanged and engine-independent — `add`/`remove`/
 * `audio`/`flush` in, `partial`/`final`/`partialCleared` out. Nothing upstream
 * knows or needs to know which engine is loaded.
 */

const { parentPort, workerData } = require('worker_threads');

const { loadEngine, describeEngine } = require('./stt');
const { Segmenter } = require('./stt/segmenter');
const { InferenceQueue } = require('./stt/onnx');

/** Streaming engines give partials away free, so the only limit is UI churn. */
const STREAM_PARTIAL_MS = 120;

/**
 * Floor on how often a segmented engine may be asked for a partial. The real
 * interval is derived from measured decode time — see partialInterval().
 */
const BASE_PARTIAL_MS = 700;

/**
 * Discord sends nothing at all while a speaker is quiet, so silence cannot be
 * detected from the audio that arrives — there isn't any. `speaking end` covers
 * the normal case as an explicit flush; this covers the case where that event
 * never comes, which does happen.
 */
const IDLE_FINALIZE_MS = 450;
const IDLE_TICK_MS = 150;

let engine = null;
let engineInfo = null;
let queue = null;
let idleTimer = null;

/** userId -> StreamingSpeaker | SegmentedSpeaker */
const speakers = new Map();

function post(msg) {
  parentPort.postMessage(msg);
}

function rss() {
  return process.memoryUsage().rss;
}

/** Int16 PCM as transferred from the Discord side -> float samples in [-1, 1). */
function toFloat(arrayBuf) {
  const pcm = new Int16Array(arrayBuf);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

// ------------------------------------------------------------- streaming ---

/** Vosk: feed it audio, it tells us where the utterances are. */
class StreamingSpeaker {
  constructor(userId) {
    this.userId = userId;
    this.session = engine.createSession();
    this.lastPartial = '';
    this.lastPartialAt = 0;
  }

  pushAudio(arrayBuf) {
    const pcm = Buffer.from(arrayBuf);
    if (this.session.accept(pcm)) {
      const text = this.session.result();
      this.lastPartial = '';
      if (text) post({ type: 'final', userId: this.userId, text });
      return;
    }
    const now = Date.now();
    if (now - this.lastPartialAt < STREAM_PARTIAL_MS) return;
    this.lastPartialAt = now;
    const partial = this.session.partial();
    if (partial && partial !== this.lastPartial) {
      this.lastPartial = partial;
      post({ type: 'partial', userId: this.userId, text: partial });
    }
  }

  flush() {
    const text = this.session.finalize();
    this.lastPartial = '';
    if (text) post({ type: 'final', userId: this.userId, text });
    else post({ type: 'partialCleared', userId: this.userId });
  }

  close() {
    this.session.free();
  }
}

// ------------------------------------------------------------- segmented ---

/**
 * Whisper, Moonshine, Parakeet: buffer an utterance, then transcribe it.
 *
 * Finals are guaranteed — they go through the queue and always run. Partials are
 * speculative: at most one outstanding per speaker, skipped whenever a real
 * decode is waiting, and discarded if the utterance they belonged to has already
 * closed. That asymmetry is the whole reason several speakers can share one CPU
 * without any of them losing a caption.
 */
class SegmentedSpeaker {
  constructor(userId) {
    this.userId = userId;
    this.seg = new Segmenter({ maxSeconds: utteranceCeiling() });
    this.lastAudioAt = Date.now();
    this.lastPartial = '';
    this.lastPartialAt = 0;
    /** Bumped on every close, so a late partial from the last one is dropped. */
    this.epoch = 0;
  }

  pushAudio(arrayBuf) {
    this.seg.push(toFloat(arrayBuf));
    this.lastAudioAt = Date.now();

    const verdict = this.seg.poll();
    if (verdict === 'final') this.finalize();
    else if (verdict === 'discard') this.discard();
    else this.maybePartial();
  }

  /** Nothing in the buffer was speech. Don't spend a decode on it. */
  discard() {
    this.seg.reset();
    this.epoch++;
    queue.cancelPartials(this.userId);
    this.clearPartial();
  }

  finalize() {
    const clip = this.seg.take();
    this.epoch++;
    queue.cancelPartials(this.userId);

    if (!clip) {
      this.clearPartial();
      return;
    }

    queue.final(() => engine.transcribe(clip)).then(
      (text) => {
        const clean = (text || '').trim();
        this.lastPartial = '';
        if (clean) post({ type: 'final', userId: this.userId, text: clean });
        else post({ type: 'partialCleared', userId: this.userId });
      },
      (err) => {
        this.clearPartial();
        post({ type: 'error', userId: this.userId, message: `decode failed: ${err.message}` });
      }
    );
  }

  maybePartial() {
    if (!partialsWanted()) return;
    const now = Date.now();
    if (now - this.lastPartialAt < partialInterval()) return;
    if (queue.busy) return;

    const clip = this.seg.view();
    if (!clip) return;

    this.lastPartialAt = now;
    const epoch = this.epoch;

    queue.partial(this.userId, () => engine.transcribe(clip)).then(
      (text) => {
        // null means a newer partial displaced this one before it ran.
        if (text === null || epoch !== this.epoch) return;
        const clean = (text || '').trim();
        if (clean && clean !== this.lastPartial) {
          this.lastPartial = clean;
          post({ type: 'partial', userId: this.userId, text: clean });
        }
      },
      () => {
        // A failed partial is not worth reporting; the final will say so.
      }
    );
  }

  clearPartial() {
    if (!this.lastPartial) return;
    this.lastPartial = '';
    post({ type: 'partialCleared', userId: this.userId });
  }

  flush() {
    if (this.seg.empty) return;
    this.finalize();
  }

  close() {
    this.epoch++;
    queue.cancelPartials(this.userId);
  }
}

// ------------------------------------------------------------ scheduling ---

/**
 * Longest clip we will hand an engine. Whisper physically cannot encode more
 * than its 30-second window, and for the others a very long clip is a very long
 * wait for the caption, so everything is held well under it.
 */
function utteranceCeiling() {
  return Number(process.env.CHATTERLAYER_STT_MAX_UTTERANCE) || 20;
}

function partialsWanted() {
  return process.env.CHATTERLAYER_STT_PARTIALS !== '0';
}

/**
 * How long a speaker waits between speculative decodes.
 *
 * Derived from what decodes actually cost on this machine rather than from a
 * per-model table, because the same model is minutes apart on a laptop and a
 * desktop. With one speaker and a fast model this sits at the floor and partials
 * feel live; with seven speakers on Parakeet it backs off to several seconds and
 * the CPU goes to finals instead, which is the right answer.
 */
function partialInterval() {
  const active = Math.max(1, speakers.size);
  const measured = queue ? queue.lastRunMs : 0;
  // Whisper's encoder runs over a padded 30-second window whatever the clip
  // length, so its partials never get cheap the way the others' do.
  const weight = engineInfo && engineInfo.partialCost === 'fixed-window' ? 4 : 2;
  return Math.max(BASE_PARTIAL_MS, measured * weight * active);
}

/** Close utterances for speakers who have simply gone quiet. */
function onIdleTick() {
  const now = Date.now();
  for (const speaker of speakers.values()) {
    if (!(speaker instanceof SegmentedSpeaker)) continue;
    if (speaker.seg.empty) continue;
    if (now - speaker.lastAudioAt < IDLE_FINALIZE_MS) continue;
    if (speaker.seg.hasSpeech) speaker.finalize();
    else speaker.discard();
  }
}

// ------------------------------------------------------------- lifecycle ---

async function init(model) {
  try {
    const t0 = Date.now();
    engineInfo = describeEngine(model.engine);
    if (!engineInfo) throw new Error(`Unknown speech engine "${model.engine}".`);

    engine = await loadEngine(model);

    if (!engineInfo.streaming) {
      queue = new InferenceQueue(Number(process.env.CHATTERLAYER_STT_CONCURRENCY) || 1);
      idleTimer = setInterval(onIdleTick, IDLE_TICK_MS);
    }

    post({
      type: 'ready',
      engine: model.engine,
      engineLabel: engineInfo.label,
      streaming: engineInfo.streaming,
      modelPath: model.path,
      modelLabel: model.label || null,
      maxSpeakers: model.maxSpeakers || null,
      // Only Vosk has a shared library to report.
      libraryPath: engine.libraryPath || null,
      loadMs: Date.now() - t0,
      rss: rss(),
    });
  } catch (err) {
    post({ type: 'fatal', message: err.message });
  }
}

function addSpeaker(userId) {
  if (!engine || speakers.has(userId)) return;
  try {
    speakers.set(
      userId,
      engineInfo.streaming ? new StreamingSpeaker(userId) : new SegmentedSpeaker(userId)
    );
    post({ type: 'speakerAdded', userId, rss: rss() });
  } catch (err) {
    post({ type: 'error', userId, message: `recognizer init failed: ${err.message}` });
  }
}

function removeSpeaker(userId) {
  pushFailures.delete(userId);
  const speaker = speakers.get(userId);
  if (!speaker) return;
  // Emit anything still buffered so the last words aren't lost on toggle-off.
  try {
    speaker.flush();
  } catch {
    /* may already be in a bad state; nothing useful to do */
  }
  try {
    speaker.close();
  } catch {
    /* ditto */
  }
  speakers.delete(userId);
  post({ type: 'speakerRemoved', userId, rss: rss() });
}

/**
 * A speaker whose pushAudio() throws on essentially every packet (a wedged FFI
 * session, a requantised graph) would otherwise post one `error` per 20 ms of
 * audio and bury the log. Report the first failure, stay quiet through a short
 * run of them, and if it never recovers stop feeding that speaker altogether —
 * toggling them off and on rebuilds the recognizer.
 */
const MAX_PUSH_FAILURES = 12; // ~240 ms of 20 ms packets
/** userId -> consecutive pushAudio failures; cleared on the first success. */
const pushFailures = new Map();

function pushAudio(userId, arrayBuf) {
  const speaker = speakers.get(userId);
  if (!speaker) return; // toggled off mid-flight; drop it
  try {
    speaker.pushAudio(arrayBuf);
    if (pushFailures.has(userId)) pushFailures.delete(userId);
  } catch (err) {
    const n = (pushFailures.get(userId) || 0) + 1;
    pushFailures.set(userId, n);

    if (n === 1) {
      post({ type: 'error', userId, message: `decode failed: ${err.message}` });
      return;
    }
    if (n < MAX_PUSH_FAILURES) return; // wait it out without saying so again

    pushFailures.delete(userId);
    try {
      speaker.close();
    } catch {
      /* already in a bad state */
    }
    speakers.delete(userId);
    post({
      type: 'error',
      userId,
      fatal: true,
      message:
        `speech recognition kept failing (${err.message}) and has been stopped ` +
        `for this speaker — toggle them off and back on to retry`,
    });
    post({ type: 'partialCleared', userId });
    post({ type: 'speakerRemoved', userId, rss: rss() });
  }
}

function flush(userId) {
  const speaker = speakers.get(userId);
  if (!speaker) return;
  try {
    speaker.flush();
  } catch (err) {
    post({ type: 'error', userId, message: `flush failed: ${err.message}` });
  }
}

function shutdown() {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
  pushFailures.clear();
  for (const userId of [...speakers.keys()]) {
    const speaker = speakers.get(userId);
    try {
      speaker.close();
    } catch {
      /* shutting down anyway */
    }
    speakers.delete(userId);
  }
  if (engine) {
    try {
      engine.close();
    } catch {
      /* ditto */
    }
    engine = null;
  }
  post({ type: 'closed' });
}

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'add':
      return addSpeaker(msg.userId);
    case 'remove':
      return removeSpeaker(msg.userId);
    case 'audio':
      return pushAudio(msg.userId, msg.buf);
    case 'flush':
      return flush(msg.userId);
    case 'stats':
      return post({
        type: 'stats',
        rss: rss(),
        speakers: speakers.size,
        queued: queue ? queue.depth : 0,
        decodeMs: queue ? queue.lastRunMs : 0,
      });
    case 'shutdown':
      return shutdown();
    default:
      return undefined;
  }
});

init(workerData.model);
