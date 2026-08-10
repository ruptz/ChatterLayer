'use strict';
/**
 * Checks that need no Discord token, no network and no speech model, so they
 * can run on every push. Covers the things that have actually broken: rate
 * conversion, colour collisions, the model catalogue, renderer wiring.
 *
 *   npm run selftest
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

/** Same, for a test that has to await. Results print after the sync ones. */
const pending = [];
function testAsync(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          console.log(`  PASS  ${name}`);
          passed++;
        },
        (err) => {
          console.error(`  FAIL  ${name}\n        ${err.message}`);
          failed++;
        }
      )
  );
}

// --- audio ---------------------------------------------------------------

const { Resampler48kStereoTo16kMono } = require('../src/engine/resample');

function makeStereo48k(freq, seconds) {
  const frames = 48000 * seconds;
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / 48000) * 8000);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

function resampleChunked(input) {
  const r = new Resampler48kStereoTo16kMono();
  const out = [];
  // 3840 bytes = one 20 ms Discord frame of 48 kHz stereo.
  for (let o = 0; o < input.length; o += 3840) {
    out.push(r.process(input.subarray(o, Math.min(o + 3840, input.length))));
  }
  return Buffer.concat(out);
}

function peak(pcm, skipSamples = 0) {
  let max = 0;
  for (let i = skipSamples * 2; i < pcm.length; i += 2) {
    max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  }
  return max;
}

console.log('\naudio');

test('48k stereo -> 16k mono produces exactly 16000 samples/sec (no drift)', () => {
  const out = resampleChunked(makeStereo48k(1000, 1));
  assert.strictEqual(out.length / 2, 16000, `got ${out.length / 2} samples`);
});

test('passband (1 kHz) survives with roughly unity gain', () => {
  const out = resampleChunked(makeStereo48k(1000, 1));
  const gain = peak(out) / 8000;
  assert.ok(gain > 0.9 && gain < 1.1, `gain ${gain.toFixed(3)}`);
});

test('15 kHz is rejected, not aliased into the speech band', () => {
  const out = resampleChunked(makeStereo48k(15000, 1));
  // Skip the filter warm-up before measuring.
  const db = 20 * Math.log10((peak(out, 100) || 1) / 8000);
  assert.ok(db < -40, `alias rejection only ${db.toFixed(1)} dB`);
});

test('resampler handles an empty chunk without throwing', () => {
  const r = new Resampler48kStereoTo16kMono();
  assert.strictEqual(r.process(Buffer.alloc(0)).length, 0);
});

// --- colours -------------------------------------------------------------

const { assignColors, colorForUser, PALETTE } = require('../src/shared/colors');

const randomId = () => String(100000000000000000n + BigInt(Math.floor(Math.random() * 1e15)));

console.log('\nspeaker colours');

test('no two speakers in a call share a colour (up to palette size)', () => {
  for (const size of [2, 4, 7, 12, PALETTE.length]) {
    for (let trial = 0; trial < 400; trial++) {
      const group = Array.from({ length: size }, randomId);
      const assigned = assignColors(group, {});
      assert.strictEqual(
        new Set(assigned.values()).size,
        size,
        `duplicate colour in a call of ${size}`
      );
    }
  }
});

test('assignment is independent of member order', () => {
  const group = Array.from({ length: 7 }, randomId);
  const a = assignColors(group, {});
  const b = assignColors([...group].reverse(), {});
  for (const id of group) assert.strictEqual(a.get(id), b.get(id));
});

test('manual colour overrides win and are not reused', () => {
  const group = Array.from({ length: 5 }, randomId);
  const assigned = assignColors(group, { [group[0]]: '#FF6B6B' });
  assert.strictEqual(assigned.get(group[0]), '#FF6B6B');
  assert.strictEqual([...assigned.values()].filter((c) => c === '#FF6B6B').length, 1);
});

test('more speakers than colours still assigns everyone', () => {
  const group = Array.from({ length: PALETTE.length + 4 }, randomId);
  assert.strictEqual(assignColors(group, {}).size, group.length);
});

test('per-user colour is stable across runs', () => {
  const id = randomId();
  assert.strictEqual(colorForUser(id), colorForUser(id));
});

// --- model catalogue -----------------------------------------------------

const { MODEL_CATALOG, findModel } = require('../src/shared/models');
const { MODEL_RANK, MODEL_LABELS } = require('../src/shared/paths');

/** Position in the accuracy ranking; lower is better. */
const rankOfDir = (dir) => MODEL_RANK.indexOf(dir);

console.log('\nspeech models');

test('every catalogue entry is complete and well formed', () => {
  for (const m of MODEL_CATALOG) {
    for (const field of [
      'key',
      'dir',
      'engine',
      'label',
      'note',
      'downloadMB',
      'ramMB',
      'maxSpeakers',
      'blurb',
    ]) {
      assert.ok(m[field], `${m.key || '?'} is missing "${field}"`);
    }
    // Exactly one of the two download shapes.
    assert.ok(
      Boolean(m.url) !== Boolean(m.files),
      `${m.key} must have either "url" (a zip) or "files", not both or neither`
    );
    if (m.url) {
      assert.ok(m.url.startsWith('https://'), `${m.key} url must be https`);
      assert.ok(m.url.endsWith('.zip'), `${m.key} url must be a .zip`);
    }
  }
});

test('per-file downloads pin a revision and declare exact byte sizes', () => {
  for (const m of MODEL_CATALOG.filter((x) => x.files)) {
    for (const f of m.files) {
      assert.ok(f.url.startsWith('https://'), `${m.key}: ${f.as} url must be https`);
      assert.ok(f.as && !f.as.includes('..'), `${m.key}: bad local name "${f.as}"`);
      // The size is what makes a truncated download detectable, and what makes
      // the progress bar honest before any response header arrives.
      assert.ok(
        Number.isInteger(f.bytes) && f.bytes > 0,
        `${m.key}: ${f.as} needs a byte size`
      );
      // A 40-character hex revision, not "main" — see the note in models.js.
      assert.ok(
        /\/resolve\/[0-9a-f]{40}\//.test(f.url),
        `${m.key}: ${f.as} must pin a commit, not a branch`
      );
    }
  }
});

test('keys, aliases and directories are all unique', () => {
  const seen = new Map();
  for (const m of MODEL_CATALOG) {
    for (const name of [m.key, ...(m.aliases || [])]) {
      assert.ok(!seen.has(name), `"${name}" is used by both ${seen.get(name)} and ${m.key}`);
      seen.set(name, m.key);
    }
  }
  const dirs = MODEL_CATALOG.map((m) => m.dir);
  assert.strictEqual(new Set(dirs).size, dirs.length, 'two models share a directory');
});

test('every catalogue engine has a loader and a descriptor', () => {
  const { ENGINES, LOADERS, describeEngine } = require('../src/engine/stt');
  for (const m of MODEL_CATALOG) {
    assert.ok(LOADERS[m.engine], `no loader for engine "${m.engine}" (${m.key})`);
    assert.ok(describeEngine(m.engine), `no descriptor for engine "${m.engine}"`);
  }
  for (const name of Object.keys(ENGINES)) {
    assert.ok(LOADERS[name], `engine "${name}" is described but has no loader`);
  }
});

test('the ONNX engines share the model rather than copying it per speaker', () => {
  // The claim the speaker limits rest on. If someone ever changes an ONNX engine
  // to hold per-speaker weights, perSpeakerMB is the number that should move, and
  // this is the test that should stop them shipping without noticing.
  for (const m of MODEL_CATALOG.filter((x) => x.engine !== 'vosk')) {
    assert.ok(
      m.perSpeakerMB <= 16,
      `${m.key} claims ${m.perSpeakerMB} MB per speaker — an ONNX engine should ` +
        `only be paying for an audio buffer`
    );
  }
});

