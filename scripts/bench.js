'use strict';
/**
 * Measures the two numbers that decide how many speakers a machine can carry:
 * memory per speaker, and CPU needed to keep up with real time.
 *
 *   node --expose-gc scripts/bench.js                        # best installed model
 *   node --expose-gc scripts/bench.js --model=whisper-base
 *   node --expose-gc scripts/bench.js --all
 *   node --expose-gc scripts/bench.js --speakers=7 --wav=speech.wav
 *
 * The two engine families have to be read differently, and the difference is the
 * whole story of how many speakers fit:
 *
 * Vosk streams. It does a fixed amount of work per 20 ms of audio whether anyone
 * is talking or not, and each speaker needs their own recogniser — so its cost is
 * per-speaker memory plus a continuous CPU draw.
 *
 * Whisper, Moonshine and Parakeet transcribe whole utterances. One copy of the
 * model serves every speaker, so a seventh speaker costs an audio buffer and
 * nothing else; and since silence is trimmed before decoding, they do no work at
 * all while nobody is talking. Their limit is latency: decodes are queued one at
 * a time, so N speakers finishing together means the last one waits N decodes.
 * That is what `--speakers` measures.
 *
 * IMPORTANT — pass --wav with real speech for meaningful CPU numbers. The
 * synthetic fallback is band-limited noise with a speech-like envelope; memory
 * figures are exact either way, but Vosk prunes low-energy noise aggressively and
 * the token loop in the ONNX engines runs short on gibberish, so both understate.
 *
 * `--all` runs each model in its own child process. It has to: neither ONNX
 * Runtime nor libvosk returns memory to the OS when a model is released, so
 * measuring a second model in the same process reports the high-water mark of
 * both and the deltas come out as nonsense (a negative model size, in the first
 * version of this script).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { listModels, resolveModel } = require('../src/shared/paths');
const { loadEngine, describeEngine } = require('../src/engine/stt');
const { InferenceQueue } = require('../src/engine/stt/onnx');
const { Segmenter } = require('../src/engine/stt/segmenter');

const SR = 16000;

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const speakerCount = Number(arg('speakers') || 7);

function rssMB() {
  // Encourage a collection so deltas reflect native allocations, not JS garbage.
  if (global.gc) global.gc();
  return process.memoryUsage().rss / 1048576;
}

/**
 * High-water mark of resident memory, sampled continuously.
 *
 * A reading taken at one chosen moment is not the number anyone needs — the first
 * version of this script sampled straight after a warm-up decode and reported
 * Whisper Base as lighter than Whisper Tiny, because the real peak arrives later,
 * once several decodes have been through the same session. What matters for "will
 * this fit on my machine" is the maximum, so watch for it.
 */
let peakRss = 0;
function watchPeak() {
  const tick = () => {
    const now = process.memoryUsage().rss / 1048576;
    if (now > peakRss) peakRss = now;
  };
  tick();
  const timer = setInterval(tick, 25);
  timer.unref();
  return () => {
    tick();
    clearInterval(timer);
    return peakRss;
  };
}

const pad = (v, n) => String(v).padStart(n);

/** Speech-like test signal: modulated, band-limited noise. */
function makeSynthetic(seconds) {
  const n = SR * seconds;
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const noise = Math.random() * 2 - 1;
    lp = lp * 0.86 + noise * 0.14; // ~1.2 kHz low-pass, roughly voice-band
    // syllable-rate envelope (~4 Hz) with pauses, like connected speech
    const env =
      Math.max(0, Math.sin((2 * Math.PI * 4 * i) / SR)) *
      (0.6 + 0.4 * Math.sin((2 * Math.PI * 0.4 * i) / SR));
    out[i] = Math.max(-1, Math.min(1, lp * env * 3.4));
  }
  return out;
}

