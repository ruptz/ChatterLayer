'use strict';
/**
 * Optional Cloudflare Quick Tunnel in front of the caption server, so a group
 * of streamers can share one host's captions instead of each running their own
 * bot, model and CPU load.
 *
 * Three things are deliberate here:
 *
 *   - Nothing starts on its own. The tunnel is spawned only by an explicit
 *     Start, never on launch, never as a side effect of the toggle. ChatterLayer
 *     is offline-by-default software and turning that inside out silently would
 *     be a betrayal of the reason people install it.
 *   - The binary is fetched on demand, not bundled. It is ~35 MB and most users
 *     stream alone and will never want it.
 *   - Quick Tunnels need no Cloudflare account and no domain. The cost is that
 *     the hostname is random and changes every run — see README.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');

const { download } = require('../shared/models');

/** cloudflared prints the assigned hostname to stderr in a banner. */
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** How long to wait for that banner before giving up and killing the child. */
const READY_TIMEOUT_MS = 45_000;

const RELEASE_BASE =
  'https://github.com/cloudflare/cloudflared/releases/latest/download';

/**
 * Which release asset this machine needs.
 *
 * Windows on ARM gets the amd64 build: Cloudflare publishes no windows/arm64
 * binary, and it runs fine under Windows' x64 emulation.
 */
function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    const name = arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
    return { name, archive: null };
  }
  if (platform === 'darwin') {
    const name =
      arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
    return { name, archive: 'tgz' };
  }
  if (platform === 'linux') {
    const suffix = { arm64: 'arm64', arm: 'arm', ia32: '386' }[arch] || 'amd64';
    return { name: `cloudflared-linux-${suffix}`, archive: null };
  }
  return null;
}

/**
 * Pull a single file out of a gzipped tar (macOS assets ship as .tgz).
 *
 * Written out rather than pulled in as a dependency: tar's format is 512-byte
 * headers with an octal size field, the archive contains exactly one file we
 * want, and adding a package to unpack one binary on one platform is a poor
 * trade.
 */
function extractFromTgz(tgzPath, wantedName, dest) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header[0] === 0) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8);
    const typeflag = String.fromCharCode(header[156]);
    offset += 512;

    if (!Number.isFinite(size)) throw new Error('Malformed cloudflared archive.');

    // '0' and '\0' are both "regular file" in the wild.
    if ((typeflag === '0' || typeflag === '\0') && path.basename(name) === wantedName) {
      fs.writeFileSync(dest, buf.subarray(offset, offset + size));
      return true;
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return false;
}

class Tunnel extends EventEmitter {
  /** @param {string} binDir writable directory for the managed binary */
  constructor(binDir) {
    super();
    this.binDir = binDir;
    this.child = null;
    this.url = '';
    this.starting = false;
    /** Set while `stop()` is tearing down, so the exit isn't reported as a crash. */
    this.stopping = false;
  }

  get running() {
    return Boolean(this.child) || this.starting;
  }

  /** Where a ChatterLayer-managed cloudflared lives. */
  managedPath() {
    return path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  /**
   * An existing cloudflared on PATH wins over downloading our own — plenty of
   * people already have it from Homebrew or winget, and a second copy would be
   * 35 MB of duplication we then have to keep current.
   */
  systemPath() {
    try {
      const probe = spawnSync('cloudflared', ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      if (!probe.error && probe.status === 0) return 'cloudflared';
    } catch {
      /* not installed */
    }
    return null;
  }

  /** The binary to run, or null if neither a system nor a managed copy exists. */
  resolveBinary() {
    const managed = this.managedPath();
    if (fs.existsSync(managed)) return managed;
    return this.systemPath();
  }

  /** Download cloudflared into `binDir`, reporting progress. Idempotent. */
  async install() {
    const existing = this.resolveBinary();
    if (existing) return existing;

    const asset = assetFor();
    if (!asset) {
      throw new Error(
        `No cloudflared build for ${process.platform}/${process.arch}. ` +
          'Install cloudflared manually and it will be picked up from PATH.'
      );
    }

    fs.mkdirSync(this.binDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatterlayer-cfd-'));
    const staged = path.join(tmpDir, asset.name);
    const target = this.managedPath();

    try {
      this.emit('status', { phase: 'download', received: 0, total: 0 });
      await download(`${RELEASE_BASE}/${asset.name}`, staged, (p) =>
        this.emit('status', { phase: 'download', received: p.received, total: p.total })
      );

      this.emit('status', { phase: 'install' });
      if (asset.archive === 'tgz') {
        if (!extractFromTgz(staged, 'cloudflared', target)) {
          throw new Error('cloudflared was not found inside the downloaded archive.');
        }
      } else {
        fs.copyFileSync(staged, target);
      }
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    return target;
  }

  /**
   * Spawn the tunnel and resolve with its public https URL.
   *
   * @param {{port: number}} opts
   * @returns {Promise<string>}
   */
  async start({ port }) {
    if (this.running) throw new Error('The tunnel is already running.');

    this.starting = true;
    this.stopping = false;
    this.url = '';

    let bin;
    try {
      bin = await this.install();
      this.emit('status', { phase: 'starting' });
    } catch (err) {
      this.starting = false;
      throw err;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let banner = '';

      const child = spawn(
        bin,
        [
          'tunnel',
          // Quick Tunnel: no account, no domain, random hostname.
          '--url',
          `http://127.0.0.1:${port}`,
          // Never let cloudflared replace its own binary underneath us.
          '--no-autoupdate',
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      this.child = child;

      const finish = (err, url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.starting = false;
        if (err) {
          this.child = null;
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          reject(err);
        } else {
          resolve(url);
        }
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            'cloudflared did not produce a tunnel URL in time. Check your ' +
              'network connection or firewall and try again.'
          )
        );
      }, READY_TIMEOUT_MS);

      const scan = (chunk) => {
        const text = chunk.toString();
        // Keep a little context so a failure has something to report.
        banner = (banner + text).slice(-2000);
        const match = text.match(URL_RE) || banner.match(URL_RE);
        if (match && !this.url) {
          this.url = match[0];
          this.emit('ready', { url: this.url });
          finish(null, this.url);
        }
      };

      // cloudflared writes its banner to stderr; read both to be safe.
      child.stdout.on('data', scan);
      child.stderr.on('data', scan);

      child.on('error', (err) => {
        finish(new Error(`Could not run cloudflared: ${err.message}`));
      });

      child.on('exit', (code) => {
        this.child = null;
        const wasReady = Boolean(this.url);
        this.url = '';
        if (!settled) {
          const tail = banner.trim().split('\n').slice(-3).join(' ').slice(0, 300);
          finish(
            new Error(
              `cloudflared exited (code ${code}) before the tunnel came up.` +
                (tail ? ` ${tail}` : '')
            )
          );
          return;
        }
        // An exit after we were live is a real drop, not a start failure.
        if (wasReady && !this.stopping) {
          this.emit('dropped', { code });
        }
        this.emit('stopped');
      });
    });
  }

  async stop() {
    const child = this.child;
    this.stopping = true;
    this.starting = false;
    this.url = '';
    if (!child) return;

    await new Promise((resolve) => {
      const done = setTimeout(() => {
        // Refused to go quietly.
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 3000);

      child.once('exit', () => {
        clearTimeout(done);
        resolve();
      });

      try {
        child.kill();
      } catch {
        clearTimeout(done);
        resolve();
      }
    });

    this.child = null;
    this.stopping = false;
  }
}

module.exports = { Tunnel, assetFor };