test('exactly one model is marked recommended', () => {
  const rec = MODEL_CATALOG.filter((m) => m.recommended);
  assert.strictEqual(rec.length, 1, `found ${rec.length}`);
});

test('the recommended model is one a typical machine can actually run', () => {
  // This used to name a specific model, which meant it went stale the moment the
  // benchmarks disagreed with it. What matters is not which model is recommended
  // but that the default download is defensible: it has to keep up with a real
  // call and not be a multi-gigabyte surprise on someone's connection.
  const rec = MODEL_CATALOG.find((m) => m.recommended);
  assert.ok(rec.maxSpeakers >= 5, `${rec.label} only manages ${rec.maxSpeakers} speakers`);
  assert.ok(rec.downloadMB <= 500, `${rec.label} is a ${rec.downloadMB} MB default download`);
  assert.ok(rec.ramMB <= 1500, `${rec.label} wants ${rec.ramMB} MB of RAM`);
  // And it should be at least as good as everything lighter than it.
  for (const m of MODEL_CATALOG) {
    if (m.downloadMB <= rec.downloadMB && m.maxSpeakers > rec.maxSpeakers) {
      assert.ok(
        rankOfDir(m.dir) > rankOfDir(rec.dir),
        `${m.label} is smaller, handles more speakers, and ranks better than the ` +
          `recommended ${rec.label}`
      );
    }
  }
});

test('catalogue keys and aliases all resolve', () => {
  for (const m of MODEL_CATALOG) {
    assert.ok(findModel(m.key), `key ${m.key}`);
    for (const alias of m.aliases || []) assert.ok(findModel(alias), `alias ${alias}`);
  }
});

test('every catalogue model appears in the ranking and has a label', () => {
  for (const m of MODEL_CATALOG) {
    assert.ok(MODEL_RANK.includes(m.dir), `${m.dir} missing from MODEL_RANK`);
    assert.ok(MODEL_LABELS[m.dir], `${m.dir} missing a label`);
  }
  assert.strictEqual(MODEL_RANK.length, MODEL_CATALOG.length, 'MODEL_RANK has stale entries');
});

test('dropdown labels carry a name, a size and a short note', () => {
  for (const m of MODEL_CATALOG) {
    const label = MODEL_LABELS[m.dir];
    assert.ok(label.startsWith(m.label), `"${label}" should start with the model name`);
    assert.ok(/\d+(\.\d+)? (MB|GB)/.test(label), `"${label}" has no size`);
    assert.ok(label.endsWith(m.note), `"${label}" should end with the note`);
    // It sits in a <select>; anything much longer gets clipped.
    assert.ok(label.length <= 64, `"${label}" is ${label.length} chars, too long for the picker`);
  }
});

// --- speech front end ----------------------------------------------------

const { Radix2, Dft } = require('../src/engine/stt/fft');
const { WhisperFeatures, melFilterbank, hzToMel, melToHz } = require('../src/engine/stt/features');

console.log('\nspeech front end');

/** Reference implementation: O(n^2) and obviously correct. */
function directPowerSpectrum(x) {
  const n = x.length;
  const out = new Float64Array((n >> 1) + 1);
  for (let k = 0; k < out.length; k++) {
    let re = 0;
    let im = 0;
    for (let j = 0; j < n; j++) {
      const a = (-2 * Math.PI * j * k) / n;
      re += x[j] * Math.cos(a);
      im += x[j] * Math.sin(a);
    }
    out[k] = re * re + im * im;
  }
  return out;
}

function testSignal(n) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = Math.sin(i * 0.31) * 0.7 + Math.cos(i * 1.73) * 0.3 + ((i % 37) - 18) / 60;
  }
  return x;
}

test('the 400-point DFT matches a direct DFT (Whisper’s window size)', () => {
  // 400 is 2^4 * 5^2, so this is the Bluestein path. If it is wrong, every mel
  // filter reads the wrong frequencies and accuracy quietly collapses.
  const x = testSignal(400);
  const mine = new Float64Array(201);
  new Dft(400).powerSpectrum(x, mine);
  const ref = directPowerSpectrum(x);
  let worst = 0;
  for (let k = 0; k < ref.length; k++) {
    worst = Math.max(worst, Math.abs(mine[k] - ref[k]) / (ref[k] + 1e-9));
  }
  assert.ok(worst < 1e-8, `max relative error ${worst.toExponential(2)}`);
});

test('a power-of-two length takes the same path to the same answer', () => {
  const x = testSignal(512);
  const mine = new Float64Array(257);
  new Dft(512).powerSpectrum(x, mine);
  const ref = directPowerSpectrum(x);
  for (let k = 0; k < ref.length; k++) {
    assert.ok(Math.abs(mine[k] - ref[k]) / (ref[k] + 1e-9) < 1e-8, `bin ${k}`);
  }
});

test('the radix-2 FFT round-trips through its inverse', () => {
  const fft = new Radix2(256);
  const re = Float64Array.from(testSignal(256));
  const im = new Float64Array(256);
  const original = Float64Array.from(re);
  fft.forward(re, im);
  fft.inverse(re, im);
  for (let i = 0; i < 256; i++) {
    assert.ok(Math.abs(re[i] - original[i]) < 1e-10, `sample ${i}`);
    assert.ok(Math.abs(im[i]) < 1e-10, `imaginary residue at ${i}`);
  }
});

test('the mel scale is invertible and linear below 1 kHz', () => {
  for (const hz of [0, 100, 500, 999, 1000, 2000, 4000, 8000]) {
    assert.ok(Math.abs(melToHz(hzToMel(hz)) - hz) < 1e-6, `${hz} Hz`);
  }
  // Slaney: 200/3 Hz per mel in the linear region.
  assert.ok(Math.abs(hzToMel(200) - 3) < 1e-9);
});

test('the mel filterbank is triangular, ordered and area-normalised', () => {
  const { filters, bins } = melFilterbank({ sampleRate: 16000, nFft: 400, nMels: 80 });
  assert.strictEqual(bins, 201);
  assert.strictEqual(filters.length, 80 * 201);

  let previousPeak = -1;
  let lowPeak = 0;
  let highPeak = 0;
  for (let m = 0; m < 80; m++) {
    const row = filters.subarray(m * bins, (m + 1) * bins);
    let sum = 0;
    let peak = 0;
    let peakAt = -1;
    for (let b = 0; b < bins; b++) {
      assert.ok(row[b] >= 0, `filter ${m} bin ${b} is negative`);
      sum += row[b];
      if (row[b] > peak) {
        peak = row[b];
        peakAt = b;
      }
    }
    assert.ok(sum > 0, `filter ${m} is empty`);
    // Non-decreasing rather than increasing: below 1 kHz the mel spacing (~35 Hz
    // for 80 filters) is finer than the FFT bin spacing (40 Hz at n_fft=400), so
    // neighbouring low filters legitimately peak on the same bin.
    assert.ok(peakAt >= previousPeak, `filter ${m} sits below filter ${m - 1}`);
    previousPeak = peakAt;
    if (m < 10) lowPeak = Math.max(lowPeak, peak);
    if (m >= 70) highPeak = Math.max(highPeak, peak);
  }

  // Slaney normalisation is equal area, not equal peak, so the wide filters at
  // the top of the range must peak lower than the narrow ones at the bottom.
  // Getting this wrong tilts the whole spectrum and quietly costs accuracy.
  assert.ok(highPeak < lowPeak, `high filters peak at ${highPeak}, low at ${lowPeak}`);
});

