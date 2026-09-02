'use strict';
/**
 * Tells the user when a newer release exists. Nothing is downloaded, nothing
 * is installed.
 *
 * Auto-updating was considered and deliberately left out. The binaries are
 * unsigned, which rules out Squirrel.Mac entirely and would leave a downloaded
 * Windows installer unverified, and neither the portable .exe nor the .deb can
 * replace themselves. A link to the release page is the one answer that works
 * for every build we ship.
 *
 * This is also the only request ChatterLayer makes on its own initiative —
 * everything else is Discord and localhost — so it runs once per launch, gives
 * up quickly, and can be switched off in the UI.
 *
 * It used to also sit behind a 24-hour throttle. That bought nothing: the check
 * only ever runs at launch, so the throttle's whole effect was to tell someone
 * who had restarted that morning they were up to date when they weren't. One
 * request per launch of a desktop app is not a budget worth managing.
 */

const https = require('https');

const OWNER_REPO = 'ruptz/ChatterLayer';
/** GitHub excludes drafts and prereleases from this endpoint, which is what
 *  we want: the release workflow publishes drafts for review first. */
const LATEST_API = `https://api.github.com/repos/${OWNER_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${OWNER_REPO}/releases/latest`;

/** A courtesy check must never hold up a launch. */
const TIMEOUT_MS = 6000;

/** `v1.2.3` and `1.2.3-rc.1` both parse; anything else doesn't. */
function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(raw || '').trim());
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

/**
 * -1, 0 or 1, as `a` is older than, equal to, or newer than `b`.
 *
 * A version we can't parse compares equal, so a tag in some unexpected shape
 * can never announce itself as an update.
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;

  for (let i = 0; i < 3; i++) {
    if (va.parts[i] !== vb.parts[i]) return va.parts[i] < vb.parts[i] ? -1 : 1;
  }
  // 1.0.0 is the release of 1.0.0-rc.1, so the plain version is the newer one.
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  return va.pre < vb.pre ? -1 : 1;
}

/** The newest published tag, or '' when the repo has no release yet. */
function fetchLatestTag(userAgent, endpoint = LATEST_API) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      endpoint,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          // The GitHub API rejects requests that don't identify themselves.
          'User-Agent': userAgent,
        },
      },
      (res) => {
        // 404 is "nothing published yet" — a fresh repo, or drafts only.
        // There is nothing newer to offer, so that isn't a failure.
        if (res.statusCode === 404) {
          res.resume();
          return resolve('');
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GitHub replied ${res.statusCode}`));
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // The payload is a few KB. Anything larger isn't what we asked for.
          if (body.length > 512 * 1024) req.destroy(new Error('Response too large'));
        });
        res.on('end', () => {
          try {
            resolve(String(JSON.parse(body).tag_name || ''));
          } catch {
            reject(new Error("Couldn't read GitHub's reply"));
          }
        });
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

function verdict(current, latest) {
  return latest && compareVersions(current, latest) < 0 ? 'available' : 'current';
}

/**
 * @param {object} o
 * @param {string} o.currentVersion  what's running, i.e. app.getVersion()
 * @param {object} o.cache           config.data.updates
 * @param {boolean} [o.force]        ask even with the setting off — the user
 *   pressed something, so the consent is in the gesture
 * @param {string} [o.endpoint]      override the API URL; only the selftest
 *   passes this, to exercise the offline path without a network
 * @returns {Promise<{state:'current'|'available'|'off'|'error', current:string,
 *   latest:string, url:string, lastCheck:number, message?:string}>}
 */
async function checkForUpdate({ currentVersion, cache = {}, force = false, endpoint }) {
  const base = { current: currentVersion, url: RELEASES_PAGE };
  const lastCheck = cache.lastCheck || 0;
  const known = cache.latest || '';

  // Switched off means switched off: no request is made at all.
  if (!cache.check && !force) {
    return { ...base, state: 'off', latest: '', lastCheck };
  }

  try {
    const latest = await fetchLatestTag(`ChatterLayer/${currentVersion}`, endpoint);
    return {
      ...base,
      state: verdict(currentVersion, latest),
      latest,
      lastCheck: Date.now(),
    };
  } catch (err) {
    // Offline, rate-limited, or GitHub having a day. The remembered tag is why
    // the cache still exists: someone who saw an update yesterday and launched
    // on a dead connection today should still be told about it.
    const stale = verdict(currentVersion, known);
    return {
      ...base,
      state: stale === 'available' ? 'available' : 'error',
      latest: known,
      lastCheck,
      message: err.message,
    };
  }
}

module.exports = {
  checkForUpdate,
  compareVersions,
  parseVersion,
  RELEASES_PAGE,
};
