'use strict';
/**
 * Stops @discordjs/voice from dragging the bot back to a channel it was just
 * moved out of.
 *
 * When someone moves the bot, Discord closes the old voice socket and, over
 * the main gateway, says where the bot is now. The two arrive in either
 * order. If the close wins, the library treats it as an accidental drop and
 * at once asks to rejoin the channel it still thinks it's in — the old one —
 * and Discord obeys. From the outside the bot bounces between the channels
 * until the gateway message happens to win.
 *
 * Nothing can know about the move at that moment, so the library's own
 * rejoins are held back briefly and then sent to whatever channel the
 * connection has learned of by then. Joins the engine asks for itself
 * (Connect, Follow, drop recovery) go straight through.
 */

/** Voice State Update: the gateway opcode for joining, moving or leaving. */
const OP_VOICE_STATE = 4;

/** Comfortably longer than the gap between the two messages on a move. */
const HOLD_MS = 1000;

/**
 * @param {Function} adapterCreator  a guild's voiceAdapterCreator
 * @param {object} o
 * @param {() => boolean} o.isOwnJoin        true while the engine itself is joining
 * @param {() => string|undefined} o.currentChannelId  where the connection now thinks it belongs
 * @param {number} [o.holdMs]
 */
function holdLibraryRejoins(adapterCreator, { isOwnJoin, currentChannelId, holdMs = HOLD_MS }) {
  return (methods) => {
    const adapter = adapterCreator(methods);
    let held = null;
    const cancel = () => {
      clearTimeout(held);
      held = null;
    };

    return {
      ...adapter,
      sendPayload(payload) {
        const isJoin = payload?.op === OP_VOICE_STATE && Boolean(payload.d?.channel_id);
        // Leaving, and the engine's own joins, are never delayed — and either
        // makes a held rejoin obsolete.
        if (!isJoin || isOwnJoin()) {
          cancel();
          return adapter.sendPayload(payload);
        }
        cancel();
        held = setTimeout(() => {
          held = null;
          const channelId = currentChannelId() || payload.d.channel_id;
          adapter.sendPayload({ ...payload, d: { ...payload.d, channel_id: channelId } });
        }, holdMs);
        held.unref?.();
        return true;
      },
      destroy() {
        cancel();
        adapter.destroy();
      },
    };
  };
}

module.exports = { holdLibraryRejoins, HOLD_MS };