test('log-mel output is the right shape, and the padding columns are identical', () => {
  const features = new WhisperFeatures({});
  // Two seconds of audio into a 30-second window: most of it is padding.
  const audio = new Float32Array(32000);
  for (let i = 0; i < audio.length; i++) audio[i] = Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.4;

  const mel = features.compute(audio, 3000);
  assert.strictEqual(mel.length, 80 * 3000);

  // Every value lands in Whisper's normalised range.
  for (let i = 0; i < mel.length; i++) {
    assert.ok(mel[i] >= -1.01 && mel[i] <= 1.51, `value ${mel[i]} at ${i} is out of range`);
  }

  // Frames past the end of the audio are windows of zeros, so they must all be
  // the same value — this is the shortcut that makes a short utterance cheap.
  const lastReal = Math.ceil((audio.length + 200) / 160);
  for (let m = 0; m < 80; m++) {
    const base = m * 3000;
    const pad = mel[base + lastReal + 5];
    for (let t = lastReal + 5; t < 3000; t++) {
      assert.strictEqual(mel[base + t], pad, `mel ${m} frame ${t} differs from the padding`);
    }
  }
});

test('log-mel finds a tone where the tone actually is', () => {
  const features = new WhisperFeatures({});
  const audio = new Float32Array(16000);
  for (let i = 0; i < audio.length; i++) audio[i] = Math.sin((2 * Math.PI * 1000 * i) / 16000) * 0.5;
  const mel = features.compute(audio, 200);

  // Energy at frame 50 should peak in the mel band containing 1 kHz.
  let best = -1;
  let bestVal = -Infinity;
  for (let m = 0; m < 80; m++) {
    const v = mel[m * 200 + 50];
    if (v > bestVal) {
      bestVal = v;
      best = m;
    }
  }
  const { filters, bins } = melFilterbank({ sampleRate: 16000, nFft: 400, nMels: 80 });
  const binFor1k = Math.round((1000 * 400) / 16000);
  assert.ok(
    filters[best * bins + binFor1k] > 0,
    `loudest mel band ${best} does not cover 1 kHz`
  );
});

// --- detokenisers --------------------------------------------------------

const { fromTokenizerJson, fromVocabTxt } = require('../src/engine/stt/tokenizer');

console.log('\ndetokenisers');

/** Write a fixture into the scratch area and hand back the path. */
function fixture(name, contents) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chatterlayer-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

test('ByteLevel BPE decodes to text, with specials dropped (Whisper)', () => {
  // "Ġ" is how ByteLevel stores a leading space.
  const file = fixture(
    'tokenizer.json',
    JSON.stringify({
      model: { type: 'BPE', vocab: { Hello: 0, 'Ġworld': 1, '!': 2 } },
      added_tokens: [{ id: 3, content: '<|endoftext|>', special: true }],
      decoder: { type: 'ByteLevel' },
    })
  );
  const detok = fromTokenizerJson(file);
  assert.strictEqual(detok.decode([0, 1, 2, 3]), 'Hello world!');
  assert.strictEqual(detok.decode([0, 1, 2, 3], { skipSpecial: false }), 'Hello world!<|endoftext|>');
});

test('SentencePiece with byte fallback reassembles multi-byte characters (Moonshine)', () => {
  // "é" is 0xC3 0xA9: two byte-fallback tokens that only make sense together, so
  // decoding token by token would produce two replacement characters.
  const file = fixture(
    'tokenizer.json',
    JSON.stringify({
      model: {
        type: 'BPE',
        vocab: { '▁caf': 0, '<0xC3>': 1, '<0xA9>': 2, '▁open': 3 },
      },
      added_tokens: [{ id: 4, content: '</s>', special: true }],
      decoder: {
        type: 'Sequence',
        decoders: [
          { type: 'Replace', pattern: { String: '▁' }, content: ' ' },
          { type: 'ByteFallback' },
          { type: 'Fuse' },
          { type: 'Strip', content: ' ', start: 1, stop: 0 },
        ],
      },
    })
  );
  const detok = fromTokenizerJson(file);
  // The leading space is stripped, as the Strip step says.
  assert.strictEqual(detok.decode([0, 1, 2, 3, 4]), 'café open');
});

test('a NeMo vocab.txt decodes with metaspace word boundaries (Parakeet)', () => {
  const file = fixture('vocab.txt', '<unk> 0\n▁hello 1\n▁wor 2\nld 3\n<blk> 4\n');
  const detok = fromVocabTxt(file);
  assert.strictEqual(detok.decode([1, 2, 3]), 'hello world');
  // The blank is never emitted by the search, but must not survive if it is.
  assert.strictEqual(detok.decode([1, 4]), 'hello');
});

// --- renderer wiring -----------------------------------------------------

console.log('\nrenderer');

test('every element id the renderer looks up exists in the HTML', () => {
  const root = path.join(__dirname, '..', 'src', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !ids.has(id));
  assert.strictEqual(missing.length, 0, `renderer references missing ids: ${missing.join(', ')}`);
});

test('copy buttons point at elements that exist', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8'
  );
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const [, target] of html.matchAll(/data-copy="([^"]+)"/g)) {
    assert.ok(ids.has(target), `data-copy="${target}" has no matching element`);
  }
});

test('all source files parse', () => {
  const { execFileSync } = require('child_process');
  const roots = ['src', 'scripts'];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) files.push(p);
    }
  };
  for (const r of roots) walk(path.join(__dirname, '..', r));
  for (const f of files) execFileSync(process.execPath, ['--check', f]);
  assert.ok(files.length > 8, `only found ${files.length} source files`);
});

// --- channel picker ------------------------------------------------------

const { ChannelType, PermissionsBitField } = require('discord.js');
const { ChatterlayerEngine } = require('../src/engine/engine');

console.log('\nchannel picker');

const F = PermissionsBitField.Flags;
const BOT = { id: 'bot-1', tag: 'Chatterlayer#0001' };

/** `granted: null` stands in for "the bot's own member isn't cached". */
function fakeChannel({ name = 'general', granted = [F.ViewChannel, F.Connect], ...rest } = {}) {
  return {
    id: `c-${name}`,
    name,
    type: ChannelType.GuildVoice,
    rawPosition: 0,
    userLimit: 0,
    members: { size: 0 },
    permissionsFor: () =>
      granted === null ? null : { has: (flag) => granted.includes(flag) },
    ...rest,
  };
}

const picker = new ChatterlayerEngine(() => {});
const describe = (ch) => picker.describeChannel(ch, BOT);

test('a channel the bot can see and connect to is joinable', () => {
  const c = describe(fakeChannel());
  assert.strictEqual(c.canJoin, true);
  assert.strictEqual(c.reason, '');
});

test('missing Connect is reported, and names the permission', () => {
  const c = describe(fakeChannel({ granted: [F.ViewChannel] }));
  assert.strictEqual(c.canJoin, false);
  assert.ok(/Connect/.test(c.reason), c.reason);
  assert.ok(!/View Channel/.test(c.reason), c.reason);
});

test('missing both permissions names both', () => {
  const c = describe(fakeChannel({ granted: [] }));
  assert.strictEqual(c.canJoin, false);
  assert.ok(/View Channel/.test(c.reason) && /Connect/.test(c.reason), c.reason);
});

