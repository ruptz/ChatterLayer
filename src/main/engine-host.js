'use strict';
/**
 * Owns the engine child process and relays its JSON messages.
 *
 * Spawned with ELECTRON_RUN_AS_NODE, which runs the Electron binary as plain
 * Node — so an installed build needs no separate Node runtime.
 */

const path = require('path');
const { fork } = require('child_process');
const { EventEmitter } = require('events');

const ENGINE_PATH = path.join(__dirname, '..', 'engine', 'engine.js');

class EngineHost extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    /** In a voice channel (or on the way there), so a model is loaded. */
    this.running = false;
    /** Logged in to Discord. Survives Disconnect — the pickers depend on it. */
    this.signedIn = false;
    /** Remembered so we can restore state if the engine has to be restarted. */
    this.lastStart = null;
    this.selected = [];
  }

  spawn() {
    if (this.child) return this.child;

    this.child = fork(ENGINE_PATH, [], {
      // Run Electron's bundled Node instead of requiring a system Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    // Surface engine stdout/stderr as log events rather than losing them.
    this.child.stdout.on('data', (d) =>
      this.emit('message', { type: 'log', level: 'info', message: d.toString().trim() })
    );
    this.child.stderr.on('data', (d) =>
      this.emit('message', { type: 'log', level: 'error', message: d.toString().trim() })
    );

    // Track the sign-in and call state the engine reports, so the host and the
    // UI can't disagree — about whether the pickers have a live session behind
    // them, or about whether a call is up. A failed Connect or a voice drop ends
    // the call from the engine's side; stop() already covers the user's side.
    this.child.on('message', (msg) => {
      if (msg.type === 'auth') {
        if (msg.state === 'signed-in') this.signedIn = true;
        else if (msg.state === 'error' || msg.state === 'signed-out') this.signedIn = false;
      }
      if (msg.type === 'status' && (msg.state === 'error' || msg.state === 'disconnected')) {
        this.running = false;
      }
      this.emit('message', msg);
    });

    this.child.on('exit', (code, signal) => {
      this.child = null;
      const wasRunning = this.running;
      const wasSignedIn = this.signedIn;
      this.running = false;
      this.signedIn = false;
      if (wasRunning) {
        this.emit('message', {
          type: 'status',
          state: 'error',
          message: `Engine stopped unexpectedly (code ${code ?? signal}). Press Connect to retry.`,
        });
      } else if (wasSignedIn) {
        // Signed in but idle — losing the session only costs the pickers, so
        // say so quietly rather than throwing the app into a fault state.
        this.emit('message', {
          type: 'auth',
          state: 'error',
          message: `Discord session ended (code ${code ?? signal}). Sign in again to refresh the channel list.`,
        });
      }
    });

    this.child.on('error', (err) =>
      this.emit('message', { type: 'status', state: 'error', message: err.message })
    );

    return this.child;
  }

  /**
   * Log in without joining anything, so the channel pickers can populate.
   * Also the refresh path: signing in with the token already in use just
   * re-publishes the server/channel tree.
   */
  signIn(token) {
    this.spawn();
    this.child.send({ type: 'signIn', token });
  }

  async start(opts) {
    this.spawn();
    this.lastStart = opts;
    this.running = true;
    this.child.send({ type: 'start', ...opts });
  }

  setSelected(userIds) {
    this.selected = userIds;
    if (this.child) this.child.send({ type: 'setSelected', userIds });
  }

  requestMembers() {
    if (this.child) this.child.send({ type: 'requestMembers' });
  }

  requestStats() {
    if (this.child) this.child.send({ type: 'stats' });
  }

  async stop() {
    this.running = false;
    if (!this.child) return;
    this.child.send({ type: 'stop' });
  }

  async shutdown() {
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

module.exports = { EngineHost };
