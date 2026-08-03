/**
 * chromiumExtension.e2e.mjs — browses a corpus of mood-varied pages in a real
 * Chromium with the unpacked extension loaded, and asserts what Feature B
 * decided and handed to Feature D on each one.
 *
 * Run:  npm run test:e2e
 *       npm run test:e2e -- --headed
 *       npm run test:e2e -- --only=tense_border_standoff
 *
 * ── Why Playwright's bundled Chromium ──────────────────────────────────────
 * --load-extension was removed from Chrome stable at 137, and 150 dropped the
 * enterprise bypass that kept it working, so an installed Chrome can no longer
 * host an unpacked extension from the command line. Playwright ships its own
 * Chromium build that still accepts it. `channel: "chromium"` matters too: the
 * plain headless default resolves to chromium_headless_shell, which has no
 * extension support at all — this launches the full browser in new-headless
 * mode instead.
 *
 * ── What is actually asserted ──────────────────────────────────────────────
 * The whole chain runs for real: content script → Feature A extraction in a
 * real renderer (Readability, colour sampling, and behaviorTracker fed by
 * genuine wheel and mouse input) → A_PAGE_DATA → Feature B → featureDClient.
 * Only the two network edges are stubbed, both by harnessServer.mjs — see its
 * header for why the classify proxy is held down rather than reconfigured.
 *
 * Each page is checked on two independent signals:
 *   - the POST /generate body recorded by the D stub (what B handed onward), and
 *   - fb_tab_<tabId>.currentMood in chrome.storage.session (what B committed),
 * which is also the only signal available for the sensitive page, since a
 * silent handoff never reaches Feature D at all.
 *
 * Feature B only commits a mood after it has held steady for 5s
 * (confidenceWindowMs), which takes at least two extractions — each page
 * self-triggers those via the heartbeat node described in moodSites.js.
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SITES, BEHAVIOURS } from "./moodSites.js";
import { startHarnessServer } from "./harnessServer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.join(__dirname, "..", "dist");

const args = process.argv.slice(2);
const HEADED = args.includes("--headed") || process.env.W2M_E2E_HEADED === "1";
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").split("=")[1] || null;
const USE_REAL_LLM = process.env.W2M_E2E_LLM === "proxy";

/** Per-page budget. B needs >5s of stable mood plus two extractions to commit. */
const SITE_TIMEOUT_MS = 45_000;
/** How long a silence page is watched to prove Feature D is never called. */
const SILENCE_OBSERVE_MS = 25_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Behaviour driving ───────────────────────────────────────────────────────
// behaviorTracker.js decays its readings 500ms after the last event, so these
// have to keep running right up to the moment an extraction snapshots them —
// hence a concurrent loop for as long as the page is open rather than a burst
// up front. Thresholds are behaviourMoodBias's: >800 px/s scroll → tense, <100
// (and >0) → focused/calm, >600 px/s cursor → energetic.
async function driveBehaviour(page, kind, control) {
  let x = 120;
  let dir = 1;

  const scrollBy = (step) =>
    page.evaluate((s) => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.__w2mDir = window.__w2mDir || 1;
      let next = window.scrollY + s * window.__w2mDir;
      if (next >= max) { next = max; window.__w2mDir = -1; }
      if (next <= 0) { next = 0; window.__w2mDir = 1; }
      window.scrollTo(0, next);
    }, step);

  while (!control.stopped) {
    try {
      switch (kind) {
        case BEHAVIOURS.SLOW_READ: // ~75 px/s — under the 100 px/s "reading" cutoff
          await scrollBy(15);
          await sleep(200);
          break;
        case BEHAVIOURS.FAST_SCROLL: // ~2000 px/s — well over the 800 px/s cutoff
          await scrollBy(200);
          await sleep(100);
          break;
        case BEHAVIOURS.FAST_CURSOR: // ~1200 px/s — over the 600 px/s cutoff
          x += dir * 120;
          if (x > 900 || x < 120) dir = -dir;
          await page.mouse.move(x, 300 + (x % 80));
          await sleep(100);
          break;
        case BEHAVIOURS.BROWSE: // unremarkable: under every bias threshold
          x += dir * 25;
          if (x > 700 || x < 120) dir = -dir;
          await page.mouse.move(x, 260);
          await scrollBy(20);
          await sleep(200);
          break;
        default: // BEHAVIOURS.STILL — touch nothing, let the readings decay to 0
          await sleep(250);
      }
    } catch {
      return; // page closed out from under the driver — expected at teardown
    }
  }
}

