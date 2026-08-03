// ui/src/offscreenTypes.js — the single source of truth for which messages
// the offscreen document handles as Feature A *extract* RPCs.
//
// This exists because background.entry.js and offscreen.entry.js used to
// disagree about what `target: "offscreen"` meant. forwardToOffscreen()
// stamps that field onto *every* message it sends — audio commands
// (LOAD_TRACK, DUCK, SET_VOLUME, ...) included — but the offscreen listener
// branched on `msg.target === "offscreen"` alone and routed all of them into
// handleExtractMessage(), whose switch only knows the four A_* types and
// falls through to `default: return false` without ever calling
// sendResponse. The listener had already returned true to hold the channel
// open, so every audio command died there: the channel closed unanswered
// ("A listener indicated an asynchronous response by returning true, but the
// message channel closed before a response was received") and the audio
// switch below it was unreachable dead code. Nothing ever played.
//
// Routing is keyed on the message *type*, not on `target`, so adding an
// audio command can't silently re-open that hole.
export const OFFSCREEN_EXTRACT_TYPES = new Set([
  "A_EMBED",
  "A_VS_SEARCH",
  "A_VS_UPSERT",
  "A_VS_CLEAR",
]);

/**
 * isExtractMessage — true only for messages handleExtractMessage can answer.
 * Everything else addressed to the offscreen document is an audio command
 * and belongs to offscreen.entry.js's own switch.
 */
export function isExtractMessage(msg) {
  return msg?.target === "offscreen" && OFFSCREEN_EXTRACT_TYPES.has(msg.type);
}
