/**
 * livePlayback.e2e.mjs — browses real websites with the unpacked extension
 * loaded and asserts that music actually comes out of it.
 *
 * Run:  npm run test:e2e:live
 *       npm run test:e2e:live -- --headed --unmuted     (watch and hear it)
 *       npm run test:e2e:live -- --only=silence
 *
 * ── How this differs from chromiumExtension.e2e.mjs ────────────────────────
 * That harness serves its own corpus and asserts which mood Feature B picks.
 * This one browses pages nobody wrote for us (see liveSites.js) and asserts the
 * part that corpus can't reach: that the offscreen document decoded the clip
 * Feature D returned, started it, and is putting signal through the audio graph
 * — and that the controls which change that signal (popup mute, tab ducking,
 * mood changes, the sensitive-page silence path) really move it.
 *
 * ── What "music is playing" is measured with ───────────────────────────────
 * offscreen.entry.js ends its chain with a Tone.Analyser, downstream of all
 * four gain stages (userGain → duckGain → moodFadeGain → EQ → reverb →
 * analyser → destination), and broadcasts an FFT frame every 100ms — but only
 * while a deck is actually running. So the peak bin of those frames is a direct
 * readout of what reaches the speakers: around -55 dBFS for the harness clip at
 * default volume, ~20 dB lower when ducked, and falling past -100 when muted.
 * A PLAYER_STATUS of "playing" only proves a decode succeeded; the analyser is
 * what proves the sound is still there ten seconds later.
 *
 * Chromium runs with --mute-audio by default here, which silences the output
 * *device* without pausing the WebAudio graph, so every measurement below is
 * unaffected. Pass --unmuted (with --headed) to actually hear it.
 *
 * ── The two network edges ──────────────────────────────────────────────────
 * The pages are real; Feature D and the classify proxy are not. harnessServer
 * stands in for the D backend (recording exactly what B handed it and serving a
 * real, decodable WAV) and holds :8078 down at 503 so B falls back to its
 * deterministic tier-1 heuristics. Running the real stack instead would make
 * generation take ~90s a page and the mood depend on an LLM's mood; neither
 * changes what this file is checking.
 *
 * ── Two timing facts that shape every phase ────────────────────────────────
 * 1. Feature B commits a mood only after it has held for 5s, which needs at
 *    least two extractions — and content.entry.js only re-extracts on DOM churn
 *    or SPA navigation. A genuinely static article therefore waits for Feature
 *    B's 60s heartbeat alarm to close the window (measured: 61s to first note
 *    on a Wikipedia article left alone). Every phase here nudges the page the
 *    way any live site nudges itself — a hidden empty node, plus scrolling —
 *    which brings first playback down to ~8s.
 * 2. background.js fades out and stops at chrome.idle's 60s mark. Idle is
 *    measured from OS-level input, which synthesized CDP input does not count
 *    as, so an automated run *will* trip it. Each phase therefore gets its own
 *    short-lived browser rather than sharing one long session, and any phase
 *    that finds playback stopped underneath it says so instead of reporting a
 *    mysterious silence.
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { LIVE_SITES } from "./liveSites.js";
import { startHarnessServer } from "./harnessServer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.join(__dirname, "..", "dist");

const args = process.argv.slice(2);
const HEADED = args.includes("--headed") || process.env.W2M_E2E_HEADED === "1";
const UNMUTED = args.includes("--unmuted");
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").split("=")[1] || null;
const USE_REAL_LLM = process.env.W2M_E2E_LLM === "proxy";

// ── Thresholds ──────────────────────────────────────────────────────────────
// Measured against the harness WAV (a -35 dBFS tone) at the engine's default
// 0.65 user volume: playing sits at -52…-57 dBFS, ducking (duckGain 0.1) lands
// at -73, and a mute ramps past -100 and keeps falling. The gaps are 20 dB and
// 45 dB, so these bounds are loose enough to survive a different clip.
const AUDIBLE_DB = -90;      // above this = signal is genuinely reaching the output
const SILENCED_DB = -95;     // below this = the graph has actually gone quiet
const DUCK_DROP_DB = 10;     // nominal drop is 20 dB; fail only well short of it
const RESTORE_TOLERANCE_DB = 8; // "back to where it was" after unmute/unduck
const MIN_FRAMES = 12;       // frames expected in a 2.5s window at 10/s

// ── Budgets ─────────────────────────────────────────────────────────────────
const PLAYBACK_TIMEOUT_MS = 45_000; // page load + two extractions + 5s window + D
const COMMIT_TIMEOUT_MS = 45_000;
const NAV_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (db) => (db == null ? "—" : `${db.toFixed(0)} dB`);

// ── Result recording ────────────────────────────────────────────────────────
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "ok  " : "FAIL";
  console.log(`      ${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, why) {
  results.push({ name, ok: null, detail: why });
  console.log(`      skip  ${name} — ${why}`);
}

// ── Browser plumbing ────────────────────────────────────────────────────────
async function getServiceWorker(context, timeoutMs = 30_000) {
  const [existing] = context.serviceWorkers();
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: timeoutMs }).catch(() => null);
}

/**
 * instrument — point the extension at the harness's Feature D stub and start
 * recording what the offscreen document broadcasts.
 *
 * The analyser and status frames are collected inside the service worker
 * because that is the only extension context Playwright can evaluate in: an
 * offscreen document is not exposed as a page or a worker target, so it can
 * only be reached by message. Its ANALYSER_DATA / PLAYER_STATUS broadcasts
 * already arrive here, which is enough — a second onMessage listener observes
 * them without disturbing background.js's own.
 *
 * Both arrays live on `self`, so a service-worker eviction would clear them.
 * Nothing here idles long enough for that (every phase polls the worker at
 * least once a second, which keeps it alive).
 */
