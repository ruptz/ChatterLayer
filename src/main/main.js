'use strict';
/**
 * Owns the window, config, caption server and engine supervisor, and passes
 * messages between them.
 *
 * Colours and display names are resolved here rather than in the engine, which
 * only knows who said what. That way renaming or recolouring a speaker applies
 * to the next caption without disturbing the Discord connection.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  globalShortcut,
  session,
  systemPreferences,
} = require('electron');

const { ConfigStore } = require('./config');
const { maybeClearQuarantine } = require('./macos-quarantine');
const { CaptionServer, newAccessKey } = require('./server');
const { Tunnel } = require('./tunnel');
const { EngineHost } = require('./engine-host');
const { colorForUser, assignColors, PALETTE } = require('../shared/colors');
const {
  tryResolveModelPath,
  listModels,
  modelsDir,
  vendorDir,
} = require('../shared/paths');
const {
  catalogWithStatus,
  installModel,
  removeModel,
  sweepPartials,
  recommendedModelFor,
  machineSpecs,
  MODEL_CATALOG,
} = require('../shared/models');
const { buildFilter, maskText } = require('../shared/wordfilter');
const { checkForUpdate, RELEASES_PAGE } = require('./updates');
const { osOption, buildOption, scrubLog, reportUrl } = require('./report');
const { isSafeExternalUrl } = require('./links');
const { whatsNewFor } = require('./whats-new');

let mainWindow = null;
let config = null;
let server = null;
let engine = null;
let tunnel = null;

/**
 * Collision-free colour assignment for everyone currently in the call,
 * recomputed whenever the member list or the overrides change. Captions read
 * from this so the overlay always matches the swatches shown in the UI.
 */
let colorAssignment = new Map();

/** Colour for a caption; falls back to the hash if the speaker already left. */
function captionColor(userId) {
  return colorAssignment.get(userId) || colorForUser(userId, config.data.colors);
}

/**
 * The name to show on stream. Resolved here rather than in the engine so that
 * renaming someone applies to the very next caption without touching the
 * Discord connection or their recognizer.
 */
function captionName(userId, fallback) {
  const alias = config.data.aliases[userId];
  return (alias && alias.trim()) || fallback;
}

/**
 * Latest sign-in state and server/channel tree from the engine.
 *
 * Cached here because the launch sign-in can finish before the renderer has
 * loaded and subscribed, and a `webContents.send` with nobody listening is
 * simply lost. `getState` serves this on init, so the pickers populate whether
 * the events arrived early, late, or not at all.
 */
let discord = { auth: 'idle', botTag: null, botId: null, message: '', guilds: [] };

/** Overlays connected right now; `local` is in practice OBS. */
let overlays = { local: 0, remote: 0 };

/** Decided once at launch; null when there's nothing to announce. */
let whatsNew = null;

/** Compiled slur matcher, rebuilt whenever the filter settings change. */
let wordFilter = buildFilter({ enabled: true, custom: [] });
let maskedTotal = 0;

function rebuildFilter() {
  wordFilter = buildFilter({
    enabled: config.data.filter.enabled,
    custom: config.data.filter.custom,
  });
}

/**
 * Pin the model and vendor directories into the environment before anything
 * reads them.
 *
 * In an installed build the app directory is read-only (Program Files), so
 * downloaded models must live in the user's data directory instead. Pinning
 * them as env vars means the engine child process resolves exactly the same
 * paths without needing Electron's `app` module, which it doesn't have.
 */
