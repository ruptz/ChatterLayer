'use strict';
/**
 * Fetches the two native libraries the app loads at runtime: libvosk for the
 * Vosk models, and ONNX Runtime for Whisper, Moonshine and Parakeet. Both ship
 * inside every build; speech models never do — the app downloads the one
 * someone picks.
 *
 *   node scripts/fetch-runtimes.js               # for this machine
 *   node scripts/fetch-runtimes.js darwin-x64    # for a cross-build
 *
 * Each archive is pinned to a version and a SHA-256 checked before anything is
 * unpacked, so a swapped upstream file fails here instead of shipping. The ONNX
 * Runtime hashes match the digests GitHub publishes for that release. Vosk's
 * releases predate those, so its hashes were taken from real downloads and the
 * library inside each was matched byte for byte against the one in Vosk's PyPI
 * wheel, whose hash PyPI publishes. Moving to a newer version means updating
 * the URL and the hash together.
 *
 * The libraries this platform needs are then copied into vendor/runtime/vosk/
 * and vendor/runtime/onnxruntime/, the layout every build bundles. Copying
 * follows symlinks, so the Linux and macOS libraries, which upstream ships as a
 * chain of links, arrive as one real file under the name the app opens.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const VENDOR = path.join(__dirname, '..', 'vendor');
const RUNTIME = path.join(VENDOR, 'runtime');

const VOSK = 'https://github.com/alphacep/vosk-api/releases/download';
const ORT = 'https://github.com/microsoft/onnxruntime/releases/download/v1.23.0';

/** `keep` picks the files that go into vendor/runtime/<to>/. */
const vosk = (file, sha256, keep) => ({ name: 'libvosk', url: `${VOSK}/${file}`, sha256, to: 'vosk', keep });
const ort = (file, sha256, lib) => ({
  name: 'ONNX Runtime 1.23.0',
  url: `${ORT}/${file}`,
  sha256,
  to: 'onnxruntime',
  keep: (name) => name === lib,
});

const RUNTIMES = {
  'win32-x64': [
    // libvosk's MinGW runtime DLLs sit beside it and have to ship with it.
    vosk('v0.3.45/vosk-win64-0.3.45.zip', 'f1dcc9cca460630f81ea8f71794f69c80bed6556d2a4e6237b5785e1d2dff34b', (n) => n.endsWith('.dll')),
    ort('onnxruntime-win-x64-1.23.0.zip', '72c23470310ec79a7d42d27fe9d257e6c98540c73fa5a1db1f67f538c6c16f2f', 'onnxruntime.dll'),
  ],
  'linux-x64': [
    vosk('v0.3.45/vosk-linux-x86_64-0.3.45.zip', 'bbdc8ed85c43979f6443142889770ea95cbfbc56cffb5c5dcd73afa875c5fbb2', (n) => n === 'libvosk.so'),
    ort('onnxruntime-linux-x64-1.23.0.tgz', 'b6deea7f2e22c10c043019f294a0ea4d2a6c0ae52a009c34847640db75ec5580', 'libonnxruntime.so'),
  ],
  'linux-arm64': [
    vosk('v0.3.45/vosk-linux-aarch64-0.3.45.zip', '45e95d37755deb07568e79497d7feba8c03aee5a9e071df29961aa023fd94541', (n) => n === 'libvosk.so'),
    ort('onnxruntime-linux-aarch64-1.23.0.tgz', '0b9f47d140411d938e47915824d8daaa424df95a88b5f1fc843172a75168f7a0', 'libonnxruntime.so'),
  ],
  // The last macOS libvosk is 0.3.42, a universal binary, so both Macs share it.
  'darwin-arm64': [
    vosk('v0.3.42/vosk-osx-0.3.42.zip', '65395f196c9d0583d79949142b25560acaf9c295f36284e18433097f3adb0ea1', (n) => n === 'libvosk.dylib'),
    ort('onnxruntime-osx-arm64-1.23.0.tgz', '8182db0ebb5caa21036a3c78178f17fabb98a7916bdab454467c8f4cf34bcfdf', 'libonnxruntime.dylib'),
  ],
  'darwin-x64': [
    vosk('v0.3.42/vosk-osx-0.3.42.zip', '65395f196c9d0583d79949142b25560acaf9c295f36284e18433097f3adb0ea1', (n) => n === 'libvosk.dylib'),
    ort('onnxruntime-osx-x86_64-1.23.0.tgz', 'a8e43edcaa349cbfc51578a7fc61ea2b88793ccf077b4bc65aca58999d20cf0f', 'libonnxruntime.dylib'),
  ],
};

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'ChatterLayer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('Download timed out')));
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Every file under `dir`, recursively, symlinks included. */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

function unpack(archive, into) {
  // Windows' own tar unpacks zips and tarballs alike. Named by full path:
  // under Git Bash, plain `tar` is GNU tar, which reads "C:" as a remote host.
  // Elsewhere, unzip for zips (macOS tar copes, many Linux tars don't).
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', archive, '-C', into], { stdio: 'inherit' });
  } else if (archive.endsWith('.zip')) {
    execFileSync('unzip', ['-q', '-o', archive, '-d', into], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', into], { stdio: 'inherit' });
  }
}

async function fetchOne(rt) {
  const out = path.join(RUNTIME, rt.to);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatterlayer-rt-'));
  try {
    const archive = path.join(tmp, path.basename(rt.url));
    console.log(`${rt.name}: downloading ${path.basename(rt.url)}`);
    await download(rt.url, archive);
    const got = sha256(archive);
    if (got !== rt.sha256) {
      throw new Error(
        `${rt.name} failed its checksum (expected ${rt.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…). Nothing was unpacked.`
      );
    }
    const unpacked = path.join(tmp, 'x');
    fs.mkdirSync(unpacked);
    unpack(archive, unpacked);
    const files = walk(unpacked).filter((f) => rt.keep(path.basename(f)));
    if (!files.length) throw new Error(`${rt.name} unpacked, but the library isn't in it.`);
    fs.mkdirSync(out, { recursive: true });
    for (const f of files) fs.copyFileSync(f, path.join(out, path.basename(f)));
    console.log(`${rt.name}: ${files.map((f) => path.basename(f)).join(', ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const key = process.argv[2] || `${process.platform}-${process.arch}`;
  const wanted = RUNTIMES[key];
  if (!wanted) {
    console.error(`No runtimes are pinned for ${key}. Pinned: ${Object.keys(RUNTIMES).join(', ')}.`);
    process.exit(1);
  }
  for (const rt of wanted) {
    const out = path.join(RUNTIME, rt.to);
    if (fs.existsSync(out) && fs.readdirSync(out).some((n) => rt.keep(n))) {
      console.log(`${rt.name}: already in vendor/runtime/${rt.to}/`);
      continue;
    }
    await fetchOne(rt);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
