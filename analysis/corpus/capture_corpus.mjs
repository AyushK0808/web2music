#!/usr/bin/env node
/**
 * C-04 — freeze the S2 corpus: drive the real extension over a URL list and
 * store what Feature A actually extracted.
 *
 *   node analysis/corpus/capture_corpus.mjs --urls analysis/corpus/urls.jsonl \
 *        --out analysis/corpus/s2_corpus.json
 *   node analysis/corpus/capture_corpus.mjs --urls ... --limit 5 --headed
 *   node analysis/corpus/capture_corpus.mjs --self-test     # no network, proves the harness
 *
 * The plan is emphatic and correct: **store extracted pageData, not live
 * URLs.** Live pages change under you and destroy replication, and a reviewer
 * re-running this in six months against the same URL list gets a different
 * corpus and different numbers. So each page is captured once, content-hashed,
 * and never fetched again.
 *
 * It drives the *real* extension rather than calling the extraction functions
 * directly, because Feature A's output depends on a live DOM, forced layout,
 * and colour sampling — none of which exist outside a browser. That is also
 * the setup that caught the syllableCounter.js load-order bug, so a capture
 * path that bypassed the manifest would be capturing a system nobody ships.
 *
 * Reuses ui/e2e's Chromium setup rather than writing a second driver.
 *
 * ── Slices ─────────────────────────────────────────────────────────────────
 * Every URL carries a `slice` tag, and §3 S2's five adversarial slices are
 * required by construction: the run refuses to declare a corpus complete
 * without them, because a corpus that is only easy pages measures nothing the
 * paper claims.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const EXT_PATH = path.join(REPO, 'ui', 'dist');

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const HEADED = args.includes('--headed');
const SELF_TEST = args.includes('--self-test');
const URLS = flag('urls', 'analysis/corpus/urls.jsonl');
const OUT = flag('out', 'analysis/corpus/s2_corpus.json');
const LIMIT = parseInt(flag('limit', '0'), 10);
const PAGE_TIMEOUT_MS = parseInt(flag('timeout', '45000'), 10);
const SETTLE_MS = parseInt(flag('settle', '3500'), 10);

/** §3 S2's adversarial slices. A corpus without all of these is not the corpus. */
export const REQUIRED_SLICES = [
  'vocabulary-mismatch',   // a gut-microbiome article with no Health keyword in it
  'non-english',           // the keyword tier is skipped by construction
  'mixed-genre',           // a recipe blog post that is mostly a personal essay
  'sensitive',             // crisis content
  'sensitive-near-miss',   // "The Great Depression", "grief counselling degree programs"
  'bypass',                // payment/checkout and chrome:// pages
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The content hash that freezes a page. Deliberately over the *extracted*
 * fields rather than over the raw HTML: two captures of the same article with
 * a different ad rotation should be the same corpus entry, and two captures
 * where the extractor changed its mind should not.
 */
/** Feature A's text field, whichever name this handoff version uses. */
export const pageText = (pd) => pd?.rawText ?? pd?.text ?? pd?.content ?? '';

export function contentHash(pageData) {
  const canonical = JSON.stringify({
    text: pageText(pageData),
    title: pageData?.title ?? '',
    description: pageData?.description ?? '',
    lang: pageData?.lang ?? '',
    colors: pageData?.colors ?? null,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Strip the fields that are about *this capture* rather than about the page.
 *
 * Two groups, and the second is the one that would have been easy to miss:
 *
 * - **behaviour** (scrollSpeed, cursorSpeed, dwellTime) is a property of the
 *   person browsing. Freezing one capture session's mouse movements into the
 *   corpus would make the signal ablation (C-08) measure the capture operator.
 * - **vector-store state** (isRevisit, nearestScore, similarPages) depends on
 *   what was captured *before* this page in the same run. Keep it and the
 *   corpus stops being order-independent: re-running the capture with the URL
 *   list shuffled would produce different records for identical pages.
 *
 * Both are preserved under `_capture_context` rather than deleted, because
 * "the extractor emitted this and we chose not to freeze it" is a fact worth
 * being able to check later.
 */
export function normalisePageData(pageData) {
  if (!pageData || typeof pageData !== 'object') return null;
  const {
    scrollSpeed, cursorSpeed, dwellTime, timestamp, capturedAt,
    isRevisit, nearestScore, similarPages,
    ...stable
  } = pageData;
  return {
    ...stable,
    _capture_context: {
      behaviour: { scrollSpeed, cursorSpeed, dwellTime },
      vector_store: { isRevisit, nearestScore, similarPages },
    },
  };
}

export function readUrlList(file) {
  const text = fs.readFileSync(file, 'utf8');
  const entries = [];
  for (const [i, line] of text.split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      throw new Error(`${file}:${i + 1} is not valid JSON: ${t.slice(0, 80)}`);
    }
    if (!rec.url || !rec.id) throw new Error(`${file}:${i + 1} needs both "id" and "url"`);
    entries.push({ slice: 'general', ...rec });
  }
  return entries;
}

/**
 * What happened on this page, as a fact rather than a pass/fail.
 *
 * "No extraction on a chrome:// URL" is the bypass policy working exactly as
 * designed, and counting it as a capture failure would put a green tick on the
 * wrong thing and a red cross on a correct one. "No extraction on an article"
 * is a real failure. The two must not share a bucket.
 */
export function classifyOutcome(entry, pageData, error) {
  const isBrowserInternal = /^chrome(-extension)?:\/\//i.test(entry.url || '');
  if (isBrowserInternal) {
    return pageData ? 'BYPASS VIOLATED — extracted from a browser-internal page'
                    : 'bypassed (expected)';
  }
  if (error) return 'navigation failed';
  if (!pageData) return 'no extraction';
  const chars = pageText(pageData).length;
  if (chars === 0) return 'extracted, empty text';
  if (chars < 200) return 'extracted, thin';
  return 'captured';
}

export function auditSlices(entries) {
  const counts = {};
  for (const e of entries) counts[e.slice] = (counts[e.slice] || 0) + 1;
  const missing = REQUIRED_SLICES.filter((s) => !counts[s]);
  const byCategory = {};
  for (const e of entries) {
    if (e.true_category) byCategory[e.true_category] = (byCategory[e.true_category] || 0) + 1;
  }
  return { counts, missing, byCategory, n: entries.length };
}

// ── Capture ───────────────────────────────────────────────────────────────

async function getServiceWorker(context, timeoutMs = 30_000) {
  const [existing] = context.serviceWorkers();
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: timeoutMs }).catch(() => null);
}

/**
 * Tap the A→B handoff in the service worker. A second onMessage listener does
 * not disturb the first — the extension's own handler still runs — so the
 * extraction being captured is the extraction that would have happened.
 */
async function installTap(worker) {
  await worker.evaluate(() => {
    if (globalThis.__w2mCaptured) return;
    globalThis.__w2mCaptured = [];
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg?.type === 'A_PAGE_DATA') {
        globalThis.__w2mCaptured.push({
          at: Date.now(),
          tabId: sender?.tab?.id ?? null,
          pageData: msg.pageData,
          telemetry: msg.telemetry,
        });
      }
      return false; // do not claim the message
    });
  });
}

