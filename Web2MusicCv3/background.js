// ─────────────────────────────────────────────────────────────────────────────
// background.js  –  Service Worker
// ─────────────────────────────────────────────────────────────────────────────

// ── Offscreen Document Management ────────────────────────────────────────────

async function ensureOffscreen() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (!hasDoc) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play generated ambient music for current webpage",
    });
    console.log("[background] Offscreen document created");
  }
}

// ── Audio State ───────────────────────────────────────────────────────────────

const audioState = {
  status: "stopped",     // stopped | loading | playing | paused | error
  currentUrl: null,
  currentTabId: null,
  currentProfile: null,
  isDucked: false,
  isEnabled: true,       // optimistic default; overwritten immediately from storage
  isPaused: false,       // dedicated pause flag — does NOT get confused with "stopped"
};

// Load persisted enabled state — runs immediately on SW startup
chrome.storage.local.get({ masterEnabled: true }, ({ masterEnabled }) => {
  audioState.isEnabled = masterEnabled;
  console.log("[background] Master switch loaded:", masterEnabled);
});

// ── Tab Monitoring ────────────────────────────────────────────────────────────

const MEDIA_DOMAINS = ["youtube.com", "spotify.com", "netflix.com", "twitch.tv", "soundcloud.com"];

function isMediaTab(url) {
  if (!url) return false;
  return MEDIA_DOMAINS.some((d) => url.includes(d));
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  audioState.currentTabId = tabId;
  if (isMediaTab(tab.url)) {
    if (!audioState.isDucked) { audioState.isDucked = true; forwardToOffscreen({ type: "DUCK" }); }
  } else {
    if (audioState.isDucked) { audioState.isDucked = false; forwardToOffscreen({ type: "UNDUCK" }); }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (tabId !== audioState.currentTabId) return;
  if (isMediaTab(tab.url)) {
    audioState.isDucked = true; forwardToOffscreen({ type: "DUCK" });
  } else {
    audioState.isDucked = false; forwardToOffscreen({ type: "UNDUCK" });
  }
});

// ── Idle Detection ────────────────────────────────────────────────────────────

chrome.idle.setDetectionInterval(60);

chrome.idle.onStateChanged.addListener((state) => {
  if (state === "idle" || state === "locked") {
    forwardToOffscreen({ type: "FADE_OUT", seconds: 4 });
    audioState.status = "stopped";
    audioState.isPaused = false;
  }
});

// ── Backend Communication ─────────────────────────────────────────────────────

const BACKEND_URL = "http://localhost:8000";

async function fetchMusicProfile(pageData) {
  const res = await fetch(`${BACKEND_URL}/profile`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pageData),
  });
  if (!res.ok) throw new Error(`/profile failed: ${res.status}`);
  return res.json();
}

async function fetchAudioUrl(profile) {
  const res = await fetch(`${BACKEND_URL}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error(`/generate failed: ${res.status}`);
  return (await res.json()).audioUrl;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function forwardToOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(msg);
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", ...audioState }).catch(() => {});
}

async function startPlayback(url) {
  await ensureOffscreen();
  await forwardToOffscreen({ type: "PLAY", url });
  audioState.currentUrl = url;
  audioState.status = "playing";
  audioState.isPaused = false;
  broadcastStatus();
}

// ── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[background] message:", msg.type);

  switch (msg.type) {

    // ── From content.js ───────────────────────────────────────────────────────
    case "PAGE_DATA": {
      (async () => {
        // Always re-read storage — SW can restart and lose in-memory state
        const { masterEnabled } = await chrome.storage.local.get({ masterEnabled: true });
        audioState.isEnabled = masterEnabled;

        if (!audioState.isEnabled) {
          console.log("[background] PAGE_DATA ignored — master switch is off");
          return;
        }

        // Only the active tab triggers playback
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || activeTab.id !== sender.tab?.id) {
          console.log("[background] PAGE_DATA ignored — not active tab");
          return;
        }

        audioState.currentTabId = sender.tab.id;
        audioState.isPaused = false;
        audioState.status = "loading";
        broadcastStatus();

        try {
          const TEST_AUDIO_URL = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";
          audioState.currentProfile = { mood: "calm", bpm: 70, energy: "low" };
          await startPlayback(TEST_AUDIO_URL);

          // TODO: swap in real backend when ready:
          // const profile = await fetchMusicProfile(msg.data);
          // audioState.currentProfile = profile;
          // const audioUrl = await fetchAudioUrl(profile);
          // await startPlayback(audioUrl);

        } catch (err) {
          console.error("[background] Pipeline error:", err);
          audioState.status = "error";
          broadcastStatus();
        }
      })();
      break;
    }

    // ── From popup: play button ───────────────────────────────────────────────
    case "POPUP_PLAY": {
      if (audioState.isPaused) {
        // ▶ after ⏸ — gain-restore resume, player never stopped
        forwardToOffscreen({ type: "RESUME" });
        audioState.isPaused = false;
        audioState.status = "playing";
      } else if (audioState.currentUrl) {
        // ▶ after stop/toggle-off — restart from beginning
        forwardToOffscreen({ type: "PLAY", url: audioState.currentUrl });
        audioState.status = "playing";
      }
      broadcastStatus();
      break;
    }

    // ── From popup: pause button ──────────────────────────────────────────────
    case "POPUP_PAUSE": {
      forwardToOffscreen({ type: "PAUSE" });
      audioState.isPaused = true;
      audioState.status = "paused";
      broadcastStatus();
      break;
    }

    case "POPUP_STOP": {
      forwardToOffscreen({ type: "STOP" });
      audioState.isPaused = false;
      audioState.status = "stopped";
      broadcastStatus();
      break;
    }

    // ── From popup: master toggle ─────────────────────────────────────────────
    case "POPUP_SET_ENABLED": {
      audioState.isEnabled = msg.enabled;
      chrome.storage.local.set({ masterEnabled: msg.enabled });

      if (!msg.enabled) {
        // Toggle OFF — fully stop, clear pause flag
        forwardToOffscreen({ type: "STOP" });
        audioState.isPaused = false;
        audioState.status = "stopped";
        broadcastStatus();
      } else {
        // Toggle ON — restart if we know the URL for this page
        if (audioState.currentUrl) {
          startPlayback(audioState.currentUrl); // startPlayback broadcasts internally
        } else {
          // No URL yet (e.g. toggled off on a new page before content.js fired).
          // Inject content.js into the active tab to re-trigger PAGE_DATA.
          chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (tab?.id) {
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["content.js"],
              }).catch((e) => console.warn("[background] Re-inject failed:", e));
            }
          });
          broadcastStatus();
        }
      }
      break;
    }

    case "POPUP_VOLUME":
      forwardToOffscreen({ type: "SET_VOLUME", value: msg.value });
      break;

    case "GET_STATUS":
      sendResponse({ ...audioState });
      return true;

    case "ANALYSER_DATA":
      chrome.runtime.sendMessage({ type: "ANALYSER_DATA", fft: msg.fft }).catch(() => {});
      break;

    case "PLAYER_STATUS":
      // Only trust "error" from offscreen — background owns all other state transitions
      if (msg.state === "error") {
        audioState.status = "error";
        broadcastStatus();
      }
      break;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[background] Extension installed/updated");
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen();
});

console.log("[background] Service worker started");