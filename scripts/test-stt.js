'use strict';
/**
 * Transcribes a WAV with an installed model, whichever engine it uses. The
 * end-to-end check that a model on disk actually produces text.
 *
 *   node scripts/test-stt.js                              # best installed model
 *   node scripts/test-stt.js --model=whisper-base         # a specific one
 *   node scripts/test-stt.js --all                        # every installed model
 *   node scripts/test-stt.js --wav=path/to/16k-mono.wav
 *   node scripts/test-stt.js --expect="and so my fellow"  # fail unless it matches
 *
 * Streaming and segmented engines are driven the same way a live call drives
 * them: 20 ms chunks through the real worker protocol, so this exercises the
 * segmenter and the queue rather than just the model.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

const { listModels, resolveModel } = require('../src/shared/paths');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** Minimal RIFF/WAVE parser: returns { sampleRate, channels, bits, data }. */
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('WAV missing fmt or data chunk');
  return { ...fmt, data };
}

/**
 * Run one model through the real worker, feeding audio at 20 ms granularity.
 *
 * Deliberately not paced in real time — that would make the run as long as the
 * audio for no benefit. The consequence is that a segmented engine sees the whole
 * clip arrive at once, so its `flush` is what closes the utterance rather than
 * detected silence, which is the same path Discord's `speaking end` takes.
 */
function transcribe(model, pcm) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '..', 'src', 'engine', 'stt-worker.js'), {
      workerData: { model },
    });

    const finals = [];
    let partials = 0;
    let loadMs = 0;
    let decodeStart = 0;
    let settled = false;
    let poll = null;
    let lastActivity = Date.now();
    const userId = 'test-speaker';

    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      worker.terminate();
      if (err) reject(err);
      else {
        resolve({
          text: finals.join(' ').replace(/\s+/g, ' ').trim(),
          partials,
          loadMs,
          decodeMs: Date.now() - decodeStart,
        });
      }
    };

    const timer = setTimeout(() => done(new Error('timed out after 300s')), 300_000);

    worker.on('error', (err) => done(err));

    worker.on('message', (msg) => {
      switch (msg.type) {
        case 'ready': {
          loadMs = msg.loadMs;
          console.log(
            `  engine  : ${msg.engine} (${msg.streaming ? 'streaming' : 'segmented'})` +
              `  loaded in ${msg.loadMs} ms, RSS ${(msg.rss / 1048576).toFixed(0)} MB`
          );
          decodeStart = Date.now();
          worker.postMessage({ type: 'add', userId });

          // 640 bytes = one 20 ms frame of 16 kHz mono 16-bit PCM.
          for (let i = 0; i < pcm.length; i += 640) {
            const chunk = pcm.subarray(i, Math.min(i + 640, pcm.length));
            const ab = chunk.buffer.slice(
              chunk.byteOffset,
              chunk.byteOffset + chunk.byteLength
            );
            worker.postMessage({ type: 'audio', userId, buf: ab }, [ab]);
          }
          worker.postMessage({ type: 'flush', userId });
          // A segmented engine answers asynchronously, so ask it how much work is
          // outstanding until there is none and nothing new has arrived.
          poll = setInterval(() => worker.postMessage({ type: 'stats' }), 100);
          return;
        }
        case 'partial':
          partials++;
          lastActivity = Date.now();
          return;
        case 'final':
          finals.push(msg.text);
          lastActivity = Date.now();
          return;
        case 'stats':
          if (msg.queued === 0 && Date.now() - lastActivity > 400) done(null);
          return;
        case 'fatal':
          return done(new Error(msg.message));
        case 'error':
          console.error(`  error   : ${msg.message}`);
          return;
        default:
          return;
      }
    });
  });
}

/** Poll `stats` until the queue drains, then collect. */
async function run(model, pcm) {
  console.log(`\n${model.label}`);
  console.log(`  path    : ${model.path}`);
  const result = await transcribe(model, pcm);
  const seconds = pcm.length / 2 / 16000;
  console.log(
    `  decoded : ${result.decodeMs} ms for ${seconds.toFixed(1)}s of audio ` +
      `(${(result.decodeMs / (seconds * 1000)).toFixed(2)}x realtime), ` +
      `${result.partials} partial${result.partials === 1 ? '' : 's'}`
  );
  console.log(`  TEXT    : ${result.text || '(empty)'}`);
  return result;
}

async function main() {
  const wavPath = arg('wav') || path.join(__dirname, '..', 'test-audio.wav');
  if (!fs.existsSync(wavPath)) {
    console.error(`No test WAV at ${wavPath}. Pass one with --wav=<file>.`);
    process.exit(1);
  }

  const wav = parseWav(fs.readFileSync(wavPath));
  if (wav.sampleRate !== 16000 || wav.channels !== 1 || wav.bits !== 16) {
    console.error(
      `Expected 16 kHz mono 16-bit PCM, got ${wav.sampleRate} Hz / ` +
        `${wav.channels} ch / ${wav.bits}-bit.`
    );
    process.exit(1);
  }

  const requested = arg('model');
  let models;
  if (flag('all')) {
    models = listModels();
  } else if (requested) {
    const hit = listModels().find((m) => m.key === requested || m.name === requested);
    if (!hit) {
      console.error(
        `"${requested}" is not installed. Installed: ` +
          (listModels().map((m) => m.key || m.name).join(', ') || '(none)')
      );
      process.exit(1);
    }
    models = [hit];
  } else {
    models = [resolveModel()];
  }

  if (!models.length) {
    console.error('No speech models installed. Run "npm run setup" first.');
    process.exit(1);
  }

  console.log('ChatterLayer speech engine test');
  console.log('===============================');
  console.log(`wav     : ${wavPath} (${(wav.data.length / 2 / 16000).toFixed(2)}s)`);
  console.log(`node    : ${process.version}  ${process.platform}-${process.arch}  ` +
    `${os.cpus().length} logical cores`);

  const expect = arg('expect');
  let failures = 0;

  for (const model of models) {
    try {
      const result = await run(model, wav.data);
      if (!result.text) {
        console.error('  FAIL    : produced no text.');
        failures++;
      } else if (expect && !result.text.toLowerCase().includes(expect.toLowerCase())) {
        console.error(`  FAIL    : expected to contain "${expect}".`);
        failures++;
      }
    } catch (err) {
      console.error(`  FAIL    : ${err.message}`);
      failures++;
    }
  }

  console.log(`\n${models.length - failures}/${models.length} models transcribed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
