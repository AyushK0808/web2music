/**
 * gapless.e2e.mjs — S-I (gapless half): is the loop gapless in the browser? (C-8, R4 #2)
 *
 * Run:  npm run test:gapless
 *       npm run test:gapless -- --clips-dir=audio-generation/results/d7-clips/musicgen-small --limit=30 --cycles=12
 *       npm run test:gapless -- --out audio-generation/results/gapless.json
 *
 * What is recorded, exactly
 * ─────────────────────────
 * offscreen.entry.js plays each clip as an AudioBufferSourceNode with
 * loop = true, loopStart = 0, loopEnd = loop_point_ms / 1000 (not Tone.Player),
 * so the loop is scheduled sample-accurately by Web Audio. This harness uses
 * that same node configuration in Chromium's own decoder and renderer:
 *
 *   1. the delivered .ogg is decoded with decodeAudioData (this is where Ogg/
 *      Opus pre-skip and end padding are trimmed or not),
 *   2. an OfflineAudioContext renders CYCLES loop repeats through one looping
 *      AudioBufferSourceNode,
 *   3. the rendered samples are returned to Node and the boundaries are
 *      analysed here.
 *
 * It is a render of the playback graph's looping stage, not a capture from the
 * sound card; it does not include the offscreen document's EQ / reverb chain or
 * the operating system's mixer. It is the strongest objective check available
 * without a listener, and the paper words it that way ("gapless", never
 * "seamless" or "inaudible").
 *
 * Per clip, at every loop boundary the harness checks:
 *   - length:       decoded frames == round(loopEnd * sampleRate) within PAD_TOL
 *                   frames (a padded container shows up here)
 *   - silence:      no run of digital silence longer than the clip's own longest
 *                   interior silence run, centred on the boundary (inserted gap)
 *   - repeat:       every cycle is sample-identical to the first (the loop
 *                   inserts or drops no frames)
 *   - step:         the largest |x[n+1]-x[n]| across the boundary, reported
 *                   relative to the 99th percentile of the same quantity inside
 *                   the clip (relative seam size; analysis/proxies/seam_relative.py
 *                   does the percentile ranking on the energy/centroid metrics)
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--") ? args[idx + 1] : fallback;
};

const CLIPS_DIR = path.resolve(REPO, flag("clips-dir", "audio-generation/fallback_clips"));
const LIMIT = parseInt(flag("limit", "30"), 10);
const CYCLES = parseInt(flag("cycles", "10"), 10);
const OUT = flag("out", null);
const PAD_TOL = 64; // frames; Opus pre-skip is 312 at 48 kHz, so a leaked pre-skip is caught
const SILENCE_EPS = 1e-5;

function listClips(dir) {
  const found = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ogg|opus)$/i.test(ent.name)) found.push(p);
    }
  };
  walk(dir);
  return found.sort().slice(0, LIMIT);
}

function loopEndFor(file) {
  const sidecar = file.replace(/\.(ogg|opus)$/i, ".json");
  if (fs.existsSync(sidecar)) {
    try {
      const meta = JSON.parse(fs.readFileSync(sidecar, "utf8"));
      if (typeof meta.loop_point_ms === "number" && meta.loop_point_ms > 0) return meta.loop_point_ms / 1000;
    } catch { /* fall through */ }
  }
  return null; // → buffer.duration, as offscreen.entry.js does when loopPointMs is absent
}

/**
 * Runs in the page: decode, render CYCLES loops through a looping source, and
 * reduce the render to compact statistics there (serialising millions of
 * samples out of the page would dominate the run).
 */
