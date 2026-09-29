'use strict';
/**
 * `chatterlayer-config.json` in Electron's per-user data directory, so it
 * survives updates and needs no write access to the install folder.
 *
 * The bot token is encrypted at rest via safeStorage (DPAPI / Keychain /
 * libsecret) where the OS supports it — it's a live credential that grants
 * control of the bot to anyone who reads it.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const CONFIG_FILENAME = 'chatterlayer-config.json';

const DEFAULTS = {
  /**
   * What gets captioned: 'discord' (a voice call), 'mic' (this PC's
   * microphone, which never signs in to Discord at all) or 'both'.
   */
  source: 'discord',
  /**
   * The microphone to capture, by the browser's deviceId; empty = the system
   * default. Whether it is captioned is the `mic` entry in `selected`, like
   * anyone else's switch.
   */
  mic: {
    deviceId: '',
    /** 1 (only loud, close speech) to 10 (picks up whispers). See mic-gate.js. */
    sensitivity: 5,
    /** How long a pause ends a caption. */
    hangMs: 700,
  },
  /**
   * The streamer's own Discord account. Captioning both the call and the mic,
   * their Discord audio is skipped while the mic is on, so they aren't
   * captioned twice.
   */
  me: {
    userId: '',
  },
  /** The voice channel to join. */
  channelId: '',
  /**
   * Which server the channel belongs to. Not used to connect — it only
   * restores the server picker to where you left it, so the channel dropdown
   * comes back populated instead of blank.
   */
  guildId: '',
  /** Discord user IDs toggled ON for captioning. */
  selected: [],
  /** userId -> "#rrggbb" overrides; unset users fall back to the hashed palette. */
  colors: {},
  /**
   * userId -> the name shown on stream, e.g. "ruptz_45454" -> "Ruptz".
   * Discord usernames are often not what someone wants broadcast.
   */
  aliases: {},
  /** Slur masking. On by default — captions go out live and unreviewed. */
  filter: {
    enabled: true,
    /** Extra terms beyond the built-in racial/ethnic slur list. */
    custom: [],
  },
  /** Optional explicit path to a Vosk model folder; empty = autodetect. */
  modelPath: '',
  /**
   * The version check. ChatterLayer otherwise talks to nothing but Discord and
   * this machine, so asking GitHub whether a newer build exists is a visible
   * setting rather than a hidden one. Nothing is ever downloaded — see
   * `updates.js`.
   */
  updates: {
    check: true,
    /** Epoch ms of the last successful check. Informational — the check runs
     *  once per launch and is not rate-limited on it. */
    lastCheck: 0,
    /** Newest tag seen, remembered so a launch with no network still knows. */
    latest: '',
  },
  server: {
    port: 8777,
    /**
     * 127.0.0.1 keeps the server reachable only from this machine (OBS).
     * Set to 0.0.0.0 to also expose it on your LAN — see README before doing
     * that, and use a tunnel rather than port-forwarding for public access.
     */
    host: '127.0.0.1',
  },
  /**
   * Remote overlay sharing over a Cloudflare Quick Tunnel, so co-streamers can
   * point OBS at one host's captions.
   *
   * `enabled` only reveals the controls — it never starts anything. The tunnel
   * is spawned by an explicit Start and is always down on launch, so an app that
   * otherwise talks to nothing can't quietly end up exposed to the internet
   * because of a checkbox someone ticked weeks ago.
   *
   * There is deliberately no access key stored here: it is minted per tunnel
   * session and kept in memory only — see `shareKey` in main.js.
   */
  share: {
    enabled: false,
  },
  overlay: {
    fontSize: 30,
    captionLifetimeMs: 7000,
    maxLines: 4,
    showPartials: true,
    showSpeakerName: true,
  },
  /**
   * The tray icon is always there — status, Show, Disconnect, Quit. This only
   * decides what the window's × does.
   *
   * On by default because the alternative is that a reflexive click ends a live
   * Discord connection and the caption feed mid-stream. Minimise is untouched
   * either way, and Quit on the tray menu always means quit.
   */
  tray: {
    closeToTray: true,
  },
  /**
   * 'system', 'light' or 'dark'. Handed straight to nativeTheme.themeSource,
   * which is what the stylesheet's prefers-color-scheme reads.
   */
  appearance: {
    theme: 'system',
  },
  /**
   * Follow mode. The bot follows this one person between voice channels in
   * the server it's in. Empty means nobody, which is the default — and being
   * followed never switches anyone's captions on.
   */
  follow: {
    userId: '',
  },
  /** System-wide pause/resume and Clear shortcuts. Off: they'd steal keys. */
  hotkeys: {
    enabled: false,
  },
  /** Start with the computer, into the tray. Signs in to Discord and nothing more. */
  startup: {
    atLogin: false,
  },
  /**
   * The version whose "What's new" has been shown, so it is shown once. Empty
   * on a fresh install and on anything older than 0.4.0 — see whats-new.js.
   */
  lastSeenVersion: '',
  /**
   * Set the first time every step of the setup checklist is green, or when
   * someone hides it. After that it never returns, even when OBS is closed.
   */
  setupDone: false,
};

