/*
 * extractionCost.js — §6 systems eval: what does Feature A's extraction
 * actually cost on real pages?
 *
 * Why this can't be playground.js: jsdom performs NO layout, so
 * getBoundingClientRect() returns zeros and getComputedStyle() is cheap and
 * fake. The one cost we most need to characterise — Colorextractor doing a
 * getComputedStyle + getBoundingClientRect per element, which can force
 * synchronous layout — only exists in a real engine. So this drives real
 * Chrome over CDP.
 *
 * What it measures, per site:
 *   - wall-clock buildPageData() duration (the number a user would feel)
 *   - per-stage latency + failure rate via getExtractionTelemetry()
 *   - colour extraction in isolation, plus how hard MAX_ELEMENTS_TO_SAMPLE bites
 *     (sampledCount vs totalElementCount)
 *   - forced-layout count/duration from Chrome's own performance timeline
 *   - whether the colour→mood signal came out live or fell back to grey
 *
 * Reports p50/p95/max, not just means: a mean hides the tail, and the tail is
 * what janks a page.
 *
 * Usage:
 *   node benchmark/extractionCost.js                       # full site list
 *   node benchmark/extractionCost.js --limit 5             # quick smoke test
 *   node benchmark/extractionCost.js --sites my-list.txt
 *   node benchmark/extractionCost.js --out results.json --headful
 *
 * Pages are visited SEQUENTIALLY and once each: concurrent loads would contend
 * for CPU and corrupt the very timings we're measuring.
 *
 * NOTE ON EMBEDDING: the local embedder is stubbed by default (a real MiniLM
 * download would dominate every measurement and tells us nothing about DOM
 * extraction cost). So the `embedding` stage timing here is NOT a real model
 * cost — measure that separately. Pass --real-embedding to opt out of the stub.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

// The real local-embedding bundle for --real-embedding (see NOTE ON EMBEDDING
// above). Built from the exact @xenova/transformers version already pinned
// in ui/package.json, via:
//   npx esbuild benchmark/.embed-bundle-build/entry.mjs --bundle
//     --format=iife --platform=browser --minify
//     --outfile=benchmark/.embed-bundle-build/transformers-bundle.js
// Re-run that build if the pinned version changes. Bundled to a plain IIFE
// rather than loaded from a CDN via addScriptTag for the same CSP reason the
// module injection above avoids addScriptTag: this still needs a *separate*,
// unavoidable network call to fetch the actual MiniLM weights from the
// Hugging Face Hub at runtime (there's no bundling around real model
// weights), and a real site's connect-src CSP can legitimately block that
// even when the script itself injected fine — that failure mode is real
// data about deployability, not a bug in this harness, and is reported as
// its own embedding-stage error rather than silently retried or masked.
const REAL_EMBEDDING_BUNDLE_PATH = path.join(
  __dirname, '.embed-bundle-build', 'transformers-bundle.js'
);

/* ── Module injection order (dependencies before pageData.js) ──────────────── */
const MODULES = [
  'Textextractor.js',
  'Colorextractor.js',
  'Embeddingmodel.js',
  // syllableCounter.js must load before Readability.js: Readability.js reads
  // window.Web2MusicSyllableCounter at top-level const-binding time (see its
  // header), and an injection order that puts it after left that binding
  // undefined in this benchmark's browser context, throwing "Cannot read
  // properties of undefined (reading 'countSyllables')" on every single site
  // (97/103 in the first real run) -- silently degrading every readability
  // measurement to a caught, swallowed error instead of a real number.
  'syllableCounter.js',
  'Readability.js',
  'behaviorTracker.js',
  'VectorStore.js',
  'pageData.js',
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }
  throw new Error(
    'Could not find Chrome. Set CHROME_PATH to your Chrome/Chromium executable.'
  );
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = {
    sites: path.join(__dirname, 'top-sites.txt'),
    out: path.join(__dirname, 'extraction-cost-results.json'),
    limit: Infinity,
    navTimeoutMs: 30000,
    settleMs: 1500,
    headful: false,
    realEmbedding: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--sites':           args.sites = next(); break;
      case '--out':             args.out = next(); break;
      case '--limit':           args.limit = parseInt(next(), 10); break;
      case '--nav-timeout':     args.navTimeoutMs = parseInt(next(), 10); break;
      case '--settle':          args.settleMs = parseInt(next(), 10); break;
      case '--headful':         args.headful = true; break;
      case '--real-embedding':  args.realEmbedding = true; break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readSites(file, limit) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const sites = lines
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
  return Number.isFinite(limit) ? sites.slice(0, limit) : sites;
}

