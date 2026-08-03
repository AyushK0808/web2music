// ui/src/offscreen.entry.js — Feature C: audio playback engine + Feature A's
// embedding/vector-store server side, both living in the offscreen document.
//
// Rewrites offscreen.js's single contested gainNode into four independent
// stages (finding (c) in the X4 integration plan):
//
//   deckA ─┐
//          ├─ crossfadeGain(A/B) ─ userGain ─ duckGain ─ moodFadeGain ─ EQ3 ─ Reverb ─ Analyser ─ out
//   deckB ─┘
//
// userGain     — only the popup's volume slider writes it.
// duckGain     — only DUCK/UNDUCK (tab monitoring) writes it.
// moodFadeGain — only Feature B's volume / isSilent / idle-fade writes it.
//
// They multiply naturally, so unducking can no longer erase B's idle fade,
// and pausing no longer resets the volume slider.
//
// Decks use raw AudioBufferSourceNode (not Tone.Player) specifically so
// loopStart/loopEnd can be set from D4's loop_point_ms — Tone.Player({loop:
// true}) loops the whole padded buffer and never hits the crossfaded seam
// X2 produced.

import { handleExtractMessage, warmEmbedWorker } from "./offscreenExtract.js";
import { isExtractMessage } from "./offscreenTypes.js";
import { createLogger } from "./log.js";

const log = createLogger("offscreen");

const CROSSFADE_SECONDS = 3.0;
const CROSSFADE_STEPS = 128;

let ctx = null;
let userGain, duckGain, moodFadeGain, eq, reverb, analyser;
let isSetup = false;

// Two alternating decks. Each deck is { source, gain, url }.
let decks = [null, null];
let activeDeckIndex = -1; // -1 = nothing loaded yet

let isPaused = false;
let pausedUserVolume = 0.65; // 0..1, restored on resume
let currentUrl = null;

async function setupEngine() {
  if (isSetup) return;

  await Tone.start();
  ctx = Tone.getContext().rawContext;

  userGain = new Tone.Gain(pausedUserVolume);
  duckGain = new Tone.Gain(1);
  moodFadeGain = new Tone.Gain(1);
  eq = new Tone.EQ3({ low: 0, mid: 0, high: -3 });
  reverb = new Tone.Reverb({ decay: 2.5, wet: 0.3 });
  await reverb.generate();
  analyser = new Tone.Analyser("fft", 256);

  userGain.connect(duckGain);
  duckGain.connect(moodFadeGain);
  moodFadeGain.connect(eq);
  eq.connect(reverb);
  reverb.connect(analyser);
  analyser.toDestination();

  isSetup = true;
  // sampleRate/state matter: a context stuck in "suspended" (no user gesture
  // yet) produces total silence while every other log still says "playing".
  log.info("Audio engine ready", { state: ctx.state, sampleRate: ctx.sampleRate });
}

// ── Equal-power crossfade curves — matches d4_process.py's own sin/cos
// shape so the two crossfades in the system (D4's seam, this transition)
// are the same curve and don't compound into an audible dip.
function equalPowerCurves(steps) {
  const fadeOut = new Float32Array(steps);
  const fadeIn = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    fadeOut[i] = Math.cos(t * 0.5 * Math.PI);
    fadeIn[i] = Math.sin(t * 0.5 * Math.PI);
  }
  return { fadeOut, fadeIn };
}

async function decodeAndBuild(url) {
  const doneFetch = log.time(`fetch ${url}`);
  const res = await fetch(url);
  doneFetch(`-> ${res.status}`);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const doneDecode = log.time(`decode ${arrayBuffer.byteLength} bytes`);
  const buffer = await ctx.decodeAudioData(arrayBuffer);
  doneDecode(`-> ${buffer.duration.toFixed(2)}s @ ${buffer.sampleRate}Hz, ${buffer.numberOfChannels}ch`);
  return buffer;
}

/**
 * loadTrack — decode `url`, build a fresh deck with loopStart/loopEnd from
 * loopPointMs (falls back to the full buffer duration if absent), and
 * crossfade from whatever deck is currently active into it. First call (no
 * active deck yet) starts at full volume with no fade.
 */
