'use strict';
/**
 * The builds are unsigned (code-signing certificates cost money the project
 * isn't spending). On macOS that means Gatekeeper stamps the downloaded app
 * with `com.apple.quarantine` and then refuses to open it — often claiming it
 * is "damaged", which it is not. The documented fix is a Terminal command most
 * people will not run:
 *
 *     xattr -dr com.apple.quarantine /Applications/ChatterLayer.app
 *
 * If we got far enough to run this code, Gatekeeper already let the app launch
 * once. This offers to clear the flag with one click so the *next* launch —
 * and every launch after a move or an update — is normal.
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const QUARANTINE_ATTR = 'com.apple.quarantine';

/** Promisified execFile that resolves { code, stdout } and never rejects. */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '' });
    });
  });
}

/** `/Applications/ChatterLayer.app` — three levels up from Contents/MacOS/<exe>. */
function bundlePath(app) {
  return path.resolve(app.getPath('exe'), '..', '..', '..');
}

function dismissMarker(app) {
  return path.join(app.getPath('userData'), '.quarantine-help-dismissed');
}

/**
 * @param {{ app: import('electron').App, dialog: import('electron').Dialog,
 *           clipboard: import('electron').Clipboard }} electron
 */
async function maybeClearQuarantine({ app, dialog, clipboard }) {
  try {
    if (process.platform !== 'darwin' || !app.isPackaged) return;
    if (fs.existsSync(dismissMarker(app))) return;

    const bundle = bundlePath(app);
    if (!bundle.endsWith('.app')) return; // not a normal bundle layout; leave it

    // `xattr -p` exits non-zero when the attribute is absent — the common case
    // once it has been cleared, or when the user built from source.
    const probe = await run('xattr', ['-p', QUARANTINE_ATTR, bundle]);
    if (probe.code !== 0 || !probe.stdout.trim()) return;

    const choice = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Fix and relaunch', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: "Don't ask again",
      title: 'macOS flagged ChatterLayer',
      message: 'macOS has quarantined ChatterLayer because the build is not code-signed.',
      detail:
        'The app is not damaged. ChatterLayer can remove the quarantine flag for ' +
        'you now — it only affects this copy of the app — and restart. Otherwise ' +
        'macOS may block it next time, and you would need to clear it by hand in ' +
        'Terminal.',
    });

    if (choice.checkboxChecked) {
      try {
        fs.writeFileSync(dismissMarker(app), '');
      } catch {
        /* not fatal */
      }
    }
    if (choice.response !== 0) return;

    const cleared = await run('xattr', ['-dr', QUARANTINE_ATTR, bundle]);
    if (cleared.code === 0) {
      app.relaunch();
      app.exit(0);
      return;
    }

    // Could not write the attribute — app is somewhere read-only, or SIP-ish.
    // Hand over the exact command instead.
    const manual = `xattr -dr ${QUARANTINE_ATTR} "${bundle}"`;
    const fallback = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Copy command', 'OK'],
      defaultId: 0,
      title: 'Could not clear it automatically',
      message: 'Run this in Terminal, then reopen ChatterLayer:',
      detail: manual,
    });
    if (fallback.response === 0) clipboard.writeText(manual);
  } catch {
    // Never let this stop the app from starting.
  }
}

module.exports = { maybeClearQuarantine };
