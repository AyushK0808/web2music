/**
 * background.js — Integration snippet (DOCUMENTATION ONLY, not imported)
 *
 * Historical reference for how Feature B plugs into a service worker via
 * the chrome.runtime.sendMessage broadcast path. The real
 * ui/src/background.entry.js no longer imports this file — it calls
 * feature_b/index.js's onHandoff2(cb) instead, which delivers handoff2
 * payloads directly, in-process. The broadcast path used below never
 * actually worked for a same-context listener: registerFeatureBListener's
 * emissions run inside the service worker, and chrome.runtime.sendMessage
 * never delivers a message back to its own sender's context (see the X4
 * integration plan's finding (a), and onHandoff2 in feature_b/index.js).
 * Kept here as a worked example of the FEATURE_B_HANDOFF payload shape for
 * anyone testing Feature B from a *different* context (e.g. a popup).
 */

"use strict";

import {
  configureFeatureB,
  registerFeatureBListener,
} from "./feature_b/index.js";

// ── 1. Load API key / backend choice from chrome.storage on startup ─────────
// Two LLM backends (see services/classify/README.md):
//   "direct" (default) — apiKey ships in this bundle, calls api.groq.com
//   "proxy"             — no key here; calls services/classify/classifyService.js, which
//                          holds GROQ_API_KEY server-side instead
// llmApiKey should be a GroqCloud key (starts with "gsk_") — get a free one
// at https://console.groq.com/keys.
chrome.storage.sync.get(["llmApiKey", "llmBackend", "llmServiceUrl", "targetModel"], (settings) => {
  configureFeatureB({
    apiKey: settings.llmBackend === "proxy"
      ? { backend: "proxy", serviceUrl: settings.llmServiceUrl || "http://localhost:8078/v1/chat/completions" }
      : (settings.llmApiKey ?? ""),
    targetModel: settings.targetModel ?? "musicgen",
  });
});

// ── 2. Register Feature B as a message listener ───────────────────────────────
registerFeatureBListener();

// ── 3. Forward Feature B's Handoff 2 output → Feature D (offscreen audio) ───
// Feature D's /generate endpoint (audio-generation/main.py) POSTs the
// request body straight through to d1_validate.py, which only recognises a
// flat, snake_case profile (mood, energy, bpm, key, style, content_category,
// ...). Forwarding the whole nested, camelCase Handoff 2 payload verbatim
// meant every one of those fields was missing, so every page silently
// generated identical default audio ("calm", 80 bpm, "C major") regardless
// of what B actually classified (fix 17). handoff2.profile (built in
// b4_promptEngineer.js) is the correct, already-flattened shape to send.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "FEATURE_B_HANDOFF") return;

  const handoff2 = message.payload;

  // Sensitive-content silence (fix 16) means "go quiet", not "generate a new
  // calm track and immediately mute it" — asking Feature D to generate audio
  // it'll never be heard playing is pure waste. Signal a local mute instead.
  if (handoff2.isSilent) {
    chrome.runtime.sendMessage({ type: "FEATURE_D_SILENCE" });
    return;
  }

  chrome.runtime.sendMessage({
    type:    "FEATURE_D_REQUEST",
    payload: handoff2.profile,
  });
});

// ── 4. Service worker keepalive (spec edge case #20) ─────────────────────────
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { /* intentionally empty */ });