async function loadTrack(url, { loopPointMs = null, crossfadeSec = CROSSFADE_SECONDS } = {}) {
  log.info("loadTrack", { url, loopPointMs, crossfadeSec, fromDeck: activeDeckIndex });
  await setupEngine();

  const buffer = await decodeAndBuild(url);
  const nextIndex = activeDeckIndex === 0 ? 1 : 0;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = loopPointMs != null ? loopPointMs / 1000 : buffer.duration;

  const deckGain = new Tone.Gain(activeDeckIndex === -1 ? 1 : 0);
  Tone.connect(source, deckGain);
  deckGain.connect(userGain);

  const prevDeck = decks[activeDeckIndex];
  const prevIndex = activeDeckIndex;
  decks[nextIndex] = { source, gain: deckGain, url };

  const t = ctx.currentTime;
  source.start(t);

  if (prevDeck) {
    const { fadeOut, fadeIn } = equalPowerCurves(CROSSFADE_STEPS);
    prevDeck.gain.gain.setValueCurveAtTime(fadeOut, t, crossfadeSec);
    deckGain.gain.setValueCurveAtTime(fadeIn, t, crossfadeSec);
    const staleSource = prevDeck.source;
    const staleGain = prevDeck.gain;
    setTimeout(() => {
      try {
        staleSource.stop();
        staleSource.disconnect();
        staleGain.dispose();
      } catch (e) { /* already stopped/disposed */ }
    }, crossfadeSec * 1000 + 100);
  }

  activeDeckIndex = nextIndex;
  currentUrl = url;
  isPaused = false;
  // The four gain stages multiply, so any one of them at 0 is total silence
  // while everything reports "playing" — dumping all four here is what makes
  // a stuck moodFadeGain (the sensitive-page silence bug) diagnosable at a
  // glance instead of by bisecting the graph.
  log.info(`deck ${nextIndex} playing${prevDeck ? ` (crossfading ${crossfadeSec}s from deck ${prevIndex})` : " (first track, no fade)"}`, {
    loopEnd: source.loopEnd,
    gains: {
      user: userGain.gain.value,
      duck: duckGain.gain.value,
      moodFade: moodFadeGain.gain.value,
    },
  });
  sendStatus("playing");
}

function stopAllDecks() {
  const live = decks.filter(Boolean).length;
  for (const deck of decks) {
    if (!deck) continue;
    try {
      deck.source.stop();
      deck.source.disconnect();
      deck.gain.dispose();
    } catch (e) { /* already stopped/disposed */ }
  }
  decks = [null, null];
  activeDeckIndex = -1;
  log.debug(`stopAllDecks: tore down ${live} deck(s)`);
}

function pause() {
  if (activeDeckIndex === -1) {
    log.debug("pause ignored — nothing loaded");
    return;
  }
  pausedUserVolume = userGain.gain.value;
  log.info("pause (remembering userGain =", pausedUserVolume, ")");
  userGain.gain.rampTo(0, 0.15);
  isPaused = true;
  sendStatus("paused");
}

function resume() {
  if (activeDeckIndex === -1) {
    log.debug("resume ignored — nothing loaded");
    return;
  }
  log.info("resume (restoring userGain =", pausedUserVolume, ")");
  userGain.gain.rampTo(pausedUserVolume, 0.15);
  isPaused = false;
  sendStatus("playing");
}

function stop() {
  log.info("stop — tearing down decks and resetting moodFadeGain to 1");
  stopAllDecks();
  isPaused = false;
  currentUrl = null;
  // Whatever faded this session out belongs to this session. idleFadeOut()
  // arrives here with moodFadeGain already ramped to 0, and the next
  // LOAD_TRACK — the popup's Play button reloads audioState.currentUrl
  // directly, without a Feature B transition to restore the gain — would
  // otherwise start a fresh track into a muted stage.
  if (moodFadeGain) {
    moodFadeGain.gain.cancelScheduledValues(ctx.currentTime);
    moodFadeGain.gain.value = 1;
  }
  sendStatus("stopped");
}

function setUserVolume(fraction) {
  const v = Math.max(0, Math.min(1, fraction));
  pausedUserVolume = v;
  log.debug(`setUserVolume ${fraction} -> ${v}${isPaused ? " (paused, stored only)" : ""}`);
  if (!isPaused && userGain) userGain.gain.rampTo(v, 0.3);
}

// ── Tab ducking — writes duckGain only, never touches userGain/moodFadeGain.
function duck() {
  log.info("duck -> duckGain 0.1");
  if (duckGain) duckGain.gain.rampTo(0.1, 0.5);
}
function unduck() {
  log.info("unduck -> duckGain 1.0");
  if (duckGain) duckGain.gain.rampTo(1.0, 0.5);
}

