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

// ─── Confidence interval logic (spec edge case #1) ───────────────────────────
// The new mood must be stable for confidenceWindowMs (default 5s, spec-
// mandated in production) before triggering a music change. Injectable via
// _config.confidenceWindowMs (see configureFeatureB below) specifically so
// tests don't have to sleep out a real 5s per assertion — production code
// never needs to touch it, since the 5000 default matches the spec.

let _pendingMood       = null;
let _pendingMoodSince  = 0;
let _currentMood       = null;
let _currentMoodSince  = 0;

/**
 * shouldTransition — returns true only if the new mood has been
 * consistently detected for ≥_config.confidenceWindowMs (spec: "Confidence
 * Interval: 5 seconds", default).
 */
function shouldTransition(newMood) {
  const now = Date.now();

  if (newMood !== _pendingMood) {
    // Mood changed — reset the window
    _pendingMood      = newMood;
    _pendingMoodSince = now;
    return false;
  }

  if (_pendingMood === _currentMood) {
    // Already playing this mood — no transition needed
    return false;
  }

  return (now - _pendingMoodSince) >= _config.confidenceWindowMs;
}

// ─── Idle fade-out (same mood held too long) ─────────────────────────────────
// If the same track has been playing for 5+ minutes with no mood change, the
// music fades out rather than looping the same mood indefinitely: the fade
// starts at the 4-minute mark and reaches silence exactly at 5 minutes.
const IDLE_FADE_START_MS    = 4 * 60 * 1000;
const IDLE_FADE_COMPLETE_MS = 5 * 60 * 1000;

/**
 * computeFadeVolume — pure function so the fade curve is unit-testable
 * without waiting out real 4-5 minute windows.
 * @param {number} idleMs   Milliseconds since the current mood started playing.
 * @returns {number|null}   null if no fade is due yet, else a 0..1 volume
 *   multiplier that reaches exactly 0 at IDLE_FADE_COMPLETE_MS and stays 0
 *   for as long as the mood remains unchanged after that.
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

// Shared by the success path and the error-fallback path so both are gated
// by the same 5s confidence interval — a candidate mood only ever becomes
// "current" (and only then updates the tracker / resets idle timing) once
// shouldTransition confirms it's held stable. Used with candidateMood =
// "calm" for pipeline errors too (fix 06): a single transient error must not
// hard-switch the music mid-session just because it happened once, same as
// a single ambiguous mood reading doesn't. buildHandoff2 is only invoked
// when actually needed, so failed/held calls don't do wasted work.
function decideTransition(candidateMood, buildHandoff2) {
  if (!shouldTransition(candidateMood)) {
    // Not a confirmed transition. If this is the same mood that's already
    // playing and it's been idle 4+ minutes, emit a fade-volume update
    // instead of staying silent — the track shouldn't loop forever unheard.
    if (_currentMood === candidateMood && _currentMoodSince) {
      const fadeVolume = computeFadeVolume(Date.now() - _currentMoodSince);
      if (fadeVolume !== null) {
        return { ...buildHandoff2(), volume: fadeVolume, isFadeUpdate: true };
      }
    }
    return null; // Not yet stable — hold current music
  }

  // Mood confirmed stable — update tracker
  _currentMood      = candidateMood;
  _currentMoodSince = Date.now();
  return { ...buildHandoff2(), volume: 1, isFadeUpdate: false };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * runFeatureB — full B1→B2→B3→B4 pipeline.
 *
 * @param {Object} pageData   Handoff 1 payload from Feature A
 * @returns {Promise<Object|null>}
 *   Handoff 2 payload, or null if no transition is needed yet.
 *
 * Returns null when:
 *   - The mood hasn't been stable for 5 seconds yet (confidence interval)
 *   - The mood is unchanged from what's already playing
 */
export async function runFeatureB(pageData) {
  try {
    // ── B1: Content Understanding ──────────────────────────────────────────
    const cleanedContent = await runB1(pageData, buildLLMConfig());

    // ── B2: Mood & Context Classification ─────────────────────────────────
    const moodContext = await runB2(cleanedContent, buildLLMConfig());

    // ── Confidence interval check (spec edge case #1) ─────────────────────
    return decideTransition(moodContext.mood, () => runB4(runB3(moodContext), {
      targetModel: _config.targetModel,
      includeAll:  _config.includeAll,
    }));

  } catch (err) {
    console.error("[FeatureB] Pipeline error:", err.message);

    // Edge case #13: LLM API offline or pipeline crash → fall back to calm —
    // but routed through the same confidence-interval gate as a real mood
    // (fix 06), so one transient error can't hard-switch away from whatever
    // is already playing. Only after "calm" has been the outcome — real or
    // erroring — for a full 5s does this actually take over, exactly like a
    // genuine mood change would.
    const hour      = new Date().getHours();
    const timeOfDay = hour >= 20 || hour < 5 ? "night" : "day";
    return decideTransition("calm", () => buildFallbackPrompt(timeOfDay));
  }
}

// ─── Chrome message listener integration ─────────────────────────────────────
// background.js calls this to wire Feature B into the Chrome extension runtime.

/**
 * registerFeatureBListener — registers Feature B as a Chrome runtime message handler.
 * Call this once from background.js after chrome.runtime is available.
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

      runFeatureB(message.payload).then((handoff2) => {
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
}

// ─── Reset (useful for testing or tab changes) ────────────────────────────────
export function resetConfidenceWindow() {
  _pendingMood      = null;
  _pendingMoodSince = 0;
  _currentMood      = null;
  _currentMoodSince = 0;
}

// ─── Re-exports for consumers who need individual stages ─────────────────────
export { runB1 } from "./b1_contentUnderstanding.js";
export { runB2, MOODS, MUSIC_CATEGORY_MAP } from "./b2_moodClassifier.js";
export { runB3 } from "./b3_musicProfileGenerator.js";
export { runB4, buildFallbackPrompt } from "./b4_promptEngineer.js";