/** 16 kHz mono 16-bit WAV -> float samples. */
function loadWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${file} is not a WAV`);
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      fmt = { channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file} has no fmt/data chunk`);
  if (fmt.rate !== SR || fmt.channels !== 1 || fmt.bits !== 16) {
    throw new Error(`${file} must be 16 kHz mono 16-bit`);
  }
  const n = data.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

function toPcm16(float32) {
  const buf = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    let v = Math.round(float32[i] * 32768);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

/**
 * Cut the sample into utterance-sized clips the way the live path would, so the
 * decode cost measured is the cost of a real caption rather than of one long file.
 */
function utterances(audio) {
  const seg = new Segmenter({});
  const clips = [];
  for (let o = 0; o < audio.length; o += 320) {
    seg.push(audio.subarray(o, Math.min(o + 320, audio.length)));
    if (seg.poll() === 'final') {
      const clip = seg.take();
      if (clip) clips.push(clip);
    }
  }
  const tail = seg.take();
  if (tail) clips.push(tail);
  // A sample with no clear pauses still has to produce something to decode.
  if (!clips.length) clips.push(audio);
  return clips;
}

/**
 * How long an utterance to use for the latency test.
 *
 * A whole sample file is the wrong unit: eleven seconds of continuous speech is
 * a monologue, and the latency it implies is not what anyone would see in a
 * Discord call. Four seconds is a normal conversational turn, and it is what the
 * suggested speaker limits are quoted against.
 */
const REFERENCE_SECONDS = 4;

function referenceClip(clips) {
  const want = SR * REFERENCE_SECONDS;
  const longest = clips.reduce((a, b) => (b.length > a.length ? b : a));
  if (longest.length >= want) return longest.subarray(0, want);

  // Shorter sample: concatenate clips until there is enough speech, so the token
  // count stays representative rather than padding with silence.
  const out = new Float32Array(want);
  let at = 0;
  for (let i = 0; at < want; i = (i + 1) % clips.length) {
    const take = Math.min(clips[i].length, want - at);
    out.set(clips[i].subarray(0, take), at);
    at += take;
  }
  return out;
}

// ---------------------------------------------------------------- streaming --

async function benchStreaming(model, audio) {
  const baseline = rssMB();
  const stopWatching = watchPeak();
  const t0 = Date.now();
  const engine = await loadEngine(model);
  const loadMs = Date.now() - t0;
  const afterModel = rssMB();

  console.log(`  load time            : ${loadMs} ms`);
  console.log(`  RSS after model      : ${afterModel.toFixed(0)} MB ` +
    `(model ~${(afterModel - baseline).toFixed(0)} MB, shared by all speakers)`);

  const pcm = toPcm16(audio);
  const sessions = [];
  let prev = afterModel;

  console.log('\n  Per-speaker recogniser cost');
  for (let i = 1; i <= speakerCount; i++) {
    const session = engine.createSession();
    // A recogniser allocates its decoding lattice lazily, so push a little audio
    // through before measuring or the cost reads as ~0.
    for (let o = 0; o < Math.min(pcm.length, SR * 2 * 2); o += 640) {
      session.accept(pcm.subarray(o, o + 640));
    }
    sessions.push(session);
    const now = rssMB();
    console.log(`    ${pad(i, 2)} speaker(s): RSS ${pad(now.toFixed(0), 5)} MB ` +
      `(+${(now - prev).toFixed(1)} MB for this one)`);
    prev = now;
  }
  const perSpeaker = (prev - afterModel) / speakerCount;
  console.log(`    average per speaker: ~${perSpeaker.toFixed(1)} MB`);

  const session = sessions[0];
  const start = Date.now();
  for (let o = 0; o < pcm.length; o += 640) {
    session.accept(pcm.subarray(o, Math.min(o + 640, pcm.length)));
  }
  session.finalize();
  const elapsed = Date.now() - start;
  const seconds = audio.length / SR;
  const rtf = elapsed / (seconds * 1000);

  console.log(`\n  Decode: ${seconds.toFixed(1)}s of audio in ${elapsed} ms ` +
    `-> ${rtf.toFixed(3)}x of one core, continuously`);
  console.log(`  ${speakerCount} speakers all talking: ~${(rtf * speakerCount).toFixed(2)} cores`);

  const peak = stopWatching();
  console.log(`  peak RSS             : ${peak.toFixed(0)} MB (high-water mark, ` +
    `${speakerCount} speakers)`);

  for (const s of sessions) s.free();
  engine.close();
  return {
    loadMs,
    ramMB: peak,
    modelMB: afterModel - baseline,
    perSpeakerMB: perSpeaker,
    rtf,
  };
}

// ---------------------------------------------------------------- segmented --

async function benchSegmented(model, audio) {
  const baseline = rssMB();
  const stopWatching = watchPeak();
  const t0 = Date.now();
  const engine = await loadEngine(model);
  const loadMs = Date.now() - t0;
  const afterModel = rssMB();

  console.log(`  load time            : ${loadMs} ms`);
  console.log(`  RSS after model      : ${afterModel.toFixed(0)} MB ` +
    `(model ~${(afterModel - baseline).toFixed(0)} MB, shared by all speakers)`);

  const clips = utterances(audio);
  const clipSeconds = clips.reduce((s, c) => s + c.length / SR, 0);
  console.log(`  sample splits into   : ${clips.length} utterance(s), ` +
    `${clipSeconds.toFixed(1)}s of speech from ${(audio.length / SR).toFixed(1)}s of audio`);

  // Warm up: the first run of a graph pays for arena growth and any lazy kernel
  // setup, which would otherwise land entirely on the first caption.
  await engine.transcribe(clips[0]);
  console.log(`  RSS after a decode   : ${rssMB().toFixed(0)} MB`);

  let total = 0;
  for (const clip of clips) {
    const start = Date.now();
    await engine.transcribe(clip);
    total += Date.now() - start;
  }
  const perSecond = total / (clipSeconds * 1000);
  console.log(`\n  Decode: ${clips.length} utterance(s) in ${total} ms ` +
    `-> ${perSecond.toFixed(3)}x of one core per second of speech`);
  console.log(`  mean per utterance   : ${(total / clips.length).toFixed(0)} ms`);

  // Latency under load. Decodes are serialised, so what a viewer notices when
  // several people stop talking at once is the queue, not the model.
  const queue = new InferenceQueue(Number(process.env.CHATTERLAYER_STT_CONCURRENCY) || 1);
  const clip = referenceClip(clips);
  console.log(`\n  Caption latency when N speakers finish a ${REFERENCE_SECONDS}s ` +
    `utterance at the same moment`);
  const latencies = [];
  for (let n = 1; n <= speakerCount; n++) {
    const started = Date.now();
    const waits = [];
    await Promise.all(
      Array.from({ length: n }, () =>
        queue.final(() => engine.transcribe(clip)).then(() => waits.push(Date.now() - started))
      )
    );
    const worst = Math.max(...waits);
    latencies.push({ n, worst });
    const verdict = worst <= 1500 ? 'ok' : worst <= 3000 ? 'noticeable' : 'too slow';
    console.log(`    ${pad(n, 2)} speaker(s): worst caption waits ${pad(worst, 5)} ms  (${verdict})`);
  }

  // Everyone finishing at once is the worst case, not the common one — in a real
  // call people mostly take turns. Quoting the worst case keeps the advice on the
  // conservative side, which is the right direction for it to be wrong in.
  const comfortable = latencies.filter((l) => l.worst <= 1500).length || 1;
  console.log(`\n  Suggested limit      : ~${comfortable} speaker(s) ` +
    `(worst case, every caption under 1.5s)`);

  const peak = stopWatching();
  console.log(`  peak RSS             : ${peak.toFixed(0)} MB (high-water mark)`);

  engine.close();
  return {
    loadMs,
    ramMB: peak,
    modelMB: afterModel - baseline,
    rtf: perSecond,
    // The single-speaker row of the latency table: how long one caption takes on
    // the standard 4-second utterance. Comparable across models, which the mean
    // over whatever the sample file happened to split into is not.
    utteranceMs: latencies[0].worst,
    maxSpeakers: comfortable,
  };
}

// --------------------------------------------------------------------- main --

/** How a child reports its numbers back to the parent, after its own output. */
const SUMMARY_PREFIX = 'BENCH-SUMMARY ';

/**
 * Run every installed model, one child process each, and collect the summaries.
 * Isolation is not optional here — see the note at the top of the file.
 */
function benchAllIsolated() {
  const models = listModels();
  if (!models.length) {
    console.error('No speech models installed. Run "npm run setup" first.');
    process.exit(1);
  }

  const passthrough = process.argv
    .slice(2)
    .filter((a) => a !== '--all' && !a.startsWith('--model='));
  const summary = [];

  for (const model of models) {
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        ['--expose-gc', __filename, `--model=${model.key || model.name}`, ...passthrough],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
      );
    } catch (err) {
      output = `${err.stdout || ''}${err.stderr || ''}`;
    }

    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith(SUMMARY_PREFIX)) {
        try {
          summary.push(JSON.parse(line.slice(SUMMARY_PREFIX.length)));
        } catch {
          /* a child that died mid-run has nothing to add */
        }
      } else if (line.trim()) {
        console.log(line);
      }
    }
  }

  if (summary.length) {
    console.log(`\n${'='.repeat(72)}\nSummary (each model measured in its own process)`);
    for (const s of summary) {
      console.log(
        `  ${s.model.padEnd(20)} RSS ${pad(s.ramMB.toFixed(0), 5)} MB   ` +
          `load ${pad(s.loadMs, 6)} ms   CPU ${s.rtf.toFixed(3)}x/s` +
          (s.utteranceMs ? `   ${pad(s.utteranceMs, 5)} ms/caption` : '') +
          (s.perSpeakerMB ? `   +${s.perSpeakerMB.toFixed(0)} MB/speaker` : '') +
          (s.maxSpeakers ? `   suggested ${s.maxSpeakers}` : '')
      );
    }
  }
  console.log();
}

