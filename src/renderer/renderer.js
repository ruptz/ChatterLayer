'use strict';
/**
 * Reaches the main process only through the `window.chatterlayer` bridge; no
 * Node APIs here by design.
 *
 * Speaker-supplied text (names, caption text) is always set via textContent,
 * never innerHTML — Discord names are untrusted input.
 */

const $ = (id) => document.getElementById(id);

const el = {
  tally: $('tally'),
  statusText: $('status-text'),
  sourceCard: $('source-card'),
  source: $('source'),
  sourceNote: $('source-note'),
  micField: $('mic-field'),
  micDevice: $('mic-device'),
  micSensitivity: $('mic-sensitivity'),
  micHang: $('mic-hang'),
  vSensitivity: $('v-sensitivity'),
  vHang: $('v-hang'),
  token: $('token'),
  toggleToken: $('toggle-token'),
  tokenHint: $('token-hint'),
  guild: $('guild'),
  refreshGuilds: $('refresh-guilds'),
  authNote: $('auth-note'),
  voiceChannel: $('voice-channel'),
  channelNote: $('channel-note'),
  manualChannel: $('manual-channel'),
  toggleManual: $('toggle-manual'),
  channel: $('channel'),
  start: $('start'),
  stop: $('stop'),
  modelPath: $('model-path'),
  model: $('model'),
  modelNote: $('model-note'),
  manageModels: $('manage-models'),
  modelList: $('model-list'),
  filterEnabled: $('filter-enabled'),
  filterCustom: $('filter-custom'),
  filterCount: $('filter-count'),
  members: $('members'),
  speakerCount: $('speaker-count'),
  urlOverlay: $('url-overlay'),
  fontSize: $('font-size'),
  lifetime: $('lifetime'),
  maxLines: $('max-lines'),
  showPartials: $('show-partials'),
  showNames: $('show-names'),
  port: $('port'),
  shareEnabled: $('share-enabled'),
  sharePanel: $('share-panel'),
  shareStart: $('share-start'),
  shareStop: $('share-stop'),
  shareRotate: $('share-rotate'),
  shareMeta: $('share-meta'),
  shareNote: $('share-note'),
  urlShare: $('url-share'),
  clear: $('clear'),
  reveal: $('reveal'),
  preview: $('preview'),
  stats: $('stats'),
  log: $('log'),
  clearLog: $('clear-log'),
  donate: $('donate'),
  build: $('build'),
  buildVersion: $('build-version'),
  checkUpdates: $('check-updates'),
  settingsToggle: $('settings-toggle'),
  settingsPanel: $('settings-panel'),
  closeToTray: $('close-to-tray'),
  theme: $('theme'),
  pause: $('pause'),
  loginRow: $('login-row'),
  launchAtLogin: $('launch-at-login'),
  hotkeysEnabled: $('hotkeys-enabled'),
  hotkeysHint: $('hotkeys-hint'),
  vFont: $('v-font'),
  vLife: $('v-life'),
  vLines: $('v-lines'),
  botGuide: $('bot-guide'),
  inviteBot: $('invite-bot'),
  obsMeta: $('obs-meta'),
  testCaption: $('test-caption'),
  report: $('report'),
  whatsNew: $('whats-new'),
  whatsNewTitle: $('whats-new-title'),
  whatsNewBody: $('whats-new-body'),
  whatsNewClose: $('whats-new-close'),
  whatsNewNotes: $('whats-new-notes'),
  whatsNewKofi: $('whats-new-kofi'),
  setup: $('setup'),
  setupMeta: $('setup-meta'),
  setupPath: $('setup-path'),
  setupHint: $('setup-hint'),
  setupAction: $('setup-action'),
  setupHide: $('setup-hide'),
};

const KOFI_URL = 'https://ko-fi.com/ruptz';
const BOT_GUIDE_URL = 'https://chatterlayer.com/#setup';

/** View Channel (1 << 10) + Connect (1 << 20). It never speaks, so no Speak. */
const INVITE_PERMISSIONS = 1049600;

