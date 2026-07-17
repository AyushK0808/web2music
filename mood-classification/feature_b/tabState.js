/**
 * FEATURE B — per-tab confidence-interval/idle-fade state (fix 13).
 *
 * The orchestrator (index.js) used to keep _pendingMood/_currentMood as
 * plain module-level `let` variables. That's fine in Node, but breaks in a
 * real MV3 extension in three ways:
 *
 *   1. MV3 background scripts are service workers, not persistent pages —
 *      Chrome kills them after ~30s of inactivity and respawns a fresh JS
 *      context on the next event. Every module-level `let` resets to its
 *      initial value on respawn, so a pending mood's stability window could
 *      get wiped and restarted indefinitely if handoffs arrive further
 *      apart than the service worker's idle timeout.
 *   2. A single global bucket was shared by every tab — switching tabs
 *      could corrupt one tab's tracked mood with another's.
 *   3. There's no way to reconstruct "what was this tab doing" after a
 *      restart from module state alone — it's gone.
 *
 * chrome.storage.session is MV3's purpose-built answer: it survives
 * service-worker restarts but (unlike .local/.sync) is cleared when the
 * browser closes, which is exactly the lifetime this tracking state should
 * have. Keyed per tabId so tabs never interfere with each other.
 *
 * Falls back to an in-memory Map when chrome.storage.session isn't
 * available (Node tests, manual scripts, older Chrome) — same shape, same
 * per-tab isolation, just without real cross-restart persistence, which
 * isn't a meaningful concept outside a real service worker anyway.
 */

"use strict";

const KEY_PREFIX = "fb_tab_";

export const DEFAULT_TAB_ID = "__default__";

function hasSessionStorage() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.session;
}

function keyFor(tabId) {
  return `${KEY_PREFIX}${tabId}`;
}

function defaultState() {
  return {
    pendingMood:      null,
    pendingMoodSince: 0,
    currentMood:      null,
    currentMoodSince: 0,
    // Enough context to rebuild the last handoff2 without a fresh
    // classification — needed so the alarm-driven re-check (index.js) can
    // re-evaluate a deadline on a static page with no new pageData.
    //   { kind: "mood", moodContext } | { kind: "fallback", timeOfDay } | null
    lastRecord: null,
  };
}

const _memoryStore = new Map();

/** Reads a tab's tracked state, or a fresh default if none exists yet. */
export async function getTabState(tabId) {
  const key = keyFor(tabId);
  if (hasSessionStorage()) {
    const stored = await chrome.storage.session.get(key);
    return stored[key] ?? defaultState();
  }
  return _memoryStore.get(key) ?? defaultState();
}

/** Persists a tab's full state object. */
export async function setTabState(tabId, state) {
  const key = keyFor(tabId);
  if (hasSessionStorage()) {
    await chrome.storage.session.set({ [key]: state });
  } else {
    _memoryStore.set(key, state);
  }
}

/** Drops a single tab's tracked state — call on tab close (edge case cleanup). */
export async function clearTabState(tabId) {
  const key = keyFor(tabId);
  if (hasSessionStorage()) {
    await chrome.storage.session.remove(key);
  } else {
    _memoryStore.delete(key);
  }
}

/** Drops every tracked tab's state (used by resetConfidenceWindow() with no args). */
export async function clearAllTabStates() {
  if (hasSessionStorage()) {
    const all = await chrome.storage.session.get(null);
    const keysToRemove = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
    if (keysToRemove.length) await chrome.storage.session.remove(keysToRemove);
  }
  _memoryStore.clear();
}
