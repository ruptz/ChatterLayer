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
const crypto = require('crypto');
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
  // These four are checked by `bytes` plus a hash of the archive. Where the hash
  // is `sha256` it was computed here from a real download; where it is `md5` it
  // is upstream's own published figure from
  // https://alphacephei.com/vosk/models/model-list.json, taken on 2026-09-17
  // because hashing the archive ourselves would mean a 4.1 GB download for two
  // models nothing recommends. That list was checked against real downloads of
  // Small and Medium on the same day and both its md5 and its size were exact,
  // which is the evidence for trusting the other two entries.
  //
  // md5 is the weaker guarantee: it catches a corrupt transfer, but MD5 is
  // collision-broken, so it is not proof against a deliberately swapped archive
  // the way sha256 is. Any of these earns a real sha256 the first time someone
  // installs it and runs `npm run hash-models` — prefer that over the md5.
  {
    key: 'small',
    engine: 'vosk',
    dir: 'vosk-model-small-en-us-0.15',
    url: `${VOSK_BASE}/vosk-model-small-en-us-0.15.zip`,
    bytes: 41205931,
    sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
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
    bytes: 130557655,
    sha256: 'd9838b4aaa82a75c4a17f5aca300eaca129aaab2a7cbf951bafbb500eb9c4334',
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
    bytes: 1913365522,
    md5: '228741ed058893e403dce60bdd659f42',
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
    bytes: 2423807363,
    md5: 'db1202c15b40ea4b1ec27b85a90dffbe',
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
    note: 'recommended for lighter PCs',
    downloadMB: 251,
    ramMB: 550,
    perSpeakerMB: 3,
    maxSpeakers: 6,
    // The recommendation for machines that can't comfortably hold Parakeet — see
    // recommendedModelFor(). Chosen on the measurements rather than on
    // reputation: against Vosk Medium it is more accurate, adds punctuation and
    // casing, produces a caption in ~150 ms, costs a tenth of the CPU per second
    // of speech, and uses *less* memory once more than three people are on (3 MB
    // per extra speaker against 51 MB). The one thing it gives up is word-by-word
    // immediacy.
    recommended: 'light',
    blurb:
      'Better accuracy than Vosk Medium, with punctuation, and the fastest here ' +
      'at about 150 ms per caption. Cost scales with the length of the phrase, ' +
      'so short replies are nearly free.',
    files: fromHf(
      'onnx-community/moonshine-base-ONNX',
      'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
      [
        [
          'onnx/encoder_model.onnx',
          'encoder_model.onnx',
          80818781,
          '153e128e7abd64a74ee47f2c3f585c3171c4d46cbb368b032827934c4e01e779',
        ],
        [
          'onnx/decoder_model_merged.onnx',
          'decoder_model_merged.onnx',
          166211345,
          '58778763ca8438963190244d6b26572bdca2cedec56a4b91e828f3f2d69ef3c5',
        ],
        [
          'config.json',
          'config.json',
          922,
          'fab7241d1e9fc6c2370c4c6dfb5da79bb54d67ed9ab6b507ac51d29d2abe01d1',
        ],
        [
          'generation_config.json',
          'generation_config.json',
          147,
          'f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44',
        ],
        [
          'preprocessor_config.json',
          'preprocessor_config.json',
          128,
          'fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679',
        ],
        [
          'tokenizer.json',
          'tokenizer.json',
          3761754,
          '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f',
        ],
      ]
    ),
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
      [
        'onnx/encoder_model_quantized.onnx',
        'encoder_model.onnx',
        10124913,
        '8cc3c6f8563d1b3fbd2c5af9f64c2bed8b020bc593c402d1ef53b9f08fbf1b90',
      ],
      [
        'onnx/decoder_model_merged_quantized.onnx',
        'decoder_model_merged.onnx',
        30727382,
        'dbb2e063b7fbc41d9803b9698f93ecb035c50cbb3fb87b56cb131e4a5eb99059',
      ],
      [
        'config.json',
        'config.json',
        2202,
        '37a1073be00d19118c06557896c7c148598f4d8277edc0f5bc07c9f5554839f1',
      ],
      [
        'generation_config.json',
        'generation_config.json',
        1590,
        '132c95ba9db45f4498f2eab3fea7c1d6a174005010f8f6b7d20cfd5e9795996b',
      ],
      [
        'preprocessor_config.json',
        'preprocessor_config.json',
        339,
        'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      ],
      [
        'tokenizer.json',
        'tokenizer.json',
        2128494,
        'c6ee8f089220a5b1188f6426456772572671c6141ae007eecb83c6a8349f5deb',
      ],
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
      [
        'onnx/encoder_model_quantized.onnx',
        'encoder_model.onnx',
        23200856,
        'd0d4e59e2842617b39787cece73d7e8f76f99b1697d3386c0e682eca2269f4a1',
      ],
      [
        'onnx/decoder_model_merged_quantized.onnx',
        'decoder_model_merged.onnx',
        53707027,
        'a25afc5858a20aabb7652cb2d555996ebe10691a69bbdb423d5073d52f060325',
      ],
      [
        'config.json',
        'config.json',
        2202,
        '5c390f2c6ba84ddeb7e362cd8b2123832911407850174e64d7081ccc36df2d64',
      ],
      [
        'generation_config.json',
        'generation_config.json',
        1500,
        '1e57ed56ad1bd7f08a49ece7fe7daada674573805a35f8bdbbe68380aab5b1ee',
      ],
      [
        'preprocessor_config.json',
        'preprocessor_config.json',
        339,
        'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      ],
      [
        'tokenizer.json',
        'tokenizer.json',
        2128494,
        'c6ee8f089220a5b1188f6426456772572671c6141ae007eecb83c6a8349f5deb',
      ],
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
      [
        'onnx/encoder_model_quantized.onnx',
        'encoder_model.onnx',
        92324819,
        'dd37efa07dad7619592ef849a40317dcfd182a2e632275a53a023f02f685cfa7',
      ],
      [
        'onnx/decoder_model_merged_quantized.onnx',
        'decoder_model_merged.onnx',
        156780181,
        '7cff5df61a1809654a5e62d89cbb99e8231b229f41412ab626a1d8fff77397ab',
      ],
      [
        'config.json',
        'config.json',
        2208,
        'afddc76e1d6b2e13e5a85a385d55d272ed61f6797d7d32895492620387336cf6',
      ],
      [
        'generation_config.json',
        'generation_config.json',
        1900,
        'dde54f4ed982cf4f57450f2d23eb5f97dd64dbc390c66a635a34a57e965b16a7',
      ],
      [
        'preprocessor_config.json',
        'preprocessor_config.json',
        339,
        'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      ],
      [
        'tokenizer.json',
        'tokenizer.json',
        2128494,
        'c6ee8f089220a5b1188f6426456772572671c6141ae007eecb83c6a8349f5deb',
      ],
    ]),
  },

  // -------------------------------------------------------------- Parakeet --
  {
    key: 'parakeet',
    aliases: ['parakeet-tdt'],
    engine: 'parakeet',
    dir: 'parakeet-tdt-0.6b-v2-onnx',
    label: 'Parakeet TDT 0.6B',
    note: 'best accuracy, recommended',
    downloadMB: 2513,
    ramMB: 2600,
    perSpeakerMB: 3,
    maxSpeakers: 4,
    // The recommendation for any machine that can hold it, and that is a lower
    // bar than the download suggests: the weights are loaded once and shared, so
    // a 16 GB PC — which most streaming PCs are — runs it comfortably. It is the
    // most accurate model here by a distance, and still ~290 ms per caption on a
    // Ryzen 5 5600X. recommendedModelFor() decides between it and Moonshine.
    recommended: 'capable',
    blurb:
      'The most accurate model here, and quicker than its size suggests — about ' +
      '290 ms per caption, because it transcribes only the phrase. Recommended ' +
      'for any PC with 16 GB of RAM: 2.5 GB of weights, loaded once and shared.',
    files: fromHf(
      'istupakov/parakeet-tdt-0.6b-v2-onnx',
      '0bbb45a3365852604aef28b538a8f066f4ccaa85',
      [
        [
          'encoder-model.onnx',
          'encoder-model.onnx',
          41770866,
          '3987bcd28175d829d12888a996a84e8f62a0e374d9ffd640662c1515adc679d3',
        ],
        // The weights live outside the graph. The filename is recorded inside
        // encoder-model.onnx, so it must land beside it under exactly this name.
        [
          'encoder-model.onnx.data',
          'encoder-model.onnx.data',
          2435420160,
          '4dab7362d4874d85965045b1e41b2d61dd2cc0fb25671a7f6b3dc47bf120cc41',
        ],
        [
          'decoder_joint-model.onnx',
          'decoder_joint-model.onnx',
          35792059,
          'cbb52a07bd70ab5b67f8439d4b3cd8704b18467b4430bcacb5adabe154b8d191',
        ],
        [
          'nemo128.onnx',
          'nemo128.onnx',
          139764,
          'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f',
        ],
        [
          'vocab.txt',
          'vocab.txt',
          9384,
          'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d',
        ],
        [
          'config.json',
          'config.json',
          97,
          '666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466',
        ],
      ]
    ),
  },
];

