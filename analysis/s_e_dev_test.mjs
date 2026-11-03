#!/usr/bin/env node
/**
 * S-E — dev/test protocol for the cascade (R4 #1).
 *
 *   node analysis/s_e_dev_test.mjs \
 *       --dev   mood-classification/results/s2-ablation-dev.json   \
 *       --test  mood-classification/results/s2-ablation-test.json  \
 *       [--gold-dev analysis/out/gold-dev.json] [--gold-test analysis/out/gold-test.json] \
 *       [--meta analysis/corpus/urls-test.jsonl] [--cutoff 2025-06-01] \
 *       --out analysis/out/s_e_dev_test.json
 *
 * Inputs are the `per_page` raw results written by
 * mood-classification/experiments/s2_tier_ablation.js (--with-a6, gates open),
 * one file for the 255 dev pages and one for the ~350 test pages. This script
 * makes no network calls: it replays the cascade, so every number is a pure
 * function of those two files.
 *
 * The rule it enforces
 *   1. Gate thresholds (zero-shot minScore / minMargin) are CHOSEN on dev only,
 *      by grid search on macro-F1 of the A6b configuration.
 *   2. Every configuration is then scored ONCE on test with those gates.
 *   3. The test file is never read before step 1 has finished.
 *
 * Reported on test, with 95% bootstrap CIs (resampling pages, 10k draws):
 *   macro-F1 and accuracy per configuration; the paired difference
 *   A6b - keyword->LLM; accuracy split by the stage that decided (L-8); and
 *   macro-F1 on pages published after --cutoff (L-6), next to the rest.
 *
 * Gold labels: --gold-* files from analysis/annotate/majority_gold.py (blind
 * author labels). Without them the results' own `true_category` (the category
 * a page was collected for) is used and the output says so.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CATEGORY_KEYWORDS } from '../mood-classification/feature_b/b1_contentUnderstanding.js';

const CATEGORIES = Object.keys(CATEGORY_KEYWORDS);
const PROD = { minScore: 0.45, minMargin: 0.10 };

const args = process.argv.slice(2);
const flag = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const need = (name) => { const v = flag(name); if (!v) { console.error(`missing --${name}`); process.exit(2); } return v; };

// ── Cascade replay (same decision order as resolveContentCategory) ───────────

function cascade(r, { zsField = null, minScore, minMargin, llm = true }) {
  if (r.isSensitive) return { category: r.keyword.primary ?? 'Entertainment', source: 'skipped-sensitive' };
  if (r.keyword.primary && !r.langSkipsKeyword) return { category: r.keyword.primary, source: 'keyword' };
  const zs = zsField ? r[zsField] : null;
  if (zs && zs.score >= minScore && zs.margin >= minMargin) return { category: zs.category, source: 'zero-shot' };
  if (llm && r.llm) return { category: r.llm, source: 'llm' };
  return { category: 'Entertainment', source: 'default' };
}

const CONFIGS = (g) => ({
  keyword_only:   (r) => cascade(r, { ...g, zsField: null, llm: false }),
  keyword_llm:    (r) => cascade(r, { ...g, zsField: null, llm: true }),
  A5_hosted_zs:   (r) => cascade(r, { ...g, zsField: 'zeroShot', llm: true }),
  A6_local_only:  (r) => cascade(r, { ...g, zsField: 'zeroShotLocal', llm: false }),
  A6b_local_llm:  (r) => cascade(r, { ...g, zsField: 'zeroShotLocal', llm: true }),
});

// ── Metrics ──────────────────────────────────────────────────────────────────

function macroF1(pairs) {
  const per = Object.fromEntries(CATEGORIES.map((c) => [c, { tp: 0, fp: 0, fn: 0 }]));
  for (const { truth, pred } of pairs) {
    if (pred === truth) { if (per[truth]) per[truth].tp++; }
    else { if (per[truth]) per[truth].fn++; if (pred && per[pred]) per[pred].fp++; }
  }
  const f1s = [];
  for (const { tp, fp, fn } of Object.values(per)) {
    if (tp + fp + fn === 0) continue;
    const p = tp + fp ? tp / (tp + fp) : 0;
    const rc = tp + fn ? tp / (tp + fn) : 0;
    f1s.push(p + rc ? (2 * p * rc) / (p + rc) : 0);
  }
  return f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null;
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Bootstrap CI of stat(indices) by resampling page indices. */
function bootstrap(n, stat, nBoot = 10000, seed = 7) {
  const rnd = mulberry32(seed);
  const draws = [];
  for (let b = 0; b < nBoot; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(rnd() * n));
    const v = stat(idx);
    if (v != null) draws.push(v);
  }
  draws.sort((a, b) => a - b);
  return draws.length ? [draws[Math.floor(0.025 * draws.length)], draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))]] : null;
}

const r3 = (v) => (v == null ? null : Number(v.toFixed(3)));

// ── Data ─────────────────────────────────────────────────────────────────────

function load(file, goldFile) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).per_page;
  let usedGold = false;
  let gold = null;
  if (goldFile) { gold = JSON.parse(fs.readFileSync(goldFile, 'utf8')).gold; usedGold = true; }
  const out = [];
  for (const r of rows) {
    const truth = gold ? gold[r.id]?.category ?? null : r.true_category;
    if (truth == null) continue; // bypass pages / unlabelled / unresolved ties
    out.push({ ...r, truth });
  }
  return { rows: out, usedGold };
}

