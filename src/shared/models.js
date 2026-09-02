'use strict';
// @ts-check
/**
 * Speech model catalogue and downloader.
 *
 * Models aren't shipped with the app — they run 40 MB to 2.5 GB and each user
 * needs exactly one, so the app fetches the chosen one on first run. Shared by
 * the in-app picker and `npm run setup` so both offer identical choices.
 *
 * Four engines are represented here. Which one a model uses is a property of the
 * catalogue entry and of the manifest written beside it on disk; nothing above
 * src/engine/stt/ has to care.
 *
 * Two download shapes:
 *   `url`    one zip containing a single top-level folder (Vosk)
 *   `files`  individual files fetched into the model directory (everything on
 *            HuggingFace, which serves files rather than archives)
 *
 * The HuggingFace entries pin a revision rather than tracking `main`. An upstream
 * re-export can change tensor names or requantise the weights, and finding that
 * out from a user's bug report is far worse than updating a hash here.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const extract = require('extract-zip');

const VOSK_BASE = 'https://alphacephei.com/vosk/models';

/** Written into every installed model directory once it is complete. */
const MANIFEST_FILENAME = 'chatterlayer-model.json';

const hf = (repo, revision) => `https://huggingface.co/${repo}/resolve/${revision}`;

/**
 * Ordered lightest-first within each engine, which is also the order shown in
 * the UI.
 *
 * `ramMB` is peak resident memory with one speaker active, and `perSpeakerMB`
 * what each additional speaker adds. For Vosk that is a second recogniser sharing
 * one acoustic model. For the ONNX engines it is an audio buffer and nothing else,
 * because the model is loaded once and shared — which is why those scale on CPU
 * rather than on memory, and why "2.5 GB per Parakeet instance" is not a thing
 * that happens.
 *
 * `maxSpeakers` is therefore a latency judgement rather than a memory one: how
 * many people can be captioned before captions start arriving late. Decodes are
 * queued one at a time, so it comes from how long one caption takes.
 *
 * Every figure below except Vosk Large and Gigaspeech is measured by
 * scripts/bench.js on a Ryzen 5 5600X against real speech, with a 4-second
 * utterance. Those two are extrapolated from their model size — they are 1.8 GB
 * and 2.3 GB downloads and were not re-measured. Runs vary by about one speaker
 * either way, and the app warns rather than refuses when you go over.
 */
