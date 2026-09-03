/**
 * latency.e2e.mjs — §6 systems eval: how long after opening a page does the
 * user actually hear something, and which part of the pipeline owns each
 * millisecond?
 *
 * Run:  npm run test:latency
 *       npm run test:latency -- --repeats 5 --out results/latency-e2e.json
 *       npm run test:latency -- --d-delay 12000        # simulate CPU MusicGen
 *       npm run test:latency -- --only=calm_nature_guide --headed
 *
 * ── Why this is separate from experiments/d4_latency.py ────────────────────
 * That script measures Feature D in isolation, over HTTP, with a synthetic
 * profile. It cannot see the three costs that sit either side of it: Feature
 * A extracting from a real DOM, Feature B's decision, and the offscreen
 * document fetching + decoding + crossfading the clip. Those are the majority
 * of the latency on a cache hit, and they only exist in a real browser with
 * the real extension loaded. This harness reuses the correctness harness's
 * Chromium setup (chromiumExtension.e2e.mjs) and mood corpus, and swaps the
 * assertions for a stopwatch.
 *
 * ── The distinction the paper has to make ─────────────────────────────────
 * Wall-clock "page open → first sound" is dominated by a *deliberate* 5s
 * wait: Feature B only commits a mood after it has held steady for
 * confidenceWindowMs, so a page cannot legitimately produce audio sooner than
 * that no matter how fast the code is (feature_b/index.js). Reporting that
 * number alone as "system latency" would be measuring a design decision and
 * calling it an implementation cost.
 *
 * So every page yields two figures:
 *
 *   wall_to_first_audio_ms   what the user experiences, confidence window
 *                            and all. This is the honest UX number.
 *   compute_ms               extract + classify + generate + decode, i.e.
 *                            the part that would shrink if the code got
 *                            faster. This is the honest engineering number.
 *
 * ── Where the numbers come from ───────────────────────────────────────────
 * Three independent clocks, all Date.now() on the same machine:
 *   - the harness's own timestamp taken immediately before page.goto()
 *   - the extension's telemetry ring buffer (ui/src/telemetry.js), read
 *     straight out of chrome.storage.local rather than through
 *     EXPORT_TELEMETRY (a message the service worker sends to itself is never
 *     delivered back to it)
 *   - the stub Feature D's request log (harnessServer.mjs)
 * Nothing is instrumented specially for this harness: it reads the telemetry
 * the extension already records in production, which is the point — if a
 * field here is missing, the shipped telemetry is missing it too.
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SITES } from "./moodSites.js";
import { startHarnessServer } from "./harnessServer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.join(__dirname, "..", "dist");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--") ? args[idx + 1] : fallback;
};

const HEADED = args.includes("--headed");
const ONLY = flag("only", null);
const REPEATS = parseInt(flag("repeats", "3"), 10);
const OUT = flag("out", null);
/** Simulated Feature D generation time. 0 = instant stub (measures the shell). */
const D_DELAY_MS = parseInt(flag("d-delay", "0"), 10);

/**
 * feature_b/index.js's confidenceWindowMs. Not readable from the harness —
 * configureFeatureB runs inside the bundled service worker and exposes
 * nothing on globalThis — so it is mirrored here and asserted against the
 * observed data below (see `windowLooksWrong`), which is what catches this
 * constant going stale rather than silently skewing every compute_ms.
 */
const CONFIDENCE_WINDOW_MS = 5000;

const SITE_TIMEOUT_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stats ───────────────────────────────────────────────────────────────────

/** Nearest-rank, no interpolation — see the same note in d4_latency.py. */
function percentile(values, p) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(ordered.length - 1, Math.ceil((p / 100) * ordered.length) - 1));
  return ordered[idx];
}

function summarise(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!clean.length) return { n: 0 };
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  return {
    n: clean.length,
    min: Math.round(Math.min(...clean)),
    p50: Math.round(percentile(clean, 50)),
    p95: Math.round(percentile(clean, 95)),
    max: Math.round(Math.max(...clean)),
    mean: Math.round(mean),
  };
}

// ── Service-worker plumbing (same as chromiumExtension.e2e.mjs) ─────────────

async function getServiceWorker(context, timeoutMs = 30_000) {
  const [existing] = context.serviceWorkers();
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: timeoutMs }).catch(() => null);
}

/** The telemetry ring buffer, read directly out of storage. */
async function readTelemetry(context) {
  const worker = await getServiceWorker(context, 10_000);
  if (!worker) return [];
  try {
    return await worker.evaluate(async () => {
      const { w2mTelemetry = [] } = await chrome.storage.local.get("w2mTelemetry");
      return w2mTelemetry;
    });
  } catch {
    return [];
  }
}

