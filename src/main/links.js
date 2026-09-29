'use strict';
/**
 * Decides which links the window may hand to the operating system.
 *
 * shell.openExternal passes the string to whatever is registered for its
 * scheme, so `file:` can launch a program and handlers like `ms-msdt:` have
 * carried remote-code-execution bugs. Every link the app opens today is a
 * fixed https address, but the window also shows Discord names and captions;
 * if one of those ever reached the page as HTML, this is what keeps injected
 * script from turning into a launched program.
 */

/** @param {unknown} url */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { isSafeExternalUrl };
