#!/usr/bin/env node
/**
 * S-F — sensitive-content detector re-measurement (R4 #3, C-2).
 *
 *   node analysis/audit/s_f_detector_study.mjs \
 *       --blackbox analysis/audit/blackbox_sensitive.json \
 *       --benign-corpus analysis/corpus/s2_corpus.json --benign-corpus analysis/corpus/s2_corpus_test.json \
 *       [--gold analysis/out/gold-dev.json --gold analysis/out/gold-test.json] \
 *       [--hosted-url http://localhost:8078/v1/zero-shot] [--local-model Xenova/nli-deberta-v3-xsmall] \
 *       [--upper-model Xenova/nli-deberta-v3-base] \
 *       --out analysis/audit/results/s_f_detectors.json
 *
 * Detectors
 *   keyword        term lists only (zero-shot disabled)
 *   hosted-2way    term lists + hosted entailment, crisis-vs-reference  (the original tier)
 *   local-3way     term lists + on-device entailment, crisis / reference / unrelated  (C-2)
 *   upper-bound    optional larger NLI model on the GPU, same 3-way hypotheses
 *
 * Sets
 *   white-box   the 47-page hand-written slice. Used ONLY to calibrate the 3-way
 *               gates (--calibrate), never to report a detector claim (L-4).
 *   black-box   real crisis / support pages captured by searching for support
 *               resources (analysis/audit/blackbox_sensitive.json, same shape as
 *               sensitive_slice.json: {pages: [{id, title, text, lang?, sensitive: true}]}).
 *   benign      every non-sensitive dev + test page, plus the white-box near-miss pages.
 *
 * Reported per detector: recall on black-box, false-positive rate on benign, both
 * with 95% Wilson intervals; recall on non-English black-box pages; per-page
 * zero-shot latency; and which stage decided.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSensitivity } from '../../mood-classification/feature_b/b1_contentUnderstanding.js';
import { createLocalClassifier } from '../../mood-classification/experiments/localZeroShot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const flag = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flagAll = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

/** 95% Wilson score interval. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Number((c - h).toFixed(3)), Number((c + h).toFixed(3))];
}

const rate = (k, n) => ({ k, n, rate: n ? Number((k / n).toFixed(3)) : null, ci95: wilson(k, n) });

// ── Data ─────────────────────────────────────────────────────────────────────

const readJson = (f) => JSON.parse(fs.readFileSync(path.resolve(REPO, f), 'utf8'));

function slicePages(file) {
  return readJson(file).pages.map((p) => ({ id: p.id, title: p.title ?? '', text: p.text ?? '', lang: p.lang ?? 'en', sensitive: p.sensitive, slice: p.slice ?? null }));
}

function benignPages() {
  const goldSensitive = new Set();
  for (const g of flagAll('gold')) {
    for (const [id, e] of Object.entries(readJson(g).gold)) if (e.sensitive) goldSensitive.add(id);
  }
  const out = [];
  for (const f of flagAll('benign-corpus')) {
    for (const p of readJson(f).pages ?? []) {
      if (!p.pageData || goldSensitive.has(p.id) || /sensitive/i.test(p.slice ?? '')) continue;
      out.push({ id: p.id, title: p.pageData.title ?? '', text: p.pageData.rawText ?? '', lang: p.pageData.lang ?? 'en', sensitive: false, slice: p.slice ?? null });
    }
  }
  const wb = slicePages('analysis/audit/sensitive_slice.json').filter((p) => !p.sensitive);
  return [...out, ...wb];
}

// ── Detectors ────────────────────────────────────────────────────────────────

async function detect(page, zeroShot) {
  const text = `${page.title} ${page.text}`;
  const t0 = Date.now();
  const r = await resolveSensitivity(text, { title: page.title, summary: page.text, keywords: [] }, zeroShot ? { zeroShot } : {});
  return { detected: r.isSensitive, source: r.source, side: r.zeroShot?.side ?? null, ms: Date.now() - t0, reason: r.zeroShotReason ?? null };
}

async function evaluate(name, zeroShot, sets) {
  const res = { detector: name, config: zeroShot ? { ...zeroShot, classify: zeroShot.classify ? '[local]' : undefined } : 'disabled' };
  for (const [setName, pages] of Object.entries(sets)) {
    const rows = [];
    for (const p of pages) {
      try { rows.push({ id: p.id, lang: p.lang, truth: p.sensitive, ...(await detect(p, zeroShot)) }); }
      catch (e) { rows.push({ id: p.id, lang: p.lang, truth: p.sensitive, error: e.message }); }
    }
    const ok = rows.filter((r) => !r.error);
    const pos = ok.filter((r) => r.truth), neg = ok.filter((r) => !r.truth);
    const entry = { n: pages.length, errors: rows.length - ok.length };
    if (pos.length) {
      entry.recall = rate(pos.filter((r) => r.detected).length, pos.length);
      const nonEn = pos.filter((r) => r.lang && r.lang !== 'en');
      if (nonEn.length) entry.recall_non_english = rate(nonEn.filter((r) => r.detected).length, nonEn.length);
    }
    if (neg.length) entry.false_positive_rate = rate(neg.filter((r) => r.detected).length, neg.length);
    const zsMs = ok.filter((r) => r.reason === 'classified' || r.reason === 'abstained').map((r) => r.ms).sort((a, b) => a - b);
    if (zsMs.length) entry.zero_shot_latency_ms = { n: zsMs.length, p50: zsMs[Math.floor(0.5 * zsMs.length)], p95: zsMs[Math.min(zsMs.length - 1, Math.floor(0.95 * zsMs.length))] };
    entry.decided_by = ok.reduce((a, r) => { a[r.source] = (a[r.source] || 0) + 1; return a; }, {});
    res[setName] = entry;
    res[`${setName}__rows`] = rows;
  }
  return res;
}

/** Choose 3-way gates on the white-box slice only (maximise Youden's J). */
async function calibrate(classify, model, whitebox) {
  let best = null;
  for (const minScore of [0.35, 0.45, 0.55, 0.65, 0.75]) {
    for (const minMargin of [0.0, 0.05, 0.1, 0.2]) {
      const r = await evaluate('cal', { enabled: true, backend: 'local', classify, model, sensitivityMinScore: minScore, sensitivityMinMargin: minMargin }, { wb: whitebox });
      const j = (r.wb.recall?.rate ?? 0) - (r.wb.false_positive_rate?.rate ?? 0);
      if (!best || j > best.j) best = { j, minScore, minMargin, recall: r.wb.recall?.rate, fpr: r.wb.false_positive_rate?.rate };
    }
  }
  return best;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const whitebox = slicePages('analysis/audit/sensitive_slice.json');
const blackboxFile = flag('blackbox');
const sets = {
  black_box: blackboxFile ? slicePages(blackboxFile) : [],
  benign: benignPages(),
};
if (!sets.black_box.length) console.warn('[S-F] no --blackbox file: recall below is on the benign set only, i.e. there is none. Provide the real crisis/support pages.');
console.log(`[S-F] black-box ${sets.black_box.length} pages, benign ${sets.benign.length} pages`);

const results = [];
results.push(await evaluate('keyword', null, sets));

const hostedUrl = flag('hosted-url');
if (hostedUrl) {
  results.push(await evaluate('hosted-2way', { enabled: true, backend: 'proxy', serviceUrl: hostedUrl, sensitivityHypotheses: 2 }, sets));
}

const localModel = flag('local-model');
const local = await createLocalClassifier({ model: localModel, log: (m) => console.log(m) });
const gates = args.includes('--calibrate')
  ? await calibrate(local.classify, local.modelId, whitebox)
  : { minScore: Number(flag('min-score', 0.45)), minMargin: Number(flag('min-margin', 0.08)) };
console.log(`[S-F] local 3-way gates: ${JSON.stringify(gates)} (calibrated on the white-box slice only: ${args.includes('--calibrate')})`);
results.push({ ...(await evaluate('local-3way', { enabled: true, backend: 'local', classify: local.classify, model: local.modelId, sensitivityMinScore: gates.minScore, sensitivityMinMargin: gates.minMargin }, sets)), gates });

const upper = flag('upper-model');
if (upper) {
  const up = await createLocalClassifier({ model: upper, quantized: false, log: (m) => console.log(m) });
  results.push(await evaluate('upper-bound', { enabled: true, backend: 'local', classify: up.classify, model: up.modelId, sensitivityMinScore: gates.minScore, sensitivityMinMargin: gates.minMargin }, sets));
}

const out = {
  startedAt: new Date().toISOString(),
  note: 'white-box slice used only for gate calibration (L-4); all detector claims come from black_box and benign',
  sets: { black_box: sets.black_box.length, benign: sets.benign.length },
  detectors: results,
};
const outFile = flag('out');
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`wrote ${outFile}`);
}
for (const d of results) {
  console.log(`${d.detector.padEnd(12)} recall ${JSON.stringify(d.black_box?.recall)}  FPR ${JSON.stringify(d.benign?.false_positive_rate)}`);
}