async function instrument(worker, backendUrl) {
  await worker.evaluate(async (backendUrl) => {
    // featureDClient re-reads backendUrl from storage.local per request, so
    // this needs no extension restart (and none is possible under
    // --load-extension — see harnessServer.mjs's header).
    await chrome.storage.local.set({ backendUrl, masterEnabled: true });

    // Park the ambient idle timer for the run. background.js asks chrome.idle
    // for a 60s detection interval, and idle is measured from OS-level input
    // that a driven browser never generates, so every phase longer than a
    // minute would otherwise be faded out and stopped mid-measurement by a
    // timer none of them are testing. The fade-out path itself is still
    // covered — phase 1 sends the FADE_OUT that listener would have sent, on
    // purpose, and asserts what happens next.
    chrome.idle.setDetectionInterval(3600);

    self.__peaks = [];
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type !== "ANALYSER_DATA") return;
      const peak = Math.max(...msg.fft);
      // A fully silent graph reads -Infinity, which JSON turns into null on the
      // way out of evaluate(); -200 keeps it a number and still sorts below
      // every real reading.
      self.__peaks.push({ db: Number.isFinite(peak) ? peak : -200, t: Date.now() });
    });
  }, backendUrl);
}

async function withBrowser(server, fn) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2m-live-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Full Chromium, not chromium_headless_shell: the shell cannot load
    // extensions at all. See chromiumExtension.e2e.mjs's header.
    channel: "chromium",
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
      ...(UNMUTED ? [] : ["--mute-audio"]),
    ],
  });

  try {
    const worker = await getServiceWorker(context);
    if (!worker) throw new Error("extension service worker never started — is ui/dist a valid unpacked extension?");
    await instrument(worker, `${server.baseUrl}/d`);
    return await fn({ context, worker, extensionId: new URL(worker.url()).host });
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

// ── Reading the extension's state ───────────────────────────────────────────

/** The offscreen document's own view: {state, url}. */
const playerStatus = (worker) =>
  worker.evaluate(() => chrome.runtime.sendMessage({ target: "offscreen", type: "GET_STATUS" }).catch(() => null));

/** Send an audio command exactly as background.js's forwardToOffscreen would. */
const toOffscreen = (worker, msg) =>
  worker.evaluate((m) => chrome.runtime.sendMessage({ target: "offscreen", ...m }).catch(() => {}), msg);

/** Feature B's committed view of the one open content tab. */
async function committedMood(worker) {
  return worker
    .evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const states = Object.entries(all)
        .filter(([k]) => k.startsWith("fb_tab_"))
        .map(([, v]) => v);
      const state = states.find((s) => s.currentMood) ?? states[0] ?? null;
      if (!state) return null;
      return {
        current: state.currentMood,
        pending: state.pendingMood,
        tier: state.lastRecord?.moodContext?.tier ?? null,
        confidence: state.lastRecord?.moodContext?.confidence ?? null,
      };
    })
    .catch(() => null);
}