const inviteUrl = (botId) =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(botId)}` +
  `&scope=bot&permissions=${INVITE_PERMISSIONS}`;

let state = {
  config: null,
  members: [],
  running: false,
  /** Sign-in state and the server/channel tree the pickers are built from. */
  discord: { auth: 'idle', botTag: null, botId: null, message: '', guilds: [] },
  /** Overlays connected to the caption server; `local` is in practice OBS. */
  overlays: { local: 0, remote: 0 },
  /** Release notes to show once after an update, or null. */
  whatsNew: null,
  /** Connected but sending nothing. */
  paused: false,
  /**
   * The model the worker actually has loaded, as opposed to the one selected in
   * the dropdown. They differ whenever someone switches models mid-call.
   */
  loadedModel: '',
  /** Remote sharing: whether the panel is armed, and the live tunnel if any. */
  share: { enabled: false, running: false, busy: false, origin: '', url: '' },
  /** Running version and where to send someone who wants a newer one. */
  version: '',
  releasesUrl: 'https://github.com/ruptz/ChatterLayer/releases/latest',
  update: null,
};
/** userId -> the monitor line currently showing that speaker's partial text. */
const partials = new Map();
/** userId -> timer clearing the channel lamp blip. */
const blips = new Map();

// ------------------------------------------------------------- indicators --

/** On air, unless paused — then the lamp says so, and so does the key. */
function renderLive() {
  if (state.running) {
    if (state.paused) setTally('paused', 'Paused');
    else setTally('onair', 'On air');
  }
  el.pause.hidden = !state.running;
  el.pause.textContent = state.paused ? 'Resume captions' : 'Pause captions';
  el.pause.classList.toggle('btn-primary', state.paused);
}

/**
 * Drive the tally lamp.
 * @param {'standby'|'linking'|'onair'|'fault'} lampState
 */
function setTally(lampState, text) {
  el.tally.dataset.state = lampState;
  el.statusText.textContent = text;
}

function log(message, level = 'info') {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('span');
  if (level === 'error') line.className = 'err';
  else if (level === 'warn') line.className = 'warn';
  line.textContent = `[${time}] ${message}\n`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

/** Pulse a speaker's indicator when their words come through. */
function blip(userId) {
  const row = el.members.querySelector(`[data-user="${CSS.escape(userId)}"]`);
  if (!row) return;
  row.classList.remove('speaking');
  // Force reflow so the animation restarts on rapid consecutive captions.
  void row.offsetWidth;
  row.classList.add('speaking');
  clearTimeout(blips.get(userId));
  blips.set(
    userId,
    setTimeout(() => row.classList.remove('speaking'), 600)
  );
}

/** Coalesce rapid slider input into one config write. */
function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const saveOverlay = debounce(async () => {
  state.config = await window.chatterlayer.updateConfig({
    overlay: {
      fontSize: Number(el.fontSize.value),
      captionLifetimeMs: Number(el.lifetime.value),
      maxLines: Number(el.maxLines.value),
      showPartials: el.showPartials.checked,
      showSpeakerName: el.showNames.checked,
    },
  });
});

const saveFilter = debounce(async () => {
  const custom = el.filterCustom.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  state.config = await window.chatterlayer.updateConfig({
    filter: { enabled: el.filterEnabled.checked, custom },
  });
}, 400);

// Applied on blur or Enter, not while typing: a pause halfway through "50000"
// would otherwise move the server to 5000 first.
async function savePort() {
  const port = Number(el.port.value);
  if (port === state.config.server.port) return;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    el.port.value = state.config.server.port;
    return;
  }
  log(`Moving caption server to port ${port}…`);
  state.config = await window.chatterlayer.updateConfig({
    server: { ...state.config.server, port },
  });
}

// ------------------------------------------------- server / channel pickers --

function renderAuth() {
  const d = state.discord;
  const set = (text, tone) => {
    el.authNote.textContent = text;
    if (tone) el.authNote.dataset.state = tone;
    else el.authNote.removeAttribute('data-state');
  };

  // Signed in, the button's job changes from getting you in to re-reading the
  // server list, so it says so.
  el.refreshGuilds.textContent = d.auth === 'signed-in' ? 'Refresh' : 'Sign in';

  if (d.auth === 'signed-in') set(d.botTag ? `Signed in as ${d.botTag}` : 'Signed in', 'ok');
  else if (d.auth === 'signing-in') set('Signing in…', 'working');
  else if (d.auth === 'error') set(d.message || 'Sign-in failed — check your bot token.', 'fault');
  else if (state.config && state.config.hasToken) set('Not signed in.');
  else set('Paste your bot token — it signs in by itself.');

  renderInvite();
  renderSetup();
}

/**
 * Signed in, the app knows the bot's id, which is all the invite link needs —
 * so nobody has to find the URL Generator. While the bot is in no server with
 * a voice channel this is the only way forward, and it looks like it.
 */
function renderInvite() {
  const d = state.discord;
  el.inviteBot.hidden = !(d.auth === 'signed-in' && d.botId);
  const lonely = !(d.guilds || []).length;
  el.inviteBot.className = lonely ? 'btn btn-sm btn-primary invite-cta' : 'linky';
  el.inviteBot.textContent = lonely
    ? 'Invite the bot to a server'
    : 'Invite the bot to another server';
}

function openInvite() {
  if (!state.discord.botId) return;
  window.chatterlayer.openExternal(inviteUrl(state.discord.botId));
  log('Opened the invite page — pick a server there. It shows up here by itself.');
}

/**
 * A placeholder option. Given an explicit empty value because an <option>
 * without one reports its text as its value, and "—" would then be sent to
 * Connect as a channel id.
 */
function placeholder(text) {
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = text;
  return opt;
}

function renderGuilds() {
  const guilds = state.discord.guilds || [];
  el.guild.replaceChildren();
  renderInvite();

  if (!guilds.length) {
    const opt = placeholder('');
    opt.textContent =
      state.discord.auth === 'signed-in' ? 'No servers with voice channels' : '—';
    el.guild.appendChild(opt);
    el.guild.disabled = true;
    renderChannels();
    return;
  }

  el.guild.disabled = false;
  for (const g of guilds) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    el.guild.appendChild(opt);
  }

  // Come back to where they left off. If the remembered server is gone, fall
  // back to whichever one holds the remembered channel before giving up.
  const saved = state.config.guildId;
  const holder = guilds.find((g) => g.channels.some((c) => c.id === state.config.channelId));
  el.guild.value = (guilds.some((g) => g.id === saved) ? saved : (holder || guilds[0]).id);
  renderChannels();
}

function renderChannels() {
  const guild = (state.discord.guilds || []).find((g) => g.id === el.guild.value);
  el.voiceChannel.replaceChildren();

  if (!guild) {
    el.voiceChannel.appendChild(placeholder('—'));
    el.voiceChannel.disabled = true;
    updateChannelNote();
    return;
  }

  el.voiceChannel.disabled = false;
  for (const c of guild.channels) {
    const opt = document.createElement('option');
    opt.value = c.id;

    const tags = [];
    if (c.stage) tags.push('stage');
    if (c.canJoin === false) tags.push('no access');
    else if (c.full) tags.push('full');
    opt.textContent = tags.length ? `${c.name} — ${tags.join(', ')}` : c.name;

    // Listed but unselectable: hiding a channel the bot lacks permission for
    // turns a fixable permissions mistake into a channel that appears not to
    // exist, which is far harder to diagnose.
    opt.disabled = c.canJoin === false;
    if (c.reason) opt.title = c.reason;

    el.voiceChannel.appendChild(opt);
  }

  const saved = guild.channels.find((c) => c.id === state.config.channelId);
  const firstJoinable = guild.channels.find((c) => c.canJoin !== false);
  const pick = saved && saved.canJoin !== false ? saved : firstJoinable;
  el.voiceChannel.value = pick ? pick.id : '';
  updateChannelNote();
}

function currentChannel() {
  const guild = (state.discord.guilds || []).find((g) => g.id === el.guild.value);
  if (!guild) return null;
  return guild.channels.find((c) => c.id === el.voiceChannel.value) || null;
}

function updateChannelNote() {
  const c = currentChannel();

  renderSetup();

  if (!c) {
    const signedIn = state.discord.auth === 'signed-in';
    el.channelNote.textContent = !signedIn
      ? 'Sign in to list your servers and voice channels.'
      : (state.discord.guilds || []).length
        ? 'No voice channel here that the bot can join.'
        : 'Invite the bot to your server — its channels appear here by themselves.';
    el.channelNote.removeAttribute('data-state');
    return;
  }

  const notes = [];
  // Joining a stage puts a bot in the audience, where it receives no audio at
  // all. Without this note that failure looks like ChatterLayer being broken.
  if (c.stage) {
    notes.push(
      'Stage channel — the bot joins as audience and hears nothing until you invite it to speak.'
    );
  }
  if (c.full) notes.push('This channel is at its user limit, so the bot may not fit.');
  if (c.canJoin === null) notes.push("Couldn't verify the bot's permissions here.");

  el.channelNote.textContent = notes.length
    ? notes.join(' ')
    : 'ChatterLayer will join this channel and list everyone in it.';
  if (notes.length) el.channelNote.dataset.state = 'working';
  else el.channelNote.removeAttribute('data-state');
}

/** Manual entry wins when it's open and filled, otherwise the picker. */
function effectiveChannelId() {
  if (!el.manualChannel.hidden) {
    const manual = el.channel.value.trim();
    if (manual) return manual;
  }
  return el.voiceChannel.value || '';
}

/**
 * The picker follows the bot when someone else moves it, and remembers the
 * move, so a reconnect goes where the call actually is.
 */
function showJoinedChannel(channelId) {
  if (!channelId || channelId === el.voiceChannel.value) return;
  if (![...el.voiceChannel.options].some((o) => o.value === channelId)) return;
  el.voiceChannel.value = channelId;
  updateChannelNote();
  persistChannel();
}

async function persistChannel() {
  const channelId = el.voiceChannel.value;
  if (!channelId) return;
  state.config = await window.chatterlayer.updateConfig({ channelId });
}

// ---------------------------------------------------------------- source --

const SOURCE_NOTES = {
  discord: 'The people in a Discord voice call, heard through your bot.',
  mic: 'This PC’s microphone only. Discord is never signed in to — nothing leaves this PC.',
  both:
    'The call, plus your own mic — so what you say while muted or off push-to-talk still gets captioned. Press “This is me” on your Discord row so you’re only captioned once.',
};

const currentSource = () => (state.config && state.config.source) || 'discord';
const usesMic = () => currentSource() !== 'discord';

/**
 * Show only what the chosen source needs. The Discord fields are hidden for
 * the mic alone, not disabled, and the transport says Start rather than
 * Connect, because there is nothing to connect to.
 */
function renderSource() {
  const source = currentSource();
  el.sourceCard.dataset.source = source;
  for (const radio of el.source.querySelectorAll('input')) {
    radio.checked = radio.value === source;
    // The engine is started for one source; switching means reconnecting.
    radio.disabled = state.running;
  }
  el.sourceNote.textContent = state.running
    ? `${SOURCE_NOTES[source]} ${source === 'mic' ? 'Stop' : 'Disconnect'} to change it.`
    : SOURCE_NOTES[source];
  el.micField.hidden = !usesMic();
  el.start.textContent = source === 'mic' ? 'Start' : 'Connect';
  el.stop.textContent = source === 'mic' ? 'Stop' : 'Disconnect';
}

/**
 * Fill the microphone picker. Browsers hide device names until the mic has
 * been opened once, so before that they are numbered instead.
 */
async function renderMics() {
  let inputs = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
    );
  } catch {
    /* no media devices at all; the default entry still stands */
  }
  el.micDevice.replaceChildren(placeholder('System default'));
  inputs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${i + 1}`;
    el.micDevice.appendChild(opt);
  });
  const saved = state.config.mic.deviceId;
  el.micDevice.value = inputs.some((d) => d.deviceId === saved) ? saved : '';
}

function syncGateLabels() {
  el.vSensitivity.textContent = el.micSensitivity.value;
  el.vHang.textContent = `${(Number(el.micHang.value) / 1000).toFixed(1)}s`;
}

const saveMicGate = debounce(async () => {
  state.config = await window.chatterlayer.updateConfig({
    mic: {
      ...state.config.mic,
      sensitivity: Number(el.micSensitivity.value),
      hangMs: Number(el.micHang.value),
    },
  });
});

// ------------------------------------------------------------ mic capture --

/**
 * The live capture, when there is one. Held only while the mic's channel is
 * switched on during a session: the OS mic-in-use light should mean captions
 * are actually being made.
 */
let mic = null;
/** Bumped on every stop, so a capture that finishes opening late closes itself. */
let micGen = 0;

function micWanted() {
  return state.running && state.members.some((m) => m.local && m.selected);
}

function syncMic() {
  if (micWanted()) {
    if (!mic) startMic();
  } else if (mic) {
    stopMic();
  }
}

async function openMicStream(deviceId) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}

