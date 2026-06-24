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

// ─── Confidence interval logic (spec edge case #1) ───────────────────────────
// The new mood must be stable for 5 seconds before triggering a music change.

const CONFIDENCE_WINDOW_MS = 5000;

let _pendingMood       = null;
let _pendingMoodSince  = 0;
let _currentMood       = null;

/**
 * shouldTransition — returns true only if the new mood has been
 * consistently detected for ≥5 seconds (spec: "Confidence Interval: 5 seconds").
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

  return (now - _pendingMoodSince) >= CONFIDENCE_WINDOW_MS;
}

// ─── Configuration ────────────────────────────────────────────────────────────
let _config = {
  apiKey:      "",          // Set via background.js from chrome.storage
  targetModel: "musicgen",  // "musicgen" | "stable-audio" | "generic"
  includeAll:  false,       // Include all prompt variants in output
};

export function configureFeatureB(config = {}) {
  _config = { ..._config, ...config };
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
    const cleanedContent = runB1(pageData);

    // ── B2: Mood & Context Classification ─────────────────────────────────
    const moodContext = await runB2(cleanedContent, _config.apiKey);

    // ── Confidence interval check (spec edge case #1) ─────────────────────
    if (!shouldTransition(moodContext.mood)) {
      return null; // Not yet stable — hold current music
    }

    // Mood confirmed stable — update tracker
    _currentMood = moodContext.mood;

    // ── B3: Music Profile Generation ──────────────────────────────────────
    const musicProfile = runB3(moodContext);

    // ── B4: Prompt Engineering ────────────────────────────────────────────
    const handoff2 = runB4(musicProfile, {
      targetModel: _config.targetModel,
      includeAll:  _config.includeAll,
    });

    return handoff2;

  } catch (err) {
    console.error("[FeatureB] Pipeline error:", err.message);

    // Edge case #13: LLM API offline or pipeline crash → fallback to calm
    const hour       = new Date().getHours();
    const timeOfDay  = hour >= 20 || hour < 5 ? "night" : "day";
    return buildFallbackPrompt(timeOfDay);
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

    return true; // Keep message channel open for async response
  });
}

// ─── Reset (useful for testing or tab changes) ────────────────────────────────
export function resetConfidenceWindow() {
  _pendingMood      = null;
  _pendingMoodSince = 0;
  _currentMood      = null;
}

// ─── Re-exports for consumers who need individual stages ─────────────────────
export { runB1 } from "./b1_contentUnderstanding.js";
export { runB2, MOODS, MUSIC_CATEGORY_MAP } from "./b2_moodClassifier.js";
export { runB3 } from "./b3_musicProfileGenerator.js";
export { runB4, buildFallbackPrompt } from "./b4_promptEngineer.js";
