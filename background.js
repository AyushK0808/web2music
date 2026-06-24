// ─────────────────────────────────────────────────────────────────────────────
// background.js  –  Service Worker
// Coordinates between: content.js → backend API → offscreen.js → popup.js
// ─────────────────────────────────────────────────────────────────────────────

// ── Offscreen Document Management ────────────────────────────────────────────

async function ensureOffscreen() {
  // chrome.offscreen.hasDocument is the correct MV3 check
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
  currentProfile: null,  // music profile JSON from backend
  isDucked: false,
  isEnabled: true,       // master switch — persisted in chrome.storage.local
};

// Load persisted enabled state on service worker startup
(async () => {
  const { masterEnabled } = await chrome.storage.local.get({ masterEnabled: true });
  audioState.isEnabled = masterEnabled;
  console.log("[background] Master switch loaded:", masterEnabled);
})();

// ── Tab Monitoring ────────────────────────────────────────────────────────────
// Detect media-playing tabs (YouTube, Spotify) and duck our audio

const MEDIA_DOMAINS = ["youtube.com", "spotify.com", "netflix.com", "twitch.tv", "soundcloud.com"];

function isMediaTab(url) {
  if (!url) return false;
  return MEDIA_DOMAINS.some((d) => url.includes(d));
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  audioState.currentTabId = tabId;

  if (isMediaTab(tab.url)) {
    if (!audioState.isDucked) {
      audioState.isDucked = true;
      forwardToOffscreen({ type: "DUCK" });
      console.log("[background] Ducking — media tab active:", tab.url);
    }
  } else {
    if (audioState.isDucked) {
      audioState.isDucked = false;
      forwardToOffscreen({ type: "UNDUCK" });
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (tabId !== audioState.currentTabId) return;

  if (isMediaTab(tab.url)) {
    audioState.isDucked = true;
    forwardToOffscreen({ type: "DUCK" });
  } else {
    // New page loaded — eventually content.js will send new DOM data
    // For now just unduck
    audioState.isDucked = false;
    forwardToOffscreen({ type: "UNDUCK" });
  }
});

// ── Idle Detection ────────────────────────────────────────────────────────────

chrome.idle.setDetectionInterval(60); // 60s of inactivity = idle

chrome.idle.onStateChanged.addListener((state) => {
  if (state === "idle" || state === "locked") {
    console.log("[background] User idle/locked — fading out");
    forwardToOffscreen({ type: "FADE_OUT", seconds: 4 });
    audioState.status = "stopped";
  } else if (state === "active") {
    // Don't auto-resume, let user or tab event trigger it
    console.log("[background] User active again");
  }
});

// ── Backend Communication ─────────────────────────────────────────────────────
// Feature C's job: receive page data → ask backend → get audio URL → play it

const BACKEND_URL = "http://localhost:8000"; // local FastAPI during dev

async function fetchMusicProfile(pageData) {
  const res = await fetch(`${BACKEND_URL}/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pageData),
  });
  if (!res.ok) throw new Error(`/profile failed: ${res.status}`);
  return res.json(); // { mood, bpm, energy, pageType, timbre }
}

async function fetchAudioUrl(profile) {
  const res = await fetch(`${BACKEND_URL}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error(`/generate failed: ${res.status}`);
  const data = await res.json();
  return data.audioUrl; // e.g. "http://localhost:8000/audio/abc123.mp3"
}

// ── Message Router ────────────────────────────────────────────────────────────

// Forward a message to the offscreen document
async function forwardToOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(msg);
}

// Broadcast status to any open popups
function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "STATUS_UPDATE",
    ...audioState,
  }).catch(() => {}); // no popup open = fine
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[background] message:", msg.type, "from:", sender.tab?.url ?? "extension");

  switch (msg.type) {

    // ── From content.js: new page data ─────────────────────────────────────
    case "PAGE_DATA": {
      // Master switch is off — ignore incoming page data entirely
      if (!audioState.isEnabled) {
        console.log("[background] PAGE_DATA ignored — master switch is off");
        break;
      }

      audioState.status = "loading";
      broadcastStatus();

      (async () => {
        try {
          await ensureOffscreen();

          // ── TEST MODE: hardcoded audio URL, no backend needed ──────────────
          // Replace this URL with your own .mp3 once the backend is ready
          const TEST_AUDIO_URL = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";

          // Fake profile so the popup chips show something during testing
          audioState.currentProfile = { mood: "calm", bpm: 70, energy: "low" };
          audioState.currentUrl = TEST_AUDIO_URL;

          await forwardToOffscreen({ type: "PLAY", url: TEST_AUDIO_URL });
          audioState.status = "playing";
          broadcastStatus();
          // ── END TEST MODE ──────────────────────────────────────────────────

          // TODO: uncomment below and remove TEST MODE block when backend is ready
          // const profile = await fetchMusicProfile(msg.data);
          // audioState.currentProfile = profile;
          // const audioUrl = await fetchAudioUrl(profile);
          // audioState.currentUrl = audioUrl;
          // await forwardToOffscreen({ type: "PLAY", url: audioUrl });
          // audioState.status = "playing";
          // broadcastStatus();

        } catch (err) {
          console.error("[background] Pipeline error:", err);
          audioState.status = "error";
          broadcastStatus();
        }
      })();

      break;
    }

    // ── From popup: user controls ──────────────────────────────────────────
    case "POPUP_PLAY":
      if (audioState.currentUrl) {
        // If stopped (player disposed), restart from scratch with the saved URL
        forwardToOffscreen({ type: "PLAY", url: audioState.currentUrl });
      } else {
        forwardToOffscreen({ type: "RESUME" });
      }
      audioState.status = "playing";
      broadcastStatus();
      break;

    case "POPUP_PAUSE":
      forwardToOffscreen({ type: "PAUSE" });
      audioState.status = "paused";
      broadcastStatus();
      break;

    case "POPUP_STOP":
      forwardToOffscreen({ type: "STOP" });
      audioState.status = "stopped";
      broadcastStatus();
      break;

    // ── From popup: master toggle ──────────────────────────────────────────
    case "POPUP_SET_ENABLED": {
      audioState.isEnabled = msg.enabled;
      // Persist so it survives service worker restarts and new tabs
      chrome.storage.local.set({ masterEnabled: msg.enabled });

      if (!msg.enabled) {
        // Kill audio immediately
        forwardToOffscreen({ type: "STOP" });
        audioState.status = "stopped";
      }
      // Broadcast so any open popup reflects the change
      broadcastStatus();
      break;
    }

    case "POPUP_VOLUME":
      forwardToOffscreen({ type: "SET_VOLUME", value: msg.value });
      break;

    case "GET_STATUS":
      sendResponse({ ...audioState });
      return true;

    // ── From offscreen: analyser data passthrough to popup ─────────────────
    case "ANALYSER_DATA":
      // Just rebroadcast — popup will receive it if open
      chrome.runtime.sendMessage({
        type: "ANALYSER_DATA",
        fft: msg.fft,
      }).catch(() => {});
      break;

    case "PLAYER_STATUS":
      audioState.status = msg.state;
      broadcastStatus();
      break;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[background] Extension installed/updated");
  await ensureOffscreen();
});

// Re-create offscreen on SW wake (service workers can sleep and restart)
chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen();
});

console.log("[background] Service worker started");