/**
 * @param {[string, string, number, string?][]} entries
 *   [remote path, local name, bytes, sha256?]. The revision pin already stops
 *   the upstream content changing under us; the optional sha256 is a stronger
 *   check than byte length against a truncated or corrupted download, and it is
 *   what makes reusing an already-present file at the top of installFiles() safe
 *   rather than a guess from its size.
 *
 *   Bumping a revision invalidates the bytes and the hashes with it, and all
 *   three have to move in the same commit: a new revision against old hashes
 *   fails every user's download with "the download is corrupt", which is a lie
 *   and worse than having no hashes at all. Regenerate them by deleting the
 *   model from `models/` (installModel() short-circuits on the manifest), asking
 *   the app to download it again, and hashing what lands —
 *   `certutil -hashfile <file> SHA256` per file, or
 *   `node scripts/hash-models.js` for the whole catalogue.
 */
function fromHf(repo, revision, entries) {
  const base = hf(repo, revision);
  return entries.map(([remote, as, bytes, sha256]) => ({
    url: `${base}/${remote}`,
    as,
    bytes,
    sha256: sha256 || null,
  }));
}

/**
 * Lowercase hex digest of a file, streamed — the largest model file is 2.4 GB,
 * past what a single Buffer can hold.
 * @param {string} filePath
 * @param {'sha256'|'md5'} algo
 * @returns {Promise<string>}
 */