// ── Service-worker plumbing ─────────────────────────────────────────────────
async function getServiceWorker(context, timeoutMs = 30_000) {
  const [existing] = context.serviceWorkers();
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: timeoutMs }).catch(() => null);
}

/**
 * readTabStates — every fb_tab_* record Feature B has written this session.
 *
 * tabState.js keys chrome.storage.session by tabId, and background.js passes
 * the real sender tab id, so this is B's own committed view of each tab. Must
 * be read before the page closes: chrome.tabs.onRemoved clears the record.
 */
async function readTabStates(context) {
  const worker = await getServiceWorker(context, 10_000);
  if (!worker) return {};
  try {
    return await worker.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith("fb_tab_")));
    });
  } catch {
    return {};
  }
}

/** The single tab record present during a one-tab-at-a-time run. */
function soleTabState(states) {
  const values = Object.values(states);
  return values.length === 1 ? values[0] : values.find((v) => v.currentMood) ?? null;
}

// ── One page ────────────────────────────────────────────────────────────────
async function runSite(context, server, site) {
  server.reset();

  // A fresh tab per site: chrome.tabs.onRemoved clears that tab's Feature B
  // state, so no page inherits a previous page's mood or confidence window and
  // the corpus can be reordered or filtered freely.
  const page = await context.newPage();
  const control = { stopped: false };
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const result = {
    site: site.name,
    expected: site.expectSilence ? "silence" : site.expectedMood,
    actual: null,
    committed: null,
    notes: [],
    pass: false,
  };

  /**
   * Diagnostics from B2's own output, which tabState persists verbatim as
   * lastRecord.moodContext. The Feature D profile carries neither the raw
   * behaviour readings nor the tier, and without them a page that fails
   * because the wheel input never landed is indistinguishable from one that
   * fails on its wording.
   */
  const noteDiagnostics = (state) => {
    const ctx = state?.lastRecord?.kind === "mood" ? state.lastRecord.moodContext : null;
    if (!ctx) return;
    result.observedScroll = ctx.scrollSpeed;
    result.observedCursor = ctx.cursorSpeed;
    result.tier = ctx.tier;
    result.confidence = ctx.confidence;
  };

  try {
    await page.goto(server.siteUrl(site.name), { waitUntil: "domcontentloaded", timeout: 20_000 });
    const driver = driveBehaviour(page, site.behaviour, control);

    if (site.expectSilence) {
      // The assertion here is an absence, so there is nothing to wait *for* —
      // watch the full window and require that B committed a decision while D
      // was never called.
      await sleep(SILENCE_OBSERVE_MS);
      const committed = soleTabState(await readTabStates(context));
      control.stopped = true;
      await driver;

      result.committed = committed?.currentMood ?? null;
      noteDiagnostics(committed);
      result.actual = server.dRequests.length === 0 ? "silence" : `d-called:${server.dRequests.map((r) => r.mood).join(",")}`;

      if (!committed?.currentMood) {
        result.notes.push(`Feature B committed no mood within ${SILENCE_OBSERVE_MS}ms (pending: ${committed?.pendingMood ?? "none"})`);
      } else if (committed.currentMood !== "silence") {
        result.notes.push(`sensitive page classified as "${committed.currentMood}" — B1's sensitive detector did not fire`);
      } else if (server.dRequests.length > 0) {
        result.notes.push(
          `sensitive page must not call Feature D, but it did: ${JSON.stringify(server.dRequests.map((r) => ({ kind: r.kind, mood: r.mood })))}`
        );
      } else {
        result.pass = true;
      }
    } else {
      const generate = await waitForGenerate(server, SITE_TIMEOUT_MS);
      const committed = soleTabState(await readTabStates(context));
      control.stopped = true;
      await driver;

      result.committed = committed?.currentMood ?? null;
      noteDiagnostics(committed);

      if (!generate) {
        result.actual = "(no Feature D request)";
        result.notes.push(
          `no POST /generate within ${SITE_TIMEOUT_MS}ms; B's committed mood was ${result.committed ?? "none"}` +
          ` (pending: ${committed?.pendingMood ?? "none"})`
        );
      } else {
        result.actual = generate.mood;
        result.pass = generate.mood === site.expectedMood;

        const fallback = server.dRequests.find((r) => r.kind === "fallback");
        if (fallback && fallback.mood !== generate.mood) {
          result.notes.push(`GET /fallback asked for "${fallback.mood}" but POST /generate sent "${generate.mood}"`);
        }
        if (result.committed && result.committed !== generate.mood) {
          result.notes.push(`storage.session committed "${result.committed}" but D was sent "${generate.mood}"`);
        }
        if (!result.pass) {
          result.notes.push(`prompt: ${String(generate.profile?.prompt ?? "").slice(0, 140)}`);
        }
      }
    }

    if (pageErrors.length) result.notes.push(`page errors: ${pageErrors.join("; ")}`);
  } finally {
    control.stopped = true;
    await page.close().catch(() => {});
  }

  return result;
}