test('uncached bot member reads as unknown, never as "cannot join"', () => {
  // A false negative here would grey out a channel that actually works, which
  // is worse than showing no verdict at all.
  const c = describe(fakeChannel({ granted: null }));
  assert.strictEqual(c.canJoin, null);
  assert.strictEqual(c.reason, '');
});

test('stage channels are flagged so the audience trap is visible', () => {
  const c = describe(fakeChannel({ type: ChannelType.GuildStageVoice }));
  assert.strictEqual(c.stage, true);
  // Still joinable — it just will not hear anything until promoted.
  assert.strictEqual(c.canJoin, true);
});

test('a channel at its user limit is flagged as full', () => {
  const c = describe(fakeChannel({ userLimit: 2, members: { size: 2 } }));
  assert.strictEqual(c.full, true);
});

test('user limit does not apply to a bot that can move members', () => {
  const c = describe(
    fakeChannel({
      userLimit: 2,
      members: { size: 2 },
      granted: [F.ViewChannel, F.Connect, F.MoveMembers],
    })
  );
  assert.strictEqual(c.full, false);
});

test('the guild tree lists voice channels only, and drops empty servers', () => {
  const guild = (name, channels) => [name, { id: `g-${name}`, name, channels: { cache: new Map(channels.map((c, i) => [i, c])) } }];
  const engine = new ChatterlayerEngine(() => {});
  engine.client = {
    isReady: () => true,
    user: BOT,
    guilds: {
      cache: new Map([
        guild('Zebra', [fakeChannel({ name: 'voice' })]),
        guild('Alpha', [
          fakeChannel({ name: 'talk' }),
          fakeChannel({ name: 'rules', type: ChannelType.GuildText }),
        ]),
        guild('Textonly', [fakeChannel({ name: 'chat', type: ChannelType.GuildText })]),
      ].map(([, g]) => [g.id, g])),
    },
  };

  let payload = null;
  engine.emit = (msg) => {
    if (msg.type === 'guilds') payload = msg;
  };
  engine.emitGuilds();

  assert.ok(payload, 'no guilds event emitted');
  assert.deepStrictEqual(
    payload.guilds.map((g) => g.name),
    ['Alpha', 'Zebra'],
    'servers should be sorted by name, with text-only servers dropped'
  );
  assert.deepStrictEqual(payload.guilds[0].channels.map((c) => c.name), ['talk']);
});

// --- word filter ---------------------------------------------------------

const { buildFilter, maskText } = require('../src/shared/wordfilter');

console.log('\nword filter');

const filter = buildFilter();
const mask = (s) => maskText(s, filter).text;

test('masks a slur mid-sentence', () => {
  const out = mask('what a chink of light');
  assert.ok(!out.includes('chink'), out);
  assert.ok(out.includes('*****'), out);
});

test('preserves surrounding words and spacing', () => {
  assert.strictEqual(mask('you are a wop mate'), 'you are a *** mate');
});

test('masks plurals of listed terms', () => {
  assert.ok(!mask('two spics').includes('spics'));
});

test('masks multi-word slurs across adjacent words', () => {
  const out = mask('called him a porch monkey today');
  assert.ok(!out.includes('porch monkey'), out);
  assert.ok(out.startsWith('called him a ***** ******'), out);
});

test('masks a term the recogniser split into separate words', () => {
  // Vosk decides where the word boundaries go, and it is not consistent about
  // it. Every one of these is a single entry in DEFAULT_TERMS.
  for (const [line, expected] of [
    ['called him a zipper head', 'called him a ****** ****'],
    ['what a towel head', 'what a ***** ****'],
    ['he is a pick a ninny', 'he is a **** * *****'],
    ['a rag head remark', 'a *** **** remark'],
  ]) {
    assert.strictEqual(mask(line), expected);
  }
});

test('masks a phrase the recogniser ran together, and its plural', () => {
  assert.strictEqual(mask('a porchmonkey'), 'a ***********');
  assert.strictEqual(mask('two porch monkeys'), 'two ***** *******');
});

test('does not crash when text ends on the start of a longer term', () => {
  // Partial results arrive a word at a time, so "porch" is emitted on its own
  // before "porch monkey" is ever complete. This used to read past the end of
  // the word list and take down the main process.
  assert.strictEqual(mask('porch'), 'porch');
  assert.strictEqual(mask('i sat on the porch'), 'i sat on the porch');
  assert.strictEqual(mask('cotton'), 'cotton');
});

test('does NOT join short words into an accidental match', () => {
  // The flip side of joining: without a length floor these read as slurs.
  for (const line of [
    'yeah we can go ok',
    'i was there in june',
    'put it on the top of the pile',
  ]) {
    assert.strictEqual(mask(line), line, `wrongly masked: ${line}`);
  }
});

test('does NOT mask innocent words containing a slur substring', () => {
  // The Scunthorpe problem. "niggardly" is unrelated in origin; the others
  // simply contain shorter sequences. Substring matching would break all four.
  for (const phrase of [
    'he was niggardly with praise',
    'that is a classic album',
    'the assassin escaped',
    'i need to analyse this',
  ]) {
    assert.strictEqual(mask(phrase), phrase, `wrongly masked: ${phrase}`);
  }
});

test('leaves ordinary speech untouched', () => {
  const line = 'okay so the plan is we push through the second gate first';
  assert.strictEqual(mask(line), line);
});

test('custom terms are masked, including phrases', () => {
  const custom = buildFilter({ custom: ['bannedword', 'two words'] });
  assert.strictEqual(maskText('a bannedword here', custom).text, 'a ********** here');
  assert.strictEqual(maskText('say two words now', custom).text, 'say *** ***** now');
});

test('disabling the filter passes text through unchanged', () => {
  const off = buildFilter({ enabled: false });
  const line = 'this contains a chink';
  assert.strictEqual(maskText(line, off).text, line);
});

test('reports how many words were masked', () => {
  assert.strictEqual(maskText('a chink and a gook', filter).masked, 2);
  assert.strictEqual(maskText('nothing to see', filter).masked, 0);
});

test('handles empty and malformed input', () => {
  assert.strictEqual(maskText('', filter).text, '');
  assert.strictEqual(maskText(null, filter).text, '');
  assert.strictEqual(maskText('   ', filter).text, '   ');
});

test('filter is on by default in the shipped config', () => {
  const { DEFAULTS } = require('../src/main/config');
  assert.strictEqual(DEFAULTS.filter.enabled, true);
});

// --- utterance segmentation ----------------------------------------------

const { Segmenter } = require('../src/engine/stt/segmenter');

console.log('\nutterance segmentation');

const SR = 16000;

function tone(seconds, amplitude = 0.3) {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * amplitude;
  return out;
}

function quiet(seconds, amplitude = 0.0002) {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * amplitude;
  return out;
}

/**
 * Feed audio the way the worker does: 20 ms at a time, and acting on each
 * verdict. Acting matters — poll() keeps saying 'final' until the buffer is
 * taken, so a helper that only observed would report a cap that never applied.
 */
function feed(seg, audio) {
  const verdicts = [];
  for (let o = 0; o < audio.length; o += 320) {
    seg.push(audio.subarray(o, Math.min(o + 320, audio.length)));
    const v = seg.poll();
    if (!v) continue;
    verdicts.push(v);
    if (v === 'final') seg.take();
    else seg.reset();
  }
  return verdicts;
}

test('speech followed by silence closes exactly one utterance', () => {
  const seg = new Segmenter({});
  const verdicts = feed(seg, tone(1.5));
  assert.deepStrictEqual(verdicts, [], 'should not close while someone is still talking');
  const after = feed(seg, quiet(1.0));
  assert.ok(after.includes('final'), 'silence after speech should close the utterance');
});

