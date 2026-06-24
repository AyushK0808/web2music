/**
 * background.js — Integration snippet
 *
 * Shows how Feature B plugs into the service worker.
 * This is NOT the full background.js — only the Feature B wiring.
 * Your full background.js will also contain Feature A cache logic,
 * offscreen audio control, and popup message handlers.
 */

"use strict";

import {
  configureFeatureB,
  registerFeatureBListener,
} from "./feature_b/index.js";

// ── 1. Load API key from chrome.storage on startup ───────────────────────────
chrome.storage.sync.get(["llmApiKey", "targetModel"], (settings) => {
  configureFeatureB({
    apiKey:      settings.llmApiKey   ?? "",
    targetModel: settings.targetModel ?? "musicgen",
  });
});

// ── 2. Register Feature B as a message listener ───────────────────────────────
registerFeatureBListener();

// ── 3. Forward Feature B's Handoff 2 output → Feature D (offscreen audio) ───
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "FEATURE_B_HANDOFF") return;

  // Send to Feature D (audio generation system)
  chrome.runtime.sendMessage({
    type:    "FEATURE_D_REQUEST",
    payload: message.payload,
  });
});

// ── 4. Service worker keepalive (spec edge case #20) ─────────────────────────
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { /* intentionally empty */ });
