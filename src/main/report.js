'use strict';
/**
 * Builds the "Report a problem" link: GitHub's new-issue page with the bug
 * form already filled in from what the app knows about itself.
 *
 * GitHub issue forms take `?<field id>=<value>` for any field, and a dropdown
 * accepts the value only when it matches one of its options exactly. The ids
 * and option strings here are therefore a contract with
 * .github/ISSUE_TEMPLATE/bug_report.yml, and the selftest holds both sides to
 * it.
 *
 * Nothing is sent. This opens a page in the user's browser, where they read
 * what was filled in and decide whether to submit it.
 */

const ISSUE_NEW = 'https://github.com/ruptz/ChatterLayer/issues/new';
const TEMPLATE = 'bug_report.yml';

/**
 * How much of the Log panel goes into the link. GitHub stops accepting URLs
 * somewhere past 8 KB, and the end of the log is where the failure is.
 */
const LOG_MAX_CHARS = 3000;

/**
 * The same three-part shape the token field watches for, but unanchored. The
 * token is never written to the log in the first place; this is for the one
 * someone pasted into a custom filter word or a caption name by mistake.
 */
const TOKEN_SHAPE = /[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/g;

/** The bug form's "Operating system" option for this machine, or ''. */
function osOption({ platform, release = '', arch }) {
  if (platform === 'win32') {
    // Windows 11 still reports itself as 10.0; the build number is the tell.
    const build = Number(String(release).split('.')[2]) || 0;
    return build >= 22000 ? 'Windows 11' : 'Windows 10';
  }
  if (platform === 'darwin') return arch === 'arm64' ? 'macOS (Apple Silicon)' : 'macOS (Intel)';
  if (platform === 'linux') return 'Linux';
  return '';
}

/**
 * The form's "How you installed it" option, or '' when none of them fits.
 * electron-builder's portable exe and AppImage runtimes announce themselves
 * through these environment variables.
 */
function buildOption({ platform, packaged, env = {} }) {
  if (!packaged) return 'From source (npm start)';
  if (platform === 'win32') {
    return env.PORTABLE_EXECUTABLE_DIR ? 'Windows portable (.exe)' : 'Windows installer (.exe)';
  }
  if (platform === 'darwin') return 'macOS (.dmg)';
  if (platform === 'linux') return env.APPIMAGE ? '' : 'Linux (.deb)';
  return '';
}

/** Anything token-shaped or matching a known secret, gone; the tail kept. */
function scrubLog(text, secrets = []) {
  let out = String(text || '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[removed]');
  }
  out = out.replace(TOKEN_SHAPE, '[removed]').trim();
  if (out.length <= LOG_MAX_CHARS) return out;
  // Cut on a line boundary so the first line isn't half a timestamp.
  const tail = out.slice(-LOG_MAX_CHARS);
  const nl = tail.indexOf('\n');
  return nl === -1 ? tail : tail.slice(nl + 1);
}

/**
 * @param {object} o
 * @param {string} o.version
 * @param {string} [o.os]     an option from osOption()
 * @param {string} [o.build]  an option from buildOption()
 * @param {string} [o.model]  an option of the form's model dropdown
 * @param {string} [o.log]    already scrubbed
 */
function reportUrl({ version, os, build, model, log }) {
  const params = new URLSearchParams({ template: TEMPLATE });
  const fields = { version, os, build, model, log };
  for (const [id, value] of Object.entries(fields)) {
    if (value) params.set(id, value);
  }
  return `${ISSUE_NEW}?${params}`;
}

module.exports = { osOption, buildOption, scrubLog, reportUrl, LOG_MAX_CHARS };
