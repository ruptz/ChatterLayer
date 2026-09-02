'use strict';
/**
 * Serves the OBS overlay page and hosts the WebSocket feed it consumes. Sharing
 * one port lets the overlay derive its socket URL from its own location, so
 * there is nothing to configure in OBS beyond the URL.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { WEB_DIR } = require('../shared/paths');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Friendly aliases so streamers can type short URLs. */
const ROUTES = {
  '/': 'overlay.html',
  '/overlay': 'overlay.html',
  '/overlay.html': 'overlay.html',
};

/** Query parameter carrying the access key. Short — this goes in an OBS field. */
const KEY_PARAM = 'k';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Did this request arrive over the tunnel rather than from this machine?
 *
 * The tunnel connects to 127.0.0.1 like OBS does, so the socket's remote address
 * cannot tell them apart. The Host header can: a local browser source asks for
 * `127.0.0.1:8777`, while a tunnelled request carries the public hostname.
 * Cloudflare's own `cf-ray`/`cf-connecting-ip` headers are a second, independent
 * tell — either one alone is enough to treat the request as remote.
 */
function isLocalRequest(req) {
  if (req.headers['cf-ray'] || req.headers['cf-connecting-ip']) return false;
  const host = String(req.headers.host || '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

/** A fresh access key: 128 bits, URL-safe, ~22 characters. */
function newAccessKey() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Failed-attempt throttling.
 *
 * Not a brute-force defence — 128 bits of key makes guessing hopeless on its
 * own arithmetic. This exists so an automated scanner cannot burn a streamer's
 * CPU and sockets mid-broadcast, which is the realistic abuse.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_FAILURES = 20;

/**
 * Ceiling on simultaneous *remote* viewers. Far above any real co-stream, and
 * the host's own OBS is never counted against it, so flooding the tunnel cannot
 * lock someone out of their own overlay.
 */
const MAX_REMOTE_CLIENTS = 16;

/**
 * Nothing a client sends is ever read (the feed is strictly one-directional),
 * so any sizeable frame is abuse. Capped low so it is rejected by the protocol
 * layer rather than buffered.
 */
const MAX_PAYLOAD_BYTES = 1024;

/** Constant-time compare that tolerates unequal lengths. */
function keyMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so hash both to a fixed width
  // first — that keeps the comparison constant-time for wrong-length guesses too.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class CaptionServer {
  constructor() {
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this.settings = { overlay: {} };
    /**
     * Access key for remote viewers. Only enforced while sharing is live —
     * see `setAccess`. Local OBS never needs it.
     */
    this.accessToken = '';
    this.requireToken = false;
    /** clientKey -> {count, resetAt} for failed authorisations. */
    this.failures = new Map();
    this.maxRemoteClients = MAX_REMOTE_CLIENTS;
  }

  /**
   * Who a failed attempt is attributed to.
   *
   * Behind the tunnel every request arrives from 127.0.0.1, so the socket's own
   * address distinguishes nobody. Cloudflare stamps `cf-connecting-ip` at its
   * edge and overwrites whatever the client sent, so it is the only identity
   * here a remote caller cannot choose for itself.
   */
  clientKey(req) {
    return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
  }

  throttled(req) {
    const rec = this.failures.get(this.clientKey(req));
    if (!rec || Date.now() >= rec.resetAt) return false;
    return rec.count >= RATE_MAX_FAILURES;
  }

  noteFailure(req) {
    const now = Date.now();
    // Opportunistic prune: a scan from many addresses must not grow this
    // without bound just by failing.
    if (this.failures.size > 1000) {
      for (const [id, rec] of this.failures) if (now >= rec.resetAt) this.failures.delete(id);
    }
    const id = this.clientKey(req);
    const rec = this.failures.get(id);
    if (!rec || now >= rec.resetAt) this.failures.set(id, { count: 1, resetAt: now + RATE_WINDOW_MS });
    else rec.count++;
  }

  /** Remote viewers only — the host's own overlay is never rationed. */
  remoteClients() {
    let n = 0;
    for (const ws of this.clients) if (!ws.chatterlayerLocal) n++;
    return n;
  }

  /**
   * Arm or disarm the access gate.
   *
   * Called when remote sharing starts and stops. With sharing off the server is
   * loopback-only and demanding a key would just break existing OBS sources, so
   * the gate is genuinely off rather than merely unused.
   */
  setAccess({ token = '', required = false } = {}) {
    this.accessToken = token || '';
    this.requireToken = Boolean(required && this.accessToken);
    // A new session starts with a clean slate rather than inheriting throttles
    // earned against a key that no longer exists.
    this.failures.clear();
    if (this.requireToken) this.dropUnauthorizedClients();
  }

  /**
   * Boot any remote viewer whose key just stopped being valid.
   *
   * Rotating the key has to cut off whoever held the old one immediately —
   * otherwise "regenerate" would only affect people who hadn't connected yet,
   * which is the opposite of what someone clicking it wants.
   */
  dropUnauthorizedClients() {
    for (const ws of this.clients) {
      if (ws.chatterlayerLocal) continue;
      if (keyMatches(ws.chatterlayerKey, this.accessToken)) continue;
      try {
        ws.close(4401, 'Access key no longer valid');
      } catch {
        /* ignore */
      }
      this.clients.delete(ws);
    }
  }

  /** Is this request allowed through the gate? */
  authorize(req) {
    if (!this.requireToken) return true;
    if (isLocalRequest(req)) return true;
    return keyMatches(this.keyFrom(req), this.accessToken);
  }

  keyFrom(req) {
    try {
      return new URL(req.url || '/', 'http://localhost').searchParams.get(KEY_PARAM) || '';
    } catch {
      return '';
    }
  }

  get port() {
    const addr = this.server && this.server.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  urls(host) {
    const p = this.port;
    if (!p) return { overlay: null };
    const h = host === '0.0.0.0' ? '127.0.0.1' : host;
    return { overlay: `http://${h}:${p}/overlay` };
  }

  /** The link a remote viewer pastes into OBS: public origin plus access key. */
  shareUrl(origin) {
    if (!origin || !this.accessToken) return null;
    return `${origin.replace(/\/+$/, '')}/overlay?${KEY_PARAM}=${encodeURIComponent(
      this.accessToken
    )}`;
  }

  start({ port = 8777, host = '127.0.0.1' } = {}) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttp(req, res));

      // `noServer` rather than handing ws the http server: the upgrade has to
      // pass the same access gate as the page, and that means inspecting the
      // request before the socket is handed over.
      this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
      this.server.on('upgrade', (req, socket, head) => {
        const deny = (code, text) => {
          socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
        };

        if (this.requireToken && this.throttled(req)) return deny(429, 'Too Many Requests');
        if (!this.authorize(req)) {
          this.noteFailure(req);
          return deny(401, 'Unauthorized');
        }

        const local = isLocalRequest(req);
        if (!local && this.remoteClients() >= this.maxRemoteClients) {
          return deny(503, 'Service Unavailable');
        }
        if (this.requireToken) this.failures.delete(this.clientKey(req));

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          // Remembered so a key rotation can identify who to disconnect.
          ws.chatterlayerLocal = local;
          ws.chatterlayerKey = this.keyFrom(req);
          this.wss.emit('connection', ws, req);
        });
      });

      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        // Send current styling so the overlay renders correctly straight away.
        // Deliberately NO caption backlog: OBS reloads the browser source on
        // scene changes, and replaying old speech would put words back on
        // stream seconds after they were said.
        ws.send(JSON.stringify({ type: 'hello', settings: this.settings }));
        // Note the absence of a 'message' handler: the caption feed is strictly
        // one-directional. A connected overlay is a viewer, never a controller,
        // and nothing it sends can reach the engine, the config or the stream.
        // Anything that changes that turns a read-only link into a control
        // channel handed out to co-streamers — don't.
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => this.clients.delete(ws));
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Port ${port} is already in use. Pick a different port in ChatterLayer's settings.`
            )
          );
        } else {
          reject(err);
        }
      });

      this.server.listen(port, host, () => resolve(this.urls(host)));
    });
  }

  handleHttp(req, res) {
    if (this.requireToken && this.throttled(req)) {
      res.writeHead(429, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': String(RATE_WINDOW_MS / 1000),
      });
      res.end('429 — too many failed attempts. Try again shortly.');
      return;
    }

    if (!this.authorize(req)) {
      this.noteFailure(req);
      // Deliberately plain and non-specific: this page is reachable by anyone
      // who guesses the tunnel hostname, and it should confirm nothing about
      // who is streaming or whether a key was close.
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('401 — this ChatterLayer overlay link needs a valid access key.');
      return;
    }
    // A correct key clears the slate, so one fat-fingered paste doesn't leave
    // a co-streamer throttled for the next minute.
    if (this.requireToken) this.failures.delete(this.clientKey(req));

    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filename = ROUTES[urlPath] || urlPath.replace(/^\/+/, '');

    // Resolve inside WEB_DIR and reject anything that escapes it. Compared with
    // a trailing separator so a *sibling* directory ("web-old") can't satisfy a
    // bare prefix test and slip through.
    const root = path.resolve(WEB_DIR);
    const filePath = path.resolve(root, filename);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        // Overlay pages are reloaded constantly while tweaking; never cache.
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  }

  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  sendCaption(caption) {
    this.broadcast({ type: 'caption', ...caption });
  }

  /** Push styling changes live — no OBS refresh needed. */
  updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    this.broadcast({ type: 'settings', settings: this.settings });
  }

  clearCaptions() {
    this.broadcast({ type: 'clear' });
  }

  async stop() {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.wss) this.wss.close();
    if (this.server) {
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
  }
}

module.exports = { CaptionServer, KEY_PARAM, newAccessKey };