/**
 * Wait until an extraction has arrived and then stopped arriving.
 *
 * Returns rather than throwing on timeout: a page that never extracts is
 * data — it tells you Feature A found nothing on it — and the outcome
 * classifier records that distinctly from a navigation failure.
 */
async function waitForExtraction(worker, { timeoutMs = 12_000, quietMs = 1200, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const n = await worker.evaluate(() => (globalThis.__w2mCaptured || []).length).catch(() => seen);
    if (n !== seen) {
      seen = n;
      lastChange = Date.now();
    }
    if (seen > 0 && Date.now() - lastChange >= quietMs) return seen;
    await sleep(pollMs);
  }
  return seen;
}

async function drainTap(worker) {
  return worker.evaluate(() => {
    const out = globalThis.__w2mCaptured || [];
    globalThis.__w2mCaptured = [];
    return out;
  });
}

async function capture(entries) {
  if (!fs.existsSync(EXT_PATH)) {
    throw new Error(`${EXT_PATH} does not exist — run "npm run build" first.`);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-corpus-'));
  const context = await chromium.launchPersistentContext(profile, {
    // Full Chromium, not chromium_headless_shell — the shell cannot load
    // extensions at all. Same constraint the e2e harnesses run under.
    channel: 'chromium',
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--mute-audio',
    ],
  });

  const results = [];
  try {
    const worker = await getServiceWorker(context);
    if (!worker) throw new Error('extension service worker never started');
    await installTap(worker);

    for (const [i, entry] of entries.entries()) {
      const page = await context.newPage();
      const started = Date.now();
      let error = null;
      try {
        await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        // Poll for the extraction rather than sleeping a fixed interval.
        //
        // A fixed settle was the first version and it was flaky in exactly the
        // way that matters: the same page captured 125 chars on one run and
        // nothing on the next, because Feature A debounces 300 ms and then
        // waits on the embedding worker, whose latency depends on what else
        // the machine is doing. Over 600 pages a flaky settle does not produce
        // 600 captures with a few gaps — it produces a corpus whose failures
        // correlate with machine load, which is a bias, not noise.
        //
        // The extra `quiet` wait after the first extraction is for SPA routes
        // and late-loading content: extraction re-fires, and the last one is
        // the state a reader would have been looking at.
        await waitForExtraction(worker, { timeoutMs: SETTLE_MS + 8000, quietMs: 1200 });
      } catch (e) {
        error = e.message;
      }

      const captured = (await drainTap(worker)).filter((c) => c.pageData);
      await page.close().catch(() => {});

      // Last extraction wins: SPA routes and late-loading content re-fire, and
      // the final state is the one a reader would have been looking at.
      const last = captured[captured.length - 1] || null;
      const pageData = last ? normalisePageData(last.pageData) : null;

      results.push({
        ...entry,
        captured_at: new Date().toISOString(),
        capture_ms: Date.now() - started,
        n_extractions: captured.length,
        error,
        outcome: classifyOutcome(entry, pageData, error),
        content_hash: pageData ? contentHash(last.pageData) : null,
        text_chars: pageText(pageData).length,
        word_count: pageData?.wordCount ?? null,
        extraction_telemetry: last?.telemetry ?? null,
        pageData,
      });

      const r = results[results.length - 1];
      process.stdout.write(
        `  [${String(i + 1).padStart(3)}/${entries.length}] ${entry.id.padEnd(30).slice(0, 30)} `
        + `${String(r.text_chars).padStart(6)} chars  ${r.slice.padEnd(20)} ${r.outcome}`
        + `${r.error ? ` — ${r.error.slice(0, 40)}` : ''}\n`,
      );
    }
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return results;
}

// ── Self-test: proves the freezing logic without touching the network ─────
function selfTest() {
  let ok = true;
  const check = (name, cond) => { ok = ok && cond; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); };

  const a = { text: 'hello world', title: 'T', description: 'D', lang: 'en', colors: { dominant: '#fff' } };
  const b = { ...a, scrollSpeed: 12, cursorSpeed: 3 };
  check('content hash ignores behaviour signals', contentHash(a) === contentHash(b));
  check('content hash changes when text changes',
    contentHash(a) !== contentHash({ ...a, text: 'hello worlds' }));

  const norm = normalisePageData({ ...b, isRevisit: true, nearestScore: 0.9, similarPages: ['x'] });
  check('normalisation drops behaviour from the stored record',
    norm.scrollSpeed === undefined && norm._capture_context.behaviour.scrollSpeed === 12);
  check('normalisation drops vector-store state, so capture order cannot leak in',
    norm.isRevisit === undefined && norm.similarPages === undefined
    && norm._capture_context.vector_store.isRevisit === true);
  check('rawText is the field Feature A actually emits',
    pageText({ rawText: 'abc' }) === 'abc' && pageText({ text: 'de' }) === 'de');

  check('a chrome:// page with no extraction is the policy working, not a failure',
    classifyOutcome({ url: 'chrome://settings/' }, null, null) === 'bypassed (expected)');
  check('a chrome:// page that DID extract is flagged as a policy violation',
    classifyOutcome({ url: 'chrome://settings/' }, { rawText: 'x' }, null).startsWith('BYPASS VIOLATED'));
  check('an article with no extraction is a failure',
    classifyOutcome({ url: 'https://e.com/a' }, null, null) === 'no extraction');
  check('a thin extraction is distinguished from a good one',
    classifyOutcome({ url: 'https://e.com/a' }, { rawText: 'x'.repeat(50) }, null) === 'extracted, thin'
    && classifyOutcome({ url: 'https://e.com/a' }, { rawText: 'x'.repeat(500) }, null) === 'captured');

  const audit = auditSlices([
    { id: '1', url: 'u', slice: 'general', true_category: 'News' },
    { id: '2', url: 'u', slice: 'non-english', true_category: 'News' },
  ]);
  check('slice audit names every missing adversarial slice',
    audit.missing.length === REQUIRED_SLICES.length - 1
    && !audit.missing.includes('non-english'));
  check('slice audit counts categories', audit.byCategory.News === 2);

  const tmp = path.join(os.tmpdir(), `w2m-urls-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, '# comment\n\n{"id":"a","url":"https://e.com","slice":"bypass"}\n');
  const list = readUrlList(tmp);
  check('url list skips comments and blanks', list.length === 1 && list[0].slice === 'bypass');
  fs.writeFileSync(tmp, '{"url":"https://e.com"}\n');
  let threw = false;
  try { readUrlList(tmp); } catch { threw = true; }
  check('url list rejects an entry with no id', threw);
  fs.rmSync(tmp, { force: true });

  console.log(`\nself-test ${ok ? 'PASSED' : 'FAILED'}`);
  return ok ? 0 : 1;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (SELF_TEST) return selfTest();

  const urlFile = path.resolve(REPO, URLS);
  if (!fs.existsSync(urlFile)) {
    console.error(`No URL list at ${urlFile}.\n`
      + `Write one as JSON Lines: {"id":"...","url":"...","slice":"...","true_category":"..."}\n`
      + `analysis/corpus/urls.example.jsonl shows the shape and the required slices.`);
    return 2;
  }

  let entries = readUrlList(urlFile);
  if (LIMIT > 0) entries = entries.slice(0, LIMIT);

  const audit = auditSlices(entries);
  console.log(`\n${entries.length} URLs from ${path.relative(REPO, urlFile)}`);
  console.log(`slices: ${Object.entries(audit.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (audit.missing.length) {
    console.warn(`\nWARNING: the list has no pages in these required slices: `
      + `${audit.missing.join(', ')}.\nThe capture will run, but the corpus is not the S2 corpus `
      + `until every adversarial slice is populated (plan §3 S2).\n`);
  }

  const results = await capture(entries);

  const outcomes = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  const failures = results.filter((r) => !r.pageData && r.outcome !== 'bypassed (expected)');
  const violations = results.filter((r) => r.outcome.startsWith('BYPASS VIOLATED'));
  const dupes = new Map();
  for (const r of results) {
    if (!r.content_hash) continue;
    dupes.set(r.content_hash, [...(dupes.get(r.content_hash) || []), r.id]);
  }
  const duplicates = [...dupes.entries()].filter(([, ids]) => ids.length > 1);

  const corpus = {
    _notice: 'Frozen S2 corpus (C-04). Extracted pageData, not URLs — re-fetching these URLs '
           + 'will not reproduce this corpus and is not how it should be replicated.',
    captured_at: new Date().toISOString(),
    extension_build: readBuildStamp(),
    n_pages: results.length,
    n_failed: failures.length,
    outcomes,
    bypass_violations: violations.map((v) => v.id),
    slices: audit.counts,
    missing_slices: audit.missing,
    duplicate_content_hashes: duplicates.map(([h, ids]) => ({ hash: h, ids })),
    pages: results,
  };

  const outFile = path.resolve(REPO, OUT);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(corpus, null, 2));

  console.log('');
  for (const [k, v] of Object.entries(outcomes)) console.log(`  ${String(v).padStart(4)}  ${k}`);
  if (failures.length) console.log(`\n  failed: ${failures.map((f) => f.id).join(', ')}`);
  if (violations.length) {
    console.log(`\n  BYPASS VIOLATION on ${violations.map((v) => v.id).join(', ')} — the extension `
      + `extracted from a page it is supposed to leave alone. That is a C5 policy failure, not a `
      + `capture problem, and it must be fixed before this corpus is used for anything.`);
  }
  if (duplicates.length) {
    console.log(`  WARNING ${duplicates.length} duplicate content hash(es) — the extractor `
      + `returned identical text for different URLs, which usually means an extraction failure `
      + `that looks like a success:`);
    for (const [, ids] of duplicates) console.log(`    ${ids.join(' == ')}`);
  }
  console.log(`\nWrote ${path.relative(REPO, outFile)}`);
  return failures.length > results.length * 0.1 ? 1 : 0;
}

function readBuildStamp() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
    return { version: manifest.version, name: manifest.name };
  } catch {
    return null;
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
