#!/usr/bin/env node
/**
 * s3_signal_ablation.js — C-08 / plan §7 ablation 1: does the multimodal input
 * earn its complexity, or is text doing all the work?
 *
 *   node mood-classification/experiments/s3_signal_ablation.js \
 *     --corpus analysis/corpus/s2_corpus.json --out mood-classification/results/s3-signals.json
 *   node mood-classification/experiments/s3_signal_ablation.js --corpus <smoke> --offline
 *
 * Feature A hands Feature B four kinds of signal: page text, page colours,
 * browsing behaviour, and a sentence embedding. Only the first is obviously
 * load-bearing. This runs the real pipeline over the frozen corpus with each
 * signal removed in turn and reports what each one is worth.
 *
 * This is the question a reviewer *will* ask, and if colour and behaviour
 * contribute nothing we should find that out ourselves and say so — a
 * multimodal system whose extra modes do no work is a finding, not a secret.
 *
 * ── The behaviour condition needs stating carefully ────────────────────────
 * The frozen corpus deliberately does not store scrollSpeed/cursorSpeed: they
 * describe the person who ran the capture, not the page (see C-04's
 * normalisePageData). So the honest ablation here is not "with vs without real
 * behaviour" — that data does not exist offline and cannot be reconstructed.
 * It is "with a synthetic behaviour profile vs without any", which measures
 * *how much the pipeline's output moves when behaviour is present at all*.
 * That bounds the signal's influence without pretending to measure its
 * accuracy contribution. The real version needs S5 telemetry, and the script
 * says so rather than quietly substituting one question for the other.
 *
 * ── --offline ──────────────────────────────────────────────────────────────
 * Skips both LLM tiers, so every page is decided by the keyword tier or the
 * default. Accuracy under --offline is not comparable to the shipped cascade,
 * but the *deltas between signal conditions* still are, and it runs with no
 * services up and no API spend.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runB1 } from '../feature_b/b1_contentUnderstanding.js';
import { runB2 } from '../feature_b/b2_moodClassifier.js';
import { CATEGORY_KEYWORDS } from '../feature_b/b1_contentUnderstanding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const OFFLINE = args.includes('--offline');
const CORPUS = flag('corpus', 'analysis/corpus/s2_corpus.json');
const OUT = flag('out', 'mood-classification/results/s3-signals.json');
const CLASSIFY_SERVICE_URL = process.env.CLASSIFY_SERVICE_URL || 'http://localhost:8078';

const CATEGORIES = Object.keys(CATEGORY_KEYWORDS);

/** A fixed synthetic browsing profile — see the header note on why. */
const SYNTHETIC_BEHAVIOUR = { scrollSpeed: 220, cursorSpeed: 340, dwellTime: 45_000 };

/**
 * The conditions. Each is a transform on the stored pageData.
 *
 * "full" restores the synthetic behaviour so that the minus-behaviour
 * condition has something to be minus *of*; without that, "full" and
 * "-behaviour" would be identical records and the row would silently read as
 * "behaviour contributes exactly nothing" for the wrong reason.
 */
const CONDITIONS = {
  full: (pd) => ({ ...pd, ...SYNTHETIC_BEHAVIOUR }),
  text_only: (pd) => ({
    rawText: pd.rawText, title: pd.title, description: pd.description,
    url: pd.url, lang: pd.lang, handoffVersion: pd.handoffVersion,
  }),
  minus_colour: (pd) => { const o = { ...pd, ...SYNTHETIC_BEHAVIOUR }; delete o.colors; delete o.colorEnergy; return o; },
  minus_behaviour: (pd) => ({ ...pd }),           // stored corpus already has none
  minus_embedding: (pd) => { const o = { ...pd, ...SYNTHETIC_BEHAVIOUR }; delete o.embedding; delete o.similarPages; delete o.nearestScore; return o; },
};

function llmConfig() {
  if (OFFLINE) return '';   // falsy key -> both tiers decline, no network
  return { backend: 'proxy', serviceUrl: `${CLASSIFY_SERVICE_URL}/v1/chat/completions` };
}

function macroF1(predictions, classes) {
  const per = Object.fromEntries(classes.map((c) => [c, { tp: 0, fp: 0, fn: 0 }]));
  for (const { truth, pred } of predictions) {
    if (pred === truth) { if (per[truth]) per[truth].tp++; }
    else { if (per[truth]) per[truth].fn++; if (pred && per[pred]) per[pred].fp++; }
  }
  const f1s = [];
  for (const c of classes) {
    const { tp, fp, fn } = per[c];
    if (tp + fp + fn === 0) continue;
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    f1s.push(p + r ? (2 * p * r) / (p + r) : 0);
  }
  return f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null;
}

const round = (v, d = 3) => (v === null || v === undefined ? null : Number(v.toFixed(d)));

async function runCondition(name, pages) {
  const rows = [];
  for (const page of pages) {
    const pd = CONDITIONS[name](page.pageData);
    let b1 = null, b2 = null, error = null;
    try {
      b1 = await runB1(pd, llmConfig(), { zeroShot: { enabled: false } });
      b2 = await runB2(b1, llmConfig());
    } catch (e) {
      error = e.message;
    }
    // runB1 returns category as an object {primary, secondary, scores, source},
    // not a string. Comparing the objects directly compares references, so
    // every condition would read as "agrees with full on 0% of pages" — a
    // number that looks like a dramatic finding and is actually a type error.
    const cat = b1?.category;
    rows.push({
      id: page.id,
      true_category: page.true_category ?? null,
      true_mood: page.true_mood ?? null,
      category: typeof cat === 'string' ? cat : (cat?.primary ?? null),
      category_source: typeof cat === 'string' ? null : (cat?.source ?? null),
      is_sensitive: b1?.isSensitive ?? null,
      mood: b2?.mood ?? null,
      energy: b2?.energyHint ?? null,
      valence: b2?.valenceHint ?? null,
      tier: b2?.tier ?? null,
      error,
    });
  }
  return rows;
}