function resolveRuntimeDirs() {
  if (!process.env.CHATTERLAYER_MODELS_DIR) {
    process.env.CHATTERLAYER_MODELS_DIR = app.isPackaged
      ? path.join(app.getPath('userData'), 'models')
      : modelsDir();
  }
  if (!process.env.CHATTERLAYER_VENDOR_DIR) {
    process.env.CHATTERLAYER_VENDOR_DIR = vendorDir();
  }
  fs.mkdirSync(process.env.CHATTERLAYER_MODELS_DIR, { recursive: true });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ------------------------------------------------------------------ tray ---

/**
 * ChatterLayer is running for as long as the stream is, and for most of that
 * time nobody needs to look at it. Closing the window therefore parks it in the
 * tray rather than ending the call: pressing × on a window that is holding a
 * Discord voice connection and serving captions to OBS should not be the way a
 * broadcast ends. Minimise stays ordinary, and Quit is on the tray menu.
 */
let tray = null;

/**
 * Set by the first exit path to run, so the close handler below stands aside
 * and lets the window actually close. Without it `app.quit()` would be caught
 * by our own preventDefault and the app could never be quit at all.
 */
let allowQuit = false;

/** Mirrors the tally lamp in the window, minus the detail no tooltip can hold. */
let trayStatus = { state: 'standby', speakers: 0 };

/**
 * Pause: still in the call, still transcribing, but nothing goes out — not to
 * the overlay, not to the monitor. The privacy panic button. Never saved, so
 * a fresh launch is never silently paused.
 */
let paused = false;

/** Told once, the first time the window vanishes into the tray. */
let toldAboutTray = false;

/**
 * Whether × parks the app rather than ending it. Read live on every close, so
 * changing the setting takes effect without a restart. Defaults to parking if
 * the config somehow isn't up yet — the safe way round for a live call.
 */
function closeToTray() {
  return !config || config.data.tray.closeToTray !== false;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  // Hidden is not minimised, so both have to be undone.
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** The lamp, in words: what the tooltip and the menu's first line say. */
function statusLabel() {
  const { state, speakers } = trayStatus;
  if (state === 'onair' && paused) return 'Paused — nothing is going out';
  if (state === 'onair') {
    return speakers ? `On air — ${speakers} on` : 'On air — nobody switched on';
  }
  if (state === 'linking') return 'Connecting…';
  if (state === 'fault') return 'Fault — open the window';
  return 'Standby';
}

function renderTray() {
  if (!tray) return;

  const running = trayStatus.state === 'onair' || trayStatus.state === 'linking';
  tray.setToolTip(`ChatterLayer — ${statusLabel()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel(), enabled: false },
      { type: 'separator' },
      { label: 'Show ChatterLayer', click: showWindow },
      {
        label: paused ? 'Resume captions' : 'Pause captions',
        enabled: running,
        click: () => setPaused(!paused),
      },
      {
        label: 'Disconnect',
        enabled: running,
        click: () => {
          if (engine) engine.stop();
        },
      },
      { type: 'separator' },
      { label: 'Quit ChatterLayer', click: () => app.quit() },
    ])
  );
}

/**
 * The app icon, shared by the tray and the window. Packaged from the asar;
 * `build/icon.png` is listed in electron-builder's `files` for exactly this
 * reason. Generated from build/icon.svg by scripts/make-icon.js.
 */
const ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.png');

function createTray() {
  // A missing file yields an empty image rather than throwing, which would
  // leave an invisible but working icon — so fall back to the window icon
  // instead of shipping a blank tray slot.
  let image = nativeImage.createFromPath(ICON_PATH);
  if (!image.isEmpty()) {
    // Windows draws the tray at 16pt; handing it a 512px PNG gets a blurry
    // downscale. resize() picks the right one at the current DPI.
    image = image.resize({ width: 16, height: 16 });
  }

  tray = new Tray(image);
  // Left click is "show me", which is what people try first.
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  renderTray();
}

function setPaused(on) {
  paused = Boolean(on);
  // A panic button that left the last sentence on screen would not be one.
  if (paused) clearCaptions();
  send('chatterlayer:event', { type: 'paused', paused });
  renderTray();
}

/** Wipe the overlay and the monitor together — they show the same thing. */
function clearCaptions() {
  server.clearCaptions();
  send('chatterlayer:event', { type: 'cleared' });
}

// ---------------------------------------------------------------- hotkeys ---

/**
 * System-wide, because the moment you need them the game has focus. Off by
 * default: a global shortcut quietly steals that key from every other app.
 */
const HOTKEYS = {
  pause: 'CommandOrControl+Alt+P',
  clear: 'CommandOrControl+Alt+K',
};

/** "Ctrl+Alt+P" on Windows and Linux, "Cmd+Alt+P" on a Mac. */
const hotkeyLabel = (accel) =>
  accel.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl');

function applyHotkeys() {
  globalShortcut.unregisterAll();
  if (!config.data.hotkeys.enabled) return;

  const taken = [];
  const bind = (accel, fn) => {
    if (!globalShortcut.register(accel, fn)) taken.push(hotkeyLabel(accel));
  };
  bind(HOTKEYS.pause, () => setPaused(!paused));
  bind(HOTKEYS.clear, clearCaptions);
  if (taken.length) {
    send('chatterlayer:event', {
      type: 'log',
      level: 'warn',
      message: `${taken.join(' and ')} ${taken.length === 1 ? 'is' : 'are'} already taken by another app, so ${taken.length === 1 ? 'it does' : 'they do'} nothing here.`,
    });
  }
}

// --------------------------------------------------------------- startup ---

/**
 * Start with the computer, straight into the tray. Only the Discord sign-in
 * happens on its own, as on any launch; the tunnel stays down and nobody is
 * captioned until someone presses Connect.
 *
 * Electron has no login items on Linux, so the setting is hidden there.
 */
function applyLoginItem() {
  if (process.platform === 'linux') return;
  const opts = {
    openAtLogin: Boolean(config.data.startup.atLogin),
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
  };
  // The portable exe unpacks itself to a new temp folder every run; the login
  // item has to point at the file the user actually keeps.
  if (process.env.PORTABLE_EXECUTABLE_FILE) opts.path = process.env.PORTABLE_EXECUTABLE_FILE;
  app.setLoginItemSettings(opts);
}

function launchedHidden() {
  if (process.argv.includes('--hidden')) return true;
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
}

// ---------------------------------------------------------- notifications ---

/** Captions have been going out, so them stopping is news. */
let captionsLive = false;
/** A stop was announced, so the recovery is worth announcing too. */
let toldStopped = false;

/** Not looking at the window — which, mid-stream, is nearly always. */
function away() {
  return (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !mainWindow.isVisible() ||
    mainWindow.isMinimized() ||
    !mainWindow.isFocused()
  );
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body });
  note.on('click', showWindow);
  note.show();
}

/** Say so when captions stop on their own and nobody is watching the app. */
function noticeStatus(msg) {
  if (msg.state === 'joined') {
    if (toldStopped && away()) notify('Captions are back', msg.message);
    toldStopped = false;
    captionsLive = true;
  } else if (msg.state === 'stopped') {
    // The user's own Disconnect.
    captionsLive = false;
    toldStopped = false;
  } else if ((msg.state === 'error' || msg.state === 'disconnected') && captionsLive) {
    captionsLive = false;
    if (away()) {
      notify('Captions stopped', msg.message);
      toldStopped = true;
    }
  }
}

const THEMES = new Set(['system', 'light', 'dark']);

/** Matches --ground in styles.css, so the window never flashes the other one. */
const themeBackground = () => (nativeTheme.shouldUseDarkColors ? '#0e0e0e' : '#ffffff');

/**
 * The stylesheet reads prefers-color-scheme, and themeSource is what Chromium
 * answers that with — so one assignment switches the whole window, live, and
 * "Match system" keeps following Windows after that.
 */
function applyTheme() {
  const theme = config && config.data.appearance.theme;
  nativeTheme.themeSource = THEMES.has(theme) ? theme : 'system';
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(themeBackground());
}

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    title: 'ChatterLayer',
    // Without this, `npm start` shows electron.exe's icon on the taskbar and
    // title bar. An installed build shows the same picture either way: the icon
    // electron-builder embeds in the exe is made from this same file.
    icon: ICON_PATH,
    backgroundColor: themeBackground(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (show) mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    // Every real exit path sets allowQuit first; anything else is the user
    // pressing × or Alt+F4. Whether that parks the app or ends it is the one
    // thing the tray setting decides.
    if (allowQuit || !closeToTray()) return;
    event.preventDefault();
    mainWindow.hide();

    if (!toldAboutTray) {
      toldAboutTray = true;
      // A window that disappears with a live Discord connection still running
      // needs to say where it went, once.
      if (tray && process.platform === 'win32') {
        tray.displayBalloon({
          title: 'ChatterLayer is still running',
          content: 'Captions keep going. Click the tray icon to bring it back, or right-click to quit.',
        });
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Current styling as the overlay expects it. */
function displaySettings() {
  return { overlay: config.data.overlay };
}

// -------------------------------------------------------- remote sharing ---

/**
 * The access key remote overlay links carry, for this tunnel session only.
 *
 * 128 bits of randomness in the URL is the whole authentication story, which is
 * appropriate for what it protects: captions that are already going out on a
 * public stream. It exists so a scanned or stale tunnel hostname isn't enough
 * to watch someone's voice channel, not to hold a secret.
 *
 * Kept in memory and re-minted on every Start, rather than saved to config.
 * A Quick Tunnel's hostname is random per session, so a link from the last run
 * is already dead — persisting the key would buy nothing, and would mean
 * writing a live credential to chatterlayer-config.json in plain text next to
 * a bot token the OS keystore goes out of its way to encrypt. One link, one
 * session.
 */
let shareKey = '';

/** Everything the renderer needs to draw the sharing panel. */
function shareState() {
  const live = Boolean(tunnel && tunnel.url);
  return {
    enabled: Boolean(config.data.share.enabled),
    running: live,
    busy: Boolean(tunnel && tunnel.starting),
    origin: live ? tunnel.url : '',
    url: live ? server.shareUrl(tunnel.url) : '',
  };
}

function sendShare(extra = {}) {
  send('chatterlayer:event', { type: 'tunnel', ...shareState(), ...extra });
}

/** Close the tunnel and disarm the access gate. Safe to call when already down. */
async function stopSharing(reason) {
  if (tunnel) await tunnel.stop();
  shareKey = '';
  server.setAccess({ required: false });
  sendShare(reason ? { message: reason } : {});
}

function wireTunnel() {
  tunnel.on('status', (status) => sendShare({ phase: status.phase, progress: status }));

  // cloudflared died on its own. The gate comes down with it — leaving it armed
  // would demand a key from the host's own OBS for no reason.
  tunnel.on('dropped', ({ code }) => {
    shareKey = '';
    server.setAccess({ required: false });
    sendShare({
      message: `The tunnel dropped (cloudflared exited, code ${code}). Start it again to get a new link.`,
      level: 'warn',
    });
  });
}

/**
 * Everything that goes on stream is resolved here: colour, display name, and
 * slur masking. Filtering at this single point means unmasked text never
 * reaches the overlay or the monitor — test captions included.
 */
function deliverCaption(msg) {
  if (paused) return;
  const body = maskText(msg.text, wordFilter);
  // A slur can just as easily be in someone's Discord name.
  const name = maskText(captionName(msg.userId, msg.username), wordFilter);

  const caption = {
    userId: msg.userId,
    username: name.text,
    text: body.text,
    color: captionColor(msg.userId),
    isFinal: msg.isFinal,
    timestamp: msg.timestamp,
  };
  server.sendCaption(caption);
  send('chatterlayer:caption', caption);

  if (msg.isFinal && body.masked + name.masked > 0) {
    maskedTotal += body.masked + name.masked;
    send('chatterlayer:event', { type: 'filter', masked: maskedTotal });
  }
}

/**
 * Lines for "Send test caption", taken in turn. Different lengths on purpose:
 * pressing it a few times shows wrapping and Max lines, which is what someone
 * sizing the source in OBS needs to see.
 */
const TEST_LINES = [
  'This is a test caption from ChatterLayer.',
  'Captions wrap like this when somebody keeps talking for a while without stopping for breath.',
  'Size and place the browser source in OBS until this looks right.',
];
let testLine = 0;

function wireEngine() {
  engine.on('message', (msg) => {
    switch (msg.type) {
      case 'caption':
        deliverCaption(msg);
        return;
      case 'captionCleared':
        server.broadcast({ type: 'captionCleared', userId: msg.userId });
        // The monitor mirrors the overlay, so it has to hear this too —
        // otherwise a cancelled partial lingers in the app but not on stream.
        send('chatterlayer:event', msg);
        return;
      case 'members': {
        // Re-derive colours across the whole call so nobody shares one.
        colorAssignment = assignColors(
          msg.members.map((m) => m.id),
          config.data.colors
        );
        const members = msg.members.map((m) => ({
          ...m,
          /** What viewers will see; empty means "use the Discord name". */
          alias: config.data.aliases[m.id] || '',
          captionName: captionName(m.id, m.displayName),
          color: colorAssignment.get(m.id),
          customColor: Boolean(config.data.colors[m.id]),
        }));
        send('chatterlayer:members', members);
        trayStatus.speakers = members.filter((m) => m.selected).length;
        renderTray();
        return;
      }
      case 'auth': {
        const gone = msg.state === 'error' || msg.state === 'signed-out';
        discord = {
          auth: msg.state,
          message: msg.message || '',
          botTag: gone ? null : msg.botTag || discord.botTag,
          botId: gone ? null : msg.botId || discord.botId,
          // Nothing to pick from once the session is gone.
          guilds: gone ? [] : discord.guilds,
        };
        send('chatterlayer:event', msg);
        return;
      }
      case 'guilds':
        discord = {
          ...discord,
          guilds: msg.guilds,
          botTag: msg.botTag || discord.botTag,
          botId: msg.botId || discord.botId,
        };
        send('chatterlayer:event', msg);
        return;
      case 'status': {
        // The same four lamp states the window shows, so the tray never
        // disagrees with the tally the user was looking at before they hid it.
        if (msg.state === 'joined') trayStatus.state = 'onair';
        else if (msg.state === 'error') trayStatus.state = 'fault';
        else if (msg.state === 'stopped' || msg.state === 'disconnected') {
          trayStatus = { state: 'standby', speakers: 0 };
        } else trayStatus.state = 'linking';
        noticeStatus(msg);
        renderTray();
        send('chatterlayer:event', msg);
        return;
      }
      default:
        send('chatterlayer:event', msg);
    }
  });
}

async function bootstrap() {
  rebuildFilter();

  // Recorded as seen straight away, so it is once per update whether or not
  // anyone presses "Got it".
  whatsNew = whatsNewFor({
    current: app.getVersion(),
    lastSeen: config.data.lastSeenVersion,
    upgraded: config.existed,
  });
  // Coming from a version before the setup checklist existed means they got
  // set up without it; it's for first runs, not a tour for people already live.
  if (config.existed && !config.data.lastSeenVersion && !config.data.setupDone) {
    config.update({ setupDone: true });
  }
  if (config.data.lastSeenVersion !== app.getVersion()) {
    config.update({ lastSeenVersion: app.getVersion() });
  }

  // Reclaim space from any model download killed mid-flight last run. The next
  // attempt re-fetches whole files, so a leftover .part is only wasted disk.
  try {
    const swept = sweepPartials(modelsDir());
    if (swept.files) {
      send('chatterlayer:event', {
        type: 'log',
        level: 'info',
        message:
          `Cleared ${swept.files} unfinished model download ` +
          `file${swept.files === 1 ? '' : 's'} (${(swept.bytes / 1e6).toFixed(0)} MB).`,
      });
    }
  } catch {
    /* best effort */
  }
  server = new CaptionServer();
  engine = new EngineHost();
  // Constructed, not started. Remote sharing is always down at launch, however
  // the toggle was left — see the `share` block in config.js.
  tunnel = new Tunnel(path.join(app.getPath('userData'), 'bin'));

  server.updateSettings(displaySettings());
  applyHotkeys();
  server.on('clients', (counts) => {
    overlays = counts;
    send('chatterlayer:event', { type: 'overlays', ...counts });
  });
  wireEngine();
  wireTunnel();

  try {
    const urls = await server.start(config.data.server);
    send('chatterlayer:event', {
      type: 'server',
      state: 'ready',
      urls,
      port: server.port,
    });
  } catch (err) {
    send('chatterlayer:event', { type: 'server', state: 'error', message: err.message });
  }

  // Sign in straight away so the server and channel pickers are populated
  // before the user goes looking for them. This only logs the bot in — no
  // speech model is loaded and no voice channel is joined until Connect.
  // Side effect worth knowing: the bot shows as online in Discord for as long
  // as ChatterLayer is open, not just while captioning.
  //
  // Not when only the mic is captioned: then nothing needs Discord, and the
  // app should make no connection to it at all.
  if (config.getToken() && config.data.source !== 'mic') engine.signIn(config.getToken());
}

/**
 * The window may ask for the microphone and nothing else — no camera, no
 * screen, no location. Electron's default grants every request.
 */
function limitPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const types = (details && details.mediaTypes) || [];
    callback(permission === 'media' && types.length > 0 && types.every((t) => t === 'audio'));
  });
}

// ------------------------------------------------------------------- IPC ---

ipcMain.handle('chatterlayer:getState', () => ({
  config: config.toClient(),
  palette: PALETTE,
  urls: server.urls(config.data.server.host),
  port: server.port,
  modelPath: tryResolveModelPath(config.data.modelPath),
  models: listModels(),
  running: engine.running,
  discord,
  share: shareState(),
  overlays,
  whatsNew,
  paused,
  platform: process.platform,
  hotkeys: { pause: hotkeyLabel(HOTKEYS.pause), clear: hotkeyLabel(HOTKEYS.clear) },
  version: app.getVersion(),
  releasesUrl: RELEASES_PAGE,
}));

ipcMain.handle('chatterlayer:setPaused', (_e, on) => {
  setPaused(on);
  return paused;
});

/**
 * Follow mode: whose channel moves the bot follows, or nobody. One person,
 * saved, so it holds across reconnects.
 */
ipcMain.handle('chatterlayer:setFollow', (_e, userId) => {
  config.update({ follow: { userId: userId || '' } });
  engine.setFollow(userId || null);
  return config.toClient();
});

/** "This is me": which Discord member is the streamer. Saved, like Follow. */
ipcMain.handle('chatterlayer:setMe', (_e, userId) => {
  config.update({ me: { userId: userId || '' } });
  engine.setMe(userId || null);
  return config.toClient();
});

ipcMain.handle('chatterlayer:dismissWhatsNew', () => {
  whatsNew = null;
  return true;
});

/**
 * A line on the overlay through exactly the path speech takes, so OBS can be
 * sized and positioned without anyone being in a call.
 */
ipcMain.handle('chatterlayer:testCaption', () => {
  const text = TEST_LINES[testLine++ % TEST_LINES.length];
  deliverCaption({
    userId: 'chatterlayer-test',
    username: 'Test',
    text,
    isFinal: true,
    timestamp: Date.now(),
  });
  return { ...overlays, paused };
});

/**
 * Open a pre-filled bug report in the browser. The renderer hands over the Log
 * panel as it reads; the token, the share key and anything shaped like a token
 * are stripped here, where the real secrets are known.
 */
ipcMain.handle('chatterlayer:reportProblem', (_e, { log } = {}) => {
  const modelDir = path.basename(tryResolveModelPath(config.data.modelPath) || '');
  const entry = MODEL_CATALOG.find((m) => m.dir === modelDir);
  // A custom model has no option on the form, so that field is left for them.
  const model = !listModels().length ? 'No model downloaded yet' : entry ? entry.label : '';

  const url = reportUrl({
    version: app.getVersion(),
    os: osOption({ platform: process.platform, release: os.release(), arch: process.arch }),
    build: buildOption({ platform: process.platform, packaged: app.isPackaged, env: process.env }),
    model,
    log: scrubLog(log, [config.getToken(), shareKey]),
  });
  return shell.openExternal(url);
});

/**
 * Arm or disarm the sharing panel. Switching it on deliberately does NOT open
 * a tunnel — that needs an explicit Start.
 */
ipcMain.handle('chatterlayer:setShareEnabled', async (_e, enabled) => {
  const on = Boolean(enabled);
  config.update({ share: { ...config.data.share, enabled: on } });
  if (!on && tunnel.running) await stopSharing();
  return shareState();
});

ipcMain.handle('chatterlayer:startShare', async () => {
  if (!config.data.share.enabled) throw new Error('Turn on remote sharing first.');
  if (tunnel.running) return shareState();
  // Without a bound port there is nothing to put a tunnel in front of, and
  // cloudflared would happily point at a dead address and hand out a link.
  if (!server.port) throw new Error('The caption server is not running — check the port setting.');

  // A new key for every session, and armed before the tunnel exists rather
  // than after: there must be no window in which the overlay is reachable from
  // the internet without a key.
  shareKey = newAccessKey();
  server.setAccess({ token: shareKey, required: true });
  sendShare({ busy: true });

  try {
    const origin = await tunnel.start({ port: server.port });
    sendShare({ origin, url: server.shareUrl(origin) });
    return shareState();
  } catch (err) {
    server.setAccess({ required: false });
    sendShare({ message: err.message, level: 'error' });
    throw err;
  }
});

ipcMain.handle('chatterlayer:stopShare', async () => {
  await stopSharing();
  return shareState();
});

/**
 * Mint a new key mid-session, invalidating every link already handed out. The
 * server drops remote viewers still holding the old one rather than letting
 * them run on until their next reconnect.
 *
 * Only meaningful while the tunnel is up — stopping it already discards the key.
 */
ipcMain.handle('chatterlayer:rotateShareToken', () => {
  if (!tunnel.url) throw new Error('Start the tunnel before regenerating its key.');
  shareKey = newAccessKey();
  server.setAccess({ token: shareKey, required: true });
  sendShare({ message: 'Access key regenerated — old links no longer work.' });
  return shareState();
});

/**
 * Ask GitHub whether a newer release exists. Notification only — nothing is
 * downloaded. `force` comes from the user switching the setting on, and asks
 * even though the stored setting may not have caught up yet.
 */
ipcMain.handle('chatterlayer:checkUpdate', async (_e, { force = false } = {}) => {
  const result = await checkForUpdate({
    currentVersion: app.getVersion(),
    cache: config.data.updates,
    force,
  });
  // Remember what we saw so tomorrow's launch doesn't ask again, and so an
  // offline launch still shows the badge. A check that was refused ('off')
  // knows nothing, and must not erase what the last real one found.
  if (result.state !== 'off') {
    config.update({
      updates: {
        ...config.data.updates,
        lastCheck: result.lastCheck,
        latest: result.latest,
      },
    });
  }
  return result;
});

/**
 * Sign in, or refresh the channel list if already signed in on this token.
 * Backs the Refresh/Retry button and the "I just pasted a new token" case —
 * the engine works out which of those it is.
 */
ipcMain.handle('chatterlayer:signIn', (_e, token) => {
  if (token) config.setToken(token);
  const activeToken = config.getToken();
  if (!activeToken) throw new Error('Enter your Discord bot token first.');
  engine.signIn(activeToken);
  return true;
});

ipcMain.handle('chatterlayer:setToken', (_e, token) => {
  config.setToken(token);
  return config.toClient();
});

ipcMain.handle('chatterlayer:updateConfig', async (_e, patch) => {
  const before = JSON.stringify(config.data.server);
  config.update(patch);

  // Overlay styling is live-pushed to the connected browser source.
  if (patch.overlay !== undefined) {
    server.updateSettings(displaySettings());
  }

  if (patch.filter !== undefined) rebuildFilter();
  if (patch.mic !== undefined) engine.setMicGate(micGate());
  if (patch.appearance !== undefined) applyTheme();
  if (patch.hotkeys !== undefined) applyHotkeys();
  if (patch.startup !== undefined) applyLoginItem();

  // Changing host/port needs the server rebound.
  if (JSON.stringify(config.data.server) !== before) {
    // A live tunnel points at the old port, so it cannot survive this. Taking
    // it down explicitly beats leaving a link that resolves to nothing.
    if (tunnel && tunnel.running) {
      await stopSharing();
      send('chatterlayer:event', {
        type: 'log',
        level: 'warn',
        message: 'Port changed — remote sharing stopped. Start it again for a new link.',
      });
    }
    await server.stop();
    try {
      const urls = await server.start(config.data.server);
      send('chatterlayer:event', { type: 'server', state: 'ready', urls, port: server.port });
      server.updateSettings(displaySettings());
    } catch (err) {
      send('chatterlayer:event', { type: 'server', state: 'error', message: err.message });
    }
  }
  return config.toClient();
});

// ---- speech model management ---------------------------------------------

ipcMain.handle('chatterlayer:modelCatalog', () => ({
  catalog: catalogWithStatus(modelsDir()),
  installed: listModels(),
  modelsDir: modelsDir(),
  // Which of the two recommended models suits this machine. Worked out from the
  // OS's own RAM and CPU figures, here, and never sent anywhere.
  suggestion: recommendedModelFor(machineSpecs()),
}));

/** Tracks in-flight downloads so the same model can't be fetched twice. */
const downloading = new Set();

ipcMain.handle('chatterlayer:installModel', async (_e, key) => {
  if (downloading.has(key)) throw new Error('That model is already downloading.');
  downloading.add(key);
  try {
    const result = await installModel(key, modelsDir(), (p) =>
      send('chatterlayer:modelProgress', { key, ...p })
    );
    // If this is the first model, select it automatically so the user isn't
    // left with a downloaded model and nothing using it.
    if (!config.data.modelPath) config.update({ modelPath: result.path });
    send('chatterlayer:modelProgress', { key, phase: 'done' });
    return { ok: true, ...result };
  } catch (err) {
    send('chatterlayer:modelProgress', { key, phase: 'error', message: err.message });
    throw err;
  } finally {
    downloading.delete(key);
  }
});

ipcMain.handle('chatterlayer:removeModel', (_e, key) => {
  if (engine.running) throw new Error('Disconnect before removing a model.');
  const removed = removeModel(key, modelsDir());
  // Drop the selection if it pointed at what we just deleted.
  if (config.data.modelPath === removed) config.update({ modelPath: '' });
  return { ok: true };
});

ipcMain.handle('chatterlayer:setAlias', (_e, { userId, alias }) => {
  const aliases = { ...config.data.aliases };
  const trimmed = (alias || '').trim();
  if (trimmed) aliases[userId] = trimmed;
  else delete aliases[userId]; // empty reverts to their Discord name
  config.update({ aliases });
  engine.requestMembers();
  return config.toClient();
});

ipcMain.handle('chatterlayer:setColor', (_e, { userId, color }) => {
  const colors = { ...config.data.colors };
  if (color) colors[userId] = color;
  else delete colors[userId]; // falling back to the hashed default
  config.update({ colors });
  engine.requestMembers(); // refresh swatches in the UI
  return config.toClient();
});

ipcMain.handle('chatterlayer:start', async (_e, { token, channelId, guildId }) => {
  if (token) config.setToken(token);
  if (channelId !== undefined) config.update({ channelId });
  if (guildId !== undefined) config.update({ guildId });

  const source = config.data.source;
  const activeToken = config.getToken();
  if (source !== 'mic') {
    if (!activeToken) throw new Error('Enter your Discord bot token first.');
    if (!config.data.channelId) throw new Error('Pick a voice channel first.');
  }

  // Before start, so the mic's gate is tuned from its first chunk and the
  // streamer's Discord audio is never captured beside their mic.
  engine.setMicGate(micGate());
  engine.setMe(config.data.me.userId || null);
  await engine.start({
    source,
    token: source === 'mic' ? undefined : activeToken,
    channelId: config.data.channelId,
    modelPath: config.data.modelPath || undefined,
  });
  // Restore the previous selection once the engine reports it has joined.
  engine.setSelected(config.data.selected || []);
  engine.setFollow(config.data.follow.userId || null);
  return true;
});

ipcMain.handle('chatterlayer:stop', async () => {
  await engine.stop();
  return true;
});

const micGate = () => ({
  sensitivity: config.data.mic.sensitivity,
  hangMs: config.data.mic.hangMs,
});

/**
 * macOS asks the user once, per app, before any page can open the mic; without
 * this getUserMedia just fails silently there. Windows and Linux answer at the
 * OS level and need nothing here.
 */
ipcMain.handle('chatterlayer:micAccess', async () => {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.askForMediaAccess('microphone');
});

/**
 * Mic audio from the window, on to the engine. Base64 because the engine's IPC
 * channel is JSON, where a Buffer turns into an array of numbers several times
 * its size.
 */
ipcMain.on('chatterlayer:micAudio', (_e, pcm) => {
  if (!(pcm instanceof Uint8Array) || !pcm.byteLength) return;
  engine.micAudio(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'));
});

ipcMain.handle('chatterlayer:setSelected', (_e, userIds) => {
  config.update({ selected: userIds });
  engine.setSelected(userIds);
  return userIds;
});

ipcMain.handle('chatterlayer:clearCaptions', () => {
  clearCaptions();
  return true;
});

ipcMain.handle('chatterlayer:copy', (_e, text) => {
  clipboard.writeText(text || '');
  return true;
});

ipcMain.handle('chatterlayer:openExternal', (_e, url) => {
  if (!isSafeExternalUrl(url)) return false;
  return shell.openExternal(url);
});
ipcMain.handle('chatterlayer:revealConfig', () => shell.showItemInFolder(config.file));

// ----------------------------------------------------------- app lifecycle --

// A second instance would fight over the caption server port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching again is how someone who forgot about the tray gets back in.
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // Unsigned build: offer to clear macOS's quarantine flag before anything
    // else, since accepting relaunches the app.
    await maybeClearQuarantine({ app, dialog, clipboard });
    resolveRuntimeDirs();
    // Before the window, so its first paint is already in the right theme.
    config = new ConfigStore();
    limitPermissions();
    applyTheme();
    // Under "Match system" Windows can flip underneath us; keep the window's
    // own backdrop (seen while resizing) in step with the page.
    nativeTheme.on('updated', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(themeBackground());
    });
    // Windows attributes notifications to this id; it must match the
    // installer's appId or they arrive labelled as someone else.
    if (process.platform === 'win32') app.setAppUserModelId('com.ruptz.chatterlayer');
    createWindow({ show: !launchedHidden() });
    createTray();
    await bootstrap();

    app.on('activate', showWindow);
  });
}

// With close-to-tray on, the close is prevented and the window is never
// destroyed, so this only runs on a genuine quit. With it off, the window
// closing is the app closing, which is the behaviour restored here.
app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/** Guards against re-entering teardown when `app.quit()` fires again. */
let quitting = false;

app.on('before-quit', async (event) => {
  // First thing, ahead of every early return: from here on the window is
  // allowed to close for real rather than being sent back to the tray.
  allowQuit = true;
  if (quitting) return;
  const needsTeardown = (engine && engine.child) || (tunnel && tunnel.running);
  if (!needsTeardown) return;

  quitting = true;
  event.preventDefault();
  // The tunnel first: it is the only part of this that is visible from outside
  // the machine, and it must not outlive the window under any exit path.
  if (tunnel) await tunnel.stop();
  // Also when there's no child: a crash restart may be pending, and quitting
  // must cancel it rather than race it.
  if (engine) await engine.shutdown();
  if (server) await server.stop();
  app.exit(0);
});