async function startMic() {
  const gen = ++micGen;
  mic = { opening: true };
  let stream = null;
  let ctx = null;
  try {
    if (!(await window.chatterlayer.micAccess())) {
      throw new Error('access is turned off for ChatterLayer in System Settings → Privacy & Security → Microphone.');
    }
    const wanted = state.config.mic.deviceId;
    try {
      stream = await openMicStream(wanted);
    } catch (err) {
      // The chosen mic was unplugged since; the default beats silence.
      if (!wanted || err.name !== 'OverconstrainedError') throw err;
      log('The chosen microphone isn’t connected — using the system default.', 'warn');
      stream = await openMicStream('');
    }

    // Chromium resamples the mic to the 16 kHz every speech model here takes.
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('mic-worklet.js');
    if (gen !== micGen) throw new Error('stopped');

    const node = new AudioWorkletNode(ctx, 'mic-tap');
    node.port.onmessage = (e) => window.chatterlayer.micAudio(new Uint8Array(e.data.buffer));
    ctx.createMediaStreamSource(stream).connect(node);
    // Pulled by the destination so it runs; it writes nothing, so nothing is heard.
    node.connect(ctx.destination);

    const [track] = stream.getAudioTracks();
    track.addEventListener('ended', () => {
      if (gen !== micGen) return;
      log('The microphone went away — trying again.', 'warn');
      stopMic();
      setTimeout(syncMic, 1000);
    });
    mic = { stream, ctx };
    log(`Mic live: ${track.label || 'system default'}`);
    // Names are readable now the mic has been opened once.
    renderMics();
  } catch (err) {
    if (stream) for (const t of stream.getTracks()) t.stop();
    if (ctx) ctx.close().catch(() => {});
    if (gen !== micGen) return;
    mic = null;
    log(`Couldn’t open the microphone: ${err.message}`, 'error');
  }
}

function stopMic() {
  micGen++;
  if (mic && mic.stream) for (const t of mic.stream.getTracks()) t.stop();
  if (mic && mic.ctx) mic.ctx.close().catch(() => {});
  mic = null;
}

// ------------------------------------------------------- channel strips --

function renderMembers() {
  el.members.replaceChildren();

  if (!state.members.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.running
      ? 'Nobody else is in the voice channel yet.'
      : 'Connect to see who’s in the voice channel.';
    el.members.appendChild(li);
    el.speakerCount.textContent = '0 on';
    el.speakerCount.dataset.on = '0';
    return;
  }

  const live = state.members.filter((m) => m.selected).length;
  el.speakerCount.textContent = `${live} on`;
  el.speakerCount.dataset.on = live ? '1' : '0';
  // Toggling someone on can push the selection past what the model keeps up
  // with, which the model note is where we say so.
  updateModelNote();

  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = `row${m.selected ? ' live' : ''}`;
    li.dataset.user = m.id;
    li.style.setProperty('--ch', m.color);

    // speaker indicator, lit in that speaker's caption colour
    const dot = document.createElement('span');
    dot.className = 'dot';

    // Identity. The name is editable in place and shows exactly what viewers
    // will see, so "ruptz_45454" can go on stream as "Ruptz". The immutable
    // Discord handle stays underneath so you can still tell who is who.
    const who = document.createElement('span');
    who.className = 'who';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'alias';
    name.value = m.captionName;
    name.placeholder = m.displayName;
    name.spellcheck = false;
    name.title = m.local
      ? 'Name shown on captions for your mic'
      : 'Name shown on captions — clear it to use their Discord name';
    name.setAttribute('aria-label', `Caption name for ${m.displayName}`);

    const commit = () => {
      const next = name.value.trim();
      if (next === (m.alias || '') || (!next && !m.alias)) return; // unchanged
      m.alias = next;
      window.chatterlayer.setAlias(m.id, next);
      const fallback = m.local ? `${m.displayName} shows as “Mic”` : `${m.displayName} shows their Discord name`;
      log(next ? `${m.displayName} shows as “${next}”` : fallback);
    };
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') {
        name.value = m.captionName;
        name.blur();
      }
    });

    const meta = document.createElement('small');
    meta.textContent = m.local
      ? 'This PC · microphone'
      : m.coveredByMic
        ? `@${m.username} · you — captioned from your mic instead`
        : `@${m.username} · ${m.id}`;
    who.append(name, meta);

    li.append(dot, who);

    if (m.bot) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'bot';
      li.append(badge);
    }

    if (m.customColor) {
      const reset = document.createElement('button');
      reset.className = 'btn btn-ghost btn-sm';
      reset.textContent = 'Reset';
      reset.title = 'Return to the automatic colour';
      reset.addEventListener('click', () => window.chatterlayer.setColor(m.id, null));
      li.append(reset);
    }

    // Follow mode: the bot goes where this person goes, within this server.
    // "This is me", only with the call and the mic both on. It is what stops the
    // streamer being captioned twice: once through Discord, once through the mic.
    if (!m.bot && !m.local && currentSource() === 'both') {
      const me = document.createElement('button');
      me.className = `btn btn-sm follow${m.me ? ' on' : ''}`;
      me.textContent = m.me ? 'Me' : 'This is me';
      me.setAttribute('aria-pressed', String(Boolean(m.me)));
      me.title = m.me
        ? 'While your mic is on, your Discord audio is skipped so you are only captioned once. Click to undo.'
        : 'Mark this as your own Discord account. Your mic then captions you, so you aren’t captioned twice.';
      me.addEventListener('click', () => setMe(m.me ? null : m.id, m));
      li.append(me);
    }

    // Never offered for bots, which don't change channels to be followed, nor
    // for the mic, which isn't in one.
    if (!m.bot && !m.local) {
      const follow = document.createElement('button');
      follow.className = `btn btn-sm follow${m.followed ? ' on' : ''}`;
      follow.textContent = m.followed ? 'Following' : 'Follow';
      follow.setAttribute('aria-pressed', String(Boolean(m.followed)));
      follow.title = m.followed
        ? `The bot moves with ${m.captionName} between voice channels in this server. Click to stop.`
        : `Have the bot follow ${m.captionName} when they change voice channel in this server.`;
      follow.addEventListener('click', () => setFollow(m.followed ? null : m.id, m));
      li.append(follow);
    }

    // caption colour picker
    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = m.color;
    swatch.title = `Caption colour for ${m.displayName}`;
    swatch.addEventListener('change', async () => {
      await window.chatterlayer.setColor(m.id, swatch.value);
    });
    li.append(swatch);

    // switch — input first so the CSS can drive track/knob via `~`
    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = m.selected;
    cb.setAttribute('aria-label', `Caption ${m.displayName}`);
    cb.addEventListener('change', () => toggleMember(m.id, cb.checked));
    const track = document.createElement('span');
    track.className = 'track';
    const knob = document.createElement('span');
    knob.className = 'knob';
    sw.append(cb, track, knob);
    li.append(sw);

    el.members.appendChild(li);
  }
}

async function setFollow(userId, member) {
  state.config = await window.chatterlayer.setFollow(userId);
  log(
    userId
      ? `Following ${member.captionName} — the bot moves when they change voice channel in this server. Their captions stay ${member.selected ? 'on' : 'off'}.`
      : 'Follow mode off — the bot stays where it is.'
  );
}

async function setMe(userId, member) {
  state.config = await window.chatterlayer.setMe(userId);
  log(
    userId
      ? `${member.captionName} is you — while your mic is on, you’re captioned from it, not from Discord.`
      : `${member.captionName} is no longer marked as you.`
  );
}

async function toggleMember(userId, on) {
  const ids = new Set(state.members.filter((m) => m.selected).map((m) => m.id));
  if (on) ids.add(userId);
  else ids.delete(userId);

  const member = state.members.find((m) => m.id === userId);
  if (member) member.selected = on;
  renderMembers();
  syncMic();

  await window.chatterlayer.setSelected([...ids]);
  log(`${member ? member.displayName : userId} — captioning ${on ? 'on' : 'off'}`);
}

// -------------------------------------------------------------- monitor --

/**
 * The monitor is a mirror of the overlay, not a log of the call. Captions
 * expire on the same Hold timer and trim to the same Max lines, so what's in
 * the box is what's on the stream at that moment — and a twelve-hour session
 * costs the same handful of nodes as a two-minute one.
 *
 * The lifecycle below is deliberately identical to the one in web/overlay.html.
 * Change one and you must change the other: they are two renderers of the same
 * rules, kept apart only because the overlay is a standalone page served to OBS
 * and can't share a module with the app.
 */

/** Trim to Max lines, oldest first. The overlay's `trim()`. */
function trimMonitor() {
  const max = Number(el.maxLines.value) || 4;
  while (el.preview.children.length > max) el.preview.firstChild.remove();
}

/** Fade a line out, then drop it. The overlay's `expire()`. */
function expireLine(node, delay) {
  const timer = setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 500);
  }, delay);
  node.dataset.timer = String(timer);
}

function clearLineTimer(node) {
  if (node.dataset.timer) clearTimeout(Number(node.dataset.timer));
}

function buildLine(cap, isPartial) {
  const div = document.createElement('div');
  div.className = `line${isPartial ? ' partial' : ''}`;
  div.style.setProperty('--ch', cap.color);
  // Decided at build time, exactly as the overlay decides it. Turning names off
  // mid-call leaves the lines already on screen alone; they age out in seconds.
  if (el.showNames.checked) {
    const who = document.createElement('b');
    who.textContent = cap.username;
    div.appendChild(who);
  }
  const text = document.createElement('span');
  text.textContent = cap.text;
  div.appendChild(text);
  return div;
}

