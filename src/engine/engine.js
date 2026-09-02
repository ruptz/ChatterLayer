'use strict';
/**
 * Discord bot: receives per-user voice, decodes Opus, resamples to 16 kHz mono
 * and feeds a speech worker thread. Speaks a small JSON protocol over process IPC
 * — see `handleCommand`.
 *
 * Nothing in this file knows which speech engine is loaded. It resolves whichever
 * model is selected, hands the descriptor to the worker, and receives
 * `{ userId, text, isFinal }` back — see src/engine/stt/index.js.
 *
 * Runs as a child process so native modules load against plain Node rather than
 * Electron's ABI, a bot crash can't take the window down, and it can be driven
 * headless (`npm run engine:headless`).
 */

const path = require('path');
const { Worker } = require('worker_threads');
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  Events,
  PermissionsBitField,
} = require('discord.js');
const {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');

const { Resampler48kStereoTo16kMono } = require('./resample');
const { resolveModel } = require('../shared/paths');

/** Discord always sends 48 kHz stereo Opus; 960 samples = 20 ms per frame. */
const OPUS = { rate: 48000, channels: 2, frameSize: 960 };

// Gigaspeech takes ~33s to load and Parakeet has 2.5 GB of weights to read off
// disk, so the model timeout is generous.
const MODEL_LOAD_TIMEOUT_MS = 300_000;
const GATEWAY_READY_TIMEOUT_MS = 30_000;

// A worker that has been ready at least once and then dies is restarted in
// place, up to this many times, before the user is told to reconnect. Mirrors
// the per-speaker audio-stream budget below. A restart that then stays up for
// WORKER_HEALTHY_MS is treated as recovered and the budget resets.
const MAX_WORKER_RESTARTS = 5;
const WORKER_HEALTHY_MS = 30_000;

/**
 * Every await in the start path is bounded. An unbounded one leaves the UI
 * stuck on "Linking" with nothing to tell the user.
 */
function onceWithTimeout(emitter, event, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      fn(arg);
    };
    const onEvent = (value) => done(resolve, value);
    const timer = setTimeout(
      () => done(reject, new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs
    );
    emitter.once(event, onEvent);
  });
}

class ChatterLayerEngine {
  constructor(emit) {
    this.emit = emit;
    this.client = null;
    this.connection = null;
    this.receiver = null;
    this.channel = null;
    this.worker = null;
    /** Raw model-path argument behind the running worker, so a crash can respawn it. */
    this.modelPath = null;
    /** Consecutive in-place worker restarts; reset once a restart stays healthy. */
    this.workerRestarts = 0;
    this.workerHealthTimer = null;
    /** userIds the streamer has toggled ON */
    this.selected = new Set();
    /** userId -> { opusStream, decoder, resampler } */
    this.streams = new Map();
    this.workerReady = false;
    this.stopping = false;
    /** userId -> consecutive stream restarts, so a broken stream can't spin. */
    this.restarts = new Map();
    /** In-flight signIn, so concurrent callers await one login rather than racing. */
    this.signingIn = null;
    /** Token behind the live session, so a changed one forces a real re-login. */
    this.token = null;
    /** What the worker reported about the loaded engine, once it is ready. */
    this.speech = null;
    /** So the "too many speakers for this model" warning is said once, not per toggle. */
    this.warnedSpeakerLimit = false;
  }

  log(level, message) {
    this.emit({ type: 'log', level, message });
  }

  // -------------------------------------------------------------- speech ---

