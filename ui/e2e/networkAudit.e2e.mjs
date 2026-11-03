/**
 * networkAudit.e2e.mjs — S-H: what actually leaves the browser? (C-7, R4 #7)
 *
 * Run:  npm run test:network-audit -- --mode=a6  --out results/network-audit-a6.json
 *       npm run test:network-audit -- --mode=a6b --real-classify --out results/network-audit-a6b.json
 *       npm run test:network-audit -- --mode=a6 --d-url=http://127.0.0.1:8000
 *
 * Every request issued by the service worker, the offscreen document, the
 * content scripts and the pages themselves is recorded through Playwright's
 * context-level network events (service-worker traffic is enabled explicitly
 * below). Each request is then classified:
 *
 *   destination   page | feature-d | classify-proxy | external
 *   carries_page_text   any run of 6 consecutive words of the page's visible
 *                       text occurs in the URL or body of the request
 *   profile_only        a /generate body whose keys are all in PROFILE_KEYS
 *
 * and four assertions from the revision plan are evaluated:
 *   1. a6   no request body contains page text
 *   2. a6b  page text leaves only for escalated pages, and only to the
 *           classify proxy; the observed off-device rate is reported so it can
 *           be compared with the replayed rate from the cascade study
 *   3. no telemetry leaves the browser (telemetry markers never appear in a body)
 *   4. requests to the generation service carry the music profile and nothing else
 *
 * The harness never fails a run on a violated assertion by itself: it writes
 * the full evidence to --out and exits non-zero, so the table in the paper is
 * generated from the same file the verdict is.
 */

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

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

const MODE = flag("mode", "a6"); // a6 | a6b
const REAL_CLASSIFY = args.includes("--real-classify") || MODE === "a6b";
const D_URL = flag("d-url", null);
const REPEATS = parseInt(flag("repeats", "1"), 10);
const DWELL_MS = parseInt(flag("dwell", "12000"), 10);
const OUT = flag("out", null);
const HEADED = args.includes("--headed");