/** Deep-merge stored config over defaults so new keys appear on upgrade. */
function mergeDefaults(stored, defaults = DEFAULTS) {
  const out = Array.isArray(defaults) ? [] : {};
  for (const key of Object.keys(defaults)) {
    const d = defaults[key];
    const s = stored ? stored[key] : undefined;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      out[key] = mergeDefaults(s, d);
    } else {
      out[key] = s === undefined ? d : s;
    }
  }
  // Preserve keys that only exist in stored data (e.g. colour overrides).
  if (stored && typeof stored === 'object') {
    for (const key of Object.keys(stored)) {
      if (!(key in out)) out[key] = stored[key];
    }
  }
  return out;
}

class ConfigStore {
  constructor() {
    this.file = path.join(app.getPath('userData'), CONFIG_FILENAME);
    /** False on a first run. Tells an upgrade apart from a fresh install. */
    this.existed = fs.existsSync(this.file);
    this.data = mergeDefaults(this.readRaw());
    /** Decrypted token is kept in memory only. */
    this.token = this.decryptToken();

    // An earlier shape of remote sharing kept its access key here. Nothing
    // reads it now — the key is minted per tunnel session and held in memory —
    // and `mergeDefaults` preserves unknown stored keys, so without this it
    // would sit in a plain-text file forever. Scrub it on load.
    if (this.data.share && 'accessToken' in this.data.share) {
      delete this.data.share.accessToken;
      this.save();
    }
  }

  readRaw() {
    try {
      if (!fs.existsSync(this.file)) return {};
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // A corrupt config should never brick the app — start fresh instead.
      return {};
    }
  }

  encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  decryptToken() {
    const raw = this.readRaw();
    if (raw.botTokenEncrypted) {
      try {
        return safeStorage.decryptString(Buffer.from(raw.botTokenEncrypted, 'base64'));
      } catch {
        return '';
      }
    }
    return raw.botToken || '';
  }

  setToken(token) {
    this.token = token || '';
    this.save();
  }

  getToken() {
    return this.token;
  }

  /** Config for the renderer — never includes the raw token. */
  toClient() {
    return {
      ...this.data,
      hasToken: Boolean(this.token),
      tokenEncrypted: this.encryptionAvailable(),
      configPath: this.file,
    };
  }

  update(patch) {
    this.data = mergeDefaults({ ...this.data, ...patch }, DEFAULTS);
    this.save();
    return this.data;
  }

  save() {
    const out = { ...this.data };
    if (this.token && this.encryptionAvailable()) {
      out.botTokenEncrypted = safeStorage.encryptString(this.token).toString('base64');
      delete out.botToken;
    } else if (this.token) {
      // No OS keystore available (some Linux setups) — store plainly but make
      // the tradeoff visible in the file itself.
      out.botToken = this.token;
      out._warning =
        'This machine has no OS keystore, so the bot token is stored in plaintext. Keep this file private.';
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('[chatterlayer] failed to save config:', err.message);
    }
  }
}

module.exports = { ConfigStore, DEFAULTS, CONFIG_FILENAME };