async function waitForGenerate(server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = server.dRequests.find((r) => r.kind === "generate");
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

// ── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(path.join(EXT_PATH, "manifest.json"))) {
    throw new Error(`No built extension at ${EXT_PATH} — run \`npm run build\` first.`);
  }

  const sites = ONLY ? SITES.filter((s) => s.name === ONLY) : SITES;
  if (sites.length === 0) throw new Error(`--only=${ONLY} matched no site in moodSites.js`);

  const server = await startHarnessServer({ stubLlm: !USE_REAL_LLM });
  const advisory = !server.classifyStubbed;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2m-e2e-"));

  console.log(`[e2e] extension:      ${EXT_PATH}`);
  console.log(`[e2e] harness origin: ${server.baseUrl}`);
  console.log(
    `[e2e] classify proxy: ` +
      (server.classifyStubbed
        ? "held down at 503 on :8078 → deterministic tier-1 heuristics"
        : USE_REAL_LLM
          ? "real proxy (W2M_E2E_LLM=proxy) — mood expectations advisory"
          : ":8078 already in use, so the real proxy is answering — mood expectations advisory")
  );
  console.log(`[e2e] browsing ${sites.length} page${sites.length === 1 ? "" : "s"}\n`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    // Full Chromium, not chromium_headless_shell — the shell cannot load
    // extensions. See the header note on --load-extension and Chrome 137+.
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

  const results = [];
  try {
    const worker = await getServiceWorker(context);
    if (!worker) throw new Error("extension service worker never started — is ui/dist a valid unpacked extension?");

    // featureDClient re-reads backendUrl from storage.local on every request,
    // so this takes effect immediately — no extension restart required (and
    // none is possible; see harnessServer.mjs's header).
    await worker.evaluate(
      async (backendUrl) => {
        await chrome.storage.local.set({ backendUrl, masterEnabled: true });
      },
      `${server.baseUrl}/d`
    );

    for (const site of sites) {
      process.stdout.write(`  ${site.name} … `);
      const result = await runSite(context, server, site);
      results.push(result);
      console.log(
        result.pass ? `ok (${result.actual})` : `FAIL — expected ${result.expected}, got ${result.actual}`
      );
      for (const note of result.notes) console.log(`      ${note}`);
    }
  } finally {
    await context.close().catch(() => {});
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n  page                            expected     sent to D    committed    scroll  cursor  tier");
  console.log("  " + "─".repeat(96));
  for (const r of results) {
    console.log(
      "  " +
        r.site.padEnd(32) +
        String(r.expected).padEnd(13) +
        String(r.actual ?? "—").padEnd(13) +
        String(r.committed ?? "—").padEnd(13) +
        String(Math.round(r.observedScroll ?? 0)).padStart(6) +
        String(Math.round(r.observedCursor ?? 0)).padStart(8) +
        "  " + String(r.tier ?? "—").padEnd(16) +
        (r.pass ? "" : "<-- FAIL")
    );
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} pages classified as expected.`);

  if (failed.length && advisory) {
    console.log(
      "\n  A live classify proxy answered instead of the stub, and an LLM is entitled to\n" +
      "  disagree with the keyword tier — reporting these rather than failing. Stop the\n" +
      "  proxy on :8078 (or unset W2M_E2E_LLM) for an assertable run."
    );
    return;
  }
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n[e2e] harness error:", err);
  process.exitCode = 1;
});