const MODEL_CATALOG = [
  // ------------------------------------------------------------------ Vosk --
  {
    key: 'small',
    engine: 'vosk',
    dir: 'vosk-model-small-en-us-0.15',
    url: `${VOSK_BASE}/vosk-model-small-en-us-0.15.zip`,
    label: 'Vosk Small',
    note: 'fastest, lowest accuracy',
    downloadMB: 40,
    ramMB: 170,
    perSpeakerMB: 12,
    maxSpeakers: 7,
    blurb: 'Lightest and fastest, and the lowest accuracy here.',
  },
  {
    key: 'medium',
    aliases: ['lgraph'],
    engine: 'vosk',
    dir: 'vosk-model-en-us-0.22-lgraph',
    url: `${VOSK_BASE}/vosk-model-en-us-0.22-lgraph.zip`,
    label: 'Vosk Medium',
    note: 'live word-by-word, no punctuation',
    downloadMB: 128,
    ramMB: 420,
    // Measured against real speech, where the decoding lattice grows far larger
    // than it does on the synthetic signal the first version of bench.js used —
    // that understated this by a factor of four.
    perSpeakerMB: 51,
    maxSpeakers: 7,
    blurb:
      'The best of the streaming models: captions appear word by word as someone ' +
      'talks, rather than a phrase at a time. Pick this over Moonshine if that ' +
      'immediacy matters more to you than punctuation and accuracy.',
  },
  {
    key: 'large',
    engine: 'vosk',
    dir: 'vosk-model-en-us-0.22',
    url: `${VOSK_BASE}/vosk-model-en-us-0.22.zip`,
    label: 'Vosk Large',
    note: 'high accuracy, heavy',
    downloadMB: 1800,
    ramMB: 5000,
    perSpeakerMB: 60,
    maxSpeakers: 4,
    blurb: 'High accuracy, trained mostly on read speech. Slow to load.',
  },
  {
    key: 'best',
    aliases: ['gigaspeech'],
    engine: 'vosk',
    dir: 'vosk-model-en-us-0.42-gigaspeech',
    url: `${VOSK_BASE}/vosk-model-en-us-0.42-gigaspeech.zip`,
    label: 'Vosk Gigaspeech',
    note: 'best Vosk accuracy, very heavy',
    downloadMB: 2300,
    ramMB: 6800,
    perSpeakerMB: 80,
    maxSpeakers: 3,
    blurb:
      'Best Vosk accuracy, trained on conversational audio rather than ' +
      'audiobooks. Needs ~7 GB of RAM and about 16x the CPU of Vosk Small.',
  },

  // ------------------------------------------------------------- Moonshine --
  {
    key: 'moonshine-base',
    aliases: ['moonshine'],
    engine: 'moonshine',
    dir: 'moonshine-base-onnx',
    label: 'Moonshine Base',
    note: 'best all-round, recommended',
    downloadMB: 251,
    ramMB: 550,
    perSpeakerMB: 3,
    maxSpeakers: 6,
    // Recommended on the measurements rather than on reputation: against Vosk
    // Medium it is more accurate, adds punctuation and casing, produces a caption
    // in ~150 ms, costs a tenth of the CPU per second of speech, and uses *less*
    // memory once more than three people are on (3 MB per extra speaker against
    // 51 MB). The one thing it gives up is word-by-word immediacy.
    recommended: true,
    blurb:
      'Better accuracy than Vosk Medium, with punctuation, and the fastest here ' +
      'at about 150 ms per caption. Cost scales with the length of the phrase, ' +
      'so short replies are nearly free.',
    files: fromHf('onnx-community/moonshine-base-ONNX', 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad', [
      ['onnx/encoder_model.onnx', 'encoder_model.onnx', 80818781],
      ['onnx/decoder_model_merged.onnx', 'decoder_model_merged.onnx', 166211345],
      ['config.json', 'config.json', 922],
      ['generation_config.json', 'generation_config.json', 147],
      ['preprocessor_config.json', 'preprocessor_config.json', 128],
      ['tokenizer.json', 'tokenizer.json', 3761754],
    ]),
  },

  // --------------------------------------------------------------- Whisper --
  // The int8-quantised exports, not float32. On a CPU shared with a game and OBS
  // they decode two to three times faster at a fraction of a percent of word
  // error rate, and download at a third of the size.
  {
    key: 'whisper-tiny',
    engine: 'whisper',
    dir: 'whisper-tiny-en-onnx',
    label: 'Whisper Tiny',
    note: 'quick, adds punctuation',
    downloadMB: 43,
    ramMB: 420,
    perSpeakerMB: 3,
    maxSpeakers: 2,
    blurb:
      'Roughly Vosk Medium accuracy, with punctuation and casing. Slower than ' +
      'its size suggests: every Whisper caption pays for a padded 30-second ' +
      'window however short the phrase was.',
    files: fromHf('Xenova/whisper-tiny.en', '79fb389fc764e7c395bd330e9531d9d32ada7049', [
      ['onnx/encoder_model_quantized.onnx', 'encoder_model.onnx', 10124913],
      ['onnx/decoder_model_merged_quantized.onnx', 'decoder_model_merged.onnx', 30727382],
      ['config.json', 'config.json', 2202],
      ['generation_config.json', 'generation_config.json', 1590],
      ['preprocessor_config.json', 'preprocessor_config.json', 339],
      ['tokenizer.json', 'tokenizer.json', 2128494],
    ]),
  },
  {
    key: 'whisper-base',
    aliases: ['whisper'],
    engine: 'whisper',
    dir: 'whisper-base-en-onnx',
    label: 'Whisper Base',
    note: 'good accuracy with punctuation',
    downloadMB: 79,
    ramMB: 700,
    perSpeakerMB: 3,
    maxSpeakers: 1,
    blurb:
      'Good accuracy with punctuation and casing, but about a second per ' +
      'caption — Moonshine Base is more accurate and six times quicker.',
    files: fromHf('Xenova/whisper-base.en', '95bf40a508535962c6483ead40270b2e32267508', [
      ['onnx/encoder_model_quantized.onnx', 'encoder_model.onnx', 23200856],
      ['onnx/decoder_model_merged_quantized.onnx', 'decoder_model_merged.onnx', 53707027],
      ['config.json', 'config.json', 2202],
      ['generation_config.json', 'generation_config.json', 1500],
      ['preprocessor_config.json', 'preprocessor_config.json', 339],
      ['tokenizer.json', 'tokenizer.json', 2128494],
    ]),
  },
  {
    key: 'whisper-small',
    engine: 'whisper',
    dir: 'whisper-small-en-onnx',
    label: 'Whisper Small',
    note: 'high accuracy, heavy on CPU',
    downloadMB: 251,
    ramMB: 1800,
    perSpeakerMB: 3,
    maxSpeakers: 1,
    blurb:
      'The most accurate Whisper here, and much the slowest: over 2 seconds ' +
      'per caption on a mid-range CPU.',
    files: fromHf('Xenova/whisper-small.en', 'fa16a75f5d91e83ecb6a2ccb690f14d91ef00ca4', [
      ['onnx/encoder_model_quantized.onnx', 'encoder_model.onnx', 92324819],
      ['onnx/decoder_model_merged_quantized.onnx', 'decoder_model_merged.onnx', 156780181],
      ['config.json', 'config.json', 2208],
      ['generation_config.json', 'generation_config.json', 1900],
      ['preprocessor_config.json', 'preprocessor_config.json', 339],
      ['tokenizer.json', 'tokenizer.json', 2128494],
    ]),
  },

  // -------------------------------------------------------------- Parakeet --
  {
    key: 'parakeet',
    aliases: ['parakeet-tdt'],
    engine: 'parakeet',
    dir: 'parakeet-tdt-0.6b-v2-onnx',
    label: 'Parakeet TDT 0.6B',
    note: 'best accuracy, very heavy',
    downloadMB: 2513,
    ramMB: 2600,
    perSpeakerMB: 3,
    maxSpeakers: 4,
    blurb:
      'Highest accuracy here, and faster per caption than Whisper Base despite ' +
      'being far larger — it transcribes only the phrase, not a padded window. ' +
      'The cost is memory: 2.5 GB of weights, loaded once and shared.',
    files: fromHf(
      'istupakov/parakeet-tdt-0.6b-v2-onnx',
      '0bbb45a3365852604aef28b538a8f066f4ccaa85',
      [
        ['encoder-model.onnx', 'encoder-model.onnx', 41770866],
        // The weights live outside the graph. The filename is recorded inside
        // encoder-model.onnx, so it must land beside it under exactly this name.
        ['encoder-model.onnx.data', 'encoder-model.onnx.data', 2435420160],
        ['decoder_joint-model.onnx', 'decoder_joint-model.onnx', 35792059],
        ['nemo128.onnx', 'nemo128.onnx', 139764],
        ['vocab.txt', 'vocab.txt', 9384],
        ['config.json', 'config.json', 97],
      ]
    ),
  },
];

