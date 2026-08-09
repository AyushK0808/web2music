/**
 * Auto-mute on audio-playing pages — Unit Tests
 * Run with: node ui/audioTabs_test.js
 *
 * Covers the policy table in src/audioTabs.js and the two behaviours that
 * are easy to regress by "simplifying" the watcher:
 *   - escalation is immediate, release is delayed (audible flickers false
 *     between tracks / across ad boundaries), and
 *   - a user-muted tab never counts as playing, even though Chrome keeps
 *     reporting audible:true for it.
 */

import { strict as assert } from "assert";
import {
  ATTENUATION,
  ATTENUATION_GAIN,
  decideAttenuation,
  isTabPlayingAudio,
  isMediaDomain,
  createAudioTabWatcher,
} from "./src/audioTabs.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("policy: active tab playing audio -> mute");
assert.equal(
  decideAttenuation({ activeTabId: 1, activeTabUrl: "https://news.example/story", playingTabIds: [1] }).level,
  ATTENUATION.MUTE
);

console.log("policy: only a background tab playing -> duck, not mute");
assert.equal(
  decideAttenuation({ activeTabId: 1, activeTabUrl: "https://docs.example", playingTabIds: [7] }).level,
  ATTENUATION.DUCK
);

console.log("policy: silent media-domain tab -> anticipatory duck");
assert.equal(
  decideAttenuation({ activeTabId: 1, activeTabUrl: "https://www.youtube.com/watch?v=x", playingTabIds: [] }).level,
  ATTENUATION.DUCK
);

console.log("policy: audible non-media page still mutes (the domain list is not the trigger)");
assert.equal(
  decideAttenuation({ activeTabId: 3, activeTabUrl: "https://some.blog/podcast-embed", playingTabIds: [3] }).level,
  ATTENUATION.MUTE
);

console.log("policy: nothing playing anywhere -> clear");
assert.equal(
  decideAttenuation({ activeTabId: 1, activeTabUrl: "https://docs.example", playingTabIds: [] }).level,
  ATTENUATION.CLEAR
);

console.log("policy: no active tab but a background tab is playing -> duck");
assert.equal(
  decideAttenuation({ activeTabId: null, activeTabUrl: null, playingTabIds: [9] }).level,
  ATTENUATION.DUCK
);

console.log("policy: gains are the three documented levels");
assert.equal(ATTENUATION_GAIN[ATTENUATION.CLEAR], 1.0);
assert.equal(ATTENUATION_GAIN[ATTENUATION.DUCK], 0.1);
assert.equal(ATTENUATION_GAIN[ATTENUATION.MUTE], 0.0);

console.log("isTabPlayingAudio: a user-muted tab is not playing, however audible Chrome says it is");
assert.equal(isTabPlayingAudio({ audible: true, mutedInfo: { muted: false } }), true);
assert.equal(isTabPlayingAudio({ audible: true, mutedInfo: { muted: true } }), false);
assert.equal(isTabPlayingAudio({ audible: false }), false);
assert.equal(isTabPlayingAudio(undefined), false);

console.log("isMediaDomain: matches the list, not everything with 'tv' in it");
assert.equal(isMediaDomain("https://www.youtube.com/watch?v=1"), true);
assert.equal(isMediaDomain("https://open.spotify.com/track/1"), true);
assert.equal(isMediaDomain("https://example.com/article"), false);
assert.equal(isMediaDomain(null), false);

// ── Watcher: escalate now, release later ────────────────────────────────────
function fakeChrome() {
  const listeners = { activated: [], updated: [], removed: [] };
  return {
    listeners,
    tabs: {
      query: async () => [],
      get: async () => ({}),
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    },
  };
}

console.log("watcher: escalation to mute is applied immediately");
{
  const changes = [];
  const w = createAudioTabWatcher(fakeChrome(), {
    onChange: (c) => changes.push(c),
    releaseDelayMs: 200,
  });
  w._set({ activeTabId: 1, activeTabUrl: "https://example.com", playing: [1] });
  assert.equal(changes.length, 1, "mute should not wait");
  assert.equal(changes[0].level, ATTENUATION.MUTE);
  assert.equal(changes[0].gain, 0);
}

console.log("watcher: release back to clear waits out the delay");
{
  const changes = [];
  const w = createAudioTabWatcher(fakeChrome(), {
    onChange: (c) => changes.push(c),
    releaseDelayMs: 150,
  });
  w._set({ activeTabId: 1, activeTabUrl: "https://example.com", playing: [1] });
  w._set({ playing: [] });
  assert.equal(changes.length, 1, "release must not fire synchronously");
  assert.equal(w.state.level, ATTENUATION.MUTE, "still muted during the release window");
  await sleep(220);
  assert.equal(changes.length, 2);
  assert.equal(changes[1].level, ATTENUATION.CLEAR);
}

console.log("watcher: a flicker back to audible inside the release window never unmutes");
{
  const changes = [];
  const w = createAudioTabWatcher(fakeChrome(), {
    onChange: (c) => changes.push(c),
    releaseDelayMs: 150,
  });
  w._set({ activeTabId: 1, activeTabUrl: "https://example.com", playing: [1] });
  w._set({ playing: [] });     // gap between two tracks
  await sleep(60);
  w._set({ playing: [1] });    // next track starts
  await sleep(220);
  assert.equal(changes.length, 1, `expected only the initial mute, got ${JSON.stringify(changes)}`);
  assert.equal(w.state.level, ATTENUATION.MUTE);
}

console.log("watcher: mute -> duck (user switches away from the playing tab) is also a release");
{
  const changes = [];
  const w = createAudioTabWatcher(fakeChrome(), {
    onChange: (c) => changes.push(c),
    releaseDelayMs: 100,
  });
  w._set({ activeTabId: 1, activeTabUrl: "https://example.com", playing: [1] });
  w._set({ activeTabId: 2, activeTabUrl: "https://docs.example" }); // tab 1 still playing in the background
  await sleep(160);
  assert.equal(changes.at(-1).level, ATTENUATION.DUCK);
  assert.equal(changes.at(-1).gain, 0.1);
}

console.log("watcher: duck -> mute escalates without waiting for the pending release");
{
  const changes = [];
  const w = createAudioTabWatcher(fakeChrome(), {
    onChange: (c) => changes.push(c),
    releaseDelayMs: 500,
  });
  w._set({ activeTabId: 1, activeTabUrl: "https://www.youtube.com/watch?v=x", playing: [] }); // duck
  assert.equal(changes.at(-1).level, ATTENUATION.DUCK);
  w._set({ playing: [1] }); // the video actually starts
  assert.equal(changes.at(-1).level, ATTENUATION.MUTE, "mute must not sit behind a release timer");
}

console.log("\nAll auto-mute (audioTabs) tests passed.");
