// ui/src/background.entry.js — MV3 service worker: Feature A relay, Feature
// B wiring (with the same-context onHandoff2 fix), Feature D client, tab
// ducking/idle, telemetry, and the popup message surface.

import { configureFeatureB, registerFeatureBHeartbeat, onHandoff2, runFeatureB, MOODS } from "../../mood-classification/feature_b/index.js";
import { requestTrack, requestGeneration } from "./featureDClient.js";
import { createAudioTabWatcher, ATTENUATION } from "./audioTabs.js";
import { recordTelemetry, urlHash, exportTelemetry } from "./telemetry.js";
import { OFFSCREEN_EXTRACT_TYPES } from "./offscreenTypes.js";
import { createLogger } from "./log.js";

const log = createLogger("background");

// ── Offscreen document lifecycle ─────────────────────────────────────────────
// Both AUDIO_PLAYBACK (Feature C) and WORKERS (the embed worker spawned for
// Feature A, so ONNX inference can't block the audio thread) — only one
// offscreen document is allowed per extension, so it hosts both.
async function ensureOffscreen() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (!hasDoc) {
    // Worth an info line, not a debug one: the offscreen document is torn down
    // with the worker, so a re-create here marks the boundary where all
    // playback state (decks, gain stages) was just reset to defaults.
    log.info("Creating offscreen document (none existed)");
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK", "WORKERS"],
      justification: "Play generated ambient music and run local embedding inference for the current webpage",
    });
    log.info("Offscreen document created");
  }
}

// Callers are fire-and-forget, so swallow-and-log rather than returning a
// promise nobody awaits — an unhandled rejection here surfaces as a bare
// "Uncaught (in promise)" at background.js:1 with no clue which command
// failed, which is exactly how the target/type routing bug stayed invisible.
async function forwardToOffscreen(msg) {
  await ensureOffscreen();
  log.debug(`-> offscreen ${msg.type}`, msg);
  try {
    return await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
  } catch (err) {
    log.warn(`offscreen '${msg.type}' failed:`, err.message);
  }
}

// ── Content-script injection ──────────────────────────────────────────────
// Chrome injects content_scripts at navigation time only: an install, update
// or "Reload" in chrome://extensions leaves every already-open tab without
// one until it is manually refreshed. Nothing downstream can tell that apart
// from a crash — A_PAGE_DATA simply never arrives, so B never transitions,
// currentProfile/currentUrl stay null, and POPUP_PLAY/POPUP_REGENERATE can
// only report that they have nothing to act on. Injecting on startup is what
// makes a reload behave the way the extensions page implies it does.
//
// Read from the manifest rather than repeating the file list: the order here
// is load-bearing (content.js destructures window.Web2MusicPageData, which
// vendor/pageData.js attaches), and a hand-maintained second copy is exactly
// the kind of thing that drifts and fails with a null-destructure.
const CONTENT_SCRIPT_FILES = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
if (!CONTENT_SCRIPT_FILES.length) {
  log.error("manifest has no content_scripts[0].js — Feature A cannot be injected into any tab");
}

async function injectContentScript(tabId, url) {
  // chrome://, chrome-extension://, and the Web Store reject scripting even
  // under <all_urls>; skipping them keeps one warning per restricted tab out
  // of the log on every reload.
  if (!/^https?:/.test(url ?? "")) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
    return true;
  } catch (err) {
    log.warn(`inject into tab ${tabId} (${url}) failed:`, err.message);
    return false;
  }
}

// Safe to run against a tab that already has the script: content.entry.js
// guards on window.__w2mContentLastRan and no-ops if it ran under 2s ago.
async function injectIntoAllTabs(reason) {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const results = await Promise.all(tabs.map((t) => injectContentScript(t.id, t.url)));
  log.info(`${reason}: injected content scripts into ${results.filter(Boolean).length}/${tabs.length} open tab(s)`);
}

// ── Audio / UI state ──────────────────────────────────────────────────────
const audioState = {
  status: "stopped",
  currentUrl: null,
  currentTabId: null,
  currentProfile: null,
  isDucked: false,
  attenuation: "clear",        // "clear" | "duck" | "mute" — see audioTabs.js
  attenuationReason: null,
  isEnabled: true,
  isPaused: false,
  classifyProxyReachable: null, // null = not yet checked
};

