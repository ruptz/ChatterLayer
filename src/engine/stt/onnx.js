'use strict';
/**
 * ONNX Runtime plumbing shared by the Moonshine, Whisper and Parakeet engines.
 *
 * onnxruntime-node ships prebuilt N-API binaries, so it loads on plain Node with
 * no compiler on the user's machine — the same reason libvosk is bound through
 * koffi rather than ffi-napi. It is required lazily: someone running a Vosk model
 * should never pay to load a second inference runtime, and a broken install
 * should only break the models that need it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let ort = null;

function runtime() {
  if (ort) return ort;
  try {
    ort = require('onnxruntime-node');
  } catch (err) {
    throw new Error(
      'This speech model runs on the ONNX Runtime, which failed to load ' +
        `(${err.message}). Reinstall ChatterLayer, or from a source checkout run ` +
        '"npm install".'
    );
  }
  ort.env.logLevel = 'error';
  return ort;
}

/**
 * How many threads a single inference may use.
 *
 * ChatterLayer shares the machine with a game, Discord and OBS, so taking every
 * core would be the wrong trade even though it would decode fastest. Half the
 * cores, capped at 8, leaves the box usable; decodes are queued rather than run
 * in parallel (see InferenceQueue), so each one gets this budget to itself.
 */
function threadBudget() {
  const override = Number(process.env.CHATTERLAYER_STT_THREADS);
  if (Number.isInteger(override) && override > 0) return override;
  const cores = os.cpus().length || 4;
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}

/**
 * Whether to let ONNX Runtime keep its CPU memory arena.
 *
 * The arena reuses one big pool across runs instead of allocating per run. It is
 * a straight speed-for-memory trade, and how good a trade depends entirely on how
 * large the graph's activations are — which is why engines choose rather than
 * inheriting one global answer. Measured on a Ryzen 5 5600X, 4-second utterance:
 *
 *   Whisper Small   arena 3609 MB / 1600 ms      no arena 1779 MB / 2278 ms
 *   Whisper Base    arena 1899 MB /  536 ms      no arena 1075 MB /  713 ms
 *   Whisper Tiny    arena  833 MB /  298 ms      no arena  382 MB /  423 ms
 *
 * Whisper pays so much because its encoder input is a fixed 30-second window
 * whatever the utterance length, so the activations are large and identical every
 * time. Moonshine's arena costs ~100 MB and Parakeet's ~400 MB, so for those the
 * memory is worth the speed and they keep it.
 *
 * CHATTERLAYER_STT_ARENA=1 or 0 overrides the engine's choice either way.
 */
function useArena(preference) {
  const override = process.env.CHATTERLAYER_STT_ARENA;
  if (override === '0') return false;
  if (override === '1') return true;
  return preference;
}

function sessionOptions({ arena = true } = {}) {
  return {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    intraOpNumThreads: threadBudget(),
    interOpNumThreads: 1,
    enableCpuMemArena: useArena(arena),
    logSeverityLevel: 3,
  };
}

async function createSession(file, options) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing model file "${path.basename(file)}" in ${path.dirname(file)}.`);
  }
  try {
    return await runtime().InferenceSession.create(file, sessionOptions(options));
  } catch (err) {
    throw new Error(`Could not load ${path.basename(file)}: ${err.message}`);
  }
}

/** Tensor shorthand. `dims` is required — ORT will not guess it. */
function tensor(type, data, dims) {
  return new (runtime().Tensor)(type, data, dims);
}

function boolTensor(value) {
  return tensor('bool', Uint8Array.from([value ? 1 : 0]), [1]);
}

function i64(values) {
  return BigInt64Array.from(values, (v) => BigInt(v));
}

/**
 * Resolve a graph input/output name from a list of candidates.
 *
 * Exports drift — the same model re-exported by a different tool renames
 * `input_features` to `mel` or `audio_signal` to `input`. Looking the name up at
 * load time turns that into a clear message at startup instead of a confusing
 * failure on the first utterance.
 */
function pickName(available, candidates, what) {
  for (const c of candidates) {
    if (available.includes(c)) return c;
  }
  throw new Error(
    `This model's ${what} is not one of the names ChatterLayer knows ` +
      `(${candidates.join(', ')}). The graph offers: ${available.join(', ')}.`
  );
}

/** Every `past_key_values.N....` group the decoder declares, as a layer count. */
function countLayers(inputNames) {
  let n = 0;
  while (inputNames.includes(`past_key_values.${n}.decoder.key`)) n++;
  return n;
}

/** Index of the largest value in `slice`, ignoring anything in `blocked`. */
function argmax(data, from, to, blocked = null) {
  let best = from;
  let bestVal = -Infinity;
  for (let i = from; i < to; i++) {
    if (blocked && blocked.has(i - from)) continue;
    const v = data[i];
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best - from;
}

/**
 * Serialises decodes and lets partial results be dropped.
 *
 * ONNX Runtime releases the JS thread while a graph runs, so nothing stops seven
 * speakers from starting seven decodes at once — which is exactly what must not
 * happen, because they would then contend for the same cores and every one of
 * them would miss its deadline. Instead: finals are queued and always run;
 * partials are speculative, one per speaker at most, and thrown away as soon as
 * they are stale.
 */
class InferenceQueue {
  constructor(concurrency = 1) {
    this.concurrency = Math.max(1, concurrency);
    this.active = 0;
    /** @type {{run: Function, resolve: Function, reject: Function}[]} */
    this.finals = [];
    /** @type {Map<string, {run: Function, resolve: Function, reject: Function}>} */
    this.partials = new Map();
    this.lastRunMs = 0;
  }

  get depth() {
    return this.finals.length + this.partials.size + this.active;
  }

  /** True when a speculative decode would only get in a real one's way. */
  get busy() {
    return this.active >= this.concurrency || this.finals.length > 0;
  }

  /** Queued behind everything already waiting, and never dropped. */
  final(run) {
    return new Promise((resolve, reject) => {
      this.finals.push({ run, resolve, reject });
      this.drain();
    });
  }

  /**
   * At most one outstanding partial per speaker: a newer one replaces the
   * pending older one, which resolves to null so its caller simply gives up.
   */
  partial(key, run) {
    return new Promise((resolve, reject) => {
      const displaced = this.partials.get(key);
      if (displaced) displaced.resolve(null);
      this.partials.set(key, { run, resolve, reject });
      this.drain();
    });
  }

  /** Drop pending partials for one speaker — their utterance has moved on. */
  cancelPartials(key) {
    const pending = this.partials.get(key);
    if (pending) {
      this.partials.delete(key);
      pending.resolve(null);
    }
  }

  drain() {
    while (this.active < this.concurrency) {
      let job = this.finals.shift();
      if (!job) {
        const next = this.partials.keys().next();
        if (next.done) return;
        job = this.partials.get(next.value);
        this.partials.delete(next.value);
      }

      this.active++;
      const started = Date.now();
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.lastRunMs = Date.now() - started;
          this.active--;
          this.drain();
        });
    }
  }
}

module.exports = {
  runtime,
  createSession,
  sessionOptions,
  threadBudget,
  tensor,
  boolTensor,
  i64,
  useArena,
  pickName,
  countLayers,
  argmax,
  InferenceQueue,
};