function addCaption(cap) {
  const empty = el.preview.querySelector('.empty');
  if (empty) empty.remove();

  // The channel strip blips whenever someone is heard, whether or not their
  // partial text is being shown.
  blip(cap.userId);

  const lifetime = Number(el.lifetime.value);

  if (!cap.isFinal) {
    // Dropped at source rather than hidden with CSS: a partial nobody can see
    // must not occupy one of the Max lines slots either.
    if (!el.showPartials.checked) return;

    let node = partials.get(cap.userId);
    if (node && node.isConnected) {
      clearLineTimer(node);
      node.replaceWith((node = buildLine(cap, true)));
    } else {
      node = buildLine(cap, true);
      el.preview.appendChild(node);
    }
    partials.set(cap.userId, node);
    // Safety net, as on the overlay: if a speaker stops mid-word their partial
    // must not sit there for the rest of the stream.
    expireLine(node, lifetime + 4000);
    trimMonitor();
    return;
  }

  // Final text supersedes that speaker's partial line.
  const existing = partials.get(cap.userId);
  if (existing && existing.isConnected) {
    clearLineTimer(existing);
    existing.remove();
  }
  partials.delete(cap.userId);

  const node = buildLine(cap, false);
  el.preview.appendChild(node);
  expireLine(node, lifetime);
  trimMonitor();
  // Eight lines at the largest text can outgrow the stage. OBS would clip the
  // same overflow off the top of its own frame; here the newest line is the one
  // worth keeping in view.
  el.preview.scrollTop = el.preview.scrollHeight;
}

/** A cancelled partial leaves the monitor at once, as it leaves the overlay. */
function dropPartial(userId) {
  const node = partials.get(userId);
  if (node && node.isConnected) {
    clearLineTimer(node);
    node.remove();
  }
  partials.delete(userId);
}

// --------------------------------------------------------------- events --

function handleEvent(msg) {
  switch (msg.type) {
    case 'status':
      if (msg.state === 'joined') {
        state.running = true;
        renderLive();
        renderSource();
        el.start.disabled = true;
        el.stop.disabled = false;
        log(msg.source === 'mic' ? msg.message : `Joined ${msg.guildName} / #${msg.channelName}`);
        showJoinedChannel(msg.channelId);
        syncMic();
      } else if (msg.state === 'error') {
        setTally('fault', 'Fault');
        state.running = false;
        renderLive();
        renderSource();
        syncMic();
        el.start.disabled = false;
        el.stop.disabled = true;
        log(msg.message, 'error');
      } else if (msg.state === 'stopped' || msg.state === 'disconnected') {
        setTally('standby', 'Standby');
        state.running = false;
        // The engine has freed the model, so the stamp goes back to describing
        // the selection rather than what was loaded.
        state.loadedModel = '';
        state.members = [];
        renderMembers();
        renderModelPath();
        renderLive();
        renderSource();
        syncMic();
        el.start.disabled = false;
        el.stop.disabled = true;
        log(msg.message);
      } else {
        setTally('linking', 'Linking');
        log(msg.message);
      }
      return;

    case 'auth':
      state.discord = {
        ...state.discord,
        auth: msg.state,
        botTag: msg.botTag || state.discord.botTag,
        botId: msg.botId || state.discord.botId,
        message: msg.message || '',
      };
      // No session, nothing to pick from.
      if (msg.state === 'error' || msg.state === 'signed-out') {
        state.discord.guilds = [];
        state.discord.botId = null;
      }
      // The main process saved the token before signing in with it. Without
      // this the field would forget there is one the moment it's emptied.
      if (msg.state === 'signed-in' && state.config) state.config.hasToken = true;
      renderAuth();
      renderGuilds();
      // A failed background sign-in is a nuisance, not a fault — the tally
      // lamp stays where it is and only the Source panel says so.
      if (msg.state === 'error') log(msg.message, 'warn');
      else if (msg.message) log(msg.message);
      return;

    case 'guilds': {
      const before = state.discord.guilds || [];
      state.discord = {
        ...state.discord,
        guilds: msg.guilds,
        botTag: msg.botTag || state.discord.botTag,
        botId: msg.botId || state.discord.botId,
      };
      renderAuth();
      renderGuilds();

      if (!msg.auto) {
        log(
          msg.guilds.length
            ? `${msg.guilds.length} server${msg.guilds.length === 1 ? '' : 's'} with voice channels.`
            : 'The bot is not in any server with a voice channel yet.'
        );
        return;
      }
      // Discord changed something by itself. A renamed channel needs no
      // announcement; a server arriving or leaving does.
      const had = new Set(before.map((g) => g.id));
      const has = new Set(msg.guilds.map((g) => g.id));
      for (const g of msg.guilds) if (!had.has(g.id)) log(`The bot can now reach ${g.name}.`);
      for (const g of before) if (!has.has(g.id)) log(`${g.name} is no longer in the server list.`);
      return;
    }

    case 'paused':
      state.paused = msg.paused;
      renderLive();
      log(
        msg.paused
          ? 'Captions paused — still in the call, but nothing goes out. The overlay was cleared.'
          : 'Captions resumed.',
        msg.paused ? 'warn' : 'info'
      );
      return;

    case 'cleared':
      clearMonitor();
      return;

    case 'overlays':
      state.overlays = { local: msg.local, remote: msg.remote };
      renderOverlays();
      renderSetup();
      return;

    case 'speech':
      if (msg.state === 'loading') {
        setTally('linking', 'Loading model');
        // The large models take ~30s. Say so, or it reads as a freeze.
        log(
          `Loading ${modelName(msg.modelPath)}… ` +
            `(large models can take 30s or more)`
        );
      } else if (msg.state === 'ready') {
        log(
          `${msg.engineLabel} ready in ${msg.loadMs} ms` +
            (msg.streaming ? '' : ' (transcribes complete phrases)')
        );
        state.loadedModel = msg.modelPath;
        renderModelPath();
      } else if (msg.state === 'error') {
        setTally('fault', 'Model fault');
        log(msg.message, 'error');
      }
      return;

    case 'server':
      if (msg.state === 'ready') {
        el.urlOverlay.textContent = msg.urls.overlay;
        el.port.value = msg.port;
        log(`Caption server on port ${msg.port}`);
      } else {
        log(msg.message, 'error');
      }
      return;

    case 'tunnel': {
      const { type, message, level, phase, progress, ...next } = msg;
      state.share = { ...state.share, ...next };
      renderShare({ message, level, phase, progress });
      if (message) log(message, level || 'info');
      return;
    }

    case 'stats': {
      const bits = [];
      if (msg.speakers !== undefined) bits.push(`${msg.speakers} ch`);
      if (msg.rss) bits.push(`${(msg.rss / 1048576).toFixed(0)} MB`);
      if (bits.length) el.stats.textContent = bits.join(' · ');
      return;
    }

    case 'captionCleared':
      dropPartial(msg.userId);
      return;

    case 'filter':
      el.filterCount.textContent = `${msg.masked} masked`;
      return;

    case 'log':
      if (msg.message) log(msg.message, msg.level);
      return;

    default:
      return;
  }
}

// ----------------------------------------------------------------- init --

/**
 * The catalogue, cached from the main process. The cost hints below are built
 * from it rather than hardcoded here, so a new model cannot end up in the picker
 * with no explanation of what it will do to your CPU.
 */
let catalog = [];

const byDir = (dirName) => catalog.find((m) => m.dir === dirName) || null;

function formatMB(mb) {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/** A model's directory name — its identity, and what the UI shows. */
const modelName = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '';

/**
 * The model stamp in the Source header.
 *
 * Two different things want to live there and they are not the same thing. Before
 * Connect it should say what *will* load; while running it has to say what
 * actually did, because the model is only loaded at connect time and changing the
 * dropdown mid-call does not swap it. When those diverge, say so — otherwise
 * switching models while connected looks like it silently did nothing.
 */
function renderModelPath() {
  const selected = el.model.value || (state.config && state.config.modelPath) || state.modelPath;
  const effective = state.running && state.loadedModel ? state.loadedModel : selected;

  if (!effective) {
    el.modelPath.textContent = 'No model installed';
    el.modelPath.title = '';
    return;
  }

  const name = modelName(effective);
  // Compared by directory name, not by path string. The two sides reach here by
  // different routes — one from the engine, one from the picker — and a
  // difference in separators or drive-letter case would otherwise read as "you
  // switched models" when nothing had changed. Directory names are unique across
  // the catalogue, so they are the identity that matters.
  const pending = state.running && state.loadedModel && selected && modelName(selected) !== name;

  el.modelPath.textContent = pending ? `${name} · switch pending` : name;
  el.modelPath.title = pending
    ? `Running ${name}. Reconnect to switch to ${modelName(selected)}.`
    : effective;
}

function renderModels() {
  const models = state.models || [];
  el.model.replaceChildren();

  if (!models.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No model installed';
    el.model.appendChild(opt);
    el.model.disabled = true;
    // Names the model that suits this PC once the catalogue has arrived.
    updateModelNote();
    // Nothing works without a model, so open the picker rather than making the
    // user hunt for it.
    el.modelList.hidden = false;
    el.manageModels.textContent = 'Hide';
    renderModelPath();
    renderSetup();
    return;
  }

  el.model.disabled = false;
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.path;
    opt.textContent = m.label;
    el.model.appendChild(opt);
  }
  // An unset modelPath means "use the best installed", which is what the main
  // process already resolved into state.modelPath.
  el.model.value = state.config.modelPath || state.modelPath || models[0].path;
  updateModelNote();
  // Covers install, remove, and every getState refresh — all of which can change
  // what is selected without anyone touching the dropdown.
  renderModelPath();
  renderSetup();
}

