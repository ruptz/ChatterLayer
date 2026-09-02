'use strict';
// @ts-check

// Bright, well-separated hues that all clear WCAG AA against the overlay's
// dark backdrop — captions are an accessibility feature first.
const PALETTE = [
  '#FF6B6B', // red
  '#4ECDC4', // teal
  '#FFD93D', // yellow
  '#6BCB77', // green
  '#4D96FF', // blue
  '#FF9F45', // orange
  '#C780FA', // purple
  '#FF6FB5', // pink
  '#00D2FF', // cyan
  '#B5E48C', // lime
  '#F4A261', // sand
  '#9D4EDD', // violet
  '#52D1DC', // aqua
  '#FFB4A2', // salmon
  '#A0C4FF', // periwinkle
  '#E8E337', // citron
];

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The colour a user gets in isolation. Fallback for people who have left.
 *
 * @param {string} userId
 * @param {Record<string,string>} [overrides] userId -> "#rrggbb"
 */
function colorForUser(userId, overrides) {
  if (overrides && overrides[userId]) return overrides[userId];
  return PALETTE[fnv1a(String(userId)) % PALETTE.length];
}

/**
 * Assign colours across a whole call so no two people share one.
 *
 * Hashing alone isn't enough: with 16 colours, seven random users collide ~78%
 * of the time. Each user still prefers their hashed colour, but collisions
 * probe forward through the palette. Sorted-ID iteration keeps the result
 * deterministic for a given set of people.
 *
 * @param {Iterable<string>} userIds
 * @param {Record<string,string>} [overrides]
 * @returns {Map<string,string>}
 */
function assignColors(userIds, overrides = {}) {
  const assignment = new Map();
  const taken = new Set();
  const ids = [...userIds].sort();

  for (const id of ids) {
    const override = overrides[id];
    if (override) {
      assignment.set(id, override);
      taken.add(override.toUpperCase());
    }
  }

  for (const id of ids) {
    if (assignment.has(id)) continue;
    const start = fnv1a(String(id)) % PALETTE.length;
    let chosen = null;
    for (let i = 0; i < PALETTE.length; i++) {
      const candidate = PALETTE[(start + i) % PALETTE.length];
      if (!taken.has(candidate.toUpperCase())) {
        chosen = candidate;
        break;
      }
    }
    // Past 16 concurrent speakers duplication is unavoidable.
    if (!chosen) chosen = PALETTE[start];
    assignment.set(id, chosen);
    taken.add(chosen.toUpperCase());
  }

  return assignment;
}

module.exports = { PALETTE, colorForUser, assignColors, fnv1a };