async function clearTelemetry(context) {
  const worker = await getServiceWorker(context, 10_000);
  if (!worker) return;
  await worker.evaluate(async () => { await chrome.storage.local.remove("w2mTelemetry"); }).catch(() => {});
}

// ── Behaviour driving ───────────────────────────────────────────────────────
// A trimmed version of the correctness harness's driver: this harness does
// not care which mood comes out, only that a *stable* one does, so every page
// gets the same unremarkable browsing motion. behaviorTracker decays its
// readings 500ms after the last event, so it has to keep running.
async function driveBehaviour(page, control) {
  let x = 120;
  let dir = 1;
  while (!control.stopped) {
    try {
      x += dir * 25;
      if (x > 700 || x < 120) dir = -dir;
      await page.mouse.move(x, 260);
      await page.evaluate(() => window.scrollBy(0, 20));
      await sleep(200);
    } catch {
      return; // page closed under the driver
    }
  }
}

// ── One measured page load ──────────────────────────────────────────────────

/**
 * Derive the stage timeline for one page visit from the three clocks.
 *
 * Every field is null-safe: a page whose mood never commits produces a
 * partial timeline, and a partial timeline is data (it says the pipeline
 * stalled and where), not a crash.
 */
function buildTimeline({ navAt, telemetry, dRequests, sessionStartAt }) {
  const since = (e) => e.ts >= sessionStartAt;
  const events = telemetry.filter(since);

  const extracts = events.filter((e) => e.stage === "A_extract");
  const decisions = events.filter((e) => e.stage === "B_decision" && e.event === "runFeatureB");
  const generates = events.filter((e) => e.stage === "D_generate");
  // "playing" fires once for the fallback clip and again for the swap
  // crossfade (offscreen.entry.js's deck-start path is shared by both). The
  // first occurrence is what a user actually hears first — correct for
  // nav_to_first_audio_ms. But decode_to_audio_ms is specifically about the
  // swap (fetch + decode + crossfade of the REAL clip), so it needs the
  // "playing" event that follows D's response, not whichever came first.
  const playingEvents = events.filter((e) => e.stage === "playback" && e.meta?.state === "playing");
  const playing = playingEvents[0] ?? null;
  const swapPlaying = generates.length
    ? playingEvents.find((e) => e.ts >= generates[0].ts) ?? null
    : null;
  const firstExtract = extracts[0] ?? null;
  const firstGenerateReq = dRequests.find((r) => r.kind === "generate") ?? null;
  const firstFallbackReq = dRequests.find((r) => r.kind === "fallback") ?? null;

  // Feature A's own per-stage telemetry rides along on the A_PAGE_DATA
  // message; totalMs across stages is the extraction cost the content script
  // paid, which is not the same as nav→A_PAGE_DATA (that also contains
  // document_idle and the scheduler's 300ms debounce).
  const extractStages = firstExtract?.meta ?? {};
  const extractSelfMs = Object.values(extractStages)
    .filter((s) => s && typeof s.totalMs === "number")
    .reduce((a, s) => a + s.totalMs, 0) || null;

  // B's decision cost is per-call; a page typically runs several before one
  // commits. Both are reported: the per-call cost is the engineering number,
  // the count explains the wall clock.
  const bMs = decisions.map((d) => d.ms).filter((m) => typeof m === "number");
  const dMs = generates.map((g) => g.ms).filter((m) => typeof m === "number");

  const t = (abs) => (abs == null ? null : Math.round(abs - navAt));

  const timeline = {
    nav_to_first_extract_ms: t(firstExtract?.ts),
    extract_self_ms: extractSelfMs === null ? null : Math.round(extractSelfMs),
    extractions_before_commit: firstGenerateReq
      ? extracts.filter((e) => e.ts <= firstGenerateReq.at).length
      : extracts.length,
    b_decision_ms_p50: bMs.length ? Math.round(percentile(bMs, 50)) : null,
    b_decision_calls: bMs.length,
    nav_to_fallback_request_ms: t(firstFallbackReq?.at),
    nav_to_generate_request_ms: t(firstGenerateReq?.at),
    d_roundtrip_ms: dMs.length ? Math.round(dMs[0]) : null,
    nav_to_first_audio_ms: t(playing?.ts),
  };

  // Decode + crossfade start: from the moment the service worker had a URL to
  // the moment the offscreen document reported the deck running. This is the
  // one stage nothing else in the project measures, and on a cold audio
  // context it is not small.
    if (swapPlaying && generates.length) {
    const generateDoneAt = generates[0].ts;
    timeline.decode_to_audio_ms = Math.round(swapPlaying.ts - generateDoneAt);
  } else {
    timeline.decode_to_audio_ms = null;
  }
  // compute_ms — everything except the deliberate wait. Built additively from
  // the stages rather than by subtracting the window from the wall clock, so
  // it stays meaningful even when the window constant is wrong (and so the
  // two can be compared to notice that it is).
  const parts = [
    timeline.nav_to_first_extract_ms,
    timeline.b_decision_ms_p50,
    timeline.d_roundtrip_ms,
    timeline.decode_to_audio_ms,
  ];
  timeline.compute_ms = parts.every((p) => p != null)
    ? Math.round(parts.reduce((a, b) => a + b, 0))
    : null;

  // Cross-check on CONFIDENCE_WINDOW_MS: the gap between the first extraction
  // and the commit cannot be much less than the window. If it is, the
  // constant above is stale and compute_ms is being compared against the
  // wrong baseline.
  if (timeline.nav_to_generate_request_ms != null && timeline.nav_to_first_extract_ms != null) {
    timeline.observed_window_ms =
      timeline.nav_to_generate_request_ms - timeline.nav_to_first_extract_ms;
    timeline.windowLooksWrong = timeline.observed_window_ms < CONFIDENCE_WINDOW_MS * 0.5;
  }

  return timeline;
}