function summarise(name, rows, baseline) {
  const labelled = rows.filter((r) => r.true_category);
  const catF1 = labelled.length
    ? macroF1(labelled.map((r) => ({ truth: r.true_category, pred: r.category })), CATEGORIES)
    : null;

  // Agreement with the full condition. This is the number that carries the
  // ablation when the corpus has no ground truth yet: "removing colour changes
  // the mood on 3% of pages" is a real, reportable bound on a signal's
  // influence, and it needs no annotation to compute.
  let categoryAgreement = null, moodAgreement = null;
  if (baseline) {
    const base = Object.fromEntries(baseline.map((r) => [r.id, r]));
    const both = rows.filter((r) => base[r.id]);
    categoryAgreement = both.filter((r) => r.category === base[r.id].category).length / both.length;
    moodAgreement = both.filter((r) => r.mood === base[r.id].mood).length / both.length;
  }

  const moodCounts = {};
  for (const r of rows) moodCounts[r.mood ?? 'null'] = (moodCounts[r.mood ?? 'null'] || 0) + 1;

  return {
    condition: name,
    n: rows.length,
    n_errors: rows.filter((r) => r.error).length,
    macro_f1_category: round(catF1),
    n_labelled: labelled.length,
    category_agreement_with_full: round(categoryAgreement),
    mood_agreement_with_full: round(moodAgreement),
    mood_distribution: moodCounts,
    sensitive_rate: round(rows.filter((r) => r.is_sensitive).length / rows.length),
  };
}

async function main() {
  const corpusPath = path.resolve(REPO, CORPUS);
  if (!fs.existsSync(corpusPath)) {
    console.error(`No corpus at ${corpusPath}.\n`
      + `Capture one first (C-04):\n`
      + `  node analysis/corpus/capture_corpus.mjs --urls analysis/corpus/urls.jsonl\n`
      + `The runner is ready; this is the data it is waiting on (D-01).`);
    process.exit(2);
  }

  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const pages = (corpus.pages || []).filter((p) => p.pageData);
  if (!pages.length) { console.error('corpus has no pages with extracted pageData'); process.exit(2); }

  console.log(`\n[s3_signal_ablation] ${pages.length} page(s) from ${path.relative(REPO, corpusPath)}`
    + `${OFFLINE ? '  (OFFLINE — no LLM tiers)' : ''}`);
  if (!corpus.pages.some((p) => p.true_category)) {
    console.log('  No ground-truth labels in this corpus: macro-F1 will be null and the '
      + 'ablation is reported as agreement-with-full only. That is still a real bound on '
      + 'each signal, and it does not wait on D-02.');
  }

  const results = {};
  let baseline = null;
  for (const name of Object.keys(CONDITIONS)) {
    process.stdout.write(`  ${name.padEnd(18)} `);
    const started = Date.now();
    const rows = await runCondition(name, pages);
    if (name === 'full') baseline = rows;
    const s = summarise(name, rows, name === 'full' ? null : baseline);
    results[name] = { ...s, rows, elapsed_ms: Date.now() - started };
    console.log(`macro-F1 ${String(s.macro_f1_category ?? '—').padStart(6)}   `
      + `category agrees ${String(s.category_agreement_with_full ?? '—').padStart(6)}   `
      + `mood agrees ${String(s.mood_agreement_with_full ?? '—').padStart(6)}   `
      + `(${Date.now() - started} ms)`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('SIGNAL ABLATION — what each input is worth');
  console.log('='.repeat(78));
  for (const [name, s] of Object.entries(results)) {
    if (name === 'full') continue;
    const cat = s.category_agreement_with_full, mood = s.mood_agreement_with_full;
    const verdict = (cat === 1 && mood === 1)
      ? 'changes NOTHING — this signal is currently decorative'
      : `moves category on ${((1 - cat) * 100).toFixed(1)}% and mood on ${((1 - mood) * 100).toFixed(1)}% of pages`;
    console.log(`  ${name.padEnd(18)} ${verdict}`);
  }
  console.log('\nThe behaviour row measures presence-vs-absence of a synthetic profile, not the');
  console.log('accuracy contribution of real browsing behaviour — the frozen corpus deliberately');
  console.log('does not carry the capture operator\'s mouse movements. S5 is where that is measured.');
  console.log('='.repeat(78));

  const outFile = path.resolve(REPO, OUT);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    generated_at: new Date().toISOString(),
    corpus: path.relative(REPO, corpusPath),
    offline: OFFLINE,
    synthetic_behaviour: SYNTHETIC_BEHAVIOUR,
    conditions: Object.fromEntries(Object.entries(results).map(([k, v]) => {
      const { rows, ...summary } = v;
      return [k, summary];
    })),
    per_page: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.rows])),
  }, null, 2));
  console.log(`\nWrote ${path.relative(REPO, outFile)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