/* ── Stats ────────────────────────────────────────────────────────────────── */

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  );
  return sortedValues[idx];
}

function summarise(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return { n: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

const fmt = (v, digits = 1) =>
  (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(digits) : '—';

/* ── Per-site measurement ─────────────────────────────────────────────────── */

async function measureSite(browser, url, moduleSources, args) {
  const page = await browser.newPage();
  const result = { url, ok: false };

  // Diagnostics for --real-embedding failures that reproduce on some
  // machines/Chrome builds but not others (item 4.6) — a renderer-side
  // console.error, an uncaught page exception, or a failed/blocked network
  // request to the model host would all currently be invisible: they'd
  // either get swallowed into the generic "window.transformersPipeline not
  // available" message downstream, or not surface at all. Collected per
  // site and attached to the result so a failing run shows the real cause
  // instead of requiring a second, separately-instrumented run to find it.
  const diagnostics = { console: [], pageErrors: [], failedRequests: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      diagnostics.console.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    diagnostics.pageErrors.push(String(err && err.message || err));
  });
  page.on('requestfailed', (req) => {
    const u = req.url();
    // Scoped to model-fetch hosts specifically -- a real page's own ads/
    // analytics/tracking requests fail constantly and are not this bug.
    if (/huggingface\.co|hf\.co|cdn-lfs/.test(u)) {
      diagnostics.failedRequests.push(`${u} -- ${req.failure()?.errorText || 'unknown'}`);
    }
  });
  page.on('response', (res) => {
    // requestfailed only fires for network-level failures (DNS, connection
    // refused, timeout) -- an HTTP error status like 403/404/429 completes
    // successfully at the network layer and would otherwise be invisible
    // here even though it's exactly what blocks a real model fetch (e.g. a
    // proxy or firewall returning 403 for a disallowed host, as opposed to
    // the request never reaching anything at all).
    const u = res.url();
    if (res.status() >= 400 && /huggingface\.co|hf\.co|cdn-lfs/.test(u)) {
      diagnostics.failedRequests.push(`${u} -- HTTP ${res.status()}`);
    }
  });

  try {
    await page.setViewport({ width: 1280, height: 800 });
    // A realistic UA: some sites serve a stripped no-JS/blocked page to
    // HeadlessChrome, which would make extraction look artificially cheap.
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    const navStart = Date.now();
    // 'domcontentloaded' rather than 'networkidle*': many top sites poll/stream
    // forever and never go idle. We then wait `settleMs` for late layout.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: args.navTimeoutMs });
    result.navMs = Date.now() - navStart;

    await new Promise(r => setTimeout(r, args.settleMs));

    // Inject Feature A via CDP Runtime.evaluate. Critically NOT addScriptTag:
    // that appends a <script> to the page and would be blocked by the strict
    // CSP most large sites ship. CDP evaluation is not subject to page CSP.
    for (const src of moduleSources) {
      await page.evaluate(src);
    }

    const modulesReady = await page.evaluate(() =>
      Boolean(window.Web2MusicPageData && window.Web2MusicColorExtractor)
    );
    if (!modulesReady) throw new Error('module injection failed (globals missing)');

    if (!args.realEmbedding) {
      // Deterministic stand-in — see NOTE ON EMBEDDING in the header.
      //
      // A hashing bag-of-WORDS vectoriser, not a character histogram: any two
      // long English texts have nearly the same character distribution, which
      // scored unrelated articles at ~0.997 cosine and made every page look like
      // a revisit. Hashing words puts disjoint vocabularies in different buckets,
      // so the reported similarity numbers mean something.
      await page.evaluate(() => {
        window.transformersPipeline = async () => async (text) => {
          const dims = 64;
          const vec = new Array(dims).fill(0);
          for (const word of String(text).toLowerCase().match(/[a-z]+/g) || []) {
            let hash = 5381;
            for (let i = 0; i < word.length; i++) {
              hash = ((hash << 5) + hash + word.charCodeAt(i)) | 0;
            }
            vec[Math.abs(hash) % dims] += 1;
          }
          const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
          return { data: vec.map(v => v / norm) };
        };
      });
    } else {
      // Real backend. Same CDP Runtime.evaluate injection as the Feature A
      // modules above (not addScriptTag, same CSP reason) — this only
      // installs window.transformersPipeline; the actual MiniLM weights are
      // fetched from the Hugging Face Hub lazily, on the first real
      // getEmbedding() call inside buildPageData() below, which is the
      // number this flag exists to measure and is deliberately NOT
      // pre-warmed here.
      if (!fs.existsSync(REAL_EMBEDDING_BUNDLE_PATH)) {
        throw new Error(
          `--real-embedding needs the bundle at ${REAL_EMBEDDING_BUNDLE_PATH}, which doesn't exist. ` +
          'Build it first — see the comment above REAL_EMBEDDING_BUNDLE_PATH for the exact command.'
        );
      }
      const bundleSrc = fs.readFileSync(REAL_EMBEDDING_BUNDLE_PATH, 'utf8');
      await page.evaluate(bundleSrc);
      const pipelineReady = await page.evaluate(() => typeof window.transformersPipeline === 'function');
      if (!pipelineReady) {
        throw new Error('--real-embedding bundle loaded but window.transformersPipeline was not defined afterward.');
      }
    }

    const measured = await page.evaluate(async () => {
      const { buildPageData, getExtractionTelemetry, resetExtractionTelemetry } =
        window.Web2MusicPageData;
      resetExtractionTelemetry();

      // Colour extraction in isolation — the flagged forced-layout risk. Run it
      // before buildPageData so its own layout work isn't already warmed up.
      let colorOnly = null;
      try {
        const t0 = performance.now();
        const c = window.Web2MusicColorExtractor.extractDominantColors(document.body);
        colorOnly = {
          ms: performance.now() - t0,
          sampledCount: c.sampledCount,
          totalElementCount: c.totalElementCount,
          colorEnergy: c.colorEnergy,
        };
      } catch (err) {
        colorOnly = { error: String(err && err.message || err) };
      }

      const t1 = performance.now();
      const handoff = await buildPageData({ useCache: false });
      const buildMs = performance.now() - t1;

      // Text-extraction coverage: how much of the page's visible text did we
      // actually capture? Under-extraction is a SILENT failure — it throws
      // nothing, so no failure counter sees it, but it starves the embedding and
      // can trip the isImageOnly fallback on a page full of prose. Boilerplate
      // stripping means coverage is legitimately < 1; it's the near-zero cases
      // that indicate the density scorer latched onto the wrong container.
      const visibleWords = (document.body && document.body.innerText || '')
        .trim().split(/\s+/).filter(Boolean).length;
      const textCoverage = visibleWords > 0 ? (handoff.wordCount || 0) / visibleWords : null;

      const colors = handoff.colors || {};
      return {
        buildMs,
        colorOnly,
        telemetry: getExtractionTelemetry(),
        wordCount: handoff.wordCount,
        visibleWords,
        textCoverage,
        extractedTextStart: (handoff.rawText || '').slice(0, 120),
        isImageOnly: handoff.isImageOnly,
        embeddingDims: (handoff.embedding || []).length,
        lang: handoff.lang,
        warnings: handoff.warnings || [],
        // The regression that motivated all this: a grey default here means the
        // colour→mood signal is dead even though every field is well-typed.
        colors,
        colourSignalLive: !(
          colors.hue === 0 && colors.saturation === 0 && colors.lightness === 0.5
        ),
        // Exercises the IndexedDB adapter — the extension's real storage path,
        // which the Node tests (memory adapter) can't reach.
        vectorStore: {
          backing: window.Web2MusicVectorStore ? 'present' : 'missing',
          isRevisit: handoff.isRevisit,
          nearestScore: handoff.nearestScore,
          similarCount: (handoff.similarPages || []).length,
        },
      };
    });

    Object.assign(result, measured, { ok: true });

    // Chrome's own view of forced synchronous layout, straight from the
    // engine's counters rather than inferred from wall-clock.
    try {
      const metrics = await page.metrics();
      result.chromeMetrics = {
        layoutCount: metrics.LayoutCount,
        layoutDurationMs: metrics.LayoutDuration * 1000,
        recalcStyleCount: metrics.RecalcStyleCount,
        recalcStyleDurationMs: metrics.RecalcStyleDuration * 1000,
        jsHeapUsedMB: metrics.JSHeapUsedSize / (1024 * 1024),
      };
    } catch { /* metrics are a bonus, not the measurement */ }

  } catch (err) {
    result.error = String(err && err.message || err);
  } finally {
    // Only attach when there's something to see -- keeps clean-run output
    // exactly as before instead of padding every result with empty arrays.
    if (diagnostics.console.length || diagnostics.pageErrors.length || diagnostics.failedRequests.length) {
      result.embeddingDiagnostics = diagnostics;
    }
    await page.close().catch(() => {});
  }

  return result;
}

/* ── Reporting ────────────────────────────────────────────────────────────── */

const STAGES = ['text', 'colors', 'behavior', 'readability', 'embedding'];

// Below this share of a page's visible text, treat extraction as having failed
// even though it raised nothing. Deliberately generous: aggressive boilerplate
// stripping on a nav-heavy page can legitimately land near 15–20%.
const UNDER_EXTRACTION_THRESHOLD = 0.1;

function report(results, args) {
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  const line = '─'.repeat(74);
  console.log(`\n${line}\nEXTRACTION COST — ${ok.length}/${results.length} sites measured\n${line}`);

  if (ok.length === 0) {
    console.log('\nNo sites were measured successfully; nothing to summarise.');
  } else {
    const build = summarise(ok.map(r => r.buildMs));
    console.log('\nbuildPageData() wall-clock (ms)');
    console.log(`  mean ${fmt(build.mean)}   p50 ${fmt(build.p50)}   p95 ${fmt(build.p95)}   max ${fmt(build.max)}`);

    console.log('\nPer-stage latency (ms) and failure rate');
    console.log('  stage         mean     p50      p95      max      fails');
    for (const stage of STAGES) {
      const s = summarise(ok.map(r => r.telemetry && r.telemetry[stage] && r.telemetry[stage].avgMs));
      const fails = ok.filter(r => r.telemetry && r.telemetry[stage] && r.telemetry[stage].failures > 0).length;
      console.log(
        '  ' + stage.padEnd(13) +
        fmt(s.mean).padEnd(9) + fmt(s.p50).padEnd(9) +
        fmt(s.p95).padEnd(9) + fmt(s.max).padEnd(9) +
        `${fails}/${ok.length}`
      );
    }

    const colorRuns = ok.filter(r => r.colorOnly && typeof r.colorOnly.ms === 'number');
    if (colorRuns.length) {
      const c = summarise(colorRuns.map(r => r.colorOnly.ms));
      const elements = summarise(colorRuns.map(r => r.colorOnly.totalElementCount));
      const capped = colorRuns.filter(r => r.colorOnly.totalElementCount > r.colorOnly.sampledCount);
      console.log('\nColour extraction in isolation (the forced-layout risk)');
      console.log(`  ms          : mean ${fmt(c.mean)}   p50 ${fmt(c.p50)}   p95 ${fmt(c.p95)}   max ${fmt(c.max)}`);
      console.log(`  elements    : p50 ${fmt(elements.p50, 0)}   p95 ${fmt(elements.p95, 0)}   max ${fmt(elements.max, 0)}`);
      console.log(`  sampling cap engaged on ${capped.length}/${colorRuns.length} sites`);
    }

    const layout = summarise(ok.map(r => r.chromeMetrics && r.chromeMetrics.layoutDurationMs));
    if (layout.n) {
      const recalc = summarise(ok.map(r => r.chromeMetrics && r.chromeMetrics.recalcStyleDurationMs));
      console.log('\nChrome engine counters (cumulative per page, ms)');
      console.log(`  layout      : mean ${fmt(layout.mean)}   p95 ${fmt(layout.p95)}   max ${fmt(layout.max)}`);
      console.log(`  recalcStyle : mean ${fmt(recalc.mean)}   p95 ${fmt(recalc.p95)}   max ${fmt(recalc.max)}`);
    }

    const live = ok.filter(r => r.colourSignalLive).length;
    const imageOnly = ok.filter(r => r.isImageOnly).length;
    console.log('\nSignal quality');
    console.log(`  colour signal live : ${live}/${ok.length} (rest fell back to the grey default)`);
    console.log(`  isImageOnly        : ${imageOnly}/${ok.length}`);

    // Silent under-extraction: a real correctness failure that no timing or
    // exception counter would ever reveal.
    const withCoverage = ok.filter(r => typeof r.textCoverage === 'number');
    if (withCoverage.length) {
      const cov = summarise(withCoverage.map(r => r.textCoverage));
      const starved = withCoverage.filter(r => r.textCoverage < UNDER_EXTRACTION_THRESHOLD && r.visibleWords > 200);
      console.log(`  text coverage      : p50 ${fmt(cov.p50 * 100)}%   mean ${fmt(cov.mean * 100)}% ` +
                  `(extracted words ÷ visible words; < 100% is expected — boilerplate is stripped)`);
      console.log(`  UNDER-EXTRACTION   : ${starved.length}/${withCoverage.length} sites captured ` +
                  `< ${UNDER_EXTRACTION_THRESHOLD * 100}% of a text-rich page`);
      for (const r of starved.slice(0, 10)) {
        console.log(`      ${r.url}`);
        console.log(`        ${r.wordCount} of ${r.visibleWords} words` +
                    `${r.isImageOnly ? ' — tripped isImageOnly, B will skip the text path' : ''}`);
        if (r.extractedTextStart) console.log(`        got: "${r.extractedTextStart.replace(/\s+/g, ' ')}…"`);
      }
      if (starved.length > 10) console.log(`      … and ${starved.length - 10} more (see JSON)`);
    }

    const withWarnings = ok.filter(r => r.warnings && r.warnings.length);
    if (withWarnings.length) {
      const counts = {};
      for (const r of withWarnings) {
        for (const w of r.warnings) {
          const stage = String(w).split(':')[0];
          counts[stage] = (counts[stage] || 0) + 1;
        }
      }
      console.log(`  stage warnings     : ${withWarnings.length}/${ok.length} sites — ` +
        Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', '));
    }
  }

  if (failed.length) {
    console.log(`\nUnmeasured (${failed.length}) — navigation/injection failures, not extraction bugs:`);
    for (const r of failed.slice(0, 15)) {
      console.log(`  ${r.url} → ${r.error}`);
    }
    if (failed.length > 15) console.log(`  … and ${failed.length - 15} more (see JSON)`);
  }

  console.log(`\nFull per-site data → ${args.out}`);
  if (!args.realEmbedding) {
    console.log('Reminder: embedding was STUBBED — that stage timing is not a real model cost.');
  }
  console.log('');
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv);
  const sites = readSites(args.sites, args.limit);
  const executablePath = findChrome();

  const moduleSources = MODULES.map(name =>
    fs.readFileSync(path.join(__dirname, '..', name), 'utf8')
  );

  console.log(`Chrome    : ${executablePath}`);
  console.log(`Sites     : ${sites.length} (from ${args.sites})`);
  console.log(`Embedding : ${args.realEmbedding ? 'REAL local model' : 'stubbed'}`);
  console.log('');

  const browser = await puppeteer.launch({
    executablePath,
    headless: !args.headful,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  try {
    for (let i = 0; i < sites.length; i++) {
      const url = sites[i];
      const label = `[${String(i + 1).padStart(3)}/${sites.length}] ${url}`;
      process.stdout.write(label.padEnd(66).slice(0, 66) + ' … ');

      const r = await measureSite(browser, url, moduleSources, args);
      results.push(r);

      if (r.ok) {
        const els = r.colorOnly && r.colorOnly.totalElementCount;
        console.log(
          `${fmt(r.buildMs)}ms  ` +
          `colour ${r.colorOnly && typeof r.colorOnly.ms === 'number' ? fmt(r.colorOnly.ms) + 'ms' : '—'}  ` +
          `${els != null ? els + ' els' : ''}  ` +
          `${r.colourSignalLive ? '' : '(grey)'}`
        );
      } else {
        console.log(`FAILED: ${String(r.error).slice(0, 60)}`);
      }

      // Write incrementally: a 100-site run is long, and a crash at site 97
      // should not throw away the first 96 measurements.
      fs.writeFileSync(args.out, JSON.stringify({
        generatedAt: new Date().toISOString(),
        config: {
          sites: args.sites, limit: args.limit, settleMs: args.settleMs,
          navTimeoutMs: args.navTimeoutMs, embedding: args.realEmbedding ? 'real' : 'stubbed',
        },
        results,
      }, null, 2));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  report(results, args);
}

main().catch(err => {
  console.error('\nBenchmark crashed:', err);
  process.exit(1);
});
