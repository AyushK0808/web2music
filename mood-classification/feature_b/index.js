/**
 * FEATURE B — Main Orchestrator
 * Mood & Context Classification (AI Layer)
 *
 * Chains:
 *   Handoff 1 (PageData from Feature A)
 *     → B1: Content Understanding
 *     → B2: Mood & Context Classification
 *     → B3: Music Profile Generation
 *     → B4: Prompt Engineering
 *   Handoff 2 (MusicProfile + Prompt → Feature D)
 *
 * This module is imported by background.js (the service worker).
 * It receives Chrome messages and dispatches the pipeline.
 */

"use strict";

import { runB1 } from "./b1_contentUnderstanding.js";
import { runB2 } from "./b2_moodClassifier.js";
import { runB3 } from "./b3_musicProfileGenerator.js";
import { runB4, buildFallbackPrompt } from "./b4_promptEngineer.js";
import { DEFAULT_MODEL } from "./llmConfig.js";
import { getTabState, setTabState, clearTabState, clearAllTabStates, DEFAULT_TAB_ID } from "./tabState.js";

// ─── Confidence interval logic (spec edge case #1) ───────────────────────────
// The new mood must be stable for confidenceWindowMs (default 5s, spec-
// mandated in production) before triggering a music change. Injectable via
// _config.confidenceWindowMs (see configureFeatureB below) specifically so
// tests don't have to sleep out a real 5s per assertion — production code
// never needs to touch it, since the 5000 default matches the spec.
//
// State itself is NOT kept in module variables (fix 13) — MV3 service
// workers are killed after ~30s idle and respawn with a fresh JS context,
// wiping any `let`. Tracking now lives in tabState.js (chrome.storage.session,
// per tabId), which survives a respawn and never mixes up two tabs.

// ─── Idle fade-out (the user has actually gone quiet, not just steady) ───────
// If nothing has been heard from the tab for 5+ minutes, the music fades out
// rather than looping forever unheard: the fade starts at the 4-minute mark
// and reaches silence exactly at 5 minutes.
//
// fix 14: this used to measure idleMs as "time since the current mood was
// confirmed" — which conflates "mood hasn't changed" with "user went idle".
// Someone reading one long, engaging article has a perfectly stable mood
// (say, "focused") for the whole visit; under the old logic their music
// would silently fade to nothing at the 5-minute mark purely because the
// mood never changed, which is the opposite of what a background-ambiance
// product should do. idleMs is now measured from lastActivityAt instead —
// the last time a *real* FEATURE_A_HANDOFF was received for this tab,
// refreshed on every genuine handoff regardless of whether the mood changed.
// The heartbeat alarm's own re-checks (fix 13) do NOT count as activity —
// only Feature A actually observing the tab does — otherwise the alarm
// itself would keep the clock alive forever and the fade could never fire.
const IDLE_FADE_START_MS    = 4 * 60 * 1000;
const IDLE_FADE_COMPLETE_MS = 5 * 60 * 1000;

/**
 * computeFadeVolume — pure function so the fade curve is unit-testable
 * without waiting out real 4-5 minute windows.
 * @param {number} idleMs   Milliseconds since the tab was last heard from
 *   (lastActivityAt) — not since the current mood was confirmed (fix 14).
 * @returns {number|null}   null if no fade is due yet, else a 0..1 volume
 *   multiplier that reaches exactly 0 at IDLE_FADE_COMPLETE_MS and stays 0
 *   for as long as no further activity is observed after that.
 */
export function computeFadeVolume(idleMs) {
  if (idleMs < IDLE_FADE_START_MS) return null;
  const fadeSpan = IDLE_FADE_COMPLETE_MS - IDLE_FADE_START_MS;
  const progress = Math.min(1, (idleMs - IDLE_FADE_START_MS) / fadeSpan);
  return parseFloat((1 - progress).toFixed(3));
}