  startWorker(modelPath) {
    return new Promise((resolve, reject) => {
      const model = resolveModel(modelPath);
      // Remembered so handleWorkerDown() can respawn the worker on a later crash.
      this.modelPath = modelPath;
      this.emit({
        type: 'speech',
        state: 'loading',
        modelPath: model.path,
        engine: model.engine,
        label: model.label,
      });

      const worker = new Worker(path.join(__dirname, 'stt-worker.js'), {
        workerData: { model },
      });
      this.worker = worker;

      // Settle exactly once. Without this, a worker that dies during startup
      // (bad model path, missing libvosk) left this promise pending forever and
      // start() simply never returned.
      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        resolve();
      };
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        this.emit({ type: 'speech', state: 'error', message });
        reject(new Error(message));
      };
      // A death before the worker was ever ready rejects start(), as before. One
      // after it was ready is recoverable in place — see handleWorkerDown().
      const lost = (message) => {
        if (!settled) return fail(message);
        this.handleWorkerDown(worker, message);
      };

      const loadTimer = setTimeout(
        () =>
          fail(
            `The speech model at "${model.path}" did not finish loading within ` +
              `${Math.round(MODEL_LOAD_TIMEOUT_MS / 1000)}s. It may be corrupt — ` +
              `remove it in the Speech model panel and download it again.`
          ),
        MODEL_LOAD_TIMEOUT_MS
      );

      worker.on('message', (msg) => {
        switch (msg.type) {
          case 'ready':
            this.workerReady = true;
            this.speech = msg;
            this.warnedSpeakerLimit = false;
            this.emit({ type: 'speech', state: 'ready', ...msg });
            this.checkSpeakerLimit();
            return succeed();
          case 'fatal':
            return lost(msg.message);
          case 'partial':
          case 'final':
            return this.emitCaption(msg);
          case 'partialCleared':
            return this.emit({ type: 'captionCleared', userId: msg.userId });
          case 'stats':
            return this.emit({ type: 'stats', ...msg });
          case 'speakerAdded':
          case 'speakerRemoved':
            return this.emit({ type: 'stats', rss: msg.rss, speakers: this.selected.size });
          case 'error':
            return this.log('warn', `[speech] ${msg.message}`);
          default:
            return undefined;
        }
      });

      worker.on('error', (err) => {
        this.workerReady = false;
        lost(`Speech engine error: ${err.message}`);
      });
      worker.on('exit', (code) => {
        this.workerReady = false;
        // A clean shutdown (code 0) after start() succeeded must not reject or
        // restart anything.
        if (code !== 0) lost(`Speech engine exited unexpectedly (code ${code}).`);
      });
    });
  }

  /**
   * A worker that had been ready has died mid-call. Restart it in place, with a
   * budget, the same way a broken audio stream is rebuilt — a silent blackout is
   * the worst outcome, worse than a visible restart.
   */
  handleWorkerDown(deadWorker, reason) {
    // Anything from a worker we have already replaced, or during teardown, is noise.
    if (this.stopping || !deadWorker || deadWorker !== this.worker || deadWorker.clDown) {
      return;
    }
    deadWorker.clDown = true;
    this.workerReady = false;
    this.worker = null;
    clearTimeout(this.workerHealthTimer);
    try {
      deadWorker.terminate();
    } catch {
      /* already gone */
    }
    this.scheduleWorkerRestart(reason);
  }

  scheduleWorkerRestart(reason) {
    if (this.stopping) return;
    const attempt = this.workerRestarts + 1;
    this.workerRestarts = attempt;

    if (attempt > MAX_WORKER_RESTARTS) {
      this.emit({ type: 'speech', state: 'error', message: reason });
      this.log(
        'error',
        `The speech engine has crashed ${MAX_WORKER_RESTARTS} times (${reason}) — ` +
          `captions have stopped. Disconnect and connect again to restart it.`
      );
      this.emit({
        type: 'status',
        state: 'error',
        message: 'Speech engine stopped — reconnect to restart captions.',
      });
      return;
    }

    this.log(
      'warn',
      `Speech engine stopped (${reason}) — restarting ` +
        `(attempt ${attempt}/${MAX_WORKER_RESTARTS})…`
    );

    this.startWorker(this.modelPath).then(
      () => {
        this.log('info', 'Speech engine restarted.');
        // The fresh worker knows no speakers; re-add everyone currently on.
        for (const userId of this.selected) this.worker.postMessage({ type: 'add', userId });
        // A restart that stays up is treated as recovered, mirroring an audio
        // stream whose packets start flowing again.
        clearTimeout(this.workerHealthTimer);
        this.workerHealthTimer = setTimeout(() => {
          this.workerRestarts = 0;
        }, WORKER_HEALTHY_MS);
        this.workerHealthTimer.unref?.();
      },
      (err) => {
        if (this.worker) {
          try {
            this.worker.terminate();
          } catch {
            /* gone */
          }
          this.worker = null;
        }
        this.workerReady = false;
        this.scheduleWorkerRestart(err.message);
      }
    );
  }

  /** Attach the speaker's display name before handing the caption upstream. */
  emitCaption({ type, userId, text }) {
    const member = this.channel?.members?.get(userId);
    const username =
      member?.displayName || member?.user?.username || this.knownName(userId) || 'Unknown';
    this.emit({
      type: 'caption',
      userId,
      username,
      text,
      isFinal: type === 'final',
      timestamp: Date.now(),
    });
  }

  knownName(userId) {
    return this.client?.users?.cache?.get(userId)?.username || null;
  }

  /**
   * Say something when more people are toggled on than the loaded model can
   * realistically keep up with.
   *
   * Memory is not the constraint — every engine here loads its model once and
   * shares it, so a seventh speaker costs an audio buffer. CPU is, and the way it
   * runs out is captions arriving several seconds after the words. Better to warn
   * than to let someone conclude the app is broken.
   */
  checkSpeakerLimit() {
    const limit = this.speech && this.speech.maxSpeakers;
    if (!limit) return;

    if (this.selected.size <= limit) {
      // Back within budget — re-arm, so a second excursion is worth mentioning
      // again. Without this the warning fires once per connection and someone who
      // toggled people off and on would never hear about it twice.
      this.warnedSpeakerLimit = false;
      return;
    }
    if (this.warnedSpeakerLimit) return;
    this.warnedSpeakerLimit = true;

    // The descriptor label carries the size and the note for the picker
    // ("Whisper Base — 79 MB, good accuracy…"); only the name belongs in a
    // sentence.
    const name =
      (this.speech.modelLabel || '').split(' — ')[0] ||
      this.speech.engineLabel ||
      'this model';
    this.log(
      'warn',
      `${this.selected.size} speakers are on, but ${name} is only comfortable with ` +
        `about ${limit} at once on a typical CPU. Captions may start arriving late — ` +
        `switch to a lighter model or caption fewer people.`
    );
  }

  // ------------------------------------------------------------- Discord ---

  /**
   * Log in and stay logged in, without touching Vosk or joining anything.
   *
   * Split out from start() so the UI can list the bot's servers and voice
   * channels before the user has picked one. Idempotent, and safe to call
   * concurrently — the second caller awaits the first login rather than
   * building a second client.
   */
  async signIn(token) {
    // Already live on this exact token — just re-publish the tree, which makes
    // this double as the Refresh action.
    if (this.client && this.client.isReady() && this.token === token) {
      this.emitGuilds();
      return;
    }
    if (this.signingIn) return this.signingIn;
    this.signingIn = this._signIn(token).finally(() => {
      this.signingIn = null;
    });
    return this.signingIn;
  }

  async _signIn(token) {
    if (!token) throw new Error('No bot token provided.');

    // Reaching here with a live client means the token changed. The old
    // session is the wrong one, so drop it — including any voice connection,
    // which belongs to a bot we're about to stop being.
    if (this.client) {
      await this.leave({ announce: true });
      try {
        await this.client.destroy();
      } catch {
        /* ignore */
      }
      this.client = null;
    }

    this.emit({ type: 'auth', state: 'signing-in', message: 'Signing in to Discord…' });

    // Non-privileged intents only. Voice-state payloads carry the member
    // object, so nobody has to enable "Server Members" in the dev portal.
    // Guilds also delivers the full channel list at login, which is what the
    // server/channel pickers are built from — no extra requests, no extra
    // permissions.
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    client.on('error', (err) => this.log('error', `Discord client error: ${err.message}`));

    // Keep the member list live as people join/leave/move.
    client.on('voiceStateUpdate', (oldState, newState) => {
      if (!this.channel) return;
      if (oldState.channelId === this.channel.id || newState.channelId === this.channel.id) {
        // A user who left should stop consuming a recognizer.
        if (oldState.channelId === this.channel.id && newState.channelId !== this.channel.id) {
          this.teardownStream(oldState.id);
        }
        this.emitMembers();
      }
    });

    this.client = client;

    try {
      await client.login(token);

      // login() resolves when the handshake starts, not when the client is
      // usable. Until READY, client.user is null, the guild caches are empty
      // and the gateway can't deliver the voice state update joinVoiceChannel
      // needs — the voice connection would silently never come up.
      if (!client.isReady()) {
        await onceWithTimeout(
          client,
          Events.ClientReady,
          GATEWAY_READY_TIMEOUT_MS,
          'Discord gateway connection'
        );
      }
    } catch (err) {
      // Leave no half-built client behind, or a retry with a corrected token
      // would find `this.client` set and skip the login entirely.
      this.client = null;
      this.token = null;
      try {
        await client.destroy();
      } catch {
        /* never logged in */
      }
      this.emit({ type: 'auth', state: 'error', message: err.message });
      throw err;
    }

    this.token = token;
    this.emit({
      type: 'auth',
      state: 'signed-in',
      message: `Signed in as ${client.user.tag}`,
      botTag: client.user.tag,
    });
    this.emitGuilds();
  }

  /**
   * Every voice channel the bot can see, grouped by server, with whether it
   * could actually join each one.
   */
  emitGuilds() {
    if (!this.client || !this.client.isReady()) return;
    const me = this.client.user;

    const guilds = [...this.client.guilds.cache.values()]
      .map((guild) => ({
        id: guild.id,
        name: guild.name,
        channels: [...guild.channels.cache.values()]
          .filter(
            (c) =>
              c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice
          )
          .sort((a, b) => a.rawPosition - b.rawPosition)
          .map((c) => this.describeChannel(c, me)),
      }))
      // A server with no voice channels is nothing to pick from.
      .filter((g) => g.channels.length)
      .sort((a, b) => a.name.localeCompare(b.name));

    this.emit({ type: 'guilds', guilds, botTag: me.tag });
  }

  describeChannel(channel, me) {
    const stage = channel.type === ChannelType.GuildStageVoice;

    // permissionsFor returns null when the bot's own member isn't cached.
    // That has to read as "unknown", never as "can't join" — greying out a
    // channel that actually works would be worse than showing no verdict.
    let perms = null;
    try {
      perms = channel.permissionsFor(me);
    } catch {
      perms = null;
    }

    let canJoin = null;
    let reason = '';
    if (perms) {
      const missing = [];
      if (!perms.has(PermissionsBitField.Flags.ViewChannel)) missing.push('View Channel');
      if (!perms.has(PermissionsBitField.Flags.Connect)) missing.push('Connect');
      canJoin = missing.length === 0;
      if (missing.length) reason = `Bot is missing ${missing.join(' and ')} here`;
    }

    return {
      id: channel.id,
      name: channel.name,
      stage,
      canJoin,
      reason,
      // Bots are subject to the user limit unless they can move members.
      full:
        !stage &&
        channel.userLimit > 0 &&
        channel.members.size >= channel.userLimit &&
        !perms?.has(PermissionsBitField.Flags.MoveMembers),
    };
  }

  async start({ token, channelId, modelPath }) {
    if (!channelId) throw new Error('No voice channel selected.');

    // Sign in before loading the model: a bad token then fails in a couple of
    // seconds instead of after a 30-second Gigaspeech load. Usually a no-op,
    // because the app signs in at launch.
    await this.signIn(token);

    await this.startWorker(modelPath);

    this.emit({
      type: 'status',
      state: 'connecting',
      message: `Looking up channel ${channelId}…`,
    });
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      throw new Error(
        `Could not find channel ${channelId}. Check the ID and that the bot is in that server.`
      );
    }
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      throw new Error(`Channel ${channelId} is not a voice channel.`);
    }
    this.channel = channel;

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // a deafened bot receives no audio at all
      selfMute: true,

      // Never set `daveEncryption: false`. It goes out as
      // max_dave_protocol_version: 0 in the voice IDENTIFY, and Discord then
      // never sends SESSION_DESCRIPTION — the bot appears in the channel (that
      // is the main gateway) but the voice connection never reaches Ready and
      // the join times out after 30s.

      // Default is 36 consecutive failures, after which @discordjs/voice throws
      // and destroys the audio stream. A speaker we can't decrypt should lose
      // captions, not take the stream down.
      decryptionFailureTolerance: 5000,
    });

    this.connection.on('error', (err) =>
      this.log('error', `Voice connection error: ${err.message}`)
    );

    // Debug is on by default in @discordjs/voice (only `debug: false` disables
    // it), and the stream dumps whole state objects. Keep the lines that
    // explain a failed handshake or an encryption mismatch.
    const VOICE_DEBUG =
      /dave|transition|downgrade|encryption|session description|udp|select protocol|decrypt/i;
    let lastDecryptLog = 0;
    this.connection.on('debug', (message) => {
      const line = String(message).split('\n')[0];
      if (!VOICE_DEBUG.test(line)) return;
      // Decrypt failures arrive at packet rate; one line every few seconds is
      // enough to diagnose without burying everything else.
      if (/decrypt/i.test(line)) {
        const now = Date.now();
        if (now - lastDecryptLog < 3000) return;
        lastDecryptLog = now;
      }
      this.log('info', `[voice] ${line.slice(0, 180)}`);
    });

    // Discord moves voice servers occasionally; try to ride it out before
    // giving up, otherwise captions would die mid-stream.
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.stopping) return;
      this.log('warn', 'Voice disconnected — attempting to resume…');
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
        this.log('info', 'Voice connection resumed.');
      } catch {
        this.log('error', 'Could not resume voice connection.');
        this.emit({ type: 'status', state: 'disconnected', message: 'Voice disconnected.' });
        this.connection.destroy();
      }
    });

    this.emit({
      type: 'status',
      state: 'connecting',
      message: `Joining voice channel #${channel.name}…`,
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch {
      this.connection.destroy();
      throw new Error(
        `Could not join #${channel.name} within 30s. Check the bot has ` +
          `"View Channel" and "Connect" on that channel, and that the channel isn't full.`
      );
    }
    this.receiver = this.connection.receiver;

    // Vosk finds utterance boundaries itself; the other engines have to be told
    // where one ends. Either way Discord's own signal is the best evidence we
    // get, and it makes trailing words appear without waiting for a packet that
    // may never come.
    this.receiver.speaking.on('end', (userId) => {
      if (this.selected.has(userId) && this.workerReady) {
        this.worker.postMessage({ type: 'flush', userId });
      }
    });

    this.emit({
      type: 'status',
      state: 'joined',
      message: `Listening in #${channel.name}`,
      channelName: channel.name,
      guildName: channel.guild.name,
    });

    this.emitMembers();
    // Anyone toggled on before we joined should start capturing now.
    for (const userId of this.selected) this.setupStream(userId);
  }

  /** Everyone currently in the voice channel, excluding the bot itself. */
  emitMembers() {
    if (!this.channel) return;
    const members = [...this.channel.members.values()]
      .filter((m) => m.id !== this.client.user.id)
      .map((m) => ({
        id: m.id,
        username: m.user.username,
        displayName: m.displayName || m.user.username,
        bot: Boolean(m.user.bot),
        selected: this.selected.has(m.id),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.emit({ type: 'members', members });
  }

  // ------------------------------------------------- per-speaker capture ---

  /**
   * Persistent subscription (EndBehaviorType.Manual) rather than subscribing on
   * each `speaking start` — the latter races the first voice packet and clips
   * the first word of every utterance. Discord sends nothing during silence, so
   * an idle subscription is free.
   */
  setupStream(userId) {
    if (!this.receiver || this.streams.has(userId) || !this.workerReady) return;

    this.worker.postMessage({ type: 'add', userId });

    const opusStream = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new prism.opus.Decoder(OPUS);
    const resampler = new Resampler48kStereoTo16kMono();

    decoder.on('data', (stereo48k) => {
      if (!this.workerReady || !this.selected.has(userId)) return;
      // Audio is flowing again — clear any earlier restart budget.
      if (this.restarts.get(userId)) this.restarts.delete(userId);
      const mono16k = resampler.process(stereo48k);
      if (!mono16k.length) return;
      // Detach from Node's Buffer pool so the ArrayBuffer can be transferred
      // to the worker with zero copying.
      const ab = mono16k.buffer.slice(
        mono16k.byteOffset,
        mono16k.byteOffset + mono16k.byteLength
      );
      this.worker.postMessage({ type: 'audio', userId, buf: ab }, [ab]);
    });

    // A stream error destroys the pipe, leaving that speaker silent for the
    // rest of the call. Rebuild instead, with a budget so a permanently broken
    // stream can't spin.
    const MAX_RESTARTS = 5;
    let handled = false;
    const onError = (err) => {
      if (handled) return; // both opusStream and decoder can fire for one fault
      handled = true;

      const who = this.knownName(userId) || userId;
      const count = (this.restarts.get(userId) || 0) + 1;
      this.restarts.set(userId, count);

      if (!this.selected.has(userId) || count > MAX_RESTARTS) {
        this.log(
          'error',
          `Audio stream for ${who} failed: ${err.message}` +
            (count > MAX_RESTARTS ? ' — giving up. Toggle them off and on to retry.' : '')
        );
        this.teardownStream(userId);
        return;
      }

      this.log('warn', `Audio stream for ${who} failed (${err.message}) — reconnecting…`);
      this.teardownStream(userId);
      setTimeout(() => {
        if (this.selected.has(userId)) this.setupStream(userId);
      }, 1000).unref();
    };
    opusStream.on('error', onError);
    decoder.on('error', onError);

    opusStream.pipe(decoder);
    this.streams.set(userId, { opusStream, decoder, resampler });
    this.log('info', `Capturing audio for ${this.knownName(userId) || userId}`);
  }

  teardownStream(userId) {
    const s = this.streams.get(userId);
    if (!s) return;
    try {
      s.opusStream.unpipe(s.decoder);
      s.opusStream.destroy();
      s.decoder.destroy();
    } catch {
      /* already torn down */
    }
    this.streams.delete(userId);
    if (this.workerReady) this.worker.postMessage({ type: 'remove', userId });
  }

  /** Live toggle. Safe to call at any time, including mid-call. */
  setSelected(userIds) {
    const next = new Set(userIds);
    for (const userId of this.selected) {
      if (!next.has(userId)) {
        this.teardownStream(userId);
        // Toggling someone off and on is the documented way to retry a stream
        // that exhausted its restart budget, so reset it here.
        this.restarts.delete(userId);
      }
    }
    this.selected = next;
    for (const userId of next) {
      if (!this.streams.has(userId)) this.setupStream(userId);
    }
    this.emitMembers();
    this.checkSpeakerLimit();
    this.emit({ type: 'stats', speakers: this.selected.size });
  }

  // -------------------------------------------------------------- teardown --

  /**
   * Leave the voice channel and free the recognizers, but stay signed in.
   *
   * Disconnect deliberately does not log the client out: the server and
   * channel pickers are built from the signed-in client's caches, and emptying
   * them every time someone disconnects would make the app look broken.
   */
  async leave({ announce = true } = {}) {
    this.stopping = true;
    this.restarts.clear();
    // Drop any in-place worker-restart budget; the next Connect starts fresh.
    this.workerRestarts = 0;
    this.modelPath = null;
    clearTimeout(this.workerHealthTimer);
    this.workerHealthTimer = null;
    for (const userId of [...this.streams.keys()]) this.teardownStream(userId);

    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        /* may already be destroyed */
      }
      this.connection = null;
    }
    if (this.worker) {
      // Capture the reference — if Connect is hit again within the grace
      // period, `this.worker` points at a new worker and the timer would kill
      // that one instead.
      const dying = this.worker;
      this.worker = null;
      this.workerReady = false;
      dying.postMessage({ type: 'shutdown' });
      // Give it a moment to free the model, then force it down.
      setTimeout(() => dying.terminate(), 1000).unref();
    }
    this.speech = null;
    this.warnedSpeakerLimit = false;
    this.channel = null;
    this.receiver = null;
    this.stopping = false;
    if (announce) this.emit({ type: 'status', state: 'stopped', message: 'Stopped.' });
  }

  /** Full teardown including the Discord session — for app shutdown. */
  async stop() {
    await this.leave({ announce: false });
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.token = null;
    this.emit({ type: 'auth', state: 'signed-out', message: 'Signed out.' });
    this.emit({ type: 'status', state: 'stopped', message: 'Stopped.' });
  }
}

// ---------------------------------------------------------------- IPC glue --

const emit = (msg) => {
  if (process.send) process.send(msg);
  else if (process.env.CHATTERLAYER_VERBOSE) console.log(JSON.stringify(msg));
};

const engine = new ChatterLayerEngine(emit);

async function handleCommand(msg) {
  try {
    switch (msg.type) {
      case 'signIn':
        // A failed sign-in already reported itself as an `auth` event. Letting
        // it fall through to the catch below would also raise a `status: error`
        // and put the whole app in a fault state, which is far too loud for
        // "the saved token needs re-pasting" on a background launch sign-in.
        return await engine.signIn(msg.token).catch(() => undefined);
      case 'start':
        return await engine.start(msg);
      case 'setSelected':
        return engine.setSelected(msg.userIds || []);
      case 'requestMembers':
        return engine.emitMembers();
      case 'stats':
        return engine.worker && engine.worker.postMessage({ type: 'stats' });
      case 'stop':
        return await engine.leave();
      case 'shutdown':
        await engine.stop();
        return process.exit(0);
      default:
        return undefined;
    }
  } catch (err) {
    emit({ type: 'status', state: 'error', message: err.message });
    emit({ type: 'log', level: 'error', message: err.stack || err.message });
    return undefined;
  }
}

process.on('message', handleCommand);

process.on('uncaughtException', (err) => {
  emit({ type: 'log', level: 'error', message: `uncaught: ${err.stack || err.message}` });
  emit({ type: 'status', state: 'error', message: err.message });
});
process.on('unhandledRejection', (err) => {
  const e = err instanceof Error ? err : new Error(String(err));
  emit({ type: 'log', level: 'error', message: `unhandled: ${e.stack || e.message}` });
});

// Headless mode: `node src/engine/engine.js --headless` with env vars set,
// useful for debugging the bot without launching Electron.
if (process.argv.includes('--headless')) {
  process.env.CHATTERLAYER_VERBOSE = '1';
  handleCommand({
    type: 'start',
    token: process.env.DISCORD_TOKEN,
    channelId: process.env.DISCORD_CHANNEL_ID,
  }).then(() => {
    if (process.env.CHATTERLAYER_SELECT) {
      engine.setSelected(process.env.CHATTERLAYER_SELECT.split(','));
    }
  });
}

module.exports = { ChatterLayerEngine };