/** @param {[string, string, number][]} entries [remote path, local name, bytes] */
function fromHf(repo, revision, entries) {
  const base = hf(repo, revision);
  return entries.map(([remote, as, bytes]) => ({ url: `${base}/${remote}`, as, bytes }));
}

function findModel(key) {
  return MODEL_CATALOG.find((m) => m.key === key || (m.aliases || []).includes(key)) || null;
}

/** The catalogue entry a given installed directory name belongs to. */
function findModelByDir(dir) {
  return MODEL_CATALOG.find((m) => m.dir === dir) || null;
}

/** Total bytes the download will move, for an honest progress bar. */
function downloadBytes(model) {
  if (model.files) return model.files.reduce((sum, f) => sum + f.bytes, 0);
  return model.downloadMB * 1e6; // zip entries have no per-file manifest
}

const PART_SUFFIX = '.part';

/**
 * Bytes free to a normal user on the volume holding `dirPath`, walking up to the
 * nearest existing ancestor. Returns null when the platform won't answer, so the
 * caller can treat "unknown" as "don't block".
 */
function freeDiskBytes(dirPath) {
  let probe = path.resolve(dirPath);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const st = fs.statfsSync(probe);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * Disk a fetch needs at its peak, with headroom. A `files` model is written in
 * place, so it is just the byte total plus a little slack. A Vosk zip is fetched
 * to a temp dir and then unpacked into modelsDir, so budget for the archive plus
 * a larger unpacked tree.
 */
function installFootprintBytes(model) {
  if (model.files) return downloadBytes(model) + 128 * 1e6;
  return model.downloadMB * 1e6 * 3;
}

/**
 * Delete `.part` files left behind in model directories by a download that was
 * killed mid-flight. installFiles() re-fetches a whole file rather than resuming
 * from its `.part`, so these are always dead weight. Safe to call at launch,
 * when no download is in progress.
 *
 * @returns {{ files: number, bytes: number }}
 */
function sweepPartials(modelsDirPath) {
  let files = 0;
  let bytes = 0;
  for (const model of MODEL_CATALOG) {
    const dir = path.join(modelsDirPath, model.dir);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // nothing there — model not installed or never started
    }
    for (const name of entries) {
      if (!name.endsWith(PART_SUFFIX)) continue;
      const full = path.join(dir, name);
      try {
        bytes += fs.statSync(full).size;
        fs.rmSync(full, { force: true });
        files++;
      } catch {
        /* vanished or locked — leave it */
      }
    }
  }
  return { files, bytes };
}