function hashFile(filePath, algo) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** @returns {Promise<string>} */
function sha256File(filePath) {
  return hashFile(filePath, 'sha256');
}

function findModel(key) {
  return (
    MODEL_CATALOG.find((m) => m.key === key || (m.aliases || []).includes(key)) || null
  );
}

/** The catalogue entry a given installed directory name belongs to. */
function findModelByDir(dir) {
  return MODEL_CATALOG.find((m) => m.dir === dir) || null;
}

/** Total bytes the download will move, for an honest progress bar. */
function downloadBytes(model) {
  if (model.files) return model.files.reduce((sum, f) => sum + f.bytes, 0);
  // `bytes` is the archive's exact size; downloadMB is the rounded figure shown
  // in the picker, and using it here ran the bar to between 102% and 106% on
  // every Vosk model, since all four round down.
  return model.bytes || model.downloadMB * 1e6;
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
  return downloadBytes(model) * 3;
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

    const request = https.get(
      url,
      { headers: { 'User-Agent': 'ChatterLayer' } },
      (res) => {
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
      }
    );

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
 *
 * The archive is checked before it is unpacked: the exact size, then `sha256` if
 * the catalogue has one, else `md5`. This matters more here than for the
 * HuggingFace models, whose URLs pin a commit so upstream cannot change under
 * us; these are plain filenames on alphacephei.com with nothing but the version
 * in the name to keep them stable.
 */
async function installZip(model, modelsDirPath, target, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatterlayer-'));
  const zipPath = path.join(tmpDir, `${model.dir}.zip`);

  try {
    await download(model.url, zipPath, onProgress);

    const size = fs.statSync(zipPath).size;
    if (model.bytes && size !== model.bytes) {
      throw new Error(
        `${model.dir}.zip downloaded as ${size} bytes but should be ${model.bytes}. ` +
          `The download was truncated or the upstream file changed.`
      );
    }

    // Prefer sha256 where we have one. md5 is only ever upstream's own published
    // value, so it catches a corrupt transfer but not a deliberately swapped
    // archive; see the `md5` note in the catalogue.
    const algo = model.sha256 ? 'sha256' : model.md5 ? 'md5' : null;
    if (algo) {
      if (onProgress) onProgress({ phase: 'verify' });
      const want = model[algo];
      const got = await hashFile(zipPath, algo);
      if (got !== want) {
        throw new Error(
          `${model.dir}.zip failed its ${algo} checksum (expected ` +
            `${want.slice(0, 12)}…, got ${got.slice(0, 12)}…). ` +
            `The download is corrupt — try again.`
        );
      }
    }

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

    // A file already at its expected size is one an earlier attempt finished —
    // trust it, unless a checksum says otherwise, in which case re-fetch it.
    if (fs.existsSync(dest) && fs.statSync(dest).size === file.bytes) {
      if (!file.sha256 || (await sha256File(dest)) === file.sha256) {
        done += file.bytes;
        if (onProgress) onProgress({ phase: 'download', received: done, total });
        continue;
      }
      fs.rmSync(dest, { force: true });
    }

    const base = done;
    await download(file.url, part, (p) => {
      if (onProgress)
        onProgress({ phase: 'download', received: base + p.received, total });
    });

    const size = fs.statSync(part).size;
    if (size !== file.bytes) {
      throw new Error(
        `${file.as} downloaded as ${size} bytes but should be ${file.bytes}. ` +
          `The download was truncated or the upstream file changed.`
      );
    }
    if (file.sha256) {
      const got = await sha256File(part);
      if (got !== file.sha256) {
        throw new Error(
          `${file.as} failed its checksum (expected ${file.sha256.slice(0, 12)}…, ` +
            `got ${got.slice(0, 12)}…). The download is corrupt — try again.`
        );
      }
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

// -------------------------------------------------------- recommendations ---

/** Parakeet's floors — see recommendedModelFor(). */
const CAPABLE_MIN_RAM_BYTES = 12 * 1024 ** 3;
const CAPABLE_MIN_THREADS = 6;

/**
 * Which of the two recommended models suits a machine.
 *
 * Parakeet is the better model by a distance, and "can run it" is a lower bar
 * than its 2.5 GB download suggests: the weights are loaded once and shared, so
 * what it needs is ~2.6 GB of RAM to spare beside OBS, a game and Discord, and a
 * CPU with a few cores. A machine sold as 16 GB reports a little under 16 GiB,
 * so the RAM floor sits at 12 GiB — every 16 GB PC clears it, an 8 GB laptop
 * doesn't. Both floors are a judgement rather than a benchmark; the app warns
 * if captions start to lag whichever model is running.
 *
 * A machine that reports nothing gets the lighter model, which runs anywhere.
 *
 * @param {{ totalMemBytes?: number, cpuThreads?: number }} [machine]
 * @returns {{ key: string, tier: 'capable' | 'light', limitedBy: 'ram' | 'cpu' | null,
 *   ramGB: number, cpuThreads: number }}
 */
function recommendedModelFor({ totalMemBytes = 0, cpuThreads = 0 } = {}) {
  const keyFor = (tier) => MODEL_CATALOG.find((m) => m.recommended === tier).key;
  const ramGB = Math.round(totalMemBytes / 1024 ** 3);
  const enoughRam = totalMemBytes >= CAPABLE_MIN_RAM_BYTES;
  const enoughCpu = cpuThreads >= CAPABLE_MIN_THREADS;

  if (enoughRam && enoughCpu) {
    return {
      key: keyFor('capable'),
      tier: 'capable',
      limitedBy: null,
      ramGB,
      cpuThreads,
    };
  }
  return {
    key: keyFor('light'),
    tier: 'light',
    limitedBy: enoughRam ? 'cpu' : 'ram',
    ramGB,
    cpuThreads,
  };
}

/** This machine, in the shape recommendedModelFor() takes. */
function machineSpecs() {
  return {
    totalMemBytes: os.totalmem(),
    cpuThreads:
      typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length,
  };
}

module.exports = {
  MODEL_CATALOG,
  MANIFEST_FILENAME,
  findModel,
  findModelByDir,
  recommendedModelFor,
  machineSpecs,
  catalogWithStatus,
  downloadBytes,
  installFootprintBytes,
  freeDiskBytes,
  sweepPartials,
  sha256File,
  installModel,
  removeModel,
  download,
  readManifest,
  writeManifest,
  looksLikeVoskModel,
  isInstalled,
};