/**
 * Which of the two recommended models suits this machine, as the main process
 * judged it from RAM and CPU threads: `{ key, tier, limitedBy, ramGB,
 * cpuThreads }`. Null until the catalogue arrives.
 */
let suggestion = null;

/** The catalogue entry for the suggestion, once both are known. */
const suggestedModel = () =>
  (suggestion && catalog.find((m) => m.key === suggestion.key)) || null;

/**
 * One line above the list that answers "which one?" for this PC, with the
 * reason — so nobody has to know whether their machine counts as high end.
 */
function suggestionLine() {
  const pick = suggestedModel();
  if (!pick) return null;

  const li = document.createElement('li');
  li.className = 'model-suggest';
  const name = document.createElement('strong');
  name.textContent = pick.label;

  // The 16 GB and 6-thread figures follow recommendedModelFor() in
  // src/shared/models.js.
  const best = catalog.find((m) => m.recommended === 'capable');
  const bestName = best ? best.label : 'The larger model';
  let why = ' — the most accurate model here.';
  if (suggestion.limitedBy === 'ram') {
    why = `. ${bestName} is more accurate, but wants a PC with 16 GB of RAM.`;
  } else if (suggestion.limitedBy === 'cpu') {
    why = `. ${bestName} is more accurate, but needs at least 6 CPU threads to keep up.`;
  }

  const specs = `${suggestion.ramGB} GB RAM, ${suggestion.cpuThreads} CPU threads`;
  const text = document.createElement('span');
  text.append(`For this PC (${specs}): `, name, why);
  li.append(text);

  if (!pick.installed) {
    const get = document.createElement('button');
    get.className = 'btn btn-sm btn-primary';
    get.textContent = fetchingSuggested ? 'Downloading…' : `Download ${pick.label}`;
    get.disabled = fetchingSuggested;
    get.addEventListener('click', downloadSuggested);
    li.append(get);
  }
  return li;
}

/** True while the one-click download is running, so it can't be started twice. */
let fetchingSuggested = false;

/**
 * The first-run shortcut: fetch the model this PC was matched to without
 * reading the list. Drives that model's own row, so progress shows where it
 * always does.
 */
async function downloadSuggested() {
  const pick = suggestedModel();
  if (!pick || pick.installed || fetchingSuggested) return;

  el.modelList.hidden = false;
  el.manageModels.textContent = 'Hide';
  const rowButton = el.modelList.querySelector(
    `.model-row[data-model="${CSS.escape(pick.key)}"] .model-action button`
  );
  // Already downloading from its own row.
  if (!rowButton || rowButton.disabled) return;

  fetchingSuggested = true;
  for (const b of el.modelList.querySelectorAll('.model-suggest button')) {
    b.disabled = true;
    b.textContent = 'Downloading…';
  }
  renderSetup();
  try {
    await downloadModelRow(pick, rowButton);
  } finally {
    fetchingSuggested = false;
    // Success redraws the catalogue; a failure leaves the Retry on the row
    // and puts this button back.
    for (const b of el.modelList.querySelectorAll('.model-suggest button')) {
      b.disabled = false;
      b.textContent = `Download ${pick.label}`;
    }
    renderSetup();
  }
}

/** Catalogue rows: download / installed / remove, with a progress bar. */
async function renderModelCatalog() {
  const fetched = await window.chatterlayer.modelCatalog();
  catalog = fetched.catalog;
  suggestion = fetched.suggestion || null;
  el.modelList.replaceChildren();

  const line = suggestionLine();
  if (line) el.modelList.appendChild(line);

  let engine = null;
  for (const m of catalog) {
    // The catalogue spans four speech engines. Grouping them keeps a list of
    // nine models readable, and makes it obvious that Whisper Tiny and Whisper
    // Small are the same thing at two sizes.
    if (m.engine !== engine) {
      engine = m.engine;
      const head = document.createElement('li');
      head.className = 'model-group';
      head.textContent = m.label.split(' ')[0];
      el.modelList.appendChild(head);
    }

    const li = document.createElement('li');
    li.className = `model-row${m.installed ? ' installed' : ''}`;
    // Lit along its edge like a live strip: the model the line above picked.
    if (suggestion && m.key === suggestion.key) li.classList.add('suggested');
    li.dataset.model = m.key;

    const info = document.createElement('div');
    info.className = 'model-info';

    const title = document.createElement('strong');
    title.textContent = m.label;
    if (m.recommended) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent =
        m.recommended === 'light' ? 'Recommended for lighter PCs' : 'Recommended';
      title.append(' ', pill);
    }

    const size = document.createElement('small');
    size.textContent =
      `${formatMB(m.downloadMB)} download · ~${formatMB(m.ramMB)} memory` +
      (m.maxSpeakers
        ? ` · ${m.maxSpeakers === 1 ? '1 speaker' : `up to ~${m.maxSpeakers} speakers`}`
        : '');

    const blurb = document.createElement('p');
    blurb.textContent = m.blurb;

    info.append(title, size, blurb);

    const action = document.createElement('div');
    action.className = 'model-action';

    if (m.installed) {
      const tick = document.createElement('span');
      tick.className = 'installed-tag';
      tick.textContent = 'Installed';
      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost btn-sm';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removeModelRow(m));
      action.append(tick, remove);
    } else {
      const get = document.createElement('button');
      get.className = 'btn btn-sm';
      get.textContent = 'Download';
      get.addEventListener('click', () => downloadModelRow(m, get));
      action.append(get);
    }

    const bar = document.createElement('div');
    bar.className = 'model-bar';
    bar.appendChild(document.createElement('i'));

    li.append(info, action, bar);
    el.modelList.appendChild(li);
  }

  // renderModels() runs first and has no catalogue to describe the selection
  // from yet, so the note is filled in once it arrives.
  updateModelNote();
  renderSetup();
}

async function downloadModelRow(model, button) {
  button.disabled = true;
  button.textContent = 'Starting…';
  log(`Downloading ${model.label} speech model (~${model.downloadMB} MB)…`);
  try {
    await window.chatterlayer.installModel(model.key);
    log(`${model.label} model installed.`);
    // Refresh both the picker and the catalogue.
    state = { ...state, ...(await window.chatterlayer.getState()) };
    renderModels();
    await renderModelCatalog();
  } catch (err) {
    log(`Download failed: ${err.message}`, 'error');
    button.disabled = false;
    button.textContent = 'Retry';
  }
}

async function removeModelRow(model) {
  try {
    await window.chatterlayer.removeModel(model.key);
    log(`${model.label} model removed.`);
    state = { ...state, ...(await window.chatterlayer.getState()) };
    renderModels();
    await renderModelCatalog();
  } catch (err) {
    log(err.message, 'error');
  }
}

/** Live progress for the row currently downloading. */
function onModelProgress(p) {
  const row = el.modelList.querySelector(`[data-model="${CSS.escape(p.key)}"]`);
  if (!row) return;
  const bar = row.querySelector('.model-bar i');
  const button = row.querySelector('.model-action button');

  if (p.phase === 'download' && p.total) {
    const pct = (p.received / p.total) * 100;
    bar.style.width = `${pct}%`;
    if (button) button.textContent = `${pct.toFixed(0)}%`;
  } else if (p.phase === 'verify') {
    bar.style.width = '100%';
    if (button) button.textContent = 'Checking…';
  } else if (p.phase === 'extract') {
    bar.style.width = '100%';
    if (button) button.textContent = 'Unpacking…';
  } else if (p.phase === 'done' || p.phase === 'error') {
    bar.style.width = '0%';
  }
}

/**
 * What picking this model will cost you, in the same place you pick it.
 *
 * The speaker figure is the part people actually need: memory is shared across
 * speakers on every engine here, so what runs out first is CPU, and the way it
 * runs out is captions arriving late rather than an error.
 */