// ─── Configuration ────────────────────────────────────────────────────────────
let _config = {
  apiKey:             "",            // Set via background.js from chrome.storage — string (direct) or { backend: 'proxy', ... }
  llmModel:           DEFAULT_MODEL, // GroqCloud model for B1/B2's classification calls — single source of truth (see llmConfig.js)
  targetModel:        "musicgen",    // Audio generation backend — "musicgen" | "stable-audio" | "generic" (unrelated to llmModel)
  includeAll:         false,         // Include all prompt variants in output
  confidenceWindowMs: 5000,          // Spec-mandated 5s stability window — override only in tests, never in production
};

export function configureFeatureB(config = {}) {
  _config = { ..._config, ...config };
}

// Merges the configured apiKey (a bare string, or a { backend: 'proxy', ... }
// object) with the configured llmModel into the single config object B1/B2's
// callCategoryLLMClassifier/callLLMClassifier expect — so both calls always
// use the same model without either file hardcoding it.
function buildLLMConfig() {
  const base = typeof _config.apiKey === "string"
    ? { apiKey: _config.apiKey }
    : { ..._config.apiKey };
  return { ...base, model: _config.llmModel };
}

// Rebuilds a handoff2 payload from a persisted record — shared by the live
// pipeline (runFeatureB, which just computed a fresh record) and the
// alarm-driven re-check (reEvaluateTab, which has no fresh pageData and must
// replay the last known one). Keeping this in one place means both paths can
// never drift into rebuilding a handoff2 differently.
function buildHandoffFromRecord(record) {
  if (record.kind === "fallback") return buildFallbackPrompt(record.timeOfDay);
  return runB4(runB3(record.moodContext), {
    targetModel: _config.targetModel,
    includeAll:  _config.includeAll,
  });
}