// ── Measuring the audio ─────────────────────────────────────────────────────

/**
 * stats — median and final reading of one window of analyser peaks.
 *
 * Median for steady-state levels (it shrugs off the odd frame caught mid-ramp),
 * and `last` for the assertions about going quiet: a mute is an asymptotic ramp
 * that is still falling when the window ends, so its median lands well above
 * where the signal actually got to.
 */
function stats(peaks) {
  if (!peaks.length) return { n: 0, median: null, last: null };
  const sorted = [...peaks].sort((a, b) => a - b);
  return { n: peaks.length, median: sorted[sorted.length >> 1], last: peaks[peaks.length - 1] };
}

/**
 * measure — settle past any in-flight gain ramp, then summarise one window of
 * analyser frames.
 *
 * settleMs matters: every gain change in the engine is a rampTo (0.15s for
 * pause, 0.3s for volume, 0.5s for duck/mood, 3s for a crossfade) and Tone's
 * ramps approach their target asymptotically, so sampling immediately after a
 * command measures the ramp rather than the result. 1.2s clears every ramp
 * except the crossfade, which callers extend for explicitly.
 */
async function measure(worker, { settleMs = 1200, windowMs = 2500 } = {}) {
  await sleep(settleMs);
  const from = Date.now();
  await sleep(windowMs);
  const peaks = await worker.evaluate((from) => self.__peaks.filter((p) => p.t >= from).map((p) => p.db), from);
  return stats(peaks);
}

/**
 * checkAudible — the "music is playing" assertion, used everywhere.
 *
 * Both halves matter: frames only arrive while a deck is running, so a frame
 * count near zero means playback stopped outright, whereas plenty of frames at
 * -140 dB means the graph is running into a gain stage someone left at zero —
 * exactly the failure that reports itself as "playing" everywhere else.
 */
function checkAudible(name, s, extra = "") {
  const detail = `${s.n} frames, median ${fmt(s.median)}${extra ? `, ${extra}` : ""}`;
  if (s.n < MIN_FRAMES) {
    check(name, false, `${detail} — playback stopped or never started`);
    return false;
  }
  if (s.median <= AUDIBLE_DB) {
    check(name, false, `${detail} — deck is running but the signal is inaudible (a gain stage is at zero)`);
    return false;
  }
  check(name, true, detail);
  return true;
}

// ── Driving a real page ─────────────────────────────────────────────────────

/**
 * driveActivity — scroll slowly and append a hidden empty node, until stopped.
 *
 * Two jobs. The scrolling keeps behaviorTracker's readings alive (they decay
 * 500ms after the last event, and B2 snapshots them at extraction time), and
 * the node makes content.entry.js's throttled MutationObserver re-extract, so
 * Feature B's 5s confidence window can close on its own rather than waiting for
 * the 60s heartbeat alarm — see this file's header. The node is empty and
 * display:none, so nothing it does can reach Readability's text or the colour
 * sampler; it is the same trick moodSites.js bakes into its own pages, applied
 * from outside because these pages aren't ours to edit.
 */
