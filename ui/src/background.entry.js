// ui/src/background.entry.js — MV3 service worker: Feature A relay, Feature
// B wiring (with the same-context onHandoff2 fix), Feature D client, tab
// ducking/idle, telemetry, and the popup message surface.

import { configureFeatureB, registerFeatureBHeartbeat, onHandoff2, runFeatureB } from "../../mood-classification/feature_b/index.js";
import { requestTrack, requestGeneration } from "./featureDClient.js";
import { recordTelemetry, urlHash, exportTelemetry } from "./telemetry.js";
import { MOODS } from "../../mood-classification/feature_b/index.js";

const OFFSCREEN_TARGETS = new Set(["A_EMBED", "A_VS_SEARCH", "A_VS_UPSERT", "A_VS_CLEAR"]);

// ── Offscreen document lifecycle ─────────────────────────────────────────────
// Both AUDIO_PLAYBACK (Feature C) and WORKERS (the embed worker spawned for
// Feature A, so ONNX inference can't block the audio thread) — only one
// offscreen document is allowed per extension, so it hosts both.
async function ensureOffscreen() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (!hasDoc) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK", "WORKERS"],
      justification: "Play generated ambient music and run local embedding inference for the current webpage",
    });
  }
}

async function forwardToOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

// ── Audio / UI state ──────────────────────────────────────────────────────
const audioState = {
  status: "stopped",
  currentUrl: null,
  currentTabId: null,
  currentProfile: null,
  isDucked: false,
  isEnabled: true,
  isPaused: false,
  classifyProxyReachable: null, // null = not yet checked
};

chrome.storage.local.get({ masterEnabled: true }, ({ masterEnabled }) => {
  audioState.isEnabled = masterEnabled;
});

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", ...audioState }).catch(() => {});
}

// ── Feature B wiring ──────────────────────────────────────────────────────
chrome.storage.sync.get(["llmApiKey", "llmBackend", "llmServiceUrl", "targetModel"], (settings) => {
  configureFeatureB({
    apiKey: settings.llmBackend === "proxy" || !settings.llmApiKey
      ? { backend: "proxy", serviceUrl: settings.llmServiceUrl || "http://localhost:8078/v1/chat/completions" }
      : settings.llmApiKey,
    targetModel: settings.targetModel ?? "musicgen",
  });
});

registerFeatureBHeartbeat();

async function checkClassifyProxy() {
  const { llmServiceUrl } = await chrome.storage.sync.get(["llmServiceUrl"]);
  const base = (llmServiceUrl || "http://localhost:8078/v1/chat/completions").replace(/\/v1\/.*/, "");
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    audioState.classifyProxyReachable = res.ok;
  } catch {
    audioState.classifyProxyReachable = false;
  }
  broadcastStatus();
}
checkClassifyProxy();

// Handoff-2 routing (X4 plan 3.3) — replaces background_integration.js,
// which is kept only as documentation now that onHandoff2 delivers in the
// same context instead of round-tripping through chrome.runtime.sendMessage.
async function handleHandoff2(handoff2, tabId) {
  recordTelemetry("B_decision", { tabId, event: "handoff2", meta: { isSilent: !!handoff2.isSilent, isFadeUpdate: !!handoff2.isFadeUpdate } });

  if (handoff2.isSilent) {
    forwardToOffscreen({ type: "FADE_TO_SILENCE" });
    return;
  }
  if (handoff2.isFadeUpdate) {
    forwardToOffscreen({ type: "SET_MOOD_VOLUME", value: handoff2.volume });
    return;
  }

  audioState.currentProfile = handoff2.profile;
  audioState.status = "loading";
  broadcastStatus();

  const t0 = performance.now();
  try {
    await requestTrack(handoff2.profile, {
      onFallback: (clip) => {
        forwardToOffscreen({ type: "LOAD_TRACK", url: clip.audio_url, loopPointMs: clip.metadata?.loop_point_ms });
      },
      onGenerated: (clip) => {
        forwardToOffscreen({ type: "LOAD_TRACK", url: clip.audio_url, loopPointMs: clip.metadata?.loop_point_ms });
        audioState.currentUrl = clip.audio_url;
        audioState.status = "playing";
        audioState.isPaused = false;
        broadcastStatus();
        recordTelemetry("D_generate", {
          tabId,
          event: "generate",
          ms: performance.now() - t0,
          meta: { cache: clip.cache, isFallback: clip.metadata?.is_fallback, timings: clip.timings },
        });
      },
    });
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer mood — not an error
    console.error("[background] Feature D request failed:", err);
    audioState.status = "error";
    broadcastStatus();
  }
}
onHandoff2(handleHandoff2);

// ── Tab monitoring / ducking ──────────────────────────────────────────────
const MEDIA_DOMAINS = ["youtube.com", "spotify.com", "netflix.com", "twitch.tv", "soundcloud.com"];
function isMediaTab(url) {
  return !!url && MEDIA_DOMAINS.some((d) => url.includes(d));
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  audioState.currentTabId = tabId;
  const shouldDuck = isMediaTab(tab.url);
  if (shouldDuck !== audioState.isDucked) {
    audioState.isDucked = shouldDuck;
    forwardToOffscreen({ type: shouldDuck ? "DUCK" : "UNDUCK" });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || tabId !== audioState.currentTabId) return;
  const shouldDuck = isMediaTab(tab.url);
  audioState.isDucked = shouldDuck;
  forwardToOffscreen({ type: shouldDuck ? "DUCK" : "UNDUCK" });
});

// ── Idle detection ────────────────────────────────────────────────────────
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "idle" || state === "locked") {
    forwardToOffscreen({ type: "FADE_OUT", seconds: 4 });
    audioState.status = "stopped";
    audioState.isPaused = false;
  }
});