// ── Feature B's mood-volume signal — writes moodFadeGain only.
function setMoodVolume(v) {
  const clamped = Math.max(0, Math.min(1, v));
  log.info(`setMoodVolume ${v} -> moodFadeGain ${clamped}`);
  if (moodFadeGain) moodFadeGain.gain.rampTo(clamped, 0.5);
}
function fadeToSilence(seconds = 3) {
  log.info(`fadeToSilence over ${seconds}s -> moodFadeGain 0 (stays 0 until the next transition or stop())`);
  if (moodFadeGain) moodFadeGain.gain.rampTo(0, seconds);
}

// ── Idle fade (extension-level, distinct from Feature B's mood fade) —
// still writes moodFadeGain so it composes the same way; stop() after.
function idleFadeOut(seconds = 3) {
  log.info(`idleFadeOut over ${seconds}s, then stop()`);
  fadeToSilence(seconds);
  setTimeout(stop, seconds * 1000 + 100);
}

// ── Analyser broadcast ────────────────────────────────────────────────────
let analyserInterval = null;
function startAnalyserBroadcast() {
  if (analyserInterval) return;
  analyserInterval = setInterval(() => {
    if (!analyser || activeDeckIndex === -1) return;
    chrome.runtime.sendMessage({ type: "ANALYSER_DATA", fft: Array.from(analyser.getValue()) }).catch(() => {});
  }, 100);
}
function stopAnalyserBroadcast() {
  if (analyserInterval) { clearInterval(analyserInterval); analyserInterval = null; }
}

function sendStatus(state) {
  chrome.runtime.sendMessage({ type: "PLAYER_STATUS", state, url: currentUrl }).catch(() => {});
}

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Gate on the message type, not on `target` alone — forwardToOffscreen()
  // stamps target:"offscreen" onto audio commands too, and routing those
  // into handleExtractMessage() left them unanswered on a held-open channel
  // while the switch below never ran. See offscreenTypes.js.
  if (isExtractMessage(msg)) {
    log.debug(`<- extract RPC ${msg.type}`);
    // handleExtractMessage is async and calls sendResponse itself once it
    // resolves — returning true here (not the promise) keeps the message
    // channel open until that happens, per the chrome.runtime.onMessage contract.
    handleExtractMessage(msg, sendResponse);
    return true;
  }

  // Every audio command lands here (forwardToOffscreen stamps target:"offscreen"
  // on all of them). Logged before the switch so a command that matches no case
  // — a typo'd type, or one the worker sends that this file never implemented —
  // is still visible rather than vanishing silently, which is how the original
  // target/type routing bug stayed hidden.
  if (msg.target === "offscreen") {
    log.debug(`<- ${msg.type}`, msg);
  }

  switch (msg.type) {
    case "LOAD_TRACK":
      loadTrack(msg.url, { loopPointMs: msg.loopPointMs, crossfadeSec: msg.crossfadeSec })
        .catch((err) => { log.error("loadTrack failed:", err, "url:", msg.url); sendStatus("error"); });
      startAnalyserBroadcast();
      break;
    case "PAUSE": pause(); break;
    case "RESUME": resume(); break;
    case "STOP": stop(); stopAnalyserBroadcast(); break;
    case "DUCK": duck(); break;
    case "UNDUCK": unduck(); break;
    case "SET_VOLUME": setUserVolume(msg.value); break;
    case "SET_MOOD_VOLUME": setMoodVolume(msg.value); break;
    case "FADE_TO_SILENCE": fadeToSilence(msg.seconds ?? 3); break;
    case "FADE_OUT": idleFadeOut(msg.seconds ?? 3); stopAnalyserBroadcast(); break;
    case "GET_STATUS":
      sendResponse({ state: activeDeckIndex !== -1 ? (isPaused ? "paused" : "playing") : "stopped", url: currentUrl });
      return true;
    default:
      if (msg.target === "offscreen") {
        log.warn(`unhandled offscreen command '${msg.type}' — no case in the switch`);
      }
  }
});

self.addEventListener("unhandledrejection", (e) => log.error("unhandled promise rejection:", e.reason));
self.addEventListener("error", (e) => log.error("uncaught error:", e.message, e.filename, e.lineno));

warmEmbedWorker();
log.info("offscreen.entry.js loaded, waiting for messages");