function driveActivity(page) {
  const control = { stopped: false };
  (async () => {
    while (!control.stopped) {
      try {
        await page.evaluate(() => {
          window.scrollBy(0, 12);
          let host = document.getElementById("__w2m_live_heartbeat");
          if (!host) {
            host = document.createElement("div");
            host.id = "__w2m_live_heartbeat";
            host.style.display = "none";
            document.body.appendChild(host);
          }
          host.appendChild(document.createElement("span"));
          if (host.childNodes.length > 4) host.removeChild(host.firstChild);
        });
      } catch {
        return; // page navigated or closed under us — expected
      }
      await sleep(700);
    }
  })();
  return control;
}

/**
 * openLive — navigate to a real URL, tolerating the network being absent.
 * @returns {Promise<boolean>} false if the page could not be reached at all.
 */
async function openLive(page, site) {
  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    return true;
  } catch (err) {
    console.log(`      (could not reach ${site.url}: ${err.message.split("\n")[0]})`);
    return false;
  }
}

async function waitForPlaying(worker, timeoutMs = PLAYBACK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await playerStatus(worker);
    if (status?.state === "playing") return status;
    await sleep(500);
  }
  return null;
}

async function waitForCommit(worker, timeoutMs = COMMIT_TIMEOUT_MS, predicate = (m) => !!m.current) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await committedMood(worker);
    if (last && predicate(last)) return last;
    await sleep(500);
  }
  return last;
}