function score(rows, decide) {
  const dec = rows.map((r) => ({ truth: r.truth, ...decide(r) }));
  const pairs = dec.map((d) => ({ truth: d.truth, pred: d.category }));
  const acc = pairs.filter((p) => p.pred === p.truth).length / pairs.length;
  const offDevice = dec.filter((d) => d.source === 'llm').length / dec.length;
  return { dec, pairs, macroF1: macroF1(pairs), accuracy: acc, offDevice };
}

// ── Step 1: choose gates on dev ──────────────────────────────────────────────

const dev = load(need('dev'), flag('gold-dev'));
const SCORES = Array.from({ length: 11 }, (_, i) => 0.3 + 0.05 * i);
const MARGINS = Array.from({ length: 7 }, (_, i) => 0.05 * i);
const grid = [];
for (const minScore of SCORES) for (const minMargin of MARGINS) {
  const s = score(dev.rows, CONFIGS({ minScore, minMargin }).A6b_local_llm);
  grid.push({ minScore: r3(minScore), minMargin: r3(minMargin), macroF1: r3(s.macroF1), offDevice: r3(s.offDevice) });
}
// Best macro-F1; ties broken by lower off-device rate, then closeness to production gates.
grid.sort((a, b) => b.macroF1 - a.macroF1 || a.offDevice - b.offDevice
  || (Math.abs(a.minScore - PROD.minScore) + Math.abs(a.minMargin - PROD.minMargin))
   - (Math.abs(b.minScore - PROD.minScore) + Math.abs(b.minMargin - PROD.minMargin)));
const chosen = { minScore: grid[0].minScore, minMargin: grid[0].minMargin };
console.log(`[S-E] gates chosen on dev (n=${dev.rows.length}): minScore=${chosen.minScore} minMargin=${chosen.minMargin} (dev macro-F1 ${grid[0].macroF1})`);

// ── Step 2: score once on test ───────────────────────────────────────────────

const test = load(need('test'), flag('gold-test'));
const metaFile = flag('meta');
const cutoff = flag('cutoff');
const meta = {};
if (metaFile && fs.existsSync(metaFile)) {
  for (const line of fs.readFileSync(metaFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    meta[m.id] = m;
  }
}

const configs = CONFIGS(chosen);
const results = {};
for (const [name, decide] of Object.entries(configs)) {
  const s = score(test.rows, decide);
  const f1Ci = bootstrap(test.rows.length, (idx) => macroF1(idx.map((i) => s.pairs[i])));
  const accCi = bootstrap(test.rows.length, (idx) => idx.filter((i) => s.pairs[i].pred === s.pairs[i].truth).length / idx.length);

  // L-8: accuracy by deciding stage.
  const byStage = {};
  for (const d of s.dec) {
    const e = (byStage[d.source] ??= { n: 0, correct: 0 });
    e.n++; if (d.category === d.truth) e.correct++;
  }
  for (const e of Object.values(byStage)) e.accuracy = r3(e.correct / e.n);

  // L-6: post-cutoff subset.
  let postCutoff = null;
  if (cutoff && Object.keys(meta).length) {
    const post = s.pairs.filter((_, i) => (meta[test.rows[i].id]?.published ?? '') > cutoff);
    const pre = s.pairs.filter((_, i) => { const p = meta[test.rows[i].id]?.published; return p && p <= cutoff; });
    postCutoff = { cutoff, n_post: post.length, macroF1_post: r3(macroF1(post)), n_pre: pre.length, macroF1_pre: r3(macroF1(pre)) };
  }

  results[name] = {
    n: test.rows.length, macroF1: r3(s.macroF1), macroF1_ci95: f1Ci?.map(r3), accuracy: r3(s.accuracy),
    accuracy_ci95: accCi?.map(r3), off_device_rate: r3(s.offDevice), by_stage: byStage, post_cutoff: postCutoff,
  };
}

// Paired differences (same resampled pages for both configurations).
function pairedDiff(a, b) {
  const sa = score(test.rows, configs[a]).pairs;
  const sb = score(test.rows, configs[b]).pairs;
  const stat = (idx) => { const x = macroF1(idx.map((i) => sa[i])), y = macroF1(idx.map((i) => sb[i])); return x != null && y != null ? x - y : null; };
  return { a, b, diff: r3(stat([...sa.keys()])), ci95: bootstrap(sa.length, stat)?.map(r3) };
}
const paired = [pairedDiff('A6b_local_llm', 'keyword_llm'), pairedDiff('A6_local_only', 'keyword_llm'), pairedDiff('A5_hosted_zs', 'keyword_llm')];

const out = {
  protocol: 'gates chosen on dev; every configuration scored once on test',
  labels: { dev: dev.usedGold ? 'blind author majority' : 'collection category (true_category)', test: test.usedGold ? 'blind author majority' : 'collection category (true_category)' },
  chosen_gates: chosen, production_gates: PROD, dev_grid_top5: grid.slice(0, 5),
  test: results, paired_macroF1_differences: paired,
};
const outFile = flag('out');
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`wrote ${outFile}`);
}
console.log(JSON.stringify({ chosen_gates: chosen, test: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { macroF1: v.macroF1, ci: v.macroF1_ci95, off_device: v.off_device_rate }])), paired }, null, 2));