async function measureSite(context, server, site, iteration) {
  server.reset();
  await clearTelemetry(context);
  const sessionStartAt = Date.now();

  const page = await context.newPage();
  const control = { stopped: false };
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  let navAt = null;
  try {
    navAt = Date.now();
    await page.goto(server.siteUrl(site.name), { waitUntil: "domcontentloaded", timeout: 20_000 });
    const driver = driveBehaviour(page, control);

        // Wait for audio, not just for the D call — the whole point is to include
    // fetch + decode + the crossfade start.
    const deadline = Date.now() + SITE_TIMEOUT_MS;
    let heardAudio = false;
    while (Date.now() < deadline) {
      const telemetry = await readTelemetry(context);
      if (telemetry.some((e) => e.ts >= sessionStartAt && e.stage === "playback" && e.meta?.state === "playing")) {
        heardAudio = true;
        break;
      }
      await sleep(250);
    }

    // Fallback-then-swap means "heard audio" above is almost always the
    // fallback clip, not the real generation — it fires in ~7ms regardless of
    // D_DELAY_MS. If a delay was configured, the swap (D's response,
    // decode, crossfade) hasn't happened yet at this point, and reading
    // telemetry now would silently produce d_roundtrip_ms/decode_to_audio_ms
    // = null for every run, not because nothing happened but because we
    // stopped watching too early. So: if we're simulating a real generation
    // delay, keep polling — past the point where audio was first heard —
    // for the D_generate event specifically, up to a deadline sized to the
    // delay rather than the fixed 60s used for "did we hear anything at all".
    if (D_DELAY_MS > 0) {
      const swapDeadline = Date.now() + D_DELAY_MS + 15_000; // delay + buffer for fetch/decode/crossfade
      while (Date.now() < swapDeadline) {
        const t = await readTelemetry(context);
        if (t.some((e) => e.ts >= sessionStartAt && e.stage === "D_generate")) break;
        await sleep(500);
      }
    }

    const telemetry = await readTelemetry(context);
    control.stopped = true;
    await driver;

    const timeline = buildTimeline({
      navAt,
      telemetry,
      dRequests: [...server.dRequests],
      sessionStartAt,
    });

    return {
      site: site.name,
      iteration,
      heardAudio,
      pageErrors,
      ...timeline,
    };
  } finally {
    control.stopped = true;
    await page.close().catch(() => {});
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────

const METRICS = [
  ["nav_to_first_extract_ms", "nav → A_PAGE_DATA (Feature A + document_idle + debounce)"],
  ["extract_self_ms", "  of which Feature A extraction itself"],
  ["b_decision_ms_p50", "Feature B decision, per call"],
  ["nav_to_fallback_request_ms", "nav → GET /fallback (first sound requested)"],
  ["nav_to_generate_request_ms", "nav → POST /generate (mood committed)"],
  ["d_roundtrip_ms", "Feature D round trip"],
  ["decode_to_audio_ms", "fetch + decode + crossfade start"],
  ["nav_to_first_audio_ms", "nav → audible (WALL CLOCK, incl. confidence window)"],
  ["compute_ms", "sum of compute stages (excl. confidence window)"],
];

function report(rows) {
  const lines = ["", "=".repeat(78), "END-TO-END LATENCY — SUMMARY", "=".repeat(78)];

  const heard = rows.filter((r) => r.heardAudio);
  lines.push(`  ${heard.length}/${rows.length} page loads reached audible playback`);
  if (D_DELAY_MS) lines.push(`  Feature D stub delay: ${D_DELAY_MS} ms (simulated generation)`);
  lines.push("");
  lines.push(`  ${"metric".padEnd(58)}${"p50".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}`);
  lines.push("  " + "-".repeat(76));

  for (const [key, label] of METRICS) {
    const s = summarise(heard.map((r) => r[key]));
    if (!s.n) {
      lines.push(`  ${label.padEnd(58)}${"—".padStart(9)}${"—".padStart(9)}${"—".padStart(9)}`);
      continue;
    }
    lines.push(
      `  ${label.padEnd(58)}${String(s.p50).padStart(9)}${String(s.p95).padStart(9)}${String(s.max).padStart(9)}`
    );
  }

  const extractions = summarise(heard.map((r) => r.extractions_before_commit));
  if (extractions.n) {
    lines.push("");
    lines.push(`  extractions before the mood committed: p50 ${extractions.p50}, max ${extractions.max}`);
  }

  const stale = heard.filter((r) => r.windowLooksWrong);
  if (stale.length) {
    lines.push("");
    lines.push(`  ⚠  ${stale.length} page(s) committed faster than ${CONFIDENCE_WINDOW_MS / 2} ms after the first`);
    lines.push(`     extraction. CONFIDENCE_WINDOW_MS in this file is probably stale — check`);
    lines.push(`     feature_b/index.js before quoting compute_ms anywhere.`);
  }

  const failures = rows.filter((r) => !r.heardAudio);
  if (failures.length) {
    lines.push("");
    lines.push("  page loads that never produced audio:");
    for (const f of failures) {
      lines.push(`    ${f.site} #${f.iteration}: committed=${f.nav_to_generate_request_ms ?? "never"} ` +
        `extracts=${f.extractions_before_commit}${f.pageErrors.length ? ` errors=${f.pageErrors.join("; ")}` : ""}`);
    }
  }

  lines.push("=".repeat(78));
  return lines.join("\n");
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(path.join(EXT_PATH, "manifest.json"))) {
    throw new Error(`No built extension at ${EXT_PATH} — run \`npm run build\` first.`);
  }

  // Silence pages never call Feature D, so they have no latency to measure.
  const sites = (ONLY ? SITES.filter((s) => s.name === ONLY) : SITES).filter((s) => !s.expectSilence);
  if (!sites.length) throw new Error(`no measurable site${ONLY ? ` matching --only=${ONLY}` : ""}`);

  const server = await startHarnessServer({ stubLlm: true, generateDelayMs: D_DELAY_MS });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2m-latency-"));

  console.log(`[latency] extension:  ${EXT_PATH}`);
  console.log(`[latency] origin:     ${server.baseUrl}`);
  console.log(`[latency] classify:   ${server.classifyStubbed ? "stubbed at 503 (tier-1 heuristics)" : "REAL proxy is up — B's LLM tier is in the numbers"}`);
  console.log(`[latency] ${sites.length} site(s) x ${REPEATS} repeat(s), D stub delay ${D_DELAY_MS} ms\n`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
  });

  const rows = [];
  try {
    const worker = await getServiceWorker(context);
    if (!worker) throw new Error("extension service worker never started — is ui/dist a valid unpacked extension?");
    await worker.evaluate(
      async (backendUrl) => { await chrome.storage.local.set({ backendUrl, masterEnabled: true }); },
      `${server.baseUrl}/d`
    );

    // A discarded warm-up load: the very first page of a session also pays
    // the offscreen document's creation, the audio context's first start and
    // the embedding model's ONNX load, none of which recur. Folding that into
    // the reported percentiles would make every stage look worse than it is
    // for all but one page load in a session.
    process.stdout.write("  (warm-up load, discarded) … ");
    await measureSite(context, server, sites[0], -1);
    console.log("done\n");

    for (let i = 0; i < REPEATS; i++) {
      for (const site of sites) {
        process.stdout.write(`  ${site.name} #${i} … `);
        const row = await measureSite(context, server, site, i);
        rows.push(row);
        console.log(
          row.heardAudio
            ? `${row.nav_to_first_audio_ms} ms wall / ${row.compute_ms ?? "?"} ms compute`
            : "NO AUDIO"
        );
      }
    }
  } finally {
    await context.close().catch(() => {});
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const summary = report(rows);
  console.log(summary);

  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(
      path.resolve(OUT),
      JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          config: { repeats: REPEATS, dDelayMs: D_DELAY_MS, confidenceWindowMs: CONFIDENCE_WINDOW_MS, sites: sites.map((s) => s.name) },
          rows,
        },
        null,
        2
      )
    );
    console.log(`\nWrote ${path.resolve(OUT)}`);
  }

  // A latency harness must not fail a build on a slow machine — the only
  // failure condition is not being able to measure at all.
  const heard = rows.filter((r) => r.heardAudio).length;
  if (heard === 0) {
    console.error("\nNo page produced audio — nothing was measured.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