async function renderInPage({ b64, loopEnd, cycles, silenceEps }) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
  const probe = new OfflineAudioContext(1, 48000, 48000);
  const buffer = await probe.decodeAudioData(bytes);
  const sr = buffer.sampleRate;
  const end = loopEnd ?? buffer.duration;
  const L = Math.round(end * sr);
  const ctx = new OfflineAudioContext(1, L * cycles, sr);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = end;
  src.connect(ctx.destination);
  src.start(0);
  const x = (await ctx.startRendering()).getChannelData(0);

  const silenceRun = (from, to) => {
    let best = 0, cur = 0;
    for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) {
      if (Math.abs(x[i]) < silenceEps) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    return best;
  };

  // Interior statistics from the first cycle.
  const steps = new Float32Array(L - 1);
  for (let i = 1; i < L; i++) steps[i - 1] = Math.abs(x[i] - x[i - 1]);
  const sorted = Float32Array.from(steps).sort();
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))];

  let repeatMismatchCycles = 0;
  for (let c = 1; c < cycles; c++) {
    for (let i = 0; i < L; i++) {
      if (Math.abs(x[c * L + i] - x[i]) > 1e-6) { repeatMismatchCycles++; break; }
    }
  }

  const WIN = Math.round(0.02 * sr);
  const boundaries = [];
  for (let c = 1; c < cycles; c++) {
    const b = c * L;
    boundaries.push({ cycle: c, step: Math.abs(x[b] - x[b - 1]), silence_run_frames: silenceRun(b - WIN, b + WIN) });
  }
  return {
    sampleRate: sr, decodedFrames: buffer.length, loopFrames: L, channels: buffer.numberOfChannels,
    cycles, p99, interiorSilence: silenceRun(0, L), repeatMismatchCycles, boundaries,
  };
}

function analyse(file, r, loopEndGiven) {
  const worstStep = r.boundaries.reduce((m, b) => Math.max(m, r.p99 > 0 ? b.step / r.p99 : 0), 0);
  const worstSilence = r.boundaries.reduce((m, b) => Math.max(m, b.silence_run_frames), 0);

  const expectedFrames = Math.round((loopEndGiven ?? r.decodedFrames / r.sampleRate) * r.sampleRate);
  const lengthOk = loopEndGiven == null || Math.abs(r.decodedFrames - expectedFrames) <= PAD_TOL;
  const silenceOk = worstSilence <= Math.max(r.interiorSilence, 2);
  const repeatOk = r.repeatMismatchCycles === 0;

  return {
    clip: path.relative(REPO, file),
    sample_rate: r.sampleRate,
    decoded_frames: r.decodedFrames,
    loop_frames: r.loopFrames,
    cycles: r.cycles,
    interior_longest_silence_frames: r.interiorSilence,
    boundary_worst_silence_frames: worstSilence,
    boundary_worst_step_vs_p99: Number(worstStep.toFixed(3)),
    repeat_mismatch_cycles: r.repeatMismatchCycles,
    length_ok: lengthOk,
    no_inserted_silence: silenceOk,
    sample_identical_cycles: repeatOk,
    gapless: lengthOk && silenceOk && repeatOk,
  };
}

async function main() {
  const clips = listClips(CLIPS_DIR);
  if (!clips.length) throw new Error(`no .ogg clips under ${CLIPS_DIR}`);
  console.log(`[gapless] ${clips.length} clip(s) x ${CYCLES} cycles from ${path.relative(REPO, CLIPS_DIR)}`);

  const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const results = [];
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    for (const file of clips) {
      const loopEnd = loopEndFor(file);
      const b64 = fs.readFileSync(file).toString("base64");
      try {
        const r = await page.evaluate(renderInPage, { b64, loopEnd, cycles: CYCLES, silenceEps: SILENCE_EPS });
        const a = analyse(file, r, loopEnd);
        results.push(a);
        console.log(`  ${a.gapless ? "ok  " : "FAIL"} ${a.clip}  frames=${a.decoded_frames}/${a.loop_frames}  ` +
          `silence=${a.boundary_worst_silence_frames}/${a.interior_longest_silence_frames}  step/p99=${a.boundary_worst_step_vs_p99}`);
      } catch (err) {
        results.push({ clip: path.relative(REPO, file), error: String(err.message ?? err), gapless: false });
        console.log(`  ERR  ${path.relative(REPO, file)}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  const ok = results.filter((r) => r.gapless).length;
  const summary = {
    clips: results.length,
    gapless: ok,
    cycles_per_clip: CYCLES,
    boundaries_checked: results.reduce((n, r) => n + (r.cycles ? r.cycles - 1 : 0), 0),
  };
  console.log(`\n${ok}/${results.length} clips gapless over ${CYCLES} cycles`);

  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), JSON.stringify({
      startedAt: new Date().toISOString(),
      config: { clipsDir: path.relative(REPO, CLIPS_DIR), limit: LIMIT, cycles: CYCLES, padTolFrames: PAD_TOL },
      summary,
      results,
    }, null, 2));
    console.log(`Wrote ${path.resolve(OUT)}`);
  }
  if (ok !== results.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