test('a buffer that never contained speech is discarded, not transcribed', () => {
  // The reason this matters: Whisper hallucinates confidently on silence, so a
  // decode of nothing produces a caption of something.
  const seg = new Segmenter({});
  const verdicts = feed(seg, quiet(4));
  assert.ok(verdicts.includes('discard'), `got ${JSON.stringify(verdicts)}`);
  assert.ok(!verdicts.includes('final'), 'silence must never reach the engine');
  assert.strictEqual(seg.view(), null, 'there is nothing to hand over');
});

test('the clip keeps more audio after the last speech than before the first', () => {
  // A word ending in a fricative trails below the energy threshold while still
  // being part of the word. Trimming symmetrically cost the final consonant:
  // "Americans" came back as "American".
  const seg = new Segmenter({});
  feed(seg, quiet(0.5));
  feed(seg, tone(1.0));
  feed(seg, quiet(0.5));
  const clip = seg.view();
  assert.ok(clip, 'expected a clip');
  const lead = seg.firstSpeech - Math.max(0, seg.firstSpeech - seg.leadSamples);
  const trail = Math.min(seg.len, seg.lastSpeech + seg.trailSamples) - seg.lastSpeech;
  assert.ok(trail > lead, `trail ${trail} should exceed lead ${lead}`);
});

test('a long unbroken turn is capped rather than growing without limit', () => {
  // Whisper cannot encode more than 30 seconds at all, and a caption nobody sees
  // for half a minute is no use on any engine.
  const seg = new Segmenter({ maxSeconds: 4 });
  const verdicts = feed(seg, tone(6));
  assert.ok(verdicts.includes('final'), 'the cap should have closed an utterance');
  assert.ok(seg.seconds <= 4.1, `buffer grew to ${seg.seconds.toFixed(1)}s`);
});

test('the noise floor does not drift up during a long turn', () => {
  // A symmetric average let a sustained turn drag the floor up until quiet words
  // stopped registering as speech and the utterance closed mid-sentence.
  const seg = new Segmenter({});
  feed(seg, tone(8, 0.3));
  assert.ok(seg.hasSpeech, 'eight seconds of tone should read as speech throughout');
  const threshold = seg.noise * 3;
  assert.ok(threshold < 0.3, `threshold climbed to ${threshold.toFixed(4)} — into the signal`);
});

test('the noise floor adapts to a genuinely noisy microphone', () => {
  const seg = new Segmenter({});
  feed(seg, quiet(3, 0.02)); // a hissy mic, well above the absolute floor
  assert.ok(seg.noise > 0.005, `floor stayed at ${seg.noise.toFixed(5)} despite the hiss`);
});

// --- decode scheduling ---------------------------------------------------

const { InferenceQueue } = require('../src/engine/stt/onnx');

console.log('\ndecode scheduling');

const defer = (ms, value) => () => new Promise((r) => setTimeout(() => r(value), ms));

testAsync('finals run one at a time, in order', async () => {
  // Several decodes at once would contend for the same cores and all miss their
  // deadline, which is the whole reason this queue exists.
  const queue = new InferenceQueue(1);
  const order = [];
  let peak = 0;
  const job = (name) => () => {
    peak = Math.max(peak, queue.active);
    return defer(20)().then(() => order.push(name));
  };
  await Promise.all([queue.final(job('a')), queue.final(job('b')), queue.final(job('c'))]);
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
  assert.strictEqual(peak, 1, `ran ${peak} decodes at once`);
});

testAsync('a newer partial displaces the pending one for the same speaker', async () => {
  const queue = new InferenceQueue(1);
  // Occupy the queue so both partials have to wait.
  const blocking = queue.final(defer(40, 'busy'));
  const first = queue.partial('user-1', defer(5, 'stale'));
  const second = queue.partial('user-1', defer(5, 'fresh'));
  assert.strictEqual(await first, null, 'the displaced partial should resolve to null');
  assert.strictEqual(await second, 'fresh');
  await blocking;
});

testAsync('partials for different speakers both survive', async () => {
  const queue = new InferenceQueue(1);
  const a = queue.partial('user-1', defer(5, 'a'));
  const b = queue.partial('user-2', defer(5, 'b'));
  assert.deepStrictEqual(await Promise.all([a, b]), ['a', 'b']);
});

testAsync('cancelling a speaker’s partials releases the caller', async () => {
  const queue = new InferenceQueue(1);
  const blocking = queue.final(defer(30, 'busy'));
  const pending = queue.partial('user-1', defer(5, 'never'));
  queue.cancelPartials('user-1');
  assert.strictEqual(await pending, null);
  await blocking;
});

test('a queue with a final waiting reports itself busy to speculative work', () => {
  const queue = new InferenceQueue(1);
  assert.strictEqual(queue.busy, false);
  queue.final(defer(50, 'x'));
  assert.strictEqual(queue.busy, true, 'a partial must not be started ahead of a final');
});

// --- CI workflows --------------------------------------------------------

console.log('\nworkflows');

// js-yaml arrives via electron-builder rather than directly, so treat it as
// optional — a missing dev dependency shouldn't fail the suite.
let yaml = null;
try {
  yaml = require('js-yaml');
} catch {
  /* skipped below */
}

const workflowDir = path.join(__dirname, '..', '.github', 'workflows');

test('workflow and builder YAML parses', () => {
  if (!yaml) {
    console.log('        (skipped — js-yaml not installed)');
    return;
  }
  const files = [
    ...fs.readdirSync(workflowDir).map((f) => path.join(workflowDir, f)),
    path.join(__dirname, '..', 'electron-builder.yml'),
  ];
  for (const file of files) {
    try {
      assert.ok(yaml.load(fs.readFileSync(file, 'utf8')), `${path.basename(file)} is empty`);
    } catch (err) {
      throw new Error(`${path.basename(file)}: ${err.message}`);
    }
  }
});