/** Everything a /generate body may carry: the music profile (feature_d models.py). */
const PROFILE_KEYS = new Set([
  "mood", "bpm", "key", "energy", "style", "content_category", "valence", "arousal", "intensity",
  "reverb", "ambience", "timbre", "instruments", "dynamics", "atmosphere_tags", "listening_context",
  "time_of_day", "sensitive_override", "nonce", "seed_override", "duration_seconds", "prompt", "tempo",
]);
const TELEMETRY_MARKERS = ["w2mTelemetry", "urlHash", "sessionId", "A_extract", "B_decision"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Page text → 6-word shingles ─────────────────────────────────────────────

const words = (text) => text.toLowerCase().replace(/<[^>]+>/g, " ").match(/[a-z0-9']+/g) ?? [];

function shingles(text, n = 6) {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

function pageTextOf(site) {
  return [site.title, site.description, site.heading, ...(site.paragraphs ?? []), site.footer].join(" ");
}

/** True when any shingle of the page text occurs in the (normalised) haystack. */
function carriesPageText(haystack, pageShingles) {
  if (!haystack) return false;
  const hw = words(decodeURIComponentSafe(haystack));
  for (let i = 0; i + 6 <= hw.length; i++) {
    if (pageShingles.has(hw.slice(i, i + 6).join(" "))) return true;
  }
  return false;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── Recording ───────────────────────────────────────────────────────────────

function classifyDestination(url, server) {
  const u = new URL(url);
  if (u.origin === new URL(server.baseUrl).origin) return u.pathname.startsWith("/d/") ? "feature-d" : "page";
  if (D_URL && u.origin === new URL(D_URL).origin) return "feature-d";
  if (u.port === "8078") return "classify-proxy";
  if (u.protocol === "chrome-extension:") return "extension-internal";
  return "external";
}

function attachRecorder(context, sink) {
  context.on("request", (req) => {
    let body = null;
    try { body = req.postData(); } catch { /* binary or absent */ }
    let size = 0;
    try { size = req.postDataBuffer()?.length ?? 0; } catch { /* ignore */ }
    let origin = "page";
    try { if (req.serviceWorker()) origin = "service-worker"; } catch { /* older Playwright */ }
    sink.push({ at: Date.now(), method: req.method(), url: req.url(), resourceType: req.resourceType(), origin, body, bodyBytes: size });
  });
}

async function getServiceWorker(context, timeoutMs = 30_000) {
  const [existing] = context.serviceWorkers();
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: timeoutMs }).catch(() => null);
}

// ── One visit ───────────────────────────────────────────────────────────────

async function visit(context, server, site, sink) {
  const startIdx = sink.length;
  const page = await context.newPage();
  const control = { stopped: false };
  (async () => {
    let x = 120, dir = 1;
    while (!control.stopped) {
      try { x += dir * 25; if (x > 700 || x < 120) dir = -dir; await page.mouse.move(x, 260); await page.evaluate(() => window.scrollBy(0, 20)); } catch { return; }
      await sleep(200);
    }
  })();
  try {
    await page.goto(server.siteUrl(site.name), { waitUntil: "domcontentloaded", timeout: 20_000 });
    await sleep(DWELL_MS);
  } finally {
    control.stopped = true;
    await page.close().catch(() => {});
  }
  return sink.slice(startIdx);
}

// ── Analysis ────────────────────────────────────────────────────────────────

function analyseVisit(site, requests, server) {
  const shin = shingles(pageTextOf(site));
  const rows = requests
    .filter((r) => !/\/sites\/.+\.html$/.test(new URL(r.url).pathname) && !r.url.startsWith("data:") && !r.url.startsWith("blob:"))
    .map((r) => {
      const dest = classifyDestination(r.url, server);
      const text = carriesPageText(`${r.url} ${r.body ?? ""}`, shin);
      const telemetry = TELEMETRY_MARKERS.some((m) => (r.body ?? "").includes(m) || r.url.includes(m));
      let profileOnly = null;
      let bodyKeys = null;
      if (dest === "feature-d" && r.method === "POST") {
        try {
          const parsed = JSON.parse(r.body ?? "{}");
          bodyKeys = Object.keys(parsed);
          profileOnly = bodyKeys.every((k) => PROFILE_KEYS.has(k));
        } catch { profileOnly = false; }
      }
      return { method: r.method, url: r.url, destination: dest, origin: r.origin, bodyBytes: r.bodyBytes, carriesPageText: text, carriesTelemetry: telemetry, profileOnly, bodyKeys };
    });
  const classifyHits = rows.filter((r) => r.destination === "classify-proxy");
  return {
    site: site.name,
    expectSilence: !!site.expectSilence,
    requests: rows,
    escalatedOffDevice: classifyHits.some((r) => r.carriesPageText),
    classifyRequests: classifyHits.length,
  };
}

function verdicts(visits) {
  const all = visits.flatMap((v) => v.requests);
  const nonClassifyWithText = all.filter((r) => r.carriesPageText && r.destination !== "classify-proxy");
  const anyText = all.filter((r) => r.carriesPageText);
  const telemetry = all.filter((r) => r.carriesTelemetry);
  const generate = all.filter((r) => r.destination === "feature-d" && r.method === "POST");
  const nonProfile = generate.filter((r) => r.profileOnly === false);
  const external = all.filter((r) => r.destination === "external");
  const escalated = visits.filter((v) => v.escalatedOffDevice).length;
  return {
    mode: MODE,
    a1_no_page_text_in_any_body_when_a6: MODE === "a6" ? anyText.length === 0 : null,
    a2_page_text_only_to_classify_proxy_when_a6b: MODE === "a6b" ? nonClassifyWithText.length === 0 : null,
    a3_no_telemetry_leaves: telemetry.length === 0,
    a4_generate_bodies_are_profile_only: nonProfile.length === 0,
    offending: {
      pageTextOutsideClassify: nonClassifyWithText.map((r) => r.url),
      pageTextAnywhere: MODE === "a6" ? anyText.map((r) => r.url) : undefined,
      telemetry: telemetry.map((r) => r.url),
      nonProfileGenerate: nonProfile.map((r) => ({ url: r.url, keys: r.bodyKeys })),
    },
    external_hosts: [...new Set(external.map((r) => new URL(r.url).host))],
    off_device_rate: visits.length ? escalated / visits.length : null,
    pages_escalated: escalated,
    pages: visits.length,
  };
}

function bytesByDestination(visits) {
  const out = {};
  for (const v of visits) {
    for (const r of v.requests) out[r.destination] = (out[r.destination] ?? 0) + r.bodyBytes;
  }
  const pages = visits.length || 1;
  return Object.fromEntries(Object.entries(out).map(([k, b]) => [k, { totalBytes: b, bytesPerPage: Math.round(b / pages) }]));
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(path.join(EXT_PATH, "manifest.json"))) {
    throw new Error(`No built extension at ${EXT_PATH} — run \`npm run build\` first.`);
  }
  const sites = SITES;
  const server = await startHarnessServer({ stubLlm: !REAL_CLASSIFY, generateDelayMs: 0 });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2m-netaudit-"));
  console.log(`[network-audit] mode=${MODE} classify=${server.classifyStubbed ? "stubbed (503)" : "REAL proxy"} d=${D_URL ?? "harness stub"} sites=${sites.length} x ${REPEATS}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });

  const sink = [];
  attachRecorder(context, sink);
  const visits = [];
  try {
    const worker = await getServiceWorker(context);
    if (!worker) throw new Error("extension service worker never started");
    await worker.evaluate(async (backendUrl) => { await chrome.storage.local.set({ backendUrl, masterEnabled: true }); },
      D_URL ? D_URL.replace(/\/$/, "") : `${server.baseUrl}/d`);
    // Since C-1 the on-device zero-shot middle stage is the shipped default. A6 is the configuration
    // with the LLM stage switched off (llmEnabled: false): the extension then makes no LLM request
    // at all, which is what the "no page text leaves the device" check needs. A6b leaves it on and
    // points it at the real classify proxy.
    if (!REAL_CLASSIFY) {
      await worker.evaluate(async () => { await chrome.storage.sync.set({ llmEnabled: false }); });
      await sleep(500);
    }

    for (let i = 0; i < REPEATS; i++) {
      for (const site of sites) {
        process.stdout.write(`  ${site.name} #${i} … `);
        const reqs = await visit(context, server, site, sink);
        const v = analyseVisit(site, reqs, server);
        visits.push(v);
        console.log(`${v.requests.length} requests, classify=${v.classifyRequests}, off-device=${v.escalatedOffDevice}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const verdict = verdicts(visits);
  const result = {
    startedAt: new Date().toISOString(),
    manifest: { node: process.version, platform: `${os.platform()} ${os.release()}` },
    config: { mode: MODE, realClassify: REAL_CLASSIFY && !server.classifyStubbed, dUrl: D_URL, repeats: REPEATS, dwellMs: DWELL_MS },
    verdict,
    bytes_by_destination: bytesByDestination(visits),
    visits,
  };
  console.log("\n" + JSON.stringify({ verdict: result.verdict, bytes_by_destination: result.bytes_by_destination }, null, 2));

  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), JSON.stringify(result, null, 2));
    console.log(`\nWrote ${path.resolve(OUT)}`);
  }

  const failed = [verdict.a1_no_page_text_in_any_body_when_a6, verdict.a2_page_text_only_to_classify_proxy_when_a6b,
    verdict.a3_no_telemetry_leaves, verdict.a4_generate_bodies_are_profile_only].some((v) => v === false);
  if (failed) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