function updateModelNote() {
  // Nothing installed yet, so there is no selection to describe: point at the
  // model that suits this PC instead. The first call comes before the catalogue
  // has arrived; renderModelCatalog() calls back in once it has.
  if (!(state.models || []).length) {
    const pick = suggestedModel();
    el.modelNote.textContent =
      'ChatterLayer needs a speech model before it can caption. ' +
      (pick ? `${pick.label} suits this PC — download it below.` : 'Choose one below.');
    el.modelNote.classList.remove('warn');
    return;
  }

  const name = modelName(el.model.value);
  const model = byDir(name);

  const parts = [];
  if (model) {
    parts.push(model.blurb);
    parts.push(`~${formatMB(model.ramMB)} memory.`);
    if (model.maxSpeakers) {
      const live = state.members.filter((m) => m.selected).length;
      const limit =
        model.maxSpeakers === 1 ? 'one speaker' : `about ${model.maxSpeakers} speakers`;
      parts.push(
        live > model.maxSpeakers
          ? `You have ${live} on — this model keeps up with ${limit}, so captions may lag.`
          : `Comfortable with ${limit} at once.`
      );
    }
  } else {
    parts.push('Custom model.');
  }
  if (state.running) parts.push('Reconnect to switch models.');

  el.modelNote.textContent = parts.join(' ');
  el.modelNote.classList.toggle(
    'warn',
    Boolean(
      model &&
        model.maxSpeakers &&
        state.members.filter((m) => m.selected).length > model.maxSpeakers
    )
  );
}

function syncFaderLabels() {
  el.vFont.textContent = el.fontSize.value;
  el.vLife.textContent = `${(Number(el.lifetime.value) / 1000).toFixed(1)}s`;
  el.vLines.textContent = el.maxLines.value;

  // The monitor stands in for the overlay, so every control that shapes the
  // overlay has to shape it too. Size is scaled rather than mirrored: 30px on a
  // 1920px scene is a different thing from 30px in a 600px panel, so the range
  // is compressed to keep the small end readable and the big end in the box.
  el.preview.style.setProperty(
    '--preview-size',
    `${(9 + Number(el.fontSize.value) * 0.3).toFixed(1)}px`
  );
  // The overlay re-trims whenever settings arrive, so lowering Max lines takes
  // effect on what's already showing rather than only on the next caption.
  trimMonitor();
}

// --------------------------------------------------------------- version --

/**
 * Paint the build stamp. Monochrome while there's nothing to do; amber with a
 * lamp when a newer release exists. Clicking it always opens the release page,
 * whatever state it's in.
 */
function renderUpdate(update) {
  const running = state.version ? `v${state.version}` : '—';

  if (update && update.state === 'available' && update.latest) {
    // Tags are cut as v1.2.3, but don't end up with "1.2.3 available" sitting
    // next to a "v0.0.5" stamp if one ever isn't.
    const tag = update.latest.startsWith('v') ? update.latest : `v${update.latest}`;
    el.build.dataset.state = 'available';
    el.buildVersion.textContent = `${tag} available`;
    el.build.title = `You're on ${running} — click to open the release page.`;
    return;
  }

  el.build.dataset.state = 'current';
  el.buildVersion.textContent = running;
  el.build.title =
    update && update.state === 'off'
      ? 'Update checks are off. Click to open the release page.'
      : 'Click to open the release page on GitHub.';
}

/**
 * @param {boolean} announce  log the outcome even when it's uninteresting.
 *   True when the user asked; false on launch, where a silent failure is
 *   kinder than telling an offline user their update check didn't work.
 */
async function refreshUpdate(announce = false) {
  let update;
  try {
    update = await window.chatterlayer.checkUpdate({ force: announce });
  } catch {
    return; // Never let a version check disturb the app.
  }
  state.update = update;
  renderUpdate(update);

  if (update.state === 'available') {
    log(`ChatterLayer ${update.latest} is out — you're on v${update.current}.`);
  } else if (announce && update.state === 'current') {
    log(`You're on the latest build (v${update.current}).`);
  } else if (announce && update.state === 'error') {
    log(`Couldn't check for updates: ${update.message}`, 'warn');
  }
}

// ---------------------------------------------------------- remote share --

const SHARE_NOTE_DEFAULT =
  'The link carries an access key — without it the page returns 401, so a ' +
  'guessed tunnel address gets nothing.';

/**
 * Draw the sharing panel.
 *
 * @param {{message?: string, level?: string, phase?: string, progress?: object}} [extra]
 *   Transient detail from the last tunnel event: a message to show, or which
 *   step of starting up we're on.
 */
function renderShare(extra = {}) {
  const s = state.share;

  el.shareEnabled.checked = s.enabled;
  el.sharePanel.hidden = !s.enabled;
  el.shareStart.disabled = !s.enabled || s.running || s.busy;
  el.shareStop.disabled = !s.running && !s.busy;
  // Nothing to rotate when no tunnel is up — the key dies with the session.
  el.shareRotate.disabled = !s.running;
  el.urlShare.textContent = s.url || '—';

  if (!s.enabled) el.shareMeta.textContent = 'Off';
  else if (s.running) el.shareMeta.textContent = 'Sharing';
  else if (s.busy) el.shareMeta.textContent = 'Opening…';
  else el.shareMeta.textContent = 'Armed';

  const note = el.shareNote;
  const setNote = (text, lampState) => {
    note.textContent = text;
    if (lampState) note.dataset.state = lampState;
    else delete note.dataset.state;
  };

  if (extra.message) {
    setNote(
      extra.message,
      extra.level === 'error' ? 'fault' : extra.level === 'warn' ? 'working' : 'ok'
    );
    return;
  }
  if (extra.phase === 'download') {
    // First run only — cloudflared is fetched once and kept.
    const { received = 0, total = 0 } = extra.progress || {};
    const pct = total ? ` ${Math.round((received / total) * 100)}%` : '';
    setNote(`Downloading cloudflared (one time)…${pct}`, 'working');
    return;
  }
  if (extra.phase === 'install') return setNote('Unpacking cloudflared…', 'working');
  if (extra.phase === 'starting') return setNote('Asking Cloudflare for a link…', 'working');

  if (s.running) {
    setNote('Live. Anyone with this exact link sees these captions.', 'ok');
    return;
  }
  setNote(SHARE_NOTE_DEFAULT);
}

// --------------------------------------------------------- setup path --

/**
 * The first run, lamp by lamp, in the order signal travels. Each is read from
 * state the app already has rather than tracked separately, so a lamp can't
 * claim something is done that isn't.
 */
const SETUP_STEPS = ['model', 'token', 'server', 'channel', 'obs'];

function setupStatus() {
  return {
    model: (state.models || []).length > 0,
    token: state.discord.auth === 'signed-in',
    server: (state.discord.guilds || []).length > 0,
    channel: Boolean(effectiveChannelId()),
    obs: state.overlays.local > 0,
  };
}

/** What to say, and offer, for the first unlit step. */
function setupNext(step) {
  const pick = suggestedModel();
  switch (step) {
    case 'model':
      if (fetchingSuggested) return { hint: `Downloading ${pick ? pick.label : 'the model'}…` };
      return pick
        ? {
            hint: `${pick.label} suits this PC. Nothing captions until a speech model is installed.`,
            action: { label: `Download ${pick.label}`, run: downloadSuggested },
          }
        : { hint: 'Download a speech model from the list below.' };
    case 'token':
      return {
        hint:
          state.discord.auth === 'error'
            ? 'Sign-in failed — check the bot token in Source.'
            : 'Paste your Discord bot token into Source. It signs in by itself.',
        action: { label: 'How do I make a bot?', run: openBotGuide },
      };
    case 'server':
      return {
        hint: 'The bot isn’t in a server with a voice channel yet.',
        action: state.discord.botId ? { label: 'Invite the bot', run: openInvite } : null,
      };
    case 'channel':
      return {
        hint: 'Choose the voice channel to caption in Source.',
        action: { label: 'Choose channel', run: () => el.voiceChannel.focus() },
      };
    default:
      return {
        hint: 'In OBS, add a Browser source with the overlay URL from Output, sized to your canvas.',
        action: { label: 'Copy overlay URL', run: copyOverlayUrl },
      };
  }
}

let setupAction = null;
/** Guards the one config write that retires the checklist. */
let setupRetired = false;