chrome.storage.local.get({ masterEnabled: true }, ({ masterEnabled }) => {
  audioState.isEnabled = masterEnabled;
  log.info("Restored masterEnabled =", masterEnabled);
});

// Log only when `status` actually changes, not on every broadcast — the popup
// re-broadcasts on volume drags and analyser ticks, and logging all of those
// buries the transitions that matter (loading -> playing -> error).
let lastLoggedStatus = null;
function broadcastStatus() {
  if (audioState.status !== lastLoggedStatus) {
    log.info(`status: ${lastLoggedStatus ?? "(init)"} -> ${audioState.status}`,
      { url: audioState.currentUrl, tabId: audioState.currentTabId, attenuation: audioState.attenuation, paused: audioState.isPaused });
    lastLoggedStatus = audioState.status;
  }
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", ...audioState }).catch(() => {});
}

// ── Feature B wiring ──────────────────────────────────────────────────────

/**
 * Tier-1.5 local backend: run the zero-shot classifier in the offscreen
 * document's worker. B1.5 calls this with { text, labels, hypothesisTemplate,
 * model } and expects HuggingFace's { labels, scores } back — see
 * feature_b/b1_zeroShotCategory.js.
 */
async function classifyZeroShotViaOffscreen(request) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "B_ZEROSHOT", ...request });
  if (!res?.ok) throw new Error(res?.error || "offscreen zero-shot failed");
  return res;
}

chrome.storage.sync.get(
  ["llmApiKey", "llmBackend", "llmServiceUrl", "targetModel", "zeroShotEnabled", "zeroShotBackend", "zeroShotModel"],
  (settings) => {
    const usingProxy = settings.llmBackend === "proxy" || !settings.llmApiKey;
    const classifyBase = (settings.llmServiceUrl || "http://localhost:8078/v1/chat/completions").replace(/\/v1\/.*/, "");
    // "proxy" runs the full facebook/bart-large-mnli server-side (the
    // classify container holds the HF token); "local" runs a distilled MNLI
    // checkpoint in the offscreen worker and sends nothing off the machine.
    // Off unless explicitly enabled — the local model is a first-use
    // download and the proxy needs a token that may not be set.
    const zeroShotBackend = settings.zeroShotBackend === "local" ? "local" : "proxy";
    const zeroShot = {
      enabled: settings.zeroShotEnabled === true,
      backend: zeroShotBackend,
      serviceUrl: `${classifyBase}/v1/zero-shot`,
      classify: zeroShotBackend === "local" ? classifyZeroShotViaOffscreen : null,
      ...(settings.zeroShotModel ? { model: settings.zeroShotModel } : {}),
    };

    configureFeatureB({
      apiKey: usingProxy
        ? { backend: "proxy", serviceUrl: settings.llmServiceUrl || "http://localhost:8078/v1/chat/completions" }
        : settings.llmApiKey,
      targetModel: settings.targetModel ?? "musicgen",
      zeroShot,
    });
    // Never log the key itself — only which path was taken.
    log.info("Feature B configured:", {
      backend: usingProxy ? "proxy" : "direct-key",
      serviceUrl: usingProxy ? (settings.llmServiceUrl || "http://localhost:8078/v1/chat/completions") : undefined,
      targetModel: settings.targetModel ?? "musicgen",
      zeroShot: zeroShot.enabled ? { backend: zeroShot.backend, model: zeroShot.model ?? "(default)" } : "disabled",
    });
  }
);

registerFeatureBHeartbeat();

async function checkClassifyProxy() {
  const { llmServiceUrl } = await chrome.storage.sync.get(["llmServiceUrl"]);
  const base = (llmServiceUrl || "http://localhost:8078/v1/chat/completions").replace(/\/v1\/.*/, "");
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    audioState.classifyProxyReachable = res.ok;
    log.info(`classify proxy ${base}/health -> ${res.status} (reachable=${res.ok})`);
  } catch (err) {
    audioState.classifyProxyReachable = false;
    log.warn(`classify proxy ${base}/health unreachable (${err.name}: ${err.message}) — `
      + "Feature B will fall back to its local classifier. Is web2music-classify-service up?");
  }
  broadcastStatus();
}
checkClassifyProxy();