test('release job passes tag_name explicitly', () => {
  // Without this the action falls back to github.ref, which is a branch ref on
  // a manual run and fails with "Missing tag_name parameter".
  const release = fs.readFileSync(path.join(workflowDir, 'release.yml'), 'utf8');
  assert.ok(/tag_name:\s*\$\{\{/.test(release), 'release.yml must set tag_name');
});

test('workflows do not pin a deprecated Node version', () => {
  for (const name of fs.readdirSync(workflowDir)) {
    const text = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    for (const [, version] of text.matchAll(/node-version:\s*'?(\d+)/g)) {
      assert.ok(Number(version) >= 22, `${name} pins Node ${version}; use 22 or newer`);
    }
  }
});

// --- version check -------------------------------------------------------

const { compareVersions, checkForUpdate } = require('../src/main/updates');

console.log('\nversion check');

const newer = (a, b) => compareVersions(a, b) < 0;

test('a bump in any position reads as newer', () => {
  assert.ok(newer('0.0.5', '0.0.6'));
  assert.ok(newer('0.0.5', '0.1.0'));
  assert.ok(newer('0.9.9', '1.0.0'));
  // Not string comparison: 10 > 9.
  assert.ok(newer('1.9.0', '1.10.0'));
});

test('the same or an older tag is never offered as an update', () => {
  for (const [running, tag] of [
    ['1.2.3', '1.2.3'],
    ['1.2.3', 'v1.2.3'],
    ['1.2.3', '1.2.2'],
    ['1.2.3', '0.9.9'],
  ]) {
    assert.ok(!newer(running, tag), `${running} -> ${tag}`);
  }
});

test('the leading v is optional on either side', () => {
  assert.ok(newer('v0.0.5', '0.0.6'));
  assert.ok(newer('0.0.5', 'v0.0.6'));
});

test('a prerelease is older than its release, and newer than what came before', () => {
  assert.ok(newer('1.0.0-rc.1', '1.0.0'));
  assert.ok(!newer('1.0.0', '1.0.0-rc.1'));
  assert.ok(newer('0.9.0', '1.0.0-rc.1'));
});

test('a tag we cannot parse never announces itself as an update', () => {
  // Better to say nothing than to nag about a release that may not exist.
  for (const tag of ['', 'latest', 'nightly', 'v1.2', 'release-2024']) {
    assert.ok(!newer('1.2.3', tag), `tag ${JSON.stringify(tag)}`);
  }
});

test('update checks are on by default, and the app knows its own version', () => {
  const { DEFAULTS } = require('../src/main/config');
  assert.strictEqual(DEFAULTS.updates.check, true);
  const pkg = require('../package.json');
  assert.ok(/^\d+\.\d+\.\d+/.test(pkg.version), `package version ${pkg.version}`);
});

testAsync('switching the check off makes no request at all', async () => {
  // The privacy promise, so it gets a test: with the setting off, an
  // unreachable timeout would be the only sign a request had gone out.
  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    cache: { check: false, lastCheck: 0, latest: '' },
  });
  assert.strictEqual(result.state, 'off');
  assert.ok(result.url.startsWith('https://github.com/'), result.url);
});

testAsync('an unreachable GitHub still reports the tag we last saw', async () => {
  // The cache is no longer a throttle — it exists for this case alone. Point
  // the check at a host that cannot answer and the remembered update survives.
  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    cache: { check: true, lastCheck: Date.now() - 60_000, latest: 'v1.1.0' },
    endpoint: 'https://127.0.0.1:1/nothing-here',
  });
  assert.strictEqual(result.state, 'available');
  assert.strictEqual(result.latest, 'v1.1.0');
});

testAsync('a cached tag the user has since installed stops being an update', async () => {
  // The verdict is re-derived from the running version, so installing 1.1.0
  // clears the badge even on a launch that can't reach GitHub to confirm it.
  const result = await checkForUpdate({
    currentVersion: '1.1.0',
    cache: { check: true, lastCheck: Date.now() - 60_000, latest: 'v1.1.0' },
    endpoint: 'https://127.0.0.1:1/nothing-here',
  });
  assert.notStrictEqual(result.state, 'available');
});

testAsync('a check made minutes ago does not silence the next launch', async () => {
  // Regression guard for dropping the 24-hour throttle. A fresh lastCheck used
  // to short-circuit to a cached verdict without asking; now the request goes
  // out regardless, so an unreachable endpoint surfaces as an error rather
  // than a confident "you're up to date".
  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    cache: { check: true, lastCheck: Date.now() - 60_000, latest: '' },
    endpoint: 'https://127.0.0.1:1/nothing-here',
  });
  assert.strictEqual(result.state, 'error');
});

// --- remote sharing ------------------------------------------------------

console.log('\nremote sharing');

const http = require('http');
const vm = require('vm');
const WebSocket = require('ws');
const { CaptionServer, newAccessKey } = require('../src/main/server');
const { assetFor } = require('../src/main/tunnel');

/**
 * A caption server on an ephemeral port, torn down afterwards. Each test gets
 * its own so they can run concurrently without fighting over the access gate.
 */
async function withServer(access, fn) {
  const server = new CaptionServer();
  await server.start({ port: 0, host: '127.0.0.1' });
  if (access) server.setAccess(access);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

/** Headers a request forwarded by cloudflared actually carries. */
const REMOTE = {
  host: 'random-words.trycloudflare.com',
  'cf-ray': '8ab0000000000000-LHR',
  'cf-connecting-ip': '203.0.113.7',
};
const localHeaders = (port) => ({ host: `127.0.0.1:${port}` });

function status(port, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function socketOpens(port, reqPath, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${reqPath}`, { headers });
    const done = (r) => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(r);
    };
    ws.on('open', () => done(true));
    ws.on('error', () => done(false));
    setTimeout(() => done(false), 4000);
  });
}

testAsync('with sharing off the overlay is served to OBS without a key', async () => {
  await withServer(null, async (s) => {
    assert.strictEqual(await status(s.port, '/overlay', localHeaders(s.port)), 200);
    assert.strictEqual(await socketOpens(s.port, '/', localHeaders(s.port)), true);
  });
});

testAsync('with sharing on a remote request without the key gets nothing', async () => {
  await withServer({ token: 'sekret', required: true }, async (s) => {
    assert.strictEqual(await status(s.port, '/overlay', REMOTE), 401);
    assert.strictEqual(await status(s.port, '/overlay?k=', REMOTE), 401);
    assert.strictEqual(await status(s.port, '/overlay?k=wrong', REMOTE), 401);
    assert.strictEqual(await socketOpens(s.port, '/', REMOTE), false);
  });
});

testAsync('a wrong key is refused as firmly as no key at all', async () => {
  // "Missing" is the easy case. These are the near-misses: a truncated key, a
  // key with something appended, the right key under the wrong parameter name.
  const key = 'Xk3pQ7rTvB2nL9wYzA4hMg';
  await withServer({ token: key, required: true }, async (s) => {
    const refused = [
      '/overlay?k=hunter2',
      `/overlay?k=${key.slice(0, 12)}`,
      `/overlay?k=${key.slice(0, -1)}`,
      `/overlay?k=${key}x`,
      `/overlay?k=${key.toLowerCase()}`,
      `/overlay?k=${key}%20`,
      `/overlay?K=${key}`,
      `/overlay?key=${key}`,
      // Parameter pollution: the first k wins, so a bad one cannot be rescued
      // by appending a good one.
      `/overlay?k=nope&k=${key}`,
      '/overlay?size=40&k=nope',
    ];
    // Each attempt comes from its own address: this is about how a bad key is
    // judged, and twenty misses from one caller would (correctly) trip the
    // rate limiter and mask the answer. Throttling has its own test below.
    let n = 0;
    for (const p of refused) {
      const who = { ...REMOTE, 'cf-connecting-ip': `203.0.113.${++n}` };
      assert.strictEqual(await status(s.port, p, who), 401, `should be refused: ${p}`);
      assert.strictEqual(await socketOpens(s.port, p, who), false, `ws should refuse: ${p}`);
    }
    // ...and the genuine article still works, with overrides attached.
    assert.strictEqual(await status(s.port, `/overlay?k=${key}&size=40`, REMOTE), 200);
  });
});

testAsync('the right key gets both the page and the caption socket', async () => {
  await withServer({ token: 'sekret', required: true }, async (s) => {
    assert.strictEqual(await status(s.port, '/overlay?k=sekret', REMOTE), 200);
    assert.strictEqual(await socketOpens(s.port, '/?k=sekret', REMOTE), true);
  });
});

testAsync('the host’s own OBS keeps working while sharing is on', async () => {
  await withServer({ token: 'sekret', required: true }, async (s) => {
    assert.strictEqual(await status(s.port, '/overlay', localHeaders(s.port)), 200);
    assert.strictEqual(await socketOpens(s.port, '/', localHeaders(s.port)), true);
  });
});

testAsync('a spoofed loopback Host cannot get past the key', async () => {
  // Anyone can set Host on a request to the tunnel, so the loopback exemption
  // must not rest on it alone — Cloudflare's own headers settle it.
  await withServer({ token: 'sekret', required: true }, async (s) => {
    const spoofed = { ...localHeaders(s.port), 'cf-ray': '8ab', 'cf-connecting-ip': '203.0.113.7' };
    assert.strictEqual(await status(s.port, '/overlay', spoofed), 401);
    assert.strictEqual(await socketOpens(s.port, '/', spoofed), false);
  });
});

testAsync('rotating the key cuts off remote viewers but not the host', async () => {
  await withServer({ token: 'old', required: true }, async (s) => {
    const remote = new WebSocket(`ws://127.0.0.1:${s.port}/?k=old`, { headers: REMOTE });
    const host = new WebSocket(`ws://127.0.0.1:${s.port}/`, { headers: localHeaders(s.port) });
    await Promise.all([
      new Promise((r) => remote.on('open', r)),
      new Promise((r) => host.on('open', r)),
    ]);

    const kicked = new Promise((r) => remote.on('close', (code) => r(code)));
    let hostDropped = false;
    host.on('close', () => (hostDropped = true));

    s.setAccess({ token: 'new', required: true });

    assert.strictEqual(await kicked, 4401, 'remote viewer should be told why');
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(hostDropped, false, 'the host’s own overlay must survive');
    assert.strictEqual(await status(s.port, '/overlay?k=old', REMOTE), 401);
    assert.strictEqual(await status(s.port, '/overlay?k=new', REMOTE), 200);
    host.close();
  });
});