async function main() {
  if (flag('all')) return benchAllIsolated();

  const wav = arg('wav');
  const audio = wav ? loadWav(wav) : makeSynthetic(8);

  let models;
  if (arg('model')) {
    const key = arg('model');
    const hit = listModels().find((m) => m.key === key || m.name === key);
    if (!hit) {
      console.error(`"${key}" is not installed. Installed: ` +
        (listModels().map((m) => m.key || m.name).join(', ') || '(none)'));
      process.exit(1);
    }
    models = [hit];
  } else models = [resolveModel()];

  console.log('ChatterLayer benchmark');
  console.log('======================');
  console.log(`node     : ${process.version}  ${process.platform}-${process.arch}`);
  console.log(`cpu      : ${os.cpus().length} logical cores` +
    (os.cpus()[0] ? ` (${os.cpus()[0].model.trim()})` : ''));
  console.log(`audio    : ${wav ? `${wav} (real speech)` : 'synthetic noise — CPU numbers understate'}`);
  console.log(`speakers : up to ${speakerCount}`);
  if (!global.gc) console.log('note     : run with --expose-gc for accurate memory deltas');

  for (const model of models) {
    const info = describeEngine(model.engine);
    console.log(`\n${'-'.repeat(72)}\n${model.label}\n  engine: ${model.engine}` +
      ` (${info.streaming ? 'streaming' : 'segmented'})`);
    try {
      const result = info.streaming
        ? await benchStreaming(model, audio)
        : await benchSegmented(model, audio);
      console.log(
        SUMMARY_PREFIX +
          JSON.stringify({ model: model.label.split(' — ')[0], ...result })
      );
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
