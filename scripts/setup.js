'use strict';
/**
 * Downloads a speech model into models/, and the libvosk runtime into vendor/ if
 * the chosen model needs it.
 *
 * For source checkouts and CI only — installed builds ship the runtime and
 * download models from inside the app. CI uses `--runtime-only` to fetch just the
 * library before packaging.
 *
 *   node scripts/setup.js                          # the recommended model for this machine
 *   node scripts/setup.js --model=medium           # a specific model
 *   node scripts/setup.js --model=whisper-base     # any engine
 *   node scripts/setup.js --runtime-only           # libvosk only (used by CI)
 *   node scripts/setup.js --list                   # show what's available
 *
 * Only Vosk needs a separate native runtime, and it is fetched only when the
 * chosen model is a Vosk one. The other three engines run on onnxruntime-node,
 * which arrives as an ordinary npm dependency with prebuilt binaries, so there is
 * nothing to fetch for them beyond the model itself. Both recommended models —
 * Parakeet, or Moonshine Base on a lighter machine — are ONNX ones, so a bare
 * `npm run setup` never brings libvosk down with it. Use `--runtime-only` (or ask
 * for a Vosk model) if you want it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const extract = require('extract-zip');

const {
  MODEL_CATALOG,
  findModel,
  recommendedModelFor,
  machineSpecs,
  installModel,
  download,
  downloadBytes,
} = require('../src/shared/models');
const { modelsDir, vendorDir, formatSize } = require('../src/shared/paths');

/** Official prebuilt libvosk runtimes, keyed by platform+arch. */
const RUNTIMES = {
  'win32-x64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip',
    lib: 'libvosk.dll',
  },
  'win32-ia32': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win32-0.3.45.zip',
    lib: 'libvosk.dll',
  },
  'linux-x64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-linux-x86_64-0.3.45.zip',
    lib: 'libvosk.so',
  },
  'linux-arm64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-linux-aarch64-0.3.45.zip',
    lib: 'libvosk.so',
  },
  'darwin-x64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.42/vosk-osx-0.3.42.zip',
    lib: 'libvosk.dylib',
  },
  'darwin-arm64': {
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.42/vosk-osx-0.3.42.zip',
    lib: 'libvosk.dylib',
  },
};

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** One-line progress that overwrites itself. */
function progress({ phase, received, total }) {
  if (phase === 'extract') {
    process.stdout.write('\r      Extracting (this can take a minute)…            ');
    return;
  }
  if (phase === 'done') {
    process.stdout.write('\r      Done.                                          \n');
    return;
  }
  const pct = total ? `${((received / total) * 100).toFixed(0)}%` : '';
  process.stdout.write(`\r      ${mb(received)}${total ? ` / ${mb(total)}` : ''} ${pct}   `);
}

/** Does this directory already contain the platform's libvosk? */
function findLib(dir, libName) {
  if (!fs.existsSync(dir)) return null;
  if (fs.existsSync(path.join(dir, libName))) return path.join(dir, libName);
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry, libName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** "(recommended…)" after a model's name in --list, if it is one. */
function recommendationTag(m, pick) {
  if (!m.recommended) return '';
  const who = m.recommended === 'light' ? 'recommended for lighter PCs' : 'recommended';
  return m.key === pick.key ? `  (${who} — suits this machine)` : `  (${who})`;
}

function listModels() {
  console.log('Available speech models:\n');
  const pick = recommendedModelFor(machineSpecs());
  let engine = null;
  for (const m of MODEL_CATALOG) {
    if (m.engine !== engine) {
      engine = m.engine;
      console.log(`  ${engine.toUpperCase()}`);
    }
    const tag = recommendationTag(m, pick);
    console.log(`    --model=${m.key.padEnd(15)} ${m.label}${tag}`);
    console.log(
      `        ${formatSize(m.downloadMB)} download, ~${formatSize(m.ramMB)} RAM, ` +
        `up to ~${m.maxSpeakers} speakers`
    );
    console.log(`        ${m.blurb}\n`);
  }
  console.log('Only the Vosk models need the separate libvosk runtime; the rest run');
  console.log('on onnxruntime-node, which "npm install" has already provided.\n');
}

async function installRuntime() {
  const key = `${process.platform}-${process.arch}`;
  const runtime = RUNTIMES[key];
  if (!runtime) {
    throw new Error(
      `No prebuilt Vosk runtime for ${key}. Build libvosk yourself and set ` +
        `CHATTERLAYER_VOSK_LIB to its location.`
    );
  }

  const vendor = vendorDir();
  const existing = findLib(vendor, runtime.lib);
  if (existing) {
    console.log(`[runtime] Already present:\n      ${existing}\n`);
    return;
  }

  console.log('[runtime] Downloading libvosk…');
  fs.mkdirSync(vendor, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatterlayer-'));
  const zip = path.join(tmp, 'runtime.zip');
  try {
    await download(runtime.url, zip, progress);
    progress({ phase: 'extract' });
    await extract(zip, { dir: vendor });
    const found = findLib(vendor, runtime.lib);
    if (!found) throw new Error(`Unpacked archive but ${runtime.lib} was not found in vendor/.`);
    progress({ phase: 'done' });
    console.log(`      ${found}\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  if (flag('list')) return listModels();

  console.log('ChatterLayer setup');
  console.log('==================');
  console.log(`platform : ${process.platform}-${process.arch}`);
  console.log(`vendor   : ${vendorDir()}`);
  console.log(`models   : ${modelsDir()}\n`);

  if (flag('runtime-only')) {
    await installRuntime();
    console.log('Runtime only — skipping model download.');
    return;
  }

  // No --model: the recommended model that suits this machine, and say which and
  // why, so a 2.5 GB download never starts as a surprise.
  let key = arg('model');
  if (!key) {
    const pick = recommendedModelFor(machineSpecs());
    key = pick.key;
    console.log(
      `[model]   No --model given, so ${findModel(key).label}: it suits this ` +
        `machine (${pick.ramGB} GB RAM, ${pick.cpuThreads} CPU threads).\n`
    );
  }
  const model = findModel(key);
  if (!model) {
    console.error(`Unknown model "${key}". Run with --list to see the options.`);
    process.exit(1);
  }

  // Fetching a shared library for a model that will never call it is pure waste,
  // and the error a Vosk model raises later says exactly how to fix it.
  if (model.engine === 'vosk') await installRuntime();
  else console.log(`[runtime] ${model.label} runs on ONNX Runtime — nothing to fetch.\n`);

  const target = path.join(modelsDir(), model.dir);
  if (fs.existsSync(path.join(target, 'chatterlayer-model.json'))) {
    console.log(`[model]   Already present:\n      ${target}\n`);
  } else {
    console.log(
      `[model]   Downloading ${model.label} — ${formatSize(model.downloadMB)}, ` +
        `~${formatSize(model.ramMB)} RAM, up to ~${model.maxSpeakers} speakers`
    );
    console.log(
      `          ${(downloadBytes(model) / 1e6).toFixed(0)} MB over ` +
        `${model.files ? `${model.files.length} files` : '1 archive'}…`
    );
    await installModel(model.key, modelsDir(), progress);
    console.log(`      ${target}\n`);
  }

  console.log('Setup complete. Start ChatterLayer with:  npm start');
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