/** Open a socket and keep it, so connection caps can actually be reached. */
function openSocket(port, reqPath, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${reqPath}`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', () => resolve(null));
    setTimeout(() => resolve(null), 4000);
  });
}

const remoteFrom = (ip) => ({ ...REMOTE, 'cf-connecting-ip': ip });

testAsync('repeated failures are throttled, per caller', async () => {
  // The key is 128 bits, so this is not a brute-force defence — it stops a
  // scanner burning a streamer's sockets and CPU mid-broadcast.
  await withServer({ token: 'sekret', required: true }, async (s) => {
    const attacker = remoteFrom('203.0.113.50');
    const codes = [];
    for (let i = 0; i < 25; i++) codes.push(await status(s.port, `/overlay?k=g${i}`, attacker));

    assert.ok(codes.slice(0, 20).every((c) => c === 401), 'first 20 should be plain refusals');
    assert.ok(codes.slice(20).every((c) => c === 429), 'the rest should be throttled');
    // Once throttled, even the real key waits — no oracle for "that one was right".
    assert.strictEqual(await status(s.port, '/overlay?k=sekret', attacker), 429);
    assert.strictEqual(await socketOpens(s.port, '/?k=sekret', attacker), false);

    // Everyone else is unaffected, including the host.
    assert.strictEqual(await status(s.port, '/overlay?k=sekret', remoteFrom('198.51.100.9')), 200);
    assert.strictEqual(await status(s.port, '/overlay', localHeaders(s.port)), 200);
  });
});

testAsync('a correct key clears the failure count', async () => {
  await withServer({ token: 'sekret', required: true }, async (s) => {
    const clumsy = remoteFrom('198.51.100.22');
    for (let i = 0; i < 15; i++) await status(s.port, '/overlay?k=typo', clumsy);
    assert.strictEqual(await status(s.port, '/overlay?k=sekret', clumsy), 200);
    // Counter reset, so another run of near-misses is tolerated rather than
    // leaving a co-streamer locked out for a minute over one bad paste.
    for (let i = 0; i < 19; i++) await status(s.port, '/overlay?k=typo', clumsy);
    assert.strictEqual(await status(s.port, '/overlay?k=sekret', clumsy), 200);
  });
});

testAsync('simultaneous remote viewers are capped, but the host never is', async () => {
  await withServer({ token: 'sekret', required: true }, async (s) => {
    const held = [];
    for (let i = 0; i < s.maxRemoteClients; i++) {
      held.push(await openSocket(s.port, '/?k=sekret', remoteFrom(`198.51.100.${i}`)));
    }
    assert.ok(held.every(Boolean), 'every viewer up to the cap should connect');
    assert.strictEqual(
      await openSocket(s.port, '/?k=sekret', remoteFrom('198.51.100.99')),
      null,
      'one past the cap must be refused'
    );

    // Flooding the tunnel must never cost the host their own overlay.
    const host = await openSocket(s.port, '/', localHeaders(s.port));
    assert.ok(host, 'the host must get in even at the cap');

    held.forEach((w) => w && w.close());
    host.close();
    await new Promise((r) => setTimeout(r, 300));
    const after = await openSocket(s.port, '/?k=sekret', remoteFrom('198.51.100.98'));
    assert.ok(after, 'a slot should free up when a viewer leaves');
    after.close();
  });
});

testAsync('the caption feed is read-only and rejects oversized frames', async () => {
  await withServer({ token: 'sekret', required: true }, async (s) => {
    const viewer = await openSocket(s.port, '/?k=sekret', REMOTE);
    viewer.send(JSON.stringify({ type: 'settings', settings: { overlay: { fontSize: 999 } } }));
    viewer.send(JSON.stringify({ type: 'clear' }));
    await new Promise((r) => setTimeout(r, 200));

    // A viewer is a viewer. Nothing it sends may reach settings, the engine or
    // the stream — the link grants watching, never controlling.
    assert.strictEqual(s.settings.overlay.fontSize, undefined, 'client input changed server state');
    assert.strictEqual(s.wss.listenerCount('message'), 0, 'nothing should act on inbound frames');

    const closed = new Promise((r) => viewer.on('close', (code) => r(code)));
    viewer.send(Buffer.alloc(64 * 1024));
    assert.strictEqual(await closed, 1009, 'an oversized frame should close the socket');
  });
});

testAsync('nothing outside web/ can be read, including sibling directories', async () => {
  await withServer(null, async (s) => {
    const local = localHeaders(s.port);
    assert.strictEqual(await status(s.port, '/../package.json', local), 403);
    assert.strictEqual(await status(s.port, '/..%2fpackage.json', local), 403);
    // A bare startsWith check would let "web-evil" satisfy the "web" prefix.
    assert.strictEqual(await status(s.port, '/../web-evil/x.html', local), 403);
  });
});

test('the share link carries the key, and there is no link without one', () => {
  const s = new CaptionServer();
  assert.strictEqual(s.shareUrl('https://x.trycloudflare.com'), null);
  s.setAccess({ token: 'a+b/c', required: true });
  assert.strictEqual(
    s.shareUrl('https://x.trycloudflare.com/'),
    'https://x.trycloudflare.com/overlay?k=a%2Bb%2Fc'
  );
});

test('access keys are unguessable and never repeat', () => {
  const keys = new Set();
  for (let i = 0; i < 500; i++) keys.add(newAccessKey());
  assert.strictEqual(keys.size, 500, 'keys must not collide');
  for (const k of keys) {
    // 16 random bytes as base64url: 22 chars, no padding, URL-safe throughout.
    assert.match(k, /^[A-Za-z0-9_-]{22}$/, `bad key shape: ${k}`);
  }
});

test('the access key is never written to disk', () => {
  const src = path.join(__dirname, '..', 'src', 'main');
  const config = fs.readFileSync(path.join(src, 'config.js'), 'utf8');
  const main = fs.readFileSync(path.join(src, 'main.js'), 'utf8');

  // The key lives for one tunnel session and stays in memory. Persisting it
  // would put a live credential in plain text beside a bot token the OS
  // keystore encrypts, and would buy nothing: the tunnel hostname is random
  // per session, so last run's link is already dead.
  const share = config.match(/share:\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(share, 'config has no share block');
  assert.ok(!/accessToken|shareKey|key/i.test(share[0]), 'no key may be stored in config');
  assert.ok(
    !/config\.update\([^)]*shareKey/s.test(main),
    'the key must never be written back to config'
  );
  // Every Start mints a fresh one rather than reusing whatever was around.
  const start = main.match(/startShare[\s\S]*?\n\}\);/);
  assert.ok(/shareKey = newAccessKey\(\)/.test(start[0]), 'Start must mint a new key');
  // And stopping discards it.
  const stop = main.match(/async function stopSharing[\s\S]*?\n}/);
  assert.ok(/shareKey = ''/.test(stop[0]), 'stopping must discard the key');

  // mergeDefaults keeps stored-only keys, so dropping the field from DEFAULTS
  // is not enough on its own — a key written by an earlier build has to be
  // actively scrubbed or it outlives the feature that wrote it.
  assert.ok(
    /delete this\.data\.share\.accessToken/.test(config),
    'a key left on disk by an earlier build must be cleared on load'
  );
});

test('sharing is off by default and the launch path never starts it', () => {
  const src = path.join(__dirname, '..', 'src', 'main');
  const config = fs.readFileSync(path.join(src, 'config.js'), 'utf8');
  const main = fs.readFileSync(path.join(src, 'main.js'), 'utf8');

  const share = config.match(/share:\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(share, 'config has no share block');
  assert.ok(/enabled:\s*false/.test(share[0]), 'sharing must default to off');

  // The promise this feature makes: a tunnel only ever opens because someone
  // pressed Start. Nothing on the launch path may call into it.
  const bootstrap = main.match(/async function bootstrap\(\)[\s\S]*?\n}/);
  assert.ok(bootstrap, 'bootstrap not found');
  assert.ok(
    !/tunnel\.start/.test(bootstrap[0]),
    'bootstrap must not start the tunnel'
  );
  assert.ok(
    /tunnel\.stop|stopSharing/.test(main.match(/before-quit[\s\S]*?\n}\);/)[0]),
    'quitting must close the tunnel'
  );
});

test('the keyed link never reaches the log panel', () => {
  // The Log panel is what people screenshot into GitHub issues. The bare
  // tunnel hostname there is harmless; the key beside it would not be.
  const js = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8'
  );
  for (const [line] of js.matchAll(/^.*\bshare\.url\b.*$/gm)) {
    assert.ok(!/\blog\(/.test(line), `the keyed link must not be logged: ${line.trim()}`);
  }
  assert.ok(
    /log\(`Remote overlay live at \$\{state\.share\.origin\}`\)/.test(js),
    'the "live" message should log the bare origin, not the keyed link'
  );

  // cloudflared only ever learns the hostname — the key is appended by us —
  // so its captured output cannot carry one into an error message.
  const tunnel = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'tunnel.js'), 'utf8');
  assert.ok(!/accessToken|shareKey|KEY_PARAM|[?&]k=/.test(tunnel), 'the tunnel must never see the key');
});

test('every platform maps to a cloudflared build, or to none at all', () => {
  assert.strictEqual(assetFor('win32', 'x64').name, 'cloudflared-windows-amd64.exe');
  // Cloudflare ships no windows/arm64 build; amd64 runs under emulation.
  assert.strictEqual(assetFor('win32', 'arm64').name, 'cloudflared-windows-amd64.exe');
  assert.strictEqual(assetFor('darwin', 'arm64').name, 'cloudflared-darwin-arm64.tgz');
  assert.strictEqual(assetFor('darwin', 'arm64').archive, 'tgz');
  assert.strictEqual(assetFor('linux', 'arm64').name, 'cloudflared-linux-arm64');
  assert.strictEqual(assetFor('linux', 'x64').archive, null);
  assert.strictEqual(assetFor('sunos', 'x64'), null);
});

// --- overlay query overrides ---------------------------------------------

console.log('\noverlay overrides');

/**
 * Run overlay.html's inline script against a stub DOM. It is the only code in
 * the project that never runs in the app itself, so nothing else would catch a
 * break in it.
 */
function runOverlay(search, where = { protocol: 'https:', host: 'abc.trycloudflare.com' }) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'overlay.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const stub = () => {
    const node = {
      children: [],
      dataset: {},
      style: { props: {}, setProperty: (k, v) => (node.style.props[k] = v) },
      classList: { add() {}, remove() {} },
      textContent: '',
      isConnected: true,
      appendChild: (c) => (node.children.push(c), c),
      remove() {},
      replaceWith() {},
      set innerHTML(_v) {
        node.children.length = 0;
      },
      get firstChild() {
        return node.children[0];
      },
    };
    return node;
  };

  const root = stub();
  const sockets = [];
  const sandbox = {
    setTimeout,
    clearTimeout,
    URLSearchParams,
    document: { documentElement: root, getElementById: stub, createElement: stub },
    location: {
      protocol: where.protocol,
      host: where.host,
      hostname: where.host.replace(/:\d+$/, ''),
      search,
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      close() {}
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  return {
    /** null when the page refused to open a socket at all. */
    wsUrl: sockets.length ? sockets[0].url : null,
    /** Push settings from the host, read back the size actually applied. */
    push(overlay) {
      sockets[0].onmessage({ data: JSON.stringify({ type: 'settings', settings: { overlay } }) });
      return root.style.props['--size'];
    },
  };
}

test('the access key is carried onto the caption socket', () => {
  assert.strictEqual(runOverlay('?k=abc123').wsUrl, 'wss://abc.trycloudflare.com/?k=abc123');
  assert.strictEqual(runOverlay('?k=a%2Bb').wsUrl, 'wss://abc.trycloudflare.com/?k=a%2Bb');
  assert.strictEqual(runOverlay('').wsUrl, 'wss://abc.trycloudflare.com/');
});

test('the key is never sent over an insecure remote connection', () => {
  const http = { protocol: 'http:', host: 'abc.trycloudflare.com' };
  assert.strictEqual(
    runOverlay('?k=abc123', http).wsUrl,
    null,
    'a plain-HTTP remote page must not open a socket carrying the key'
  );
  // The host's own OBS is plain HTTP by design and never leaves the machine.
  assert.strictEqual(
    runOverlay('', { protocol: 'http:', host: '127.0.0.1:8777' }).wsUrl,
    'ws://127.0.0.1:8777/'
  );
  assert.strictEqual(
    runOverlay('', { protocol: 'http:', host: 'localhost:8777' }).wsUrl,
    'ws://localhost:8777/'
  );
});

test('the host drives styling when a viewer overrides nothing', () => {
  assert.strictEqual(runOverlay('?k=x').push({ fontSize: 52 }), '52px');
});

test('a viewer’s own size survives the host changing theirs', () => {
  // The point of the overrides: four people sharing one overlay each need it
  // sized for their own scene, and the host must not be able to stomp that.
  const viewer = runOverlay('?k=x&size=18');
  assert.strictEqual(viewer.push({ fontSize: 52 }), '18px');
  assert.strictEqual(viewer.push({ fontSize: 64 }), '18px');
});

test('override values are clamped and junk is ignored', () => {
  assert.strictEqual(runOverlay('?size=9999').push({ fontSize: 30 }), '200px');
  assert.strictEqual(runOverlay('?size=0').push({ fontSize: 30 }), '8px');
  assert.strictEqual(runOverlay('?size=big').push({ fontSize: 30 }), '30px');
  assert.strictEqual(runOverlay('?nonsense=1').push({ fontSize: 30 }), '30px');
});

// --- result --------------------------------------------------------------

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
});