// Shared by the success path, the error-fallback path, and the alarm-driven
// re-check so all three are gated by the exact same confidence interval — a
// candidate mood only ever becomes "current" (and only then updates the
// tracker / resets idle timing) once it's held stable for confidenceWindowMs.
// Used with candidateMood = "calm" for pipeline errors too (fix 06): a single
// transient error must not hard-switch the music mid-session. State is read
// and written back through tabState.js exactly once per call (fix 13) so
// this survives a service-worker restart between calls and never crosses
// tabs. record is only used to build a handoff2 when one is actually needed,
// so held/no-op calls don't do wasted work.
//
// isFreshActivity (fix 14): true for a real FEATURE_A_HANDOFF (runFeatureB),
// false for the heartbeat's own re-check (reEvaluateActiveTab) — only real
// activity should reset the idle-fade clock, otherwise the heartbeat firing
// on its own schedule would keep the clock alive forever and the fade could
// never trigger regardless of whether the user is actually still there.
async function decideTransition(tabId, candidateMood, record, { isFreshActivity = true } = {}) {
  const state = await getTabState(tabId);
  const now = Date.now();

  if (isFreshActivity) {
    state.lastActivityAt = now;
  }

  let isTransition = false;
  if (candidateMood !== state.pendingMood) {
    // Mood changed (or this is the first call ever for this tab) — reset the window.
    state.pendingMood = candidateMood;
    state.pendingMoodSince = now;
  } else if (state.pendingMood !== state.currentMood) {
    isTransition = (now - state.pendingMoodSince) >= _config.confidenceWindowMs;
  }

  // Keep the latest known context fresh regardless of outcome — this is what
  // lets a later alarm-driven re-check (no fresh pageData available) replay
  // the same pending/idle evaluation on a static page.
  state.lastRecord = record;

  let result = null;
  if (isTransition) {
    state.currentMood = candidateMood;
    state.currentMoodSince = now;
    result = { ...buildHandoffFromRecord(record), volume: 1, isFadeUpdate: false };
  } else if (state.currentMood === candidateMood) {
    // Not a new transition. Fade is driven by genuine inactivity (fix 14),
    // not by "the mood hasn't changed" — someone reading one long article
    // has a stable mood the whole time but isn't idle. If nothing real has
    // been heard from this tab for 4+ minutes, emit a fade-volume update
    // instead of staying silent — the track shouldn't loop forever unheard.
    const idleMs = now - (state.lastActivityAt || now);
    const fadeVolume = computeFadeVolume(idleMs);
    if (fadeVolume !== null) {
      result = { ...buildHandoffFromRecord(record), volume: fadeVolume, isFadeUpdate: true };
    }
  }

  await setTabState(tabId, state);
  return result;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * runFeatureB — full B1→B2→B3→B4 pipeline.
 *
 * @param {Object} pageData   Handoff 1 payload from Feature A
 * @param {string|number} [tabId]  Tab this signal came from — tracking state
 *   (pending/current mood, idle timing) is isolated per tabId (fix 13).
 *   Omit only for direct/manual calls that don't care about multi-tab
 *   isolation (tests, scripts) — they all share one default bucket, the same
 *   sharing behaviour this had before tab isolation existed.
 * @returns {Promise<Object|null>}
 *   Handoff 2 payload, or null if no transition is needed yet.
 *
 * Returns null when:
 *   - The mood hasn't been stable for confidenceWindowMs yet (confidence interval)
 *   - The mood is unchanged from what's already playing
 */
export async function runFeatureB(pageData, tabId = DEFAULT_TAB_ID) {
  try {
    // ── B1: Content Understanding ──────────────────────────────────────────
    const cleanedContent = await runB1(pageData, buildLLMConfig());

    // ── B2: Mood & Context Classification ─────────────────────────────────
    const moodContext = await runB2(cleanedContent, buildLLMConfig());

    // ── Confidence interval check (spec edge case #1) ─────────────────────
    return await decideTransition(tabId, moodContext.mood, { kind: "mood", moodContext });

  } catch (err) {
    console.error("[FeatureB] Pipeline error:", err.message);

    // Edge case #13: LLM API offline or pipeline crash → fall back to calm —
    // but routed through the same confidence-interval gate as a real mood
    // (fix 06), so one transient error can't hard-switch away from whatever
    // is already playing. Only after "calm" has been the outcome — real or
    // erroring — for a full window does this actually take over, exactly
    // like a genuine mood change would.
    const hour      = new Date().getHours();
    const timeOfDay = hour >= 20 || hour < 5 ? "night" : "day";
    return await decideTransition(tabId, "calm", { kind: "fallback", timeOfDay });
  }
}

// ─── Alarm-driven re-check (fix 13) ────────────────────────────────────────
// runFeatureB only ever runs in response to a fresh FEATURE_A_HANDOFF
// message. On a static page — no more scroll/DOM signals — nothing sends
// another one, so a mood stuck "pending" could sit there forever and the
// idle-fade curve (needs 4-5 real minutes to have elapsed) would never get
// re-evaluated either. This re-checks the *active* tab's already-tracked
// state against the current clock, with no new pageData required, and emits
// a handoff2 if a deadline (transition or fade) has actually passed.
//
// Chrome clamps alarm periods to a 1-minute minimum in published extensions,
// so this can't hit the 5s confidence window on the nose — the trade-off is
// bounded latency (worst case ~1 extra minute) instead of the mood never
// resolving at all, which is the actual failure being fixed here.
const HEARTBEAT_ALARM_NAME       = "feature-b-heartbeat";
const HEARTBEAT_PERIOD_MINUTES   = 1;

async function reEvaluateActiveTab() {
  if (typeof chrome === "undefined" || !chrome.tabs) return;

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const activeTabId = tabs[0]?.id;
    if (!activeTabId) return;

    const state = await getTabState(activeTabId);
    if (!state.lastRecord) return; // nothing has ever run for this tab yet

    // Re-propose the same pending mood (or, if none is pending, the current
    // one) — decideTransition itself figures out whether that means a
    // transition is now due, a fade update is now due, or neither yet.
    const candidateMood = state.pendingMood ?? state.currentMood;
    if (!candidateMood) return;

    // isFreshActivity: false — this is Chrome's own timer firing, not a
    // signal that the user is still there (fix 14). Must not reset the
    // idle-fade clock, or the heartbeat would keep it alive forever.
    const handoff2 = await decideTransition(activeTabId, candidateMood, state.lastRecord, { isFreshActivity: false });
    if (handoff2) {
      chrome.runtime.sendMessage({ type: "FEATURE_B_HANDOFF", payload: handoff2 });
    }
  });
}

