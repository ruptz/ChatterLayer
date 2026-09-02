'use strict';
// @ts-check
/**
 * Caption word filter.
 *
 * Speech recognition output goes straight onto a live stream, so anything the
 * recogniser emits is broadcast before a human can react. This masks slurs on
 * the way out.
 *
 * The default list below is racial and ethnic slurs only — the category that
 * gets channels banned and does real harm. Anything else is left to the
 * streamer's own list, since standards differ per platform and community.
 */

/**
 * Base terms. Common plural and agentive endings are generated in `expand()`,
 * and spacing is irrelevant to matching (see `compact()`), so only the root
 * form is listed.
 *
 * Streamers can add them via the custom list as well.
 */
const DEFAULT_TERMS = [
  'nigger',
  'nigga',
  'niggah',
  'chink',
  'gook',
  'spic',
  'wetback',
  'beaner',
  'kike',
  'heeb',
  'jigaboo',
  'sambo',
  'darkie',
  'darky',
  'pickaninny',
  'golliwog',
  'towelhead',
  'raghead',
  'paki',
  'zipperhead',
  'slanteye',
  'gyppo',
  'redskin',
  'injun',
  'squaw',
  'abo',
  'boong',
  'coolie',
  'wop',
  'dago',
  'honky',
  'mulatto',
  'quadroon',
  'octoroon',
  'tarbaby',
  'coon',
];

/**
 * Multi-word slurs, matched across adjacent words. Kept separate from
 * DEFAULT_TERMS only for readability — both lists are matched the same way, so
 * a term written here as one word is still caught when spoken as two.
 */
const DEFAULT_PHRASES = [
  'porch monkey',
  'jungle bunny',
  'sand nigger',
  'camel jockey',
  'curry muncher',
  'cotton picker',
  'half breed',
];

/**
 * Strip everything but letters. Vosk emits lowercase words with no
 * punctuation, so this mainly guards against custom entries and any future
 * recogniser that adds punctuation.
 */
function normalize(token) {
  return token.toLowerCase().replace(/[^a-z]/g, '');
}

/** A base term plus the endings a recogniser realistically emits. */
function expand(term) {
  return [term, `${term}s`, `${term}es`, `${term}z`];
}

/**
 * Drop the spaces from an entry.
 *
 * Where a recogniser puts word boundaries is a coin toss: "zipperhead" comes
 * back as "zipper head", "pickaninny" as "pick a ninny", "porch monkey" as one
 * token. Matching on the space-stripped form makes every one of those the same
 * lookup, so a term only has to be listed once in whichever form reads best.
 */
function compact(entry) {
  return String(entry)
    .split(/\s+/)
    .map(normalize)
    .join('');
}

/**
 * How many adjacent words may be joined into one candidate. Four leaves room
 * beyond the worst real case ("pick a ninny", three); past that the recogniser
 * has produced something no word list would have caught anyway.
 */
const MAX_JOIN_WORDS = 4;

/**
 * Joins shorter than this are ignored. Without the floor, short terms fire on
 * innocent pairs — "go ok" is "gook" once the space is gone. Single words are
 * still matched at any length, so nothing that was caught before gets through.
 */
const MIN_JOIN_LENGTH = 5;

/**
 * Build a matcher from the default lists plus the streamer's own entries.
 *
 * @param {{enabled?: boolean, custom?: string[]}} [options]
 */
function buildFilter({ enabled = true, custom = [] } = {}) {
  const keys = new Set();
  let longest = 0;

  const add = (entry) => {
    const base = compact(entry);
    if (!base) return;
    for (const variant of expand(base)) {
      keys.add(variant);
      longest = Math.max(longest, variant.length);
    }
  };

  if (enabled) {
    for (const term of DEFAULT_TERMS) add(term);
    for (const phrase of DEFAULT_PHRASES) add(phrase);
    for (const entry of custom) add(entry);
  }

  return { enabled, keys, longest, size: keys.size };
}

/**
 * Mask any filtered term in `text`, preserving spacing and word length.
 *
 * @param {string} text
 * @param {ReturnType<buildFilter>} filter
 * @returns {{text: string, masked: number}}
 */
function maskText(text, filter) {
  if (!text || !filter || !filter.enabled || filter.size === 0) {
    return { text: text || '', masked: 0 };
  }

  // Split into words and the whitespace between them so the original spacing
  // can be rebuilt exactly. The capturing group puts words at even indices.
  const parts = String(text).split(/(\s+)/);
  const slots = []; // where in `parts` each word sits
  const words = []; // that word, normalized
  for (let i = 0; i < parts.length; i += 2) {
    const word = normalize(parts[i]);
    if (word) {
      slots.push(i);
      words.push(word);
    }
  }

  // Walk every run of adjacent words, joined. A run of one is the plain
  // single-word case; longer runs catch terms the recogniser split apart.
  const hits = new Set();
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let n = 0; n < MAX_JOIN_WORDS && i + n < words.length; n++) {
      joined += words[i + n];
      if (joined.length > filter.longest) break;
      if (n > 0 && joined.length < MIN_JOIN_LENGTH) continue;
      if (filter.keys.has(joined)) {
        for (let w = 0; w <= n; w++) hits.add(i + w);
      }
    }
  }

  if (hits.size === 0) return { text, masked: 0 };

  for (const at of hits) parts[slots[at]] = '*'.repeat(parts[slots[at]].length);
  return { text: parts.join(''), masked: hits.size };
}

module.exports = {
  DEFAULT_TERMS,
  DEFAULT_PHRASES,
  normalize,
  buildFilter,
  maskText,
};
