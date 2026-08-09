/**
 * Offscreen message routing — Unit Tests
 * Run with: node ui/offscreen_routing_test.js
 *
 * Regression cover for the bug where every audio command sent through
 * forwardToOffscreen() was swallowed. background.entry.js stamps
 * target:"offscreen" onto all of them, and offscreen.entry.js branched on
 * that field alone, so LOAD_TRACK/DUCK/SET_VOLUME/... were routed into
 * handleExtractMessage(), hit its `default: return false` without ever
 * calling sendResponse, and died on a channel the listener had already held
 * open with `return true`. The audio switch underneath was unreachable and
 * no track ever played.
 */

import { strict as assert } from "assert";
import { OFFSCREEN_EXTRACT_TYPES, isExtractMessage } from "./src/offscreenTypes.js";

// Every message type offscreen.entry.js's audio switch handles. If a case is
// added there it belongs here too — this list is what proves it stays
// reachable.
const AUDIO_COMMANDS = [
  "LOAD_TRACK",
  "PAUSE",
  "RESUME",
  "STOP",
  "DUCK",
  "UNDUCK",
  "SET_ATTENUATION",
  "SET_VOLUME",
  "SET_MOOD_VOLUME",
  "FADE_TO_SILENCE",
  "FADE_OUT",
  "GET_STATUS",
];

console.log("routing: the four Feature A extract RPCs go to handleExtractMessage");
for (const type of OFFSCREEN_EXTRACT_TYPES) {
  assert(isExtractMessage({ target: "offscreen", type }), `${type} should route to the extract handler`);
}

console.log("routing: audio commands are NOT routed to handleExtractMessage");
for (const type of AUDIO_COMMANDS) {
  // This is the exact shape forwardToOffscreen() produces — target is always
  // stamped on, which is why gating on it alone was wrong.
  assert.equal(
    isExtractMessage({ target: "offscreen", type }),
    false,
    `${type} must fall through to the audio switch, not the extract handler`
  );
}

console.log("routing: extract types still require the offscreen target");
for (const type of OFFSCREEN_EXTRACT_TYPES) {
  assert.equal(isExtractMessage({ type }), false, `${type} without target must not be claimed`);
  assert.equal(isExtractMessage({ target: "popup", type }), false, `${type} aimed elsewhere must not be claimed`);
}

console.log("routing: malformed messages don't throw");
for (const msg of [undefined, null, {}, { target: "offscreen" }, { target: "offscreen", type: "UNKNOWN" }]) {
  assert.equal(isExtractMessage(msg), false, `${JSON.stringify(msg)} must not be claimed`);
}

console.log("routing: the extract set matches handleExtractMessage's switch");
assert.deepEqual(
  [...OFFSCREEN_EXTRACT_TYPES].sort(),
  ["A_EMBED", "A_VS_CLEAR", "A_VS_SEARCH", "A_VS_UPSERT", "B_ZEROSHOT"],
  "extract types drifted from offscreenExtract.js's switch — update both"
);

console.log("\nAll offscreen routing tests passed.");
