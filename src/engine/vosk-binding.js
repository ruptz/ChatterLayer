'use strict';
/**
 * FFI binding to the official libvosk.
 *
 * The `vosk` npm package binds it through `ffi-napi`, which is unmaintained
 * since 2022 and fails to build on Node 18+ (and needs an electron-rebuild pass
 * on top). koffi ships prebuilt N-API binaries, so the same upstream library
 * loads on modern Node and Electron with no compiler on the user's machine.
 *
 * Signatures come from vendor/.../vosk_api.h.
 */

const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { vendorDir } = require('../shared/paths');

/** Platform-specific shared library filename. */
const LIB_FILENAME = {
  win32: 'libvosk.dll',
  linux: 'libvosk.so',
  darwin: 'libvosk.dylib',
}[process.platform];

/**
 * Locate libvosk. Search order:
 *   1. CHATTERLAYER_VOSK_LIB env var (file path or containing directory)
 *   2. explicit `hint` argument
 *   3. a shallow scan of the vendor directory — which differs between a dev
 *      checkout and an installed build, hence vendorDir()
 * Returns the absolute path to the library file.
 */
function findLibrary(hint) {
  const candidates = [];

  const fromEnv = process.env.CHATTERLAYER_VOSK_LIB;
  if (fromEnv) candidates.push(fromEnv);
  if (hint) candidates.push(hint);

  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const stat = fs.statSync(c);
    if (stat.isFile()) return path.resolve(c);
    if (stat.isDirectory()) {
      const p = path.join(c, LIB_FILENAME);
      if (fs.existsSync(p)) return path.resolve(p);
    }
  }

  // Scan vendor/ one level deep — the upstream zips extract into a versioned
  // folder such as vendor/vosk-win64-0.3.45/libvosk.dll
  const vendor = vendorDir();
  if (fs.existsSync(vendor)) {
    const direct = path.join(vendor, LIB_FILENAME);
    if (fs.existsSync(direct)) return direct;
    for (const entry of fs.readdirSync(vendor)) {
      const p = path.join(vendor, entry, LIB_FILENAME);
      if (fs.existsSync(p)) return p;
    }
  }

  // Not plain "npm run setup" — that fetches the recommended model, which is a
  // Moonshine one and does not pull the Vosk runtime down with it.
  throw new Error(
    `ChatterLayer: could not find ${LIB_FILENAME}.\n` +
      `Run "npm run setup -- --runtime-only" to download the Vosk runtime, or ` +
      `set CHATTERLAYER_VOSK_LIB to its location.`
  );
}

let api = null; // memoised bound function table
let libraryPath = null;

/**
 * Load libvosk and bind the functions we use. Safe to call repeatedly —
 * the library is only loaded once per process.
 */
function loadApi(hint) {
  if (api) return api;

  libraryPath = findLibrary(hint);
  const libDir = path.dirname(libraryPath);

  // libvosk.dll has sibling dependencies (libstdc++-6, libgcc_s_seh-1,
  // libwinpthread-1); PATH is the reliable way to let the loader find them.
  if (process.platform === 'win32') {
    process.env.PATH = `${libDir}${path.delimiter}${process.env.PATH || ''}`;
  }

  const lib = koffi.load(libraryPath);

  koffi.opaque('VoskModel');
  koffi.opaque('VoskRecognizer');

  api = {
    setLogLevel: lib.func('void vosk_set_log_level(int level)'),
    modelNew: lib.func('VoskModel* vosk_model_new(const char* model_path)'),
    modelFree: lib.func('void vosk_model_free(VoskModel* model)'),
    recognizerNew: lib.func(
      'VoskRecognizer* vosk_recognizer_new(VoskModel* model, float sample_rate)'
    ),
    recognizerSetWords: lib.func(
      'void vosk_recognizer_set_words(VoskRecognizer* r, int words)'
    ),
    recognizerSetMaxAlternatives: lib.func(
      'void vosk_recognizer_set_max_alternatives(VoskRecognizer* r, int n)'
    ),
    // `len` is a BYTE count, not a sample count. Returns 1 when an utterance
    // ended and a final result is ready.
    acceptWaveform: lib.func(
      'int vosk_recognizer_accept_waveform(VoskRecognizer* r, const uint8_t* data, int len)'
    ),
    result: lib.func('const char* vosk_recognizer_result(VoskRecognizer* r)'),
    partialResult: lib.func(
      'const char* vosk_recognizer_partial_result(VoskRecognizer* r)'
    ),
    finalResult: lib.func(
      'const char* vosk_recognizer_final_result(VoskRecognizer* r)'
    ),
    recognizerReset: lib.func('void vosk_recognizer_reset(VoskRecognizer* r)'),
    recognizerFree: lib.func('void vosk_recognizer_free(VoskRecognizer* r)'),
  };

  // Kaldi is extremely chatty on stderr; -1 silences everything.
  api.setLogLevel(-1);
  return api;
}

function parseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/**
 * The acoustic model. This is the expensive object — 116 MB for the small
 * model, 6.8 GB for Gigaspeech — and is shared by every recognizer, so adding
 * a speaker costs a recognizer rather than another copy of the model.
 */
class VoskModel {
  constructor(modelPath, libHint) {
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `ChatterLayer: Vosk model not found at "${modelPath}".\n` +
          `Run "npm run setup" to download it.`
      );
    }
    if (
      !fs.existsSync(path.join(modelPath, 'conf')) &&
      !fs.existsSync(path.join(modelPath, 'am'))
    ) {
      throw new Error(
        `ChatterLayer: "${modelPath}" does not look like a Vosk model ` +
          `(no conf/ or am/ inside). Point at the extracted model folder itself.`
      );
    }

    this.api = loadApi(libHint);
    this.handle = this.api.modelNew(modelPath);
    if (!this.handle) {
      throw new Error(`ChatterLayer: Vosk failed to load the model at "${modelPath}".`);
    }
    this.path = modelPath;
  }

  free() {
    if (this.handle) {
      this.api.modelFree(this.handle);
      this.handle = null;
    }
  }
}

/** One streaming decoder, created per selected speaker and freed on toggle-off. */
class VoskRecognizer {
  constructor(model, sampleRate = 16000, { words = false } = {}) {
    this.api = model.api;
    this.handle = this.api.recognizerNew(model.handle, sampleRate);
    if (!this.handle) throw new Error('ChatterLayer: failed to create Vosk recognizer.');
    if (words) this.api.recognizerSetWords(this.handle, 1);
  }

  /**
   * Feed 16 kHz mono 16-bit PCM.
   * @param {Buffer} pcm
   * @returns {boolean} true when a final result is ready to collect
   */
  acceptWaveform(pcm) {
    return this.api.acceptWaveform(this.handle, pcm, pcm.length) === 1;
  }

  /** Completed utterance: { text }. */
  result() {
    return parseJson(this.api.result(this.handle));
  }

  /** In-progress guess: { partial }. Cheap, safe to poll. */
  partialResult() {
    return parseJson(this.api.partialResult(this.handle));
  }

  /** Flush anything buffered and end the utterance: { text }. */
  finalResult() {
    return parseJson(this.api.finalResult(this.handle));
  }

  reset() {
    this.api.recognizerReset(this.handle);
  }

  free() {
    if (this.handle) {
      this.api.recognizerFree(this.handle);
      this.handle = null;
    }
  }
}

module.exports = {
  VoskModel,
  VoskRecognizer,
  loadApi,
  findLibrary,
  // A function rather than a getter: a getter reads as a plain value and
  // silently captures null when destructured at require time.
  getLibraryPath: () => libraryPath,
};