async function waitForGenerate(server, timeoutMs = PLAYBACK_TIMEOUT_MS, after = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = server.dRequests.filter((r) => r.kind === "generate")[after];
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

// ── Phase 1: music plays on a real page, and the popup can silence it ───────
async function phasePlayback(server) {
  const site = LIVE_SITES.calm;
  console.log(`\n  [playback] ${site.label}`);
  server.reset();

  return withBrowser(server, async ({ context, worker, extensionId }) => {
    const page = await context.newPage();
    if (!(await openLive(page, site))) return skip("playback", "site unreachable");
    const activity = driveActivity(page);

    const t0 = Date.now();
    const generate = await waitForGenerate(server);
    const mood = await committedMood(worker);

    if (!generate) {
      check("live-pipeline", false, `no POST /generate within ${PLAYBACK_TIMEOUT_MS}ms (B: ${mood?.current ?? "nothing committed"}/${mood?.pending ?? "—"})`);
      activity.stopped = true;
      return;
    }
    check(
      "live-pipeline",
      generate.mood === mood?.current,
      `real page → B committed "${mood?.current}" (${mood?.tier}, conf ${mood?.confidence?.toFixed(2)}) → D got "${generate.mood}" in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );

    const fallback = server.dRequests.find((r) => r.kind === "fallback");
    check("instant-fallback", !!fallback && fallback.mood === generate.mood,
      fallback ? `GET /fallback/${fallback.mood} preceded the generation` : "no /fallback request — the instant-start path did not run");

    // Either clip is a pass here: requestTrack starts the instant fallback and
    // crossfades the generated one in behind it, so which of the two is loaded
    // at this instant is a race the assertion has no business caring about.
    const playing = await waitForPlaying(worker);
    const expected = new RegExp(`/d/clip/(fallback|generated)-${generate.mood}\\.wav$`);
    check("playback-started", expected.test(playing?.url ?? ""),
      playing?.url ? `offscreen is playing ${playing.url.split("/").pop()}` : "offscreen never reported a track it was playing");
    if (!playing) { activity.stopped = true; return; }

    const baseline = await measure(worker);
    if (!checkAudible("audio-signal", baseline)) { activity.stopped = true; return; }

    // ── The popup's mute button, clicked for real ───────────────────────────
    // Opening popup.html as a tab is the only way to drive the real popup:
    // Playwright cannot open the browser-action bubble. The scripts, messaging
    // and extension origin are identical either way — only the framing differs.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
    await popup.waitForSelector("#btnMute", { timeout: 5000 });

    await popup.click("#btnMute");
    const muted = await measure(worker, { settleMs: 2500 });
    check(
      "popup-mute",
      muted.n > 0 && muted.last <= SILENCED_DB && baseline.median - muted.last >= 25,
      `${fmt(baseline.median)} → ${fmt(muted.last)} after one click`
    );

    await popup.click("#btnMute");
    const unmuted = await measure(worker, { settleMs: 1500 });
    check(
      "popup-unmute",
      unmuted.median != null && Math.abs(unmuted.median - baseline.median) <= RESTORE_TOLERANCE_DB,
      `back to ${fmt(unmuted.median)} (baseline ${fmt(baseline.median)})`
    );
    await popup.close();

    // ── Recovery after the idle fade-out ───────────────────────────────────
    // FADE_OUT is what background.js sends when chrome.idle reports 60s of
    // inactivity: moodFadeGain ramps to 0, then the engine stops. Sending it
    // directly reproduces that without waiting out a real idle window (which an
    // automated run cannot influence — see the header). The track that follows
    // is what the popup's Play button sends on the way back.
    await toOffscreen(worker, { type: "FADE_OUT", seconds: 2 });
    await sleep(3500);
    const afterFade = await playerStatus(worker);
    check("idle-fade-stops", afterFade?.state === "stopped", `offscreen reports "${afterFade?.state}"`);

    await toOffscreen(worker, { type: "LOAD_TRACK", url: `${server.baseUrl}/d/clip/generated-${generate.mood}.wav` });
    const resumed = await measure(worker, { settleMs: 1500 });
    checkAudible("resume-after-idle-fade", resumed, "the next track after an idle fade must not start into a muted stage");

    activity.stopped = true;
  });
}

// ── Phase 2: a real media tab ducks the music ───────────────────────────────
async function phaseDucking(server) {
  // Deliberately not the Wikipedia page the other phases use: this is the one
  // phase whose assertions don't depend on which mood comes out, so it is the
  // cheapest place to put a site with a completely different DOM shape and be
  // sure the suite isn't quietly testing one publisher's markup.
  const site = LIVE_SITES.curious;
  console.log(`\n  [ducking] ${site.label} + ${LIVE_SITES.media.label}`);
  server.reset();

  return withBrowser(server, async ({ context, worker }) => {
    const page = await context.newPage();
    if (!(await openLive(page, site))) return skip("media-duck", "site unreachable");
    const activity = driveActivity(page);

    if (!(await waitForPlaying(worker))) {
      check("media-duck", false, "nothing was playing to duck");
      activity.stopped = true;
      return;
    }
    const baseline = await measure(worker);
    if (!checkAudible("pre-duck-signal", baseline)) { activity.stopped = true; return; }

    // Opening the tab is the whole trigger: background.js's isMediaTab() matches
    // the URL on tabs.onActivated/onUpdated and sends DUCK by itself.
    const media = await context.newPage();
    if (!(await openLive(media, LIVE_SITES.media))) {
      skip("media-duck", "youtube.com unreachable");
      activity.stopped = true;
      return;
    }
    const ducked = await measure(worker, { settleMs: 2500 });
    check(
      "media-duck",
      ducked.median != null && baseline.median - ducked.median >= DUCK_DROP_DB,
      `${fmt(baseline.median)} → ${fmt(ducked.median)} with a real media tab in front (nominal drop is 20 dB)`
    );

    await media.close();
    await page.bringToFront();
    const unducked = await measure(worker, { settleMs: 2500 });
    check(
      "media-unduck",
      unducked.median != null && Math.abs(unducked.median - baseline.median) <= RESTORE_TOLERANCE_DB,
      `back to ${fmt(unducked.median)} after the media tab closed`
    );

    activity.stopped = true;
  });
}

// ── Phase 3: navigating between real pages changes the music ────────────────
async function phaseMoodChange(server) {
  const from = LIVE_SITES.calm;
  const to = LIVE_SITES.energetic;
  console.log(`\n  [mood-change] ${from.label} → ${to.label}`);
  server.reset();

  return withBrowser(server, async ({ context, worker }) => {
    const page = await context.newPage();
    if (!(await openLive(page, from))) return skip("mood-change", "first site unreachable");
    let activity = driveActivity(page);

    const first = await waitForGenerate(server);
    if (!first) {
      check("mood-change", false, "the first page never reached Feature D");
      activity.stopped = true;
      return;
    }

    activity.stopped = true;
    if (!(await openLive(page, to))) return skip("mood-change", "second site unreachable");
    activity = driveActivity(page);

    const second = await waitForGenerate(server, PLAYBACK_TIMEOUT_MS, 1);
    if (!second) {
      const mood = await committedMood(worker);
      // Not a code failure if both real pages simply read the same way — say so
      // rather than colouring it red.
      if (mood?.current === first.mood) {
        skip("mood-change", `both pages classified "${first.mood}" — no transition was due`);
      } else {
        check("mood-change", false, `second page committed "${mood?.current ?? "nothing"}" but no second POST /generate arrived`);
      }
      activity.stopped = true;
      return;
    }

    check("mood-change", second.mood !== first.mood, `"${first.mood}" → "${second.mood}", second generation requested`);

    // The engine crossfades over 3s, so give the swap room before measuring.
    const after = await measure(worker, { settleMs: 4000 });
    checkAudible("post-change-signal", after, `still playing after the crossfade into "${second.mood}"`);

    activity.stopped = true;
  });
}

// ── Phase 4: a real sensitive page silences music that is already playing ───
//
// The order is the point. Arriving at a sensitive page cold proves very little:
// with nothing playing, the offscreen engine has not been built yet, so
// FADE_TO_SILENCE lands on an undefined gain node and does nothing, and any
// music that starts afterwards is audible by default. The sequence that
// actually exercises the feature — and the one a reader hits in real life — is
// music playing, *then* the sensitive page, *then* browsing on.
async function phaseSilence(server) {
  const before = LIVE_SITES.calm;
  const site = LIVE_SITES.sensitive;
  const after = LIVE_SITES.energetic;
  console.log(`\n  [silence] ${before.label} → ${site.label} → ${after.label}`);
  server.reset();

  return withBrowser(server, async ({ context, worker }) => {
    const page = await context.newPage();
    if (!(await openLive(page, before))) return skip("live-silence", "warm-up site unreachable");
    let activity = driveActivity(page);

    if (!(await waitForPlaying(worker))) {
      check("live-silence", false, "no music was playing to silence");
      activity.stopped = true;
      return;
    }
    const baseline = await measure(worker);
    if (!checkAudible("pre-silence-signal", baseline)) { activity.stopped = true; return; }

    // ── Onto the sensitive page ────────────────────────────────────────────
    const requestsBefore = server.dRequests.length;
    const generatesBefore = server.dRequests.filter((r) => r.kind === "generate").length;
    activity.stopped = true;
    if (!(await openLive(page, site))) return skip("live-silence", "site unreachable");
    activity = driveActivity(page);

    const mood = await waitForCommit(worker, COMMIT_TIMEOUT_MS, (m) => m.current === "silence");
    check("live-silence", mood?.current === "silence",
      mood?.current === "silence"
        ? "B1's sensitive detector fired on a real page and B committed \"silence\""
        : `expected "silence", got "${mood?.current ?? "nothing"}" (pending ${mood?.pending ?? "—"})`);

    const silenced = await measure(worker, { settleMs: 3500 }); // FADE_TO_SILENCE ramps over 3s
    check("silence-mutes-playing-music",
      silenced.last != null && silenced.last <= SILENCED_DB,
      `${fmt(baseline.median)} → ${fmt(silenced.last)}`);

    check("no-generation-for-sensitive-page", server.dRequests.length === requestsBefore,
      server.dRequests.length === requestsBefore
        ? "Feature D was not called for the sensitive page"
        : `Feature D was called: ${server.dRequests.slice(requestsBefore).map((r) => `${r.kind}:${r.mood}`).join(", ")}`);

    // ── Browsing on afterwards ─────────────────────────────────────────────
    // moodFadeGain is still at 0 from the fade above, and loading a track does
    // not touch it — so this is the assertion that the safety feature silences
    // one page rather than the rest of the session.
    activity.stopped = true;
    if (!(await openLive(page, after))) return skip("recovery-after-silence", "follow-up site unreachable");
    activity = driveActivity(page);

    const generate = await waitForGenerate(server, PLAYBACK_TIMEOUT_MS, generatesBefore);
    check("recovery-generation", !!generate,
      generate ? `D called with "${generate.mood}" after leaving the sensitive page` : "no generation after leaving the sensitive page");
    if (!generate) { activity.stopped = true; return; }

    if (!(await waitForPlaying(worker))) {
      check("recovery-after-silence", false, "offscreen never reported \"playing\" on the follow-up page");
      activity.stopped = true;
      return;
    }
    const recovered = await measure(worker, { settleMs: 2500 });
    checkAudible("recovery-after-silence", recovered, "music must be audible again once the sensitive page is behind you");

    activity.stopped = true;
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────
const PHASES = [
  { name: "playback", run: phasePlayback },
  { name: "ducking", run: phaseDucking },
  { name: "mood-change", run: phaseMoodChange },
  { name: "silence", run: phaseSilence },
];

async function main() {
  if (!fs.existsSync(path.join(EXT_PATH, "manifest.json"))) {
    throw new Error(`No built extension at ${EXT_PATH} — run \`npm run build\` first.`);
  }

  const phases = ONLY ? PHASES.filter((p) => p.name === ONLY) : PHASES;
  if (phases.length === 0) throw new Error(`--only=${ONLY} matched no phase (have: ${PHASES.map((p) => p.name).join(", ")})`);

  const server = await startHarnessServer({ stubLlm: !USE_REAL_LLM });
  const advisory = !server.classifyStubbed;

  console.log(`[live] extension:      ${EXT_PATH}`);
  console.log(`[live] Feature D stub: ${server.baseUrl}/d`);
  console.log(
    `[live] classify proxy: ` +
      (server.classifyStubbed
        ? "held down at 503 on :8078 → deterministic tier-1 heuristics"
        : "a live proxy is answering on :8078 — moods come from an LLM this run")
  );
  console.log(`[live] audio:          ${UNMUTED ? "audible (--unmuted)" : "device muted; the WebAudio graph still runs"}`);
  console.log(`[live] phases:         ${phases.map((p) => p.name).join(", ")}`);

  try {
    for (const phase of phases) await phase.run(server);
  } finally {
    await server.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  const passed = results.filter((r) => r.ok === true);

  console.log(`\n  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  for (const r of failed) console.log(`    FAIL  ${r.name} — ${r.detail}`);

  if (results.length === 0 || passed.length === 0) {
    console.log(
      "\n  Nothing was verified — every live page was unreachable. This suite needs\n" +
      "  outbound network access; the offline pipeline checks live in `npm run test:e2e`."
    );
    return;
  }
  if (failed.length && advisory) {
    console.log(
      "\n  A live classify proxy answered instead of the stub, so the moods above came\n" +
      "  from an LLM. Stop the proxy on :8078 for a run whose moods are pinned."
    );
  }
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n[live] harness error:", err);
  process.exitCode = 1;
});