// ------------------------------------------------------------- manifests ---

/**
 * A manifest is written last, once every file is in place, so its presence is
 * what marks a model as complete. A half-finished download therefore never looks
 * installed — which used to be the failure mode where a model appeared in the
 * picker and then failed to load.
 */
function readManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST_FILENAME), 'utf8');
    const manifest = JSON.parse(raw);
    return manifest && manifest.engine ? manifest : null;
  } catch {
    return null;
  }
}

function writeManifest(dir, model) {
  const manifest = {
    chatterlayer: 1,
    key: model.key,
    engine: model.engine,
    label: model.label,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** The Kaldi layout, for Vosk models installed before manifests existed. */
function looksLikeVoskModel(dir) {
  return fs.existsSync(path.join(dir, 'conf')) || fs.existsSync(path.join(dir, 'am'));
}

function isInstalled(dir, model) {
  if (!fs.existsSync(dir)) return false;
  if (readManifest(dir)) return true;
  return Boolean(model) && model.engine === 'vosk' && looksLikeVoskModel(dir);
}

/** Catalogue annotated with whether each model is already on disk. */
function catalogWithStatus(modelsDirPath) {
  return MODEL_CATALOG.map((m) => {
    const target = path.join(modelsDirPath, m.dir);
    return { ...m, installed: isInstalled(target, m), path: target };
  });
}

// ------------------------------------------------------------- downloading ---

/**
 * Download a URL to disk, following redirects and reporting progress.
 * Resolves once the file is fully written and closed.
 */
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));

    const request = https.get(url, { headers: { 'User-Agent': 'ChatterLayer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // Location may be relative — HuggingFace's first hop is a bare path such
        // as /api/resolve-cache/... before the CDN redirect, and handing that
        // straight to https.get throws ERR_INVALID_URL.
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }

      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastTick = 0;

      const file = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        // Throttle: this drives a progress bar over IPC, not a log.
        if (onProgress && now - lastTick > 200) {
          lastTick = now;
          onProgress({ phase: 'download', received, total });
        }
      });
      res.on('error', reject);
      res.pipe(file);
      file.on('error', reject);
      file.on('finish', () => file.close(() => resolve()));
    });

    request.on('error', reject);
    // A stalled connection should fail, not hang the installer forever.
    request.setTimeout(60_000, () => request.destroy(new Error('Download timed out')));
  });
}

/**
 * Fetch a zip and unpack it (Vosk).
 *
 * Extraction is pure JS (extract-zip) rather than shelling out to PowerShell or
 * `unzip` — a packaged app cannot rely on either being present.
 */
