'use strict';
/**
 * Shared by the main process, the engine child process and the setup script,
 * so nothing here may assume Electron's `app` module exists.
 *
 * Installed builds put vendor/ in the app's read-only resources and models/ in
 * the user's data directory, since Program Files isn't writable and models are
 * downloaded after install. The main process pins both into the environment
 * (CHATTERLAYER_MODELS_DIR / CHATTERLAYER_VENDOR_DIR) for the engine.
 *
 * Model discovery is manifest-driven. Every model the app installs gets a
 * `chatterlayer-model.json` naming its engine, so a directory on disk is
 * self-describing and adding a fifth engine needs no changes here. Vosk models
 * installed before manifests existed are still recognised by their Kaldi layout.
 */

const fs = require('fs');
const path = require('path');

const {
  MODEL_CATALOG,
  findModelByDir,
  readManifest,
  looksLikeVoskModel,
} = require('./models');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(PROJECT_ROOT, 'web');

/** Where downloaded speech models live. Writable. */
function modelsDir() {
  if (process.env.CHATTERLAYER_MODELS_DIR) return process.env.CHATTERLAYER_MODELS_DIR;
  return path.join(PROJECT_ROOT, 'models');
}

/** Where libvosk lives. Read-only in an installed build. */
function vendorDir() {
  if (process.env.CHATTERLAYER_VENDOR_DIR) return process.env.CHATTERLAYER_VENDOR_DIR;
  // In a packaged build electron-builder copies vendor/ into resources/,
  // outside the asar archive so the shared library is a real file on disk.
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'vendor');
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.join(PROJECT_ROOT, 'vendor');
}

/**
 * Known models, most accurate first. Used to auto-pick a default and to order
 * the picker, so installing a better model actually starts being used.
 *
 * Kept as an explicit list rather than derived from a field in the catalogue,
 * because the interesting comparisons are across engines — where Moonshine Base
 * sits relative to Vosk Gigaspeech is a judgement, and a judgement reads better
 * as one ordered list than as nine numbers spread over nine entries.
 */
const MODEL_RANK = [
  'parakeet-tdt-0.6b-v2-onnx',
  'whisper-small-en-onnx',
  'moonshine-base-onnx',
  'vosk-model-en-us-0.42-gigaspeech',
  'vosk-model-en-us-0.22',
  'whisper-base-en-onnx',
  'whisper-tiny-en-onnx',
  'vosk-model-en-us-0.22-lgraph',
  'vosk-model-small-en-us-0.15',
];

function formatSize(mb) {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/**
 * Dropdown labels: name, approximate size, one short note. Generated from the
 * catalogue so a new model cannot end up in the picker unlabelled.
 */
const MODEL_LABELS = Object.fromEntries(
  MODEL_CATALOG.map((m) => [m.dir, `${m.label} — ${formatSize(m.downloadMB)}, ${m.note}`])
);

function rankOf(name) {
  const i = MODEL_RANK.indexOf(name);
  return i === -1 ? MODEL_RANK.length : i;
}

/**
 * Is this directory a usable model, and if so whose?
 *
 * @returns {{engine: string, key: string|null, label: string}|null}
 */
function identifyModelDir(dir) {
  const name = path.basename(dir);
  const catalogued = findModelByDir(name);

  const manifest = readManifest(dir);
  if (manifest) {
    return {
      engine: manifest.engine,
      key: manifest.key || (catalogued && catalogued.key) || null,
      label: MODEL_LABELS[name] || manifest.label || name,
    };
  }

  // Installed by an older build, or by hand: only Vosk models are identifiable
  // from their layout alone, and only those ever shipped without a manifest.
  if (looksLikeVoskModel(dir)) {
    return {
      engine: 'vosk',
      key: catalogued ? catalogued.key : null,
      label: MODEL_LABELS[name] || name,
    };
  }

  return null;
}

/**
 * Every installed model, best-first.
 *
 * @returns {{name: string, path: string, label: string, engine: string,
 *            key: string|null, maxSpeakers: number|null}[]}
 */
function listModels() {
  const dir = modelsDir();
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(dir, d.name);
      const identity = identifyModelDir(full);
      if (!identity) return null;
      const catalogued = findModelByDir(d.name);
      return {
        name: d.name,
        path: full,
        ...identity,
        maxSpeakers: catalogued ? catalogued.maxSpeakers : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => rankOf(a.name) - rankOf(b.name) || a.name.localeCompare(b.name));
}

/** Back-compatible name: callers only ever asked "is this a model directory". */
function looksLikeModel(dir) {
  return identifyModelDir(dir) !== null;
}

/**
 * Resolve which model to load, as a full descriptor — the engine has to come
 * along with the path, or the worker would have to guess how to open it.
 *
 *   1. CHATTERLAYER_MODEL env var
 *   2. explicit override (chosen in the app)
 *   3. the most accurate installed model
 *
 * @param {string} [override] path to a model directory
 */
function resolveModel(override) {
  const candidates = [process.env.CHATTERLAYER_MODEL, override].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const full = path.resolve(candidate);
    const identity = identifyModelDir(full);
    if (!identity) {
      throw new Error(
        `ChatterLayer: "${full}" does not look like a speech model ChatterLayer ` +
          `can open. Pick one from the Speech model panel.`
      );
    }
    const catalogued = findModelByDir(path.basename(full));
    return {
      name: path.basename(full),
      path: full,
      ...identity,
      maxSpeakers: catalogued ? catalogued.maxSpeakers : null,
    };
  }

  const installed = listModels();
  if (installed.length) return installed[0];

  throw new Error(
    'ChatterLayer: no speech model installed yet. Open ChatterLayer and download ' +
      'one from the Speech model panel (or run "npm run setup" from source).'
  );
}

/** Just the directory. Kept for the Vosk-specific scripts. */
function resolveModelPath(override) {
  return resolveModel(override).path;
}

/** Non-throwing variant for UI status checks. */
function tryResolveModelPath(override) {
  try {
    return resolveModelPath(override);
  } catch {
    return null;
  }
}

module.exports = {
  PROJECT_ROOT,
  WEB_DIR,
  MODEL_LABELS,
  MODEL_RANK,
  formatSize,
  modelsDir,
  vendorDir,
  listModels,
  identifyModelDir,
  looksLikeModel,
  resolveModel,
  resolveModelPath,
  tryResolveModelPath,
};
