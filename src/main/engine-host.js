'use strict';
/**
 * Owns the engine child process and relays its JSON messages.
 *
 * Spawned with ELECTRON_RUN_AS_NODE, which runs the Electron binary as plain
 * Node — so an installed build needs no separate Node runtime.
 *
 * The engine loads native code (libvosk, onnxruntime) that can take the whole
 * process down with it. When that happens mid-stream nobody is watching the
 * window, so the host brings it back by itself: respawn, sign in, rejoin the
 * call, and switch the same people back on — a few times, with backoff, before
 * it gives up and says so.
 */

const path = require('path');
const { fork } = require('child_process');
const { EventEmitter } = require('events');

const ENGINE_PATH = path.join(__dirname, '..', 'engine', 'engine.js');

/**
 * Wait before each restart attempt. A crash that repeats immediately is
 * probably a bad model or driver, and hammering it helps nobody; one that
 * happens once an hour should come back almost at once.
 */
const RESTART_DELAYS_MS = [1000, 3000, 10_000, 30_000, 60_000];

/** Up this long after a restart, and the next crash starts a fresh budget. */
const HEALTHY_MS = 120_000;

class EngineHost extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {typeof fork} [o.fork]           only the selftest swaps this
   * @param {number[]} [o.restartDelays]
   */
  constructor({ fork: forkImpl = fork, restartDelays = RESTART_DELAYS_MS } = {}) {
    super();
    this.fork = forkImpl;
    this.restartDelays = restartDelays;
    this.child = null;
    /** In a voice channel (or on the way there), so a model is loaded. */
    this.running = false;
    /** Logged in to Discord. Survives Disconnect — the pickers depend on it. */
    this.signedIn = false;
    /** The call to rejoin after a crash. Cleared by Disconnect. */
    this.lastStart = null;
    this.selected = [];
    /** Whose channel moves the bot follows, or null. */
    this.follow = null;
    /** Mic gate sliders, re-sent after a restart. */
    this.micGate = null;
    /** The streamer's own Discord id, or null. */
    this.me = null;
    /** The token of the live session, so a restart can sign straight back in. */
    this.token = null;
    /** Set by shutdown(), so a deliberate exit is never "recovered". */
    this.shuttingDown = false;
    this.restarts = 0;
    this.restartTimer = null;
    this.healthyTimer = null;
  }

  spawn() {
    if (this.child) return this.child;

    const child = this.fork(ENGINE_PATH, [], {
      // Run Electron's bundled Node instead of requiring a system Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;

    // Surface engine stdout/stderr as log events rather than losing them.
    child.stdout.on('data', (d) =>
      this.emit('message', { type: 'log', level: 'info', message: d.toString().trim() })
    );
    child.stderr.on('data', (d) =>
      this.emit('message', { type: 'log', level: 'error', message: d.toString().trim() })
    );

    // Track the sign-in and call state the engine reports, so the host and the
    // UI can't disagree — about whether the pickers have a live session behind
    // them, or about whether a call is up. A failed Connect or a voice drop ends
    // the call from the engine's side; stop() already covers the user's side.
    child.on('message', (msg) => {
      if (msg.type === 'auth') {
        if (msg.state === 'signed-in') this.signedIn = true;
        else if (msg.state === 'error' || msg.state === 'signed-out') this.signedIn = false;
      }
      if (msg.type === 'status' && (msg.state === 'error' || msg.state === 'disconnected')) {
        this.running = false;
      }
      // A mod moving the bot changes which channel "the call" is. A restart
      // should come back to where it actually was.
      if (msg.type === 'status' && msg.state === 'joined' && msg.channelId && this.lastStart) {
        this.lastStart = { ...this.lastStart, channelId: msg.channelId };
      }
      if (this.restarts && this.isRecovered(msg)) this.markHealthy();
      this.emit('message', msg);
    });

    child.on('exit', (code, signal) => this.onExit(child, code ?? signal));

    child.on('error', (err) =>
      this.emit('message', { type: 'status', state: 'error', message: err.message })
    );

    return child;
  }

  /** Back where it was before the crash: in the call, or at least signed in. */
  isRecovered(msg) {
    if (this.lastStart) return msg.type === 'status' && msg.state === 'joined';
    return msg.type === 'auth' && msg.state === 'signed-in';
  }

  markHealthy() {
    clearTimeout(this.healthyTimer);
    this.healthyTimer = setTimeout(() => {
      this.restarts = 0;
    }, HEALTHY_MS);
    this.healthyTimer.unref?.();
  }

  onExit(child, code) {
    if (child !== this.child) return;
    this.child = null;
    const wasRunning = this.running;
    const wasSignedIn = this.signedIn;
    this.running = false;
    this.signedIn = false;
    if (this.shuttingDown || (!wasRunning && !wasSignedIn)) return;

    // A mic-only session has no token, and needs none to come back.
    const resumable = this.token || (wasRunning && this.lastStart);
    if (resumable && this.restarts < this.restartDelays.length) {
      this.scheduleRestart(code, wasRunning);
      return;
    }

    if (wasRunning) {
      this.emit('message', {
        type: 'status',
        state: 'error',
        message: `Engine stopped unexpectedly (code ${code}). Press Connect to retry.`,
      });
    } else {
      // Signed in but idle — losing the session only costs the pickers, so
      // say so quietly rather than throwing the app into a fault state.
      this.emit('message', {
        type: 'auth',
        state: 'error',
        message: `Discord session ended (code ${code}). Sign in again to refresh the channel list.`,
      });
    }
  }

  scheduleRestart(code, resumeCall) {
    const attempt = ++this.restarts;
    const total = this.restartDelays.length;
    clearTimeout(this.healthyTimer);
    this.emit('message', {
      type: 'log',
      level: 'warn',
      message:
        `The engine stopped unexpectedly (code ${code}) — restarting ` +
        `(attempt ${attempt}/${total})…`,
    });
    if (resumeCall) {
      // Linking, not Fault: it is on its way back.
      this.emit('message', {
        type: 'status',
        state: 'connecting',
        message: 'Restarting the engine…',
      });
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // Someone pressed Connect or Quit in the meantime; theirs wins.
      if (this.shuttingDown || this.child) return;
      if (this.token) this.signIn(this.token);
      // Disconnect clears lastStart, so a call the user ended stays ended.
      if (resumeCall && this.lastStart) {
        this.start(this.lastStart);
        this.setSelected(this.selected);
        if (this.follow) this.setFollow(this.follow);
      }
    }, this.restartDelays[attempt - 1]);
    this.restartTimer.unref?.();
  }

  /**
   * Log in without joining anything, so the channel pickers can populate.
   * Also the refresh path: signing in with the token already in use just
   * re-publishes the server/channel tree.
   */
  signIn(token) {
    this.token = token;
    this.spawn();
    this.child.send({ type: 'signIn', token });
  }

  async start(opts) {
    if (opts.token) this.token = opts.token;
    this.spawn();
    // A fresh engine (first start, or after a crash) knows no gate settings.
    if (this.micGate) this.child.send({ type: 'setMicGate', ...this.micGate });
    // Nor who the streamer is, which has to land before anyone is switched on.
    if (this.me) this.child.send({ type: 'setMe', userId: this.me });
    this.lastStart = opts;
    this.running = true;
    this.child.send({ type: 'start', ...opts });
  }

  setSelected(userIds) {
    this.selected = userIds;
    if (this.child) this.child.send({ type: 'setSelected', userIds });
  }

  setFollow(userId) {
    this.follow = userId || null;
    if (this.child) this.child.send({ type: 'setFollow', userId: this.follow });
  }

  /** Which Discord member is the streamer — see `meId` in the engine. */
  setMe(userId) {
    this.me = userId || null;
    if (this.child) this.child.send({ type: 'setMe', userId: this.me });
  }

  /** @param {{ sensitivity: number, hangMs: number }} settings */
  setMicGate(settings) {
    this.micGate = settings;
    if (this.child) this.child.send({ type: 'setMicGate', ...settings });
  }

  /** @param {string} pcm 16 kHz mono Int16 PCM, base64 — see ipc `micAudio`. */
  micAudio(pcm) {
    if (this.child && this.running) this.child.send({ type: 'micAudio', pcm });
  }

  requestMembers() {
    if (this.child) this.child.send({ type: 'requestMembers' });
  }

  requestStats() {
    if (this.child) this.child.send({ type: 'stats' });
  }

  async stop() {
    this.running = false;
    this.lastStart = null;
    if (!this.child) return;
    this.child.send({ type: 'stop' });
  }

  async shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.restartTimer);
    this.running = false;
    this.signedIn = false;
    if (!this.child) return;
    const child = this.child;
    child.send({ type: 'shutdown' });
    // Don't let a wedged engine hold up app quit.
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 2500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }
}

module.exports = { EngineHost, RESTART_DELAYS_MS };