// ─── Chrome message listener integration ─────────────────────────────────────
// background.js calls this to wire Feature B into the Chrome extension runtime.

/**
 * registerFeatureBListener — registers Feature B as a Chrome runtime message handler,
 * plus the heartbeat alarm and tab-cleanup listener fix 13 needs. Call this
 * once from background.js after chrome.runtime is available — safe to call
 * again on every service-worker respawn (chrome.alarms.create with the same
 * name just replaces the existing alarm, and alarms themselves persist
 * across respawns regardless).
 *
 * Expected message format from Feature A:
 * {
 *   type: "FEATURE_A_HANDOFF",
 *   payload: { ...pageData }
 * }
 *
 * Sends response to Feature D via:
 * {
 *   type: "FEATURE_B_HANDOFF",
 *   payload: { ...handoff2 }
 * }
 */
export function registerFeatureBListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "FEATURE_A_HANDOFF") return false;

    // Active tab guard — only process signals from the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabId = tabs[0]?.id;
      if (!activeTabId || sender.tab?.id !== activeTabId) {
        return; // Ignore signals from inactive tabs (spec edge case #4)
      }

      runFeatureB(message.payload, activeTabId).then((handoff2) => {
        if (!handoff2) return; // Confidence interval not yet met

        chrome.runtime.sendMessage({
          type:    "FEATURE_B_HANDOFF",
          payload: handoff2,
        });
      });
    });

    // sendResponse is never called — the result goes out via a separate
    // runtime.sendMessage broadcast above, not as a reply on this message's
    // own channel. Returning true here without ever calling sendResponse
    // told Chrome to keep this message port open indefinitely, leaking it
    // for the lifetime of the service worker. false tells Chrome this
    // listener is synchronous-done and the port can close immediately; the
    // async work above (tabs.query, runFeatureB, sendMessage) runs
    // independently of this listener's return value either way.
    return false;
  });

  // Re-evaluate the active tab's deadlines even when no new handoff arrives
  // (fix 13) — without this, a static page's pending mood could sit stuck
  // forever and the idle fade would never fire.
  if (typeof chrome !== "undefined" && chrome.alarms) {
    chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === HEARTBEAT_ALARM_NAME) reEvaluateActiveTab();
    });
  }

  // Drop a tab's tracked state when it closes, so chrome.storage.session
  // doesn't accumulate stale per-tab records for the rest of the browser session.
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => { clearTabState(tabId); });
  }
}

// ─── Reset (useful for testing or tab changes) ────────────────────────────────
/**
 * resetConfidenceWindow — clears tracked mood state.
 * @param {string|number} [tabId]  Clear only this tab's state. Omit to clear
 *   every tracked tab (the default — matches the old "wipe everything"
 *   module-global behaviour, used heavily by tests to isolate cases).
 */
export async function resetConfidenceWindow(tabId) {
  if (tabId !== undefined) {
    await clearTabState(tabId);
  } else {
    await clearAllTabStates();
  }
}

// ─── Re-exports for consumers who need individual stages ─────────────────────
export { runB1 } from "./b1_contentUnderstanding.js";
export { runB2, MOODS, MUSIC_CATEGORY_MAP } from "./b2_moodClassifier.js";
export { runB3 } from "./b3_musicProfileGenerator.js";
export { runB4, buildFallbackPrompt } from "./b4_promptEngineer.js";
