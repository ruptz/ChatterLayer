'use strict';
// The renderer's whole reach into the app, as it was under Electron's preload:
// the same `window.chatterlayer` surface, now carried by Tauri commands and
// events. renderer.js is unchanged; it cannot tell which shell it runs in.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // Electron rejected with an Error; Tauri rejects with the bare message.
  const call = (cmd, args) =>
    invoke(cmd, args).catch((err) => {
      throw err instanceof Error ? err : new Error(String(err));
    });
  const on = (name, cb) => listen(name, (e) => cb(e.payload));

  window.chatterlayer = {
    getState: () => call('get_state'),
    updateConfig: (patch) => call('update_config', { patch }),
    setToken: (token) => call('set_token', { token }),

    signIn: (token) => call('sign_in', { token: token || null }),
    start: (opts) => call('start', { opts: opts || {} }),
    stop: () => call('stop'),
    micAccess: () => call('mic_access'),
    // Fire-and-forget, ten times a second while the mic is live. Sent as a raw
    // body: JSON would turn every sample into a number in an array.
    micAudio: (pcm) => {
      invoke('mic_audio', pcm).catch(() => {});
    },
    setSelected: (userIds) => call('set_selected', { userIds }),
    setColor: (userId, color) => call('set_color', { userId, color: color || null }),
    setAlias: (userId, alias) => call('set_alias', { userId, alias: alias || '' }),
    clearCaptions: () => call('clear_captions'),
    testCaption: () => call('test_caption'),
    setPaused: (on) => call('set_paused', { on: Boolean(on) }),
    setFollow: (userId) => call('set_follow', { userId: userId || null }),
    setMe: (userId) => call('set_me', { userId: userId || null }),
    reportProblem: (log) => call('report_problem', { log: log || '' }),
    dismissWhatsNew: () => call('dismiss_whats_new'),

    setShareEnabled: (on) => call('set_share_enabled', { on: Boolean(on) }),
    startShare: () => call('start_share'),
    stopShare: () => call('stop_share'),
    rotateShareToken: () => call('rotate_share_token'),

    modelCatalog: () => call('model_catalog'),
    installModel: (key) => call('install_model', { key }),
    removeModel: (key) => call('remove_model', { key }),
    onModelProgress: (cb) => on('chatterlayer:modelProgress', cb),

    checkUpdate: (opts) => call('check_update', { force: Boolean(opts && opts.force) }),

    copy: (text) => call('copy', { text: text || '' }),
    openExternal: (url) => call('open_external', { url: String(url || '') }),
    revealConfig: () => call('reveal_config'),
    listFonts: () => call('list_fonts'),
    openFontsFolder: () => call('open_fonts_folder'),

    onEvent: (cb) => on('chatterlayer:event', cb),
    onMembers: (cb) => on('chatterlayer:members', cb),
    onCaption: (cb) => on('chatterlayer:caption', cb),
  };
})();
