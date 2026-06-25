// ─────────────────────────────────────────────────────────────────────────────
// offscreen.js  –  Feature C: Audio Playback Engine
// Runs in the offscreen document (has a real AudioContext, unlike SW)
// ─────────────────────────────────────────────────────────────────────────────

let player = null;
let analyser = null;
let gainNode = null;
let reverbNode = null;
let isSetup = false;
let currentUrl = null;
let isPaused = false;
let pausedVolume = -6; // remember volume before pause so resume restores it

// ── Engine Setup ─────────────────────────────────────────────────────────────
// Called once, lazily, on first PLAY message.
// AudioContext can only be created after a user gesture or inside an offscreen doc.

async function setupEngine() {
  if (isSetup) return;

  await Tone.start();

  // ── Effects chain: Player → Gain → EQ → Reverb → Analyser → Destination
  gainNode = new Tone.Volume(-6); // master volume, -6dB default

  const eq = new Tone.EQ3({
    low: 0,
    mid: 0,
    high: -3, // slight high cut to feel more ambient
  });

  reverbNode = new Tone.Reverb({
    decay: 2.5,
    wet: 0.3,
  });
  await reverbNode.generate(); // reverb IR needs async generation

  analyser = new Tone.Analyser("fft", 256);

  // Wire up the chain (connect doesn't return the node in Tone, so chain manually)
  gainNode.connect(eq);
  eq.connect(reverbNode);
  reverbNode.connect(analyser);
  analyser.toDestination();

  isSetup = true;
  console.log("[offscreen] Audio engine ready");
}

// ── Player Management ─────────────────────────────────────────────────────────

async function playUrl(url) {
  await setupEngine();

  // Stop and dispose existing player cleanly
  if (player) {
    player.stop();
    player.disconnect();
    player.dispose();
    player = null;
  }

  // Reset pause state and restore volume for the new track
  isPaused = false;
  pausedVolume = -6;
  if (gainNode) gainNode.volume.value = -6;

  currentUrl = url;

  // Track whether onload fired synchronously (cached buffer) before constructor returns
  let loadedSync = false;

  const p = new Tone.Player({
    url: url,
    loop: true,
    autostart: false,
    onload: () => {
      if (player) {
        // Normal case: constructor already returned, player is assigned
        player.connect(gainNode);
        player.start();
        console.log("[offscreen] Playing (async load):", url);
        sendStatus("playing");
      } else {
        // Cached case: onload fired before constructor returned, player not assigned yet
        // Set the flag; the code below the constructor will handle connect+start
        loadedSync = true;
      }
    },
    onerror: (err) => {
      console.error("[offscreen] Player error:", err);
      sendStatus("error");
    },
  });

  player = p;

  // If onload already fired synchronously (cached URL), connect and start now
  if (loadedSync) {
    player.connect(gainNode);
    player.start();
    console.log("[offscreen] Playing (sync/cached load):", url);
    sendStatus("playing");
  }
}

function pause() {
  if (!player) return;
  if (gainNode) {
    pausedVolume = gainNode.volume.value;
    gainNode.volume.rampTo(-60, 0.15); // -60dB is effectively silent; -Infinity is invalid in Tone.js
  }
  isPaused = true;
  sendStatus("paused");
}

function resume() {
  if (!player) return;
  // Restore volume — audio never actually stopped so it continues from the same position
  if (gainNode) {
    gainNode.volume.rampTo(pausedVolume, 0.15);
  }
  isPaused = false;
  sendStatus("playing");
}

function stop() {
  if (player) {
    player.stop();
    player.disconnect();
    player.dispose();
    player = null;
  }
  isPaused = false;
  if (gainNode) gainNode.volume.value = -6; // restore default so next play isn't silent
  sendStatus("stopped");
}

// ── Tab Ducking ───────────────────────────────────────────────────────────────
// When user switches to YouTube/Spotify tab, duck our audio to ~10%

function duck() {
  if (gainNode) {
    gainNode.volume.rampTo(-20, 0.5); // fade to -20dB over 0.5s
    console.log("[offscreen] Ducking audio");
  }
}

function unduck() {
  if (gainNode && !isPaused) {
    gainNode.volume.rampTo(-6, 0.5); // restore to -6dB only if not paused
    console.log("[offscreen] Unducking audio");
  }
}

function setVolume(dbOrFraction) {
  if (!gainNode) return;
  const db = dbOrFraction <= 1 && dbOrFraction >= 0
    ? Tone.gainToDb(dbOrFraction)
    : dbOrFraction;
  // Always track the target volume for when we resume
  pausedVolume = db;
  // Only apply immediately if not paused — otherwise resume will pick it up
  if (!isPaused) {
    gainNode.volume.rampTo(db, 0.3);
  }
}

// ── Idle Fade ─────────────────────────────────────────────────────────────────

function fadeOut(seconds = 3) {
  if (gainNode) {
    gainNode.volume.rampTo(-60, seconds);
    setTimeout(stop, seconds * 1000 + 100);
  }
}

function fadeIn(seconds = 1.5) {
  if (gainNode) {
    gainNode.volume.rampTo(-6, seconds);
  }
}

// ── Analyser Data ─────────────────────────────────────────────────────────────
// Periodically sends FFT data to background.js → popup for visualizer

let analyserInterval = null;

function startAnalyserBroadcast() {
  if (analyserInterval) return;
  analyserInterval = setInterval(() => {
    if (!analyser || !player) return;
    const values = Array.from(analyser.getValue()); // Float32Array → plain array
    chrome.runtime.sendMessage({
      type: "ANALYSER_DATA",
      fft: values,
    }).catch(() => {}); // popup might be closed, ignore
  }, 100); // 10fps is plenty for visuals
}

function stopAnalyserBroadcast() {
  if (analyserInterval) {
    clearInterval(analyserInterval);
    analyserInterval = null;
  }
}

// ── Status Helper ─────────────────────────────────────────────────────────────

function sendStatus(state) {
  chrome.runtime.sendMessage({
    type: "PLAYER_STATUS",
    state,
    url: currentUrl,
  }).catch(() => {});
}

// ── Message Listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log("[offscreen] received:", msg.type);

  switch (msg.type) {
    case "PLAY":
      playUrl(msg.url);
      startAnalyserBroadcast();
      break;

    case "PAUSE":
      pause();
      break;

    case "RESUME":
      resume();
      break;

    case "STOP":
      stop();
      stopAnalyserBroadcast();
      break;

    case "DUCK":
      duck();
      break;

    case "UNDUCK":
      unduck();
      break;

    case "SET_VOLUME":
      setVolume(msg.value); // 0.0–1.0 or dB
      break;

    case "FADE_OUT":
      fadeOut(msg.seconds ?? 3);
      stopAnalyserBroadcast();
      break;

    case "FADE_IN":
      fadeIn(msg.seconds ?? 1.5);
      break;

    case "GET_STATUS":
      sendResponse({
        state: player ? "playing" : "stopped",
        url: currentUrl,
      });
      return true; // keep channel open for async response
  }
});

console.log("[offscreen] offscreen.js loaded, waiting for messages");