// ── Message router ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Relay for Feature A's offscreen RPCs (embed / vector store) — see the
  // comment in remoteDeps.js on why `target` is added here, not by the
  // content script itself.
  if (OFFSCREEN_TARGETS.has(msg.type)) {
    (async () => {
      await ensureOffscreen();
      chrome.runtime.sendMessage({ target: "offscreen", ...msg }, (response) => sendResponse(response));
    })();
    return true;
  }

  switch (msg.type) {
    case "A_PAGE_DATA": {
      (async () => {
        const { masterEnabled } = await chrome.storage.local.get({ masterEnabled: true });
        audioState.isEnabled = masterEnabled;
        if (!audioState.isEnabled) return;

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || activeTab.id !== sender.tab?.id) return;

        audioState.currentTabId = sender.tab.id;
        const hash = await urlHash(msg.pageData?.url);
        recordTelemetry("A_extract", { tabId: sender.tab.id, event: "extract", urlHash: hash, meta: msg.telemetry });

        const t0 = performance.now();
        const handoff2 = await runFeatureB(msg.pageData, sender.tab.id);
        recordTelemetry("B_decision", { tabId: sender.tab.id, event: "runFeatureB", ms: performance.now() - t0, meta: { transitioned: !!handoff2 } });
        if (handoff2) handleHandoff2(handoff2, sender.tab.id);
      })();
      break;
    }

    case "POPUP_PLAY":
      if (audioState.isPaused) {
        forwardToOffscreen({ type: "RESUME" });
        audioState.isPaused = false;
        audioState.status = "playing";
      } else if (audioState.currentUrl) {
        forwardToOffscreen({ type: "LOAD_TRACK", url: audioState.currentUrl });
        audioState.status = "playing";
      }
      broadcastStatus();
      break;

    case "POPUP_PAUSE":
      forwardToOffscreen({ type: "PAUSE" });
      audioState.isPaused = true;
      audioState.status = "paused";
      broadcastStatus();
      break;

    case "POPUP_STOP":
      forwardToOffscreen({ type: "STOP" });
      audioState.isPaused = false;
      audioState.status = "stopped";
      broadcastStatus();
      break;

    case "POPUP_SET_ENABLED":
      audioState.isEnabled = msg.enabled;
      chrome.storage.local.set({ masterEnabled: msg.enabled });
      if (!msg.enabled) {
        forwardToOffscreen({ type: "STOP" });
        audioState.isPaused = false;
        audioState.status = "stopped";
        broadcastStatus();
      } else if (audioState.currentUrl) {
        forwardToOffscreen({ type: "LOAD_TRACK", url: audioState.currentUrl });
        audioState.status = "playing";
        broadcastStatus();
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
          if (tab?.id) {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: [
                "vendor/Textextractor.js", "vendor/Colorextractor.js", "vendor/Readability.js",
                "vendor/behaviorTracker.js", "vendor/pageData.js", "content.js",
              ],
            }).catch((e) => console.warn("[background] Re-inject failed:", e));
          }
        });
        broadcastStatus();
      }
      break;

    case "POPUP_VOLUME":
      forwardToOffscreen({ type: "SET_VOLUME", value: msg.value });
      recordTelemetry("user_control", { event: "user_volume", meta: { value: msg.value } });
      break;

    case "POPUP_MUTE":
      forwardToOffscreen({ type: "SET_VOLUME", value: msg.muted ? 0 : (msg.previousValue ?? 0.65) });
      recordTelemetry("user_control", { event: "user_mute", meta: { muted: msg.muted } });
      break;

    case "POPUP_MOOD_CORRECTION":
      recordTelemetry("user_control", {
        event: "mood_correction",
        meta: { predicted: msg.predicted, corrected: msg.corrected, urlHashOverride: msg.urlHash },
      });
      break;

    case "POPUP_REGENERATE": {
      // Skip/regenerate: re-POST the current profile with a fresh nonce so
      // D5's cache key misses and a new seed is drawn (X4 plan 6.1) — see
      // models.py's `nonce` field and d5_cache[_local].py's make_cache_key.
      if (!audioState.currentProfile) break;
      recordTelemetry("user_control", { event: "user_regenerate" });
      audioState.status = "loading";
      broadcastStatus();
      requestGeneration({ ...audioState.currentProfile, nonce: crypto.randomUUID() })
        .then((clip) => {
          forwardToOffscreen({ type: "LOAD_TRACK", url: clip.audio_url, loopPointMs: clip.metadata?.loop_point_ms });
          audioState.currentUrl = clip.audio_url;
          audioState.status = "playing";
          broadcastStatus();
        })
        .catch((err) => {
          if (err.name === "AbortError") return;
          console.error("[background] Regenerate failed:", err);
          audioState.status = "error";
          broadcastStatus();
        });
      break;
    }

    case "GET_STATUS":
      sendResponse({ ...audioState });
      return true;

    case "GET_MOODS":
      sendResponse({ moods: Object.values(MOODS) });
      return true;

    case "EXPORT_TELEMETRY":
      exportTelemetry().then(sendResponse);
      return true;

    case "ANALYSER_DATA":
      chrome.runtime.sendMessage({ type: "ANALYSER_DATA", fft: msg.fft }).catch(() => {});
      break;

    case "PLAYER_STATUS":
      if (msg.state === "error") {
        audioState.status = "error";
        broadcastStatus();
      }
      recordTelemetry("playback", { event: "player_status", meta: { state: msg.state } });
      break;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => ensureOffscreen());
chrome.runtime.onStartup.addListener(() => ensureOffscreen());

console.log("[background] Service worker started");