async function installZip(model, modelsDirPath, target, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatterlayer-'));
  const zipPath = path.join(tmpDir, `${model.dir}.zip`);

  try {
    await download(model.url, zipPath, onProgress);

    if (onProgress) onProgress({ phase: 'extract' });
    // The archives contain a single top-level folder matching model.dir, so
    // extracting into modelsDir lands it in exactly the right place.
    await extract(zipPath, { dir: modelsDirPath });

    if (!fs.existsSync(target)) {
      throw new Error(`Archive unpacked but "${model.dir}" was not found inside it.`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Fetch a model that is served as individual files (everything on HuggingFace).
 *
 * Written straight into the target directory under `.part` names rather than via
 * the system temp directory: a 2.5 GB model would otherwise need the space twice
 * over, and the final move would be a cross-volume copy whenever temp and the
 * user's data directory sit on different drives.
 */
async function installFiles(model, target, onProgress) {
  const total = downloadBytes(model);
  let done = 0;

  for (const file of model.files) {
    const dest = path.join(target, file.as);
    const part = `${dest}.part`;

    // A file already at its expected size is one an earlier attempt finished.
    if (fs.existsSync(dest) && fs.statSync(dest).size === file.bytes) {
      done += file.bytes;
      if (onProgress) onProgress({ phase: 'download', received: done, total });
      continue;
    }

    const base = done;
    await download(file.url, part, (p) => {
      if (onProgress) onProgress({ phase: 'download', received: base + p.received, total });
    });

    const size = fs.statSync(part).size;
    if (size !== file.bytes) {
      throw new Error(
        `${file.as} downloaded as ${size} bytes but should be ${file.bytes}. ` +
          `The download was truncated or the upstream file changed.`
      );
    }
    fs.renameSync(part, dest);
    done += file.bytes;
    if (onProgress) onProgress({ phase: 'download', received: done, total });
  }
}

/**
 * Fetch and unpack a model into `modelsDirPath`.
 *
 * @param {string} key catalogue key or alias
 * @param {string} modelsDirPath destination directory (created if missing)
 * @param {(p: {phase: string, received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{name: string, path: string, engine: string}>}
 */
async function installModel(key, modelsDirPath, onProgress) {
  const model = findModel(key);
  if (!model) throw new Error(`Unknown model "${key}".`);

  const target = path.join(modelsDirPath, model.dir);
  if (isInstalled(target, model)) {
    return { name: model.dir, path: target, engine: model.engine };
  }

  // Fail up front on an obviously-too-small disk rather than partway through a
  // multi-GB download with a write error.
  const need = installFootprintBytes(model);
  const free = freeDiskBytes(modelsDirPath);
  if (free !== null && free < need) {
    const gb = (n) => (n / 1e9).toFixed(1);
    throw new Error(
      `Not enough free disk space for ${model.label}: it needs about ${gb(need)} GB ` +
        `free, but only ${gb(free)} GB is available where models are stored. ` +
        `Free up some space and try again.`
    );
  }

  fs.mkdirSync(modelsDirPath, { recursive: true });

  try {
    if (model.files) {
      fs.mkdirSync(target, { recursive: true });
      await installFiles(model, target, onProgress);
    } else {
      await installZip(model, modelsDirPath, target, onProgress);
    }

    writeManifest(target, model);
    if (onProgress) onProgress({ phase: 'done' });
    return { name: model.dir, path: target, engine: model.engine };
  } catch (err) {
    // Never leave a half-extracted model behind — without a manifest it would
    // not load, but it would still occupy the disk silently.
    fs.rmSync(target, { recursive: true, force: true });
    throw err;
  }
}

/** Remove an installed model. */
function removeModel(key, modelsDirPath) {
  const model = findModel(key);
  if (!model) throw new Error(`Unknown model "${key}".`);
  const target = path.join(modelsDirPath, model.dir);
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

module.exports = {
  MODEL_CATALOG,
  MANIFEST_FILENAME,
  findModel,
  findModelByDir,
  catalogWithStatus,
  downloadBytes,
  installFootprintBytes,
  freeDiskBytes,
  sweepPartials,
  installModel,
  removeModel,
  download,
  readManifest,
  writeManifest,
  looksLikeVoskModel,
  isInstalled,
};