// Handoff-2 routing (X4 plan 3.3) — replaces background_integration.js,
// which is kept only as documentation now that onHandoff2 delivers in the
// same context instead of round-tripping through chrome.runtime.sendMessage.
async function handleHandoff2(handoff2, tabId) {
  // `ms` (total) + `meta.timings` (per-stage breakdown) mirrors D_generate's
  // shape below exactly, so both sides of the latency budget line up in the
  // same telemetry export instead of needing separate parsing per stage.
  const bTimings = handoff2.timings || null;
  const bMs = bTimings ? Object.values(bTimings).reduce((sum, ms) => sum + ms, 0) : undefined;
  recordTelemetry("B_decision", {
    tabId,
    event: "handoff2",
    ms: bMs,
    meta: { isSilent: !!handoff2.isSilent, isFadeUpdate: !!handoff2.isFadeUpdate, timings: bTimings },
  });

  log.info("handoff2 received", {
    tabId,
    kind: handoff2.isSilent ? "silence" : handoff2.isFadeUpdate ? "fade-update" : "transition",
    mood: handoff2.profile?.mood,
    volume: handoff2.volume,
  });

  if (handoff2.isSilent) {
    log.info("B signalled sensitive-content silence — fading out, skipping /generate entirely");
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

  // B stamps every real transition with the volume it wants — 1, unless it is
  // fading — and only isFadeUpdate handoffs used to reach SET_MOOD_VOLUME, so
  // that 1 was dropped on the floor. moodFadeGain then stayed wherever the last
  // fade left it: after a sensitive page's FADE_TO_SILENCE (or the idle
  // FADE_OUT below), every later track decoded, started and reported "playing"
  // into a stage still pinned at zero, and the session was silent from then on.
  // Restoring it here is what makes the silence apply to that page rather than
  // to the rest of the browsing session.
  forwardToOffscreen({ type: "SET_MOOD_VOLUME", value: handoff2.volume ?? 1 });

  const t0 = performance.now();
  const doneD = log.time(`D request (${handoff2.profile?.mood})`);
  try {
    await requestTrack(handoff2.profile, {
      onFallback: (clip) => {
        log.info("instant fallback playing while /generate runs:", clip.audio_url);
        forwardToOffscreen({ type: "LOAD_TRACK", url: clip.audio_url, loopPointMs: clip.metadata?.loop_point_ms });
      },
      onGenerated: (clip) => {
        // cache/is_fallback is the single most useful line in this file: a
        // steady stream of cache=miss + isFallback=true means D is generating
        // real audio and then failing to persist it, so nothing ever warms and
        // every page gets a canned clip. That is exactly what a broken
        // save_to_cache looks like from up here.
        doneD(`cache=${clip.cache} isFallback=${!!clip.metadata?.is_fallback}`);
        log.info("generated clip:", {
          url: clip.audio_url,
          cache: clip.cache,
          isFallback: !!clip.metadata?.is_fallback,
          mood: clip.metadata?.mood,
          loopPointMs: clip.metadata?.loop_point_ms,
          timings: clip.timings,
        });
        if (clip.cache === "miss" && clip.metadata?.is_fallback) {
          log.warn("D returned a FALLBACK clip, not generated audio — check the Feature D "
            + "container logs for '[MAIN] save_to_cache failed' or '[MAIN] Generation failed'.");
        }
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
    if (err.name === "AbortError") {
      log.debug("D request aborted — superseded by a newer mood, not an error");
      return;
    }
    log.error("Feature D request failed:", err);
    audioState.status = "error";
    broadcastStatus();
  }
}
onHandoff2(handleHandoff2);

// ── Tab monitoring: auto-mute on pages that are playing their own audio ────
// The decision lives in audioTabs.js (pure policy + a Chrome-event watcher);
// this is only the wiring that turns a decision into a gain command and
// records it. Ducking used to be a hardcoded domain list checked on two
// events, which both over- and under-fired — see that file's header.
const audioTabs = createAudioTabWatcher(chrome, {
  log,
  onChange: ({ level, gain, reason }) => {
    audioState.attenuation = level;
    audioState.attenuationReason = reason;
    // isDucked is kept for the popup and GET_STATUS consumers that predate
    // the three-level model: anything short of full volume reads as ducked.
    audioState.isDucked = level !== ATTENUATION.CLEAR;
    forwardToOffscreen({ type: "SET_ATTENUATION", gain, reason });
    recordTelemetry("playback", { event: "attenuation", meta: { level, gain, reason } });
    broadcastStatus();
  },
});
audioTabs.start();

// The watcher owns attenuation; currentTabId is still tracked here because
// A_PAGE_DATA's active-tab guard and the popup both read it.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  audioState.currentTabId = tabId;
});

// ── Idle detection ────────────────────────────────────────────────────────
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  log.info("idle state ->", state);
  if (state === "idle" || state === "locked") {
    log.info("fading out for idle (4s), then stopping");
    forwardToOffscreen({ type: "FADE_OUT", seconds: 4 });
    audioState.status = "stopped";
    audioState.isPaused = false;
    // NOTE: no broadcastStatus() here, unlike every other status write in this
    // file — the popup keeps showing "playing" until something else broadcasts.
    // Left as-is deliberately (this pass is logging only); debug-logged so the
    // divergence is at least visible rather than inferred.
    log.debug("status set to 'stopped' for idle without broadcasting — popup may show stale state");
  }
});