function renderSetup() {
  if (!state.config || state.config.setupDone || setupRetired) {
    el.setup.hidden = true;
    return;
  }

  el.setup.dataset.source = currentSource();
  // The mic alone needs no bot, server or channel.
  const steps =
    currentSource() === 'mic' ? SETUP_STEPS.filter((s) => s === 'model' || s === 'obs') : SETUP_STEPS;
  const done = setupStatus();
  const next = steps.find((step) => !done[step]);
  if (!next) {
    log('Setup complete — every lamp is lit. Captions go out as soon as someone speaks.');
    retireSetup();
    return;
  }

  el.setup.hidden = false;
  for (const li of el.setupPath.children) {
    const step = li.dataset.step;
    li.dataset.state = done[step] ? 'done' : step === next ? 'next' : '';
  }
  const lit = steps.filter((step) => done[step]).length;
  el.setupMeta.textContent = `${lit} of ${steps.length}`;

  const { hint, action } = setupNext(next);
  el.setupHint.textContent = hint;
  setupAction = action ? action.run : null;
  el.setupAction.hidden = !action;
  if (action) el.setupAction.textContent = action.label;
}

/** Gone for good: not back when OBS closes, nor after an update. */
async function retireSetup() {
  el.setup.hidden = true;
  if (setupRetired) return;
  setupRetired = true;
  state.config = await window.chatterlayer.updateConfig({ setupDone: true });
}

function openBotGuide() {
  window.chatterlayer.openExternal(BOT_GUIDE_URL);
}

async function copyOverlayUrl() {
  const url = el.urlOverlay.textContent;
  if (!url || url === '—') return;
  await window.chatterlayer.copy(url);
  log('Overlay URL copied — paste it into a Browser source in OBS.');
}

// ------------------------------------------------------------- overlays --

/**
 * The server sees OBS connect, so the app can say so rather than leaving
 * people to alt-tab and check. A browser on this PC opening the URL counts
 * too, which is fine: it's the same page OBS would get.
 */
function renderOverlays() {
  const n = state.overlays.local;
  el.obsMeta.dataset.on = n ? '1' : '0';
  el.obsMeta.textContent = !n ? 'OBS not connected' : n === 1 ? 'OBS connected' : `${n} sources connected`;
  el.obsMeta.title = n
    ? 'A browser source on this PC is showing the overlay right now.'
    : 'Nothing on this PC has the overlay open. Add the URL below to OBS as a Browser source.';
}

// ------------------------------------------------------------ what's new --

function renderWhatsNew() {
  const notes = state.whatsNew;
  el.whatsNew.hidden = !(notes && notes.length);
  if (el.whatsNew.hidden) return;

  el.whatsNewTitle.textContent = `What’s new in v${notes[0].version}`;
  el.whatsNewBody.replaceChildren();
  for (const release of notes) {
    // Several versions at once only happens after skipping an update, and then
    // it matters which change came when.
    if (notes.length > 1) {
      const head = document.createElement('h3');
      head.className = 'news-version';
      head.textContent = `v${release.version}`;
      el.whatsNewBody.appendChild(head);
    }
    const list = document.createElement('ul');
    list.className = 'news';
    for (const item of release.items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    }
    el.whatsNewBody.appendChild(list);
  }
}

async function init() {
  state = { ...state, ...(await window.chatterlayer.getState()) };
  const c = state.config;

  el.channel.value = c.channelId || '';
  renderSource();
  renderMics();
  el.micSensitivity.value = c.mic.sensitivity;
  el.micHang.value = c.mic.hangMs;
  syncGateLabels();
  renderAuth();
  renderGuilds();
  if (c.hasToken) maskToken();
  el.tokenHint.textContent = c.tokenEncrypted
    ? 'Encrypted by your OS keystore.'
    : 'No OS keystore here — the token is stored in plain text. Keep the config file private.';

  el.fontSize.value = c.overlay.fontSize;
  el.lifetime.value = c.overlay.captionLifetimeMs;
  el.maxLines.value = c.overlay.maxLines;
  el.showPartials.checked = c.overlay.showPartials;
  el.showNames.checked = c.overlay.showSpeakerName;
  el.port.value = c.server.port;
  el.filterEnabled.checked = c.filter.enabled;
  el.filterCustom.value = (c.filter.custom || []).join('\n');
  el.checkUpdates.checked = c.updates.check;
  el.closeToTray.checked = c.tray.closeToTray;
  for (const radio of el.theme.querySelectorAll('input')) {
    radio.checked = radio.value === c.appearance.theme;
  }
  el.launchAtLogin.checked = c.startup.atLogin;
  // Electron has no login items on Linux.
  el.loginRow.hidden = state.platform === 'linux';
  el.hotkeysEnabled.checked = c.hotkeys.enabled;
  el.hotkeysHint.textContent =
    `${state.hotkeys.pause} pauses or resumes captions, ${state.hotkeys.clear} clears them. ` +
    'They work while a game has focus, and take those keys from every other app.';
  renderLive();
  syncFaderLabels();

  if (state.urls && state.urls.overlay) el.urlOverlay.textContent = state.urls.overlay;
  renderShare();
  renderOverlays();
  renderWhatsNew();

  renderModels();
  renderModelCatalog();

  renderMembers();
  renderUpdate(null);
  log(`ChatterLayer v${state.version} ready.`);

  // Deliberately not awaited: the window is usable before GitHub answers, and
  // the request gives up after six seconds either way.
  refreshUpdate();
}

// ------------------------------------------------------------ listeners --

el.toggleToken.addEventListener('click', () => {
  const showing = el.token.type === 'text';
  el.token.type = showing ? 'password' : 'text';
  el.toggleToken.textContent = showing ? 'Show' : 'Hide';
});

/** Stands in for a saved token, which never comes back to the renderer. */
function maskToken() {
  el.token.value = '••••••••••••••••••••••••';
  el.token.dataset.masked = '1';
}

// Clear the mask on first edit so the placeholder is never saved as a token.
el.token.addEventListener('focus', () => {
  if (el.token.dataset.masked) {
    el.token.value = '';
    delete el.token.dataset.masked;
  }
});

// Clicking in and back out without typing must not leave the field looking
// wiped: the saved token is still there, so the dots come back.
el.token.addEventListener('blur', () => {
  if (!el.token.value.trim() && state.config && state.config.hasToken) maskToken();
});

/**
 * Bot tokens are three dot-separated parts. This decides *when* to sign in on
 * its own — not whether a token is acceptable — so that a half-typed one
 * doesn't fire a sign-in per keystroke. Anything it doesn't recognise still
 * signs in from the button, which is what Discord changing the shape would
 * look like.
 */
const looksLikeToken = (t) => /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/.test(t);

async function signIn(token) {
  try {
    await window.chatterlayer.signIn(token);
  } catch (err) {
    log(err.message, 'error');
  }
}

/** The last token we tried, so retyping the same one doesn't sign in twice. */
let attemptedToken = '';

// Sign in a moment after typing stops, so pasting the token is the whole step.
const signInWhenPasted = debounce(() => {
  const token = el.token.value.trim();
  if (el.token.dataset.masked || !looksLikeToken(token)) return;
  if (token === attemptedToken || state.discord.auth === 'signing-in') return;
  attemptedToken = token;
  signIn(token);
}, 700);

el.token.addEventListener('input', signInWhenPasted);

el.start.addEventListener('click', async () => {
  el.start.disabled = true;
  setTally('linking', 'Linking');
  try {
    await window.chatterlayer.start({
      token: el.token.dataset.masked ? undefined : el.token.value.trim() || undefined,
      // Undefined rather than empty: if the pickers haven't populated yet,
      // this must fall through to the remembered channel, not erase it.
      channelId: effectiveChannelId() || undefined,
      guildId: el.guild.value || undefined,
    });
  } catch (err) {
    setTally('fault', 'Fault');
    log(err.message, 'error');
    el.start.disabled = false;
  }
});

el.source.addEventListener('change', async (e) => {
  const source = e.target.value;
  state.config = await window.chatterlayer.updateConfig({ source });
  // Choosing the mic is asking for it to be captioned; its switch starts on.
  const selected = state.config.selected || [];
  if (source !== 'discord' && !selected.includes('mic')) {
    state.config.selected = await window.chatterlayer.setSelected([...selected, 'mic']);
  }
  renderSource();
  renderSetup();
  log(
    {
      discord: 'Source: the Discord call.',
      mic: 'Source: your mic only. ChatterLayer won’t sign in to Discord for this.',
      both: 'Source: the Discord call and your mic.',
    }[source]
  );
  // The launch sign-in was skipped while only the mic was in use; the pickers
  // need it back now.
  const d = state.discord.auth;
  if (source !== 'mic' && state.config.hasToken && d !== 'signed-in' && d !== 'signing-in') {
    signIn();
  }
});

el.micDevice.addEventListener('change', async () => {
  state.config = await window.chatterlayer.updateConfig({
    mic: { ...state.config.mic, deviceId: el.micDevice.value },
  });
  // A live capture moves to the new mic straight away.
  if (mic) {
    stopMic();
    syncMic();
  }
});

for (const input of [el.micSensitivity, el.micHang]) {
  input.addEventListener('input', () => {
    syncGateLabels();
    saveMicGate();
  });
}

