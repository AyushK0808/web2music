#!/usr/bin/env node
/**
 * s2_tier_ablation.js — §5.2 / C3: the A1-A7 tier-cascade ablation runner.
 *
 * Plan §13 critical path step 4 ("S2 harness (A1-A7 runner)") was `not
 * started` and no eval harness of any kind existed anywhere in the repo
 * (confirmed by grepping for macro_f1/Krippendorff/eval_harness). This is
 * that runner. What it does NOT do: the plan's actual S2 corpus is 600
 * pages labelled independently by 3 annotators with Krippendorff's alpha
 * reported as the human ceiling (plan §3 S2) -- that is real annotation
 * work this script cannot substitute for. It ships with an 18-page smoke
 * corpus (s2_smoke_corpus.json) instead, single-annotator, explicitly
 * flagged as unfit for the paper, whose only job is to prove this harness
 * is correct end-to-end against the live tiers before the real corpus
 * exists. Point --corpus at the real one once it's frozen; nothing else
 * about this script needs to change.
 *
 * For each page, the three tiers are each called exactly ONCE (zero-shot
 * with its confidence gates forced open, so it always returns its top
 * category rather than abstaining) and the raw per-tier results are cached.
 * Every cascade configuration (A1, A4, A5, and the A7 threshold sweep) is
 * then computed by REPLAYING those cached results through the same
 * cascade logic resolveContentCategory() uses (keyword decides if it hits
 * AND lang==='en'; else zero-shot decides if it clears minScore/minMargin;
 * else the LLM; else the "Entertainment" default) -- not by re-calling the
 * tiers per configuration. That's what makes the A7 sweep free: it's pure
 * post-hoc arithmetic over already-collected scores, not 1000 more API
 * calls.
 *
 * Usage:
 *   # classify-service must be up (docker compose -f docker/docker-compose.yml up -d classify-service)
 *   node experiments/s2_tier_ablation.js
 *   node experiments/s2_tier_ablation.js --corpus experiments/s2_smoke_corpus.json --out results/s2-ablation.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  classifyContentCategory,
  callCategoryLLMClassifier,
  checkSensitiveContent,
  cleanText,
  extractKeywords,
  summariseContent,
  CATEGORY_KEYWORDS,
} from '../feature_b/b1_contentUnderstanding.js';
import { classifyCategoryZeroShot } from '../feature_b/b1_zeroShotCategory.js';
import { createLocalClassifier } from './localZeroShot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CATEGORIES = Object.keys(CATEGORY_KEYWORDS);
const CLASSIFY_SERVICE_URL = process.env.CLASSIFY_SERVICE_URL || 'http://localhost:8078';
// retry: this script fires one LLM call per page, back-to-back, for every page
// in the corpus -- a free-tier Groq key rate-limits (429) most of a 200+ page
// run in seconds without this. maxRetries/baseDelayMs are opt-in on
// callCategoryLLMClassifier specifically so the live extension (one page at a
// time, real user waiting) never inherits a multi-second backoff.
const LLM_CONFIG = {
  backend: 'proxy',
  serviceUrl: `${CLASSIFY_SERVICE_URL}/v1/chat/completions`,
  retry: { maxRetries: 6, baseDelayMs: 2000 },
};
const ZS_SERVICE_URL = `${CLASSIFY_SERVICE_URL}/v1/zero-shot`;
// Proactive pacing between pages, on top of the reactive retry above --
// staying under the rate limit from the start means fewer 429s to retry out
// of in the first place, so the run finishes faster overall, not slower.
const PAGE_PACING_MS = Number(process.env.S2_PAGE_PACING_MS ?? 1500);

// Production defaults (b1_zeroShotCategory.js DEFAULT_MIN_SCORE/DEFAULT_MIN_MARGIN).
const PROD_MIN_SCORE = 0.45;
const PROD_MIN_MARGIN = 0.10;

// ── Per-page raw tier calls (each tier hit exactly once per page) ──────────

// ── A6: the local distilled checkpoint (C-02) ─────────────────────────────
//
// The plan's §3 S2 and T2 both promise an A6 and the harness never had one,
// which left pre-mortem objection #7 ("sending page text to Groq is a privacy
// problem") with nothing to point at. A6 is the **zero-exposure operating
// point**: keyword → local distilled zero-shot → default, with the LLM tier
// removed entirely rather than merely deprioritised. That is what makes F5's
// trade-off curve reach the exposure axis instead of stopping short of it, and
// "here is the accuracy you get for exactly zero page text leaving the device"
// is a far stronger answer than "we send less than we used to".
//
// It runs through classifyCategoryZeroShot's `local` backend — the same code
// path the extension's worker uses — so the A2/A5/A6 comparison is between
// checkpoints, not between implementations.
let _localClassifier = null;

async function collectLocalZeroShot(page, cleaned) {
  if (!_localClassifier) return { zs: null, err: 'local classifier not initialised', ms: null };
  const started = Date.now();
  try {
    const zs = await classifyCategoryZeroShot(
      cleaned,
      {
        enabled: true,
        backend: 'local',
        classify: _localClassifier.classify,
        model: _localClassifier.modelId,
        // Gates forced open here for the same reason as the proxy tier: the
        // abstention decision is re-applied per configuration from the stored
        // score/margin, which is what makes the A7 sweep free.
        minScore: 0,
        minMargin: 0,
        // A distilled BART in Node WASM is slower than the 8s production
        // budget allows; timing out here would measure the timeout.
        timeoutMs: 120_000,
      },
    );
    return { zs, err: null, ms: Date.now() - started };
  } catch (e) {
    return { zs: null, err: e.message, ms: Date.now() - started };
  }
}

async function collectRawResults(rawPage) {
  // s2_smoke_corpus.json has rawText/title/lang at the top level of each
  // page record. analysis/corpus/s2_corpus.json (capture_corpus.mjs's real
  // output) nests the same fields under page.pageData instead, matching
  // Feature A's actual Handoff-1 shape -- this harness was only ever
  // exercised against the smoke corpus, so that mismatch silently zeroed
  // out keyword/zero-shot extraction on every real-corpus page (empty
  // rawText -> empty cleaned text -> no keywords, langSkipsKeyword always
  // true since page.lang was undefined !== 'en' -> straight to the LLM tier
  // every time, hence exposure_rate pinned at 1.0 regardless of threshold).
  // Falls back to the flat shape first so the smoke corpus keeps working
  // unchanged.
  const page = {
    ...rawPage,
    rawText: rawPage.rawText ?? rawPage.pageData?.rawText ?? '',
    title:   rawPage.title   ?? rawPage.pageData?.title   ?? '',
    lang:    rawPage.lang    ?? rawPage.pageData?.lang    ?? 'en',
  };

  const cleaned = cleanText(page.rawText || '');
  const isSensitive = checkSensitiveContent(cleaned + ' ' + page.title);
  const keywords = extractKeywords(cleaned);
  const summary = summariseContent(cleaned);

  const heuristic = classifyContentCategory(keywords, page.title);
  const langSkipsKeyword = page.lang !== 'en';

  // Zero-shot with gates forced open (minScore/minMargin: 0) so A2 gets the
  // model's raw top-1 prediction regardless of confidence -- the abstention
  // decision is re-applied later, per configuration, from the stored
  // score/margin, not baked into this call.
  let zs = null, zsError = null, zsMs = null;
  const zsStarted = Date.now();
  try {
    zs = await classifyCategoryZeroShot(
      { keywords, title: page.title, summary },
      { enabled: true, backend: 'proxy', serviceUrl: ZS_SERVICE_URL, minScore: 0, minMargin: 0 }
    );
  } catch (e) {
    zsError = e.message;
  }
  zsMs = Date.now() - zsStarted;

  let llm = null, llmError = null;
  const llmStarted = Date.now();
  try {
    llm = await callCategoryLLMClassifier({ keywords, title: page.title, summary }, LLM_CONFIG);
  } catch (e) {
    llmError = e.message;
  }
  const llmMs = Date.now() - llmStarted;

  // A6's tier, when the local classifier has been initialised.
  const local = _localClassifier
    ? await collectLocalZeroShot(page, { keywords, title: page.title, summary })
    : { zs: null, err: null, ms: null };

  return {
    id: page.id,
    true_category: page.true_category,
    lang: page.lang,
    isSensitive,
    langSkipsKeyword,
    keyword: { primary: heuristic.primary, secondary: heuristic.secondary },
    zeroShot: zs ? { category: zs.category, score: zs.score, margin: zs.margin, runnerUp: zs.runnerUp, model: zs.model } : null,
    zeroShotError: zsError,
    zeroShotMs: zsMs,
    zeroShotLocal: local.zs
      ? { category: local.zs.category, score: local.zs.score, margin: local.zs.margin, runnerUp: local.zs.runnerUp, model: local.zs.model }
      : null,
    zeroShotLocalError: local.err,
    zeroShotLocalMs: local.ms,
    llm,
    llmError,
    llmMs,
  };
}

// ── Cascade replay (mirrors resolveContentCategory's decision order) ───────

function simulateCascade(r, { zeroShotEnabled, minScore = PROD_MIN_SCORE, minMargin = PROD_MIN_MARGIN,
                              zeroShotField = 'zeroShot', allowLLM = true }) {
  // Sensitive pages never reach the category LLM (runB1's own branch) --
  // heuristic-only, defaulting to Entertainment same as production.
  if (r.isSensitive) {
    return { category: r.keyword.primary ?? 'Entertainment', source: 'skipped-sensitive' };
  }
  if (r.keyword.primary && !r.langSkipsKeyword) {
    return { category: r.keyword.primary, source: 'keyword' };
  }
  const zs = r[zeroShotField];
  if (zeroShotEnabled && zs && zs.score >= minScore && zs.margin >= minMargin) {
    // A6 uses the same 'zero-shot' source label deliberately: the escalation
    // column should read the same for A5 and A6, because the *tier* is the
    // same. What differs is where it runs, and that is the exposure column's
    // job to say, not the escalation column's.
    return { category: zs.category, source: 'zero-shot' };
  }
  // A6 has no LLM tier at all — that absence is the entire point of the
  // configuration, so it defaults rather than escalating.
  if (allowLLM && r.llm) {
    return { category: r.llm, source: 'llm' };
  }
  return { category: 'Entertainment', source: 'default' };
}

// A2/A3 "tier alone" configurations don't cascade at all -- they report
// what that one tier says, null if it declined, with no fallback.
function tierAlone(r, tier) {
  if (tier === 'keyword') return r.keyword.primary ? { category: r.keyword.primary, source: 'keyword' } : { category: null, source: 'none' };
  if (tier === 'zero-shot') return r.zeroShot ? { category: r.zeroShot.category, source: 'zero-shot' } : { category: null, source: 'none' };
  if (tier === 'llm') return r.llm ? { category: r.llm, source: 'llm' } : { category: null, source: 'none' };
}

// ── Metrics ──────────────────────────────────────────────────────────────

function macroF1(predictions) {
  // predictions: [{ true: 'Health', pred: 'Health' | null }, ...]
  // Callers are expected to have already dropped any entry whose `true`
  // isn't a real category (e.g. the 6 bypass pages in the S2 corpus, whose
  // true_category is deliberately "?" because a donation page or a
  // chrome://settings page has no content category to be right or wrong
  // about). This function trusts that and does not re-filter, so a caller
  // that forgets to filter will silently leak false positives against
  // whatever real category those pages happened to be predicted as -- see
  // summariseConfig's scoreable filter below, which is the actual fix.
  const perClass = {};
  for (const cat of CATEGORIES) perClass[cat] = { tp: 0, fp: 0, fn: 0 };

  for (const { true: truth, pred } of predictions) {
    if (pred === truth) {
      if (perClass[truth]) perClass[truth].tp++;
    } else {
      if (perClass[truth]) perClass[truth].fn++;
      if (pred && perClass[pred]) perClass[pred].fp++;
    }
  }

  const f1s = [];
  for (const cat of CATEGORIES) {
    const { tp, fp, fn } = perClass[cat];
    if (tp + fp + fn === 0) continue; // category absent from both truth and predictions -- excluded, not scored as 0
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    f1s.push(f1);
  }
  return f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null;
}

function summariseConfig(name, results, decide, { zeroShotIsLocal = false } = {}) {
  const allPredictions = results.map((r) => ({ true: r.true_category, pred: decide(r).category }));

  // Bypass-slice pages (donation pages, chrome:// settings -- correctly
  // bypassed before either LLM tier in production, but still run through the
  // cascade here for measurement) have no valid ground truth and must not be
  // scored. In the corpus JSON their true_category is null/undefined, not
  // the literal string "?" -- that string only ever existed in this file's
  // own console.log display formatting (`r.true_category || '?'`) below. An
  // earlier version of this filter checked `p.true !== '?'`, which matched
  // nothing against the real null value and left both bugs live: accuracy's
  // denominator still counted these 6 pages as guaranteed misses (deflating
  // every config's accuracy by a constant ~6/260), and macroF1's
  // false-positive branch still leaked against whatever category each was
  // predicted as -- Entertainment took 3, Educational/Legal/News took 1
  // each in the run that surfaced this. n stays at the full results.length
  // for transparency about how many pages were processed; accuracy and
  // macro_f1 are computed over the scoreable subset only.
  const predictions = allPredictions.filter((p) => p.true != null);
  const correct = predictions.filter((p) => p.pred === p.true).length;
  const sources = results.map((r) => decide(r).source);

  const sourceCounts = {};
  for (const s of sources) sourceCounts[s] = (sourceCounts[s] || 0) + 1;

  // exposure: pages whose text left the machine (LLM tier decided, i.e. the
  // page text was sent to Groq -- the proxy zero-shot tier ALSO sends text
  // off-device to HF, but the plan (§4 metrics dictionary) defines exposure
  // specifically as `source == "llm"`; the zero-shot-proxy privacy cost is
  // a separate, smaller number worth reporting alongside it, not folded in.
  // Unlike accuracy/macro_f1, exposure intentionally still counts bypass
  // pages over the full results.length: it measures what actually left the
  // device during this run, which happened regardless of whether those 6
  // pages have a scoreable ground-truth label. In production these pages
  // would never reach the classifier at all (Fig. 2's own bypass path
  // short-circuits them earlier), so this run's exposure_rate is a slight
  // overestimate relative to the deployed system -- worth restating if that
  // gap matters for how the number gets used.
  const exposureRate = sourceCounts['llm'] ? sourceCounts['llm'] / results.length : 0;
  // A6 runs the zero-shot tier on-device, so its zero-shot decisions cost no
  // exposure at all. Reporting them in the same column as A5's proxy calls
  // would erase the entire difference between the two configurations, which is
  // the one thing this configuration exists to show.
  const zeroShotProxyRate = (!zeroShotIsLocal && sourceCounts['zero-shot'])
    ? sourceCounts['zero-shot'] / results.length : 0;
  const zeroShotLocalRate = (zeroShotIsLocal && sourceCounts['zero-shot'])
    ? sourceCounts['zero-shot'] / results.length : 0;

  return {
    name,
    n: results.length,
    n_scored: predictions.length,
    accuracy: round(correct / predictions.length, 3),
    macro_f1: round(macroF1(predictions), 3),
    escalation: sourceCounts,
    exposure_rate: round(exposureRate, 3),
    zero_shot_proxy_rate: round(zeroShotProxyRate, 3),
    zero_shot_local_rate: round(zeroShotLocalRate, 3),
    // Total share of pages whose text left the device by any route. This is
    // the number pre-mortem #7 is actually asking about, and it is the one
    // that goes to zero for A6.
    total_offdevice_rate: round(exposureRate + zeroShotProxyRate, 3),
  };
}

function round(v, d) {
  return v === null || v === undefined ? null : Number(v.toFixed(d));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Entry point ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const WITH_A6 = args.includes('--with-a6');

async function main() {

  const corpusPath = path.resolve(__dirname, flag('corpus', 's2_smoke_corpus.json'));
  const outPath = flag('out', null);
  const rescorePath = flag('rescore', null);

  // --rescore replays scoring against an existing output file's per_page
  // array instead of re-running the cascade -- every decide() function
  // (tierAlone, simulateCascade) is a pure function over cached
  // keyword/zeroShot/llm fields already saved there, so this needs no
  // network calls and burns no Groq/HF quota. Exists specifically so a
  // scoring-logic fix (like the truth==="?" bypass-page exclusion) can be
  // verified against a real, already-paid-for run instead of requiring a
  // second full pass over the corpus.
  if (rescorePath) {
    const prior = JSON.parse(fs.readFileSync(path.resolve(rescorePath), 'utf8'));
    console.log(`[s2_tier_ablation] Rescoring ${prior.per_page.length} cached page(s) from ${rescorePath} ` +
      '-- no network calls, no API quota used.');
    await runScoringAndReport(prior.per_page, outPath || rescorePath);
    return;
  }

  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const pages = corpus.pages;
  if (corpus._notice) console.log(`\n[s2_tier_ablation] ${corpus._notice}\n`);
  console.log(`[s2_tier_ablation] ${pages.length} page(s) from ${corpusPath}`);

  // A6's local checkpoint, loaded once before the page loop. Loading it per
  // page would make the A6 column a measurement of model loading.
  if (WITH_A6) {
    try {
      _localClassifier = await createLocalClassifier({
        model: flag('a6-model', null),
        log: (m) => console.log(`[s2_tier_ablation] ${m}`),
      });
      console.log(`[s2_tier_ablation] A6 enabled: ${_localClassifier.modelId} (on-device, zero exposure)`);
    } catch (e) {
      console.error(`[s2_tier_ablation] A6 unavailable: ${e.message}
` +
        '  A6 is the zero-exposure operating point and pre-mortem #7 has nothing to point at ' +
        'without it. Fix this rather than reporting T2 with the column missing.');
      process.exit(1);
    }
  } else {
    console.log('[s2_tier_ablation] A6 not run (pass --with-a6). T2 and F5 will be missing the ' +
      'zero-exposure point.');
  }

  // Health check first -- fail fast and legibly, same convention as
  // audio-generation/experiments/d4_latency.py, rather than N pages of
  // identical "fetch failed" errors.
  try {
    const health = await fetch(`${CLASSIFY_SERVICE_URL}/health`).then((r) => r.json());
    console.log(`[s2_tier_ablation] classify-service: groq=${health.keyConfigured} zero-shot=${health.zeroShotConfigured} (${health.zeroShotModel || 'n/a'})`);
    if (!health.zeroShotConfigured) {
      console.warn('[s2_tier_ablation] WARNING: zeroShotConfigured=false -- A2/A5/A7 will show 0% zero-shot escalation. Set HF_API_TOKEN in .env and rebuild classify-service.');
    }
  } catch (e) {
    console.error(`[s2_tier_ablation] Cannot reach classify-service at ${CLASSIFY_SERVICE_URL} (${e.message}).\n` +
      'Start it with: docker compose -f docker/docker-compose.yml up -d classify-service');
    process.exit(1);
  }

  const results = [];
  for (let i = 0; i < pages.length; i++) {
    if (i > 0 && PAGE_PACING_MS > 0) await sleep(PAGE_PACING_MS);
    const r = await collectRawResults(pages[i]);
    results.push(r);
    const fmtZs = (z, err) => (z ? `${z.category} (${z.score.toFixed(2)}/${z.margin.toFixed(2)})` : (err || 'null'));
    const zs = fmtZs(r.zeroShot, r.zeroShotError);
    const zsl = WITH_A6 ? `  local=${fmtZs(r.zeroShotLocal, r.zeroShotLocalError).padEnd(28)}` : '';
    console.log(`  [${i + 1}/${pages.length}] ${r.id.padEnd(32)} truth=${(r.true_category || '?').padEnd(14)} ` +
      `kw=${String(r.keyword.primary).padEnd(14)} zs=${zs.padEnd(28)}${zsl} llm=${r.llm}`);
  }

  await runScoringAndReport(results, outPath, corpusPath);
}

// Scoring + console report + optional JSON write. Pulled out of main() so
// --rescore can call it directly against a saved per_page array without
// duplicating this logic (and risking the two copies drifting apart the way
// the original bypass-page scoring bug could have, had it been fixed in only
// one of two near-identical blocks).
async function runScoringAndReport(results, outPath, corpusLabel = '(rescored -- see source file)') {
  const configs = [
    summariseConfig('A1 keyword-only', results, (r) => tierAlone(r, 'keyword')),
    summariseConfig('A2 zero-shot-only (ungated)', results, (r) => tierAlone(r, 'zero-shot')),
    summariseConfig('A3 LLM-only', results, (r) => tierAlone(r, 'llm')),
    summariseConfig('A4 keyword->LLM', results, (r) => simulateCascade(r, { zeroShotEnabled: false })),
    summariseConfig('A5 keyword->zero-shot->LLM', results, (r) => simulateCascade(r, { zeroShotEnabled: true, minScore: PROD_MIN_SCORE, minMargin: PROD_MIN_MARGIN })),
  ];

  if (WITH_A6 && _localClassifier) {
    // A6 — keyword -> LOCAL distilled zero-shot -> default. No LLM tier: the
    // point of the configuration is that nothing leaves the device, and a
    // cascade that still falls through to Groq would not be that point.
    configs.push(summariseConfig(
      `A6 keyword->local zero-shot (${_localClassifier.modelId}), no LLM`,
      results,
      (r) => simulateCascade(r, {
        zeroShotEnabled: true, minScore: PROD_MIN_SCORE, minMargin: PROD_MIN_MARGIN,
        zeroShotField: 'zeroShotLocal', allowLLM: false,
      }),
      { zeroShotIsLocal: true },
    ));
    // The same local tier *with* the LLM behind it, so the A5/A6 comparison
    // separates two things that would otherwise be confounded: the cost of the
    // smaller checkpoint, and the cost of removing the LLM entirely.
    configs.push(summariseConfig(
      'A6b keyword->local zero-shot->LLM',
      results,
      (r) => simulateCascade(r, {
        zeroShotEnabled: true, minScore: PROD_MIN_SCORE, minMargin: PROD_MIN_MARGIN,
        zeroShotField: 'zeroShotLocal', allowLLM: true,
      }),
      { zeroShotIsLocal: true },
    ));
  }

  console.log('\n' + '='.repeat(78));
  console.log('TIER ABLATION — SUMMARY');
  console.log('='.repeat(78));
  for (const c of configs) {
    console.log(`\n${c.name}  (n=${c.n}, n_scored=${c.n_scored})`);
    console.log(`  accuracy ${c.accuracy}   macro-F1 ${c.macro_f1}   exposure_rate ${c.exposure_rate}   ` +
      `zs_proxy ${c.zero_shot_proxy_rate}   zs_local ${c.zero_shot_local_rate}   ` +
      `TOTAL off-device ${c.total_offdevice_rate}`);
    console.log(`  escalation: ${JSON.stringify(c.escalation)}`);
  }

  // A7 — threshold sweep, pure post-hoc replay of already-collected scores.
  console.log(`\n${'─'.repeat(78)}\nA7 threshold sweep (minScore x minMargin) — the accuracy/exposure dial\n${'─'.repeat(78)}`);
  const sweep = [];
  for (const minScore of [0.30, 0.45, 0.60, 0.75]) {
    for (const minMargin of [0.05, 0.10, 0.20]) {
      const cfg = summariseConfig(`A7 (minScore=${minScore}, minMargin=${minMargin})`, results,
        (r) => simulateCascade(r, { zeroShotEnabled: true, minScore, minMargin }));
      sweep.push({ minScore, minMargin, macro_f1: cfg.macro_f1, exposure_rate: cfg.exposure_rate, zero_shot_proxy_rate: cfg.zero_shot_proxy_rate });
      console.log(`  minScore=${minScore.toFixed(2)} minMargin=${minMargin.toFixed(2)}  ->  ` +
        `macro-F1 ${cfg.macro_f1}   exposure ${cfg.exposure_rate}   zs-used ${cfg.zero_shot_proxy_rate}`);
    }
  }
  console.log('='.repeat(78));

  if (outPath) {
    const outFull = path.resolve(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(outFull), { recursive: true });
    fs.writeFileSync(outFull, JSON.stringify({ corpus: corpusLabel, per_page: results, configs, a7_sweep: sweep }, null, 2));
    console.log(`\nWrote ${outFull}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
