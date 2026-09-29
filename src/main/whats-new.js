'use strict';
/**
 * The "What's new" card shown once after an update.
 *
 * The notes ship inside the app rather than being fetched from the release
 * page: the update check is optional, and someone who switched it off should
 * still find out what the version they just installed does differently.
 *
 * Once means once. It is decided at launch, recorded straight away, and never
 * comes back on a timer — whether or not the card is dismissed.
 */

const { compareVersions } = require('./updates');

/** Newest first. A release with nothing worth announcing needs no entry. */
const NOTES = [
  {
    version: '0.4.0',
    items: [
      'Caption your own mic. Under Source, pick Discord call, My mic, or Both. My mic alone never signs in to Discord, so nothing leaves your PC.',
      'Both catches what you say while muted in Discord or off push-to-talk, like reading chat out. Press “This is me” on your own Discord row and you’re only captioned once.',
      'A new look, matching chatterlayer.com — with light and dark, or Match system, under the cog.',
      'It recovers on its own: a crashed engine restarts and rejoins the call with the same people on, and a dropped voice connection is rejoined instead of ending the stream.',
      'Pause captions stays in the call but sends nothing, and clears the overlay at once. Also on the tray menu, and on a hotkey if you turn them on.',
      'Follow mode: press Follow on someone and the bot moves with them between voice channels in that server.',
      'The bot stays in the call when a moderator moves it, and you get a notification if captions stop while you’re looking elsewhere.',
      'Start with the computer, straight into the tray — signed in and waiting, nothing else.',
      'A setup checklist walks a first run from model to OBS, and gets out of the way once everything is green.',
      'Invite the bot to a server straight from the Source panel — no URL Generator.',
      'Server and channel pickers update by themselves when the bot joins a server or a channel changes.',
      'Output shows whether OBS is connected, and Send test caption puts a line on the overlay so you can size it without being in a call.',
      'Download the model that suits this PC in one click.',
      'Report a problem opens a bug report with your version, system and log already filled in — never your token.',
    ],
  },
];

/**
 * What to show at this launch, or null.
 *
 * @param {object} o
 * @param {string} o.current     the running version
 * @param {string} o.lastSeen    the version recorded last time, '' if never
 * @param {boolean} o.upgraded   whether a config file existed before this
 *   launch. Distinguishes a fresh install (nothing to announce) from an
 *   upgrade from a version too old to have recorded `lastSeen`.
 * @returns {{version: string, items: string[]}[] | null}
 */
function whatsNewFor({ current, lastSeen, upgraded, notes = NOTES }) {
  if (!lastSeen && !upgraded) return null;
  const shown = notes.filter(
    (n) =>
      compareVersions(n.version, current) <= 0 &&
      // With no record of what came before, only this version's notes are
      // safe to claim as new.
      (lastSeen ? compareVersions(n.version, lastSeen) > 0 : n.version === current)
  );
  return shown.length ? shown : null;
}

module.exports = { whatsNewFor, NOTES };