navigator.mediaDevices.addEventListener('devicechange', () => {
  if (state.config) renderMics();
});

el.stop.addEventListener('click', async () => {
  el.stop.disabled = true;
  await window.chatterlayer.stop();
});

for (const input of [el.fontSize, el.lifetime, el.maxLines]) {
  input.addEventListener('input', () => {
    syncFaderLabels();
    saveOverlay();
  });
}
for (const box of [el.showPartials, el.showNames]) {
  box.addEventListener('change', () => {
    syncFaderLabels();
    saveOverlay();
  });
}
el.port.addEventListener('change', savePort);
el.filterEnabled.addEventListener('change', () => {
  saveFilter();
  log(
    el.filterEnabled.checked
      ? 'Word filter on.'
      : 'Word filter OFF — captions go out unmasked.',
    el.filterEnabled.checked ? 'info' : 'warn'
  );
});
el.filterCustom.addEventListener('input', saveFilter);

el.refreshGuilds.addEventListener('click', () => {
  const token = el.token.dataset.masked ? undefined : el.token.value.trim() || undefined;
  // A deliberate press retries a token the debounce already gave up on.
  attemptedToken = token || '';
  return signIn(token);
});

el.guild.addEventListener('change', async () => {
  state.config = await window.chatterlayer.updateConfig({ guildId: el.guild.value });
  renderChannels();
  await persistChannel();
});

el.voiceChannel.addEventListener('change', async () => {
  updateChannelNote();
  await persistChannel();
});

el.toggleManual.addEventListener('click', () => {
  const wasOpen = !el.manualChannel.hidden;
  el.manualChannel.hidden = wasOpen;
  el.toggleManual.textContent = wasOpen
    ? 'Enter a channel ID manually'
    : 'Use the pickers instead';
  if (wasOpen) persistChannel();
});

el.channel.addEventListener('change', () =>
  window.chatterlayer.updateConfig({ channelId: el.channel.value.trim() })
);
el.channel.addEventListener('input', renderSetup);

el.botGuide.addEventListener('click', openBotGuide);
el.inviteBot.addEventListener('click', openInvite);

el.setupAction.addEventListener('click', () => {
  if (setupAction) setupAction();
});
el.setupHide.addEventListener('click', () => {
  retireSetup();
  log('Setup checklist hidden.');
});

el.whatsNewClose.addEventListener('click', () => {
  el.whatsNew.hidden = true;
  state.whatsNew = null;
  window.chatterlayer.dismissWhatsNew();
});
el.whatsNewNotes.addEventListener('click', () =>
  window.chatterlayer.openExternal(
    `https://github.com/ruptz/ChatterLayer/releases/tag/v${state.version}`
  )
);
el.whatsNewKofi.addEventListener('click', () => window.chatterlayer.openExternal(KOFI_URL));

el.manageModels.addEventListener('click', () => {
  el.modelList.hidden = !el.modelList.hidden;
  el.manageModels.textContent = el.modelList.hidden ? 'Get models' : 'Hide';
});

el.model.addEventListener('change', async () => {
  state.config = await window.chatterlayer.updateConfig({ modelPath: el.model.value });
  updateModelNote();
  renderModelPath();
  const name = modelName(el.model.value);
  // The model is loaded once at connect time, so a live switch needs a restart.
  log(`Speech model set to ${name}${state.running ? ' — reconnect to apply' : ''}`);
});

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = $(btn.dataset.copy).textContent;
    if (!text || text === '—') return;
    await window.chatterlayer.copy(text);
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = original), 1200);
  });
}

el.testCaption.addEventListener('click', async () => {
  const { local, paused } = await window.chatterlayer.testCaption();
  if (paused) {
    log('Captions are paused, so the test caption went nowhere. Resume to send one.', 'warn');
  } else if (!local) {
    log('Test caption sent, but no OBS source is connected — only the Monitor shows it.', 'warn');
  }
});

el.report.addEventListener('click', async () => {
  try {
    await window.chatterlayer.reportProblem(el.log.textContent);
    log('Opened a bug report in your browser. Read it over before you submit — nothing is sent until you do.');
  } catch (err) {
    log(`Couldn't open the bug report: ${err.message}`, 'error');
  }
});

/** The monitor's half of Clear; the main process wipes the overlay. */
function clearMonitor() {
  el.preview.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'Cleared.';
  el.preview.appendChild(empty);
  partials.clear();
}

// The main process answers with a `cleared` event, which is also what the
// Clear hotkey sends, so both paths empty the monitor the same way.
el.clear.addEventListener('click', () => window.chatterlayer.clearCaptions());

el.pause.addEventListener('click', () => window.chatterlayer.setPaused(!state.paused));

el.shareEnabled.addEventListener('change', async () => {
  const on = el.shareEnabled.checked;
  state.share = await window.chatterlayer.setShareEnabled(on);
  renderShare();
  log(
    on
      ? 'Remote overlay armed — nothing is open yet, press Start tunnel for a link.'
      : 'Remote overlay off.'
  );
});

el.shareStart.addEventListener('click', async () => {
  el.shareStart.disabled = true;
  try {
    state.share = await window.chatterlayer.startShare();
    renderShare();
    log(`Remote overlay live at ${state.share.origin}`);
  } catch (err) {
    log(err.message, 'error');
    renderShare({ message: err.message, level: 'error' });
  }
});

el.shareStop.addEventListener('click', async () => {
  el.shareStop.disabled = true;
  state.share = await window.chatterlayer.stopShare();
  renderShare();
  log('Remote overlay stopped — the shared link is dead.');
});

el.shareRotate.addEventListener('click', async () => {
  try {
    state.share = await window.chatterlayer.rotateShareToken();
    renderShare();
  } catch (err) {
    log(err.message, 'error');
  }
});

// --------------------------------------------------------- app settings --

function openSettings(open) {
  el.settingsPanel.hidden = !open;
  el.settingsToggle.setAttribute('aria-expanded', String(open));
}

el.settingsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  openSettings(el.settingsPanel.hidden);
});

// Click anywhere else, or press Escape, and it goes away — a panel this small
// doesn't deserve a close button.
document.addEventListener('click', (e) => {
  if (el.settingsPanel.hidden) return;
  if (!el.settingsPanel.contains(e.target)) openSettings(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.settingsPanel.hidden) {
    openSettings(false);
    el.settingsToggle.focus();
  }
});

el.closeToTray.addEventListener('change', async () => {
  const on = el.closeToTray.checked;
  state.config = await window.chatterlayer.updateConfig({
    tray: { ...state.config.tray, closeToTray: on },
  });
  log(
    on
      ? 'Closing the window will keep ChatterLayer running in the tray.'
      : 'Closing the window will now quit ChatterLayer and end the call.'
  );
});

// The main process owns the switch itself (nativeTheme), which is what the
// stylesheet's prefers-color-scheme follows, so this only has to save it.
el.theme.addEventListener('change', async (e) => {
  state.config = await window.chatterlayer.updateConfig({ appearance: { theme: e.target.value } });
});

el.launchAtLogin.addEventListener('change', async () => {
  const on = el.launchAtLogin.checked;
  state.config = await window.chatterlayer.updateConfig({ startup: { atLogin: on } });
  log(
    on
      ? 'ChatterLayer will start with the computer, in the tray, signed in and waiting.'
      : 'ChatterLayer will no longer start with the computer.'
  );
});

el.hotkeysEnabled.addEventListener('change', async () => {
  const on = el.hotkeysEnabled.checked;
  state.config = await window.chatterlayer.updateConfig({ hotkeys: { enabled: on } });
  log(on ? `Global hotkeys on: ${state.hotkeys.pause} pause/resume, ${state.hotkeys.clear} clear.` : 'Global hotkeys off.');
});

el.reveal.addEventListener('click', () => window.chatterlayer.revealConfig());
el.clearLog.addEventListener('click', () => el.log.replaceChildren());

el.donate.addEventListener('click', () => window.chatterlayer.openExternal(KOFI_URL));

el.build.addEventListener('click', () =>
  window.chatterlayer.openExternal(
    (state.update && state.update.url) || state.releasesUrl
  )
);

el.checkUpdates.addEventListener('change', async () => {
  const on = el.checkUpdates.checked;
  state.config = await window.chatterlayer.updateConfig({
    updates: { ...state.config.updates, check: on },
  });
  if (on) {
    // Switching it on is a request for an answer now, not tomorrow.
    refreshUpdate(true);
  } else {
    state.update = { state: 'off' };
    renderUpdate(state.update);
    log('Update checks off — ChatterLayer now makes no requests of its own.');
  }
});

window.chatterlayer.onModelProgress(onModelProgress);
window.chatterlayer.onEvent(handleEvent);
window.chatterlayer.onCaption(addCaption);
window.chatterlayer.onMembers((members) => {
  state.members = members;
  renderMembers();
  syncMic();
});

init();