// ── Message router ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages the worker sends to ITSELF (STATUS_UPDATE/ANALYSER_DATA
  // broadcasts) also arrive here. Skipping them keeps the log a record of
  // inbound traffic rather than an echo of our own chatter — ANALYSER_DATA
  // alone fires 10x/sec.
  if (msg.type !== "ANALYSER_DATA" && msg.type !== "STATUS_UPDATE") {
    log.debug(`<- ${msg.type}`, { fromTab: sender.tab?.id, fromUrl: sender.tab?.url ?? "(extension page)" });
  }

  // Relay for Feature A's offscreen RPCs (embed / vector store) — see the
  // comment in remoteDeps.js on why `target` is added here, not by the
  // content script itself.
  if (OFFSCREEN_EXTRACT_TYPES.has(msg.type)) {
    (async () => {
      await ensureOffscreen();
      chrome.runtime.sendMessage({ target: "offscreen", ...msg }, (response) => {
        if (chrome.runtime.lastError) {
          // Without this the relay fails completely silently: sendResponse
          // still fires (with undefined), the content script sees a
          // null embedding, and Feature A looks like it returned no result.
          log.warn(`offscreen relay '${msg.type}' errored:`, chrome.runtime.lastError.message);
        }
        sendResponse(response);
      });
    })();
    return true;
  }

  switch (msg.type) {
    case "A_PAGE_DATA": {
      (async () => {
        const { masterEnabled } = await chrome.storage.local.get({ masterEnabled: true });
        audioState.isEnabled = masterEnabled;
        if (!audioState.isEnabled) {
          log.debug("A_PAGE_DATA dropped — extension disabled (masterEnabled=false)");
          return;
        }

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || activeTab.id !== sender.tab?.id) {
          // Background tabs extract too; only the focused one drives audio.
          log.debug(`A_PAGE_DATA dropped — tab ${sender.tab?.id} is not the active tab (${activeTab?.id})`);
          return;
        }

        audioState.currentTabId = sender.tab.id;
        const hash = await urlHash(msg.pageData?.url);
        recordTelemetry("A_extract", { tabId: sender.tab.id, event: "extract", urlHash: hash, meta: msg.telemetry });

        log.info("A→B handoff received", {
          tabId: sender.tab.id,
          url: msg.pageData?.url,
          textChars: msg.pageData?.text?.length ?? msg.pageData?.content?.length,
          hasColors: !!msg.pageData?.colors,
        });

        const t0 = performance.now();
        const doneB = log.time("runFeatureB");
        // Which of B1's tiers actually decided is only observable from inside
        // the pipeline: it fires on every page, but a handoff 2 only exists on
        // a transition, so reading the tier off `handoff2` would silently
        // measure the transition subset alone. Captured here per page instead.
        let tiers = null;
        const handoff2 = await runFeatureB(msg.pageData, sender.tab.id, {
          onDiagnostics: (d) => { tiers = d; },
        });
        doneB(handoff2 ? `-> ${handoff2.profile?.mood ?? "silence/fade"}` : "-> no transition");
        recordTelemetry("B_decision", {
          tabId: sender.tab.id,
          event: "runFeatureB",
          ms: performance.now() - t0,
          meta: {
            transitioned:   !!handoff2,
            categorySource: tiers?.categorySource ?? null,
            moodTier:       tiers?.moodTier ?? null,
          },
        });

        // B returns null until a mood has held steady for confidenceWindowMs
        // (5s), so the *first* extraction on any tab never reaches D. Say so
        // out loud — silence here is indistinguishable from a crash, which is
        // what made "D never runs" look like a bug rather than the gate
        // working as designed. See decideTransition in feature_b/index.js.
        if (!handoff2) {
          log.info("B: no transition yet (confidence window not met) — D not called");
          return;
        }
        log.info("B→D handoff:", handoff2.profile?.mood ?? "(silence/fade)", handoff2.profile);
        handleHandoff2(handoff2, sender.tab.id);
      })();
      break;
    }

    case "POPUP_PLAY":
      if (audioState.isPaused) {
        log.info("POPUP_PLAY -> resuming paused track");
        forwardToOffscreen({ type: "RESUME" });
        audioState.isPaused = false;
        audioState.status = "playing";
      } else if (audioState.currentUrl) {
        log.info("POPUP_PLAY -> reloading", audioState.currentUrl);
        forwardToOffscreen({ type: "LOAD_TRACK", url: audioState.currentUrl });
        audioState.status = "playing";
      } else {
        log.warn("POPUP_PLAY ignored — nothing paused and no currentUrl yet "
          + "(no mood transition has completed since the worker last started)");
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
      log.info("POPUP_SET_ENABLED ->", msg.enabled);
      // The closest thing to a "voluntary disable" signal this build can
      // honestly produce. A true uninstall rate is not measurable locally:
      // Chrome deletes chrome.storage.local (the ring buffer with it) when the
      // extension is removed, and the only surviving hook, setUninstallURL,
      // fires a network request — which this build's local-only guarantee
      // forbids. S5 therefore reports toggle-off rate, not uninstall rate.
      recordTelemetry("user_control", { event: "user_enabled_toggle", meta: { enabled: !!msg.enabled } });
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
            log.info("re-injecting content scripts into tab", tab.id, tab.url);
            injectContentScript(tab.id, tab.url)
              .then((ok) => log.debug(`re-inject ${ok ? "complete" : "skipped (not an http(s) tab)"} for tab`, tab.id));
          } else {
            log.warn("re-inject skipped — no active tab");
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
      if (!audioState.currentProfile) {
        log.warn("POPUP_REGENERATE ignored — no currentProfile (nothing has played yet this worker lifetime)");
        break;
      }
      recordTelemetry("user_control", { event: "user_regenerate" });
      audioState.status = "loading";
      broadcastStatus();
      const nonce = crypto.randomUUID();
      log.info("POPUP_REGENERATE for mood", audioState.currentProfile.mood, "nonce", nonce);
      const doneRegen = log.time("regenerate");
      requestGeneration({ ...audioState.currentProfile, nonce })
        .then((clip) => {
          doneRegen(`cache=${clip.cache} isFallback=${!!clip.metadata?.is_fallback} url=${clip.audio_url}`);
          forwardToOffscreen({ type: "LOAD_TRACK", url: clip.audio_url, loopPointMs: clip.metadata?.loop_point_ms });
          audioState.currentUrl = clip.audio_url;
          audioState.status = "playing";
          broadcastStatus();
        })
        .catch((err) => {
          if (err.name === "AbortError") {
            log.debug("regenerate aborted — superseded by a newer request");
            return;
          }
          log.error("Regenerate failed:", err);
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
        log.error("offscreen reported a playback error for", msg.url);
        audioState.status = "error";
        broadcastStatus();
      } else {
        log.debug("offscreen player status:", msg.state, msg.url ?? "");
      }
      recordTelemetry("playback", { event: "player_status", meta: { state: msg.state } });
      break;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  log.info("onInstalled:", details.reason, details.previousVersion ?? "");
  ensureOffscreen();
  injectIntoAllTabs("onInstalled");
});
chrome.runtime.onStartup.addListener(() => {
  log.info("onStartup: browser launched");
  ensureOffscreen();
  injectIntoAllTabs("onStartup");
});

// Uncaught failures inside the worker otherwise land as a bare
// "Uncaught (in promise)" at background.js:1 with the bundled line number,
// which points at nothing useful.
self.addEventListener("unhandledrejection", (e) => log.error("unhandled promise rejection:", e.reason));
self.addEventListener("error", (e) => log.error("uncaught error:", e.message, e.filename, e.lineno));

// A service worker restart resets every module-level variable in this file
// (audioState included). Printing the backend URL here means the first line
// after a restart already answers "which Feature D is it talking to?".
chrome.storage.local.get({ backendUrl: "http://localhost:8000" }, ({ backendUrl }) => {
  log.info("Service worker started — Feature D backend:", backendUrl);
});
