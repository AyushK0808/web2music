// Paired bootstrap CI for the A4-A5 accuracy gap against the 208-page
// majority-vote label, requested by review: "the gap is a difference of two
// proportions on the same items." Reimplements simulateCascade's exact logic
// from s2_tier_ablation.js (not imported, since that file has no exports)
// against the same per-page raw results already collected in
// results/s2-ablation-majority-a5a7.json, so this is a re-scoring of existing
// data, not a new tier run.
import fs from 'node:fs';

const PROD_MIN_SCORE = 0.45;
const PROD_MIN_MARGIN = 0.10;

function simulateCascade(r, { zeroShotEnabled, minScore = PROD_MIN_SCORE, minMargin = PROD_MIN_MARGIN }) {
  if (r.isSensitive) return r.keyword.primary ?? 'Entertainment';
  if (r.keyword.primary && !r.langSkipsKeyword) return r.keyword.primary;
  const zs = r.zeroShot;
  if (zeroShotEnabled && zs && zs.score >= minScore && zs.margin >= minMargin) return zs.category;
  if (r.llm) return r.llm;
  return 'Entertainment';
}

const d = JSON.parse(fs.readFileSync('./results/s2-ablation-majority-a5a7.json', 'utf8'));
const pages = d.per_page;
console.log('n pages:', pages.length);

const a4Correct = pages.map((r) => (simulateCascade(r, { zeroShotEnabled: false }) === r.true_category ? 1 : 0));
const a5Correct = pages.map((r) => (simulateCascade(r, { zeroShotEnabled: true }) === r.true_category ? 1 : 0));

const a4Acc = a4Correct.reduce((s, v) => s + v, 0) / pages.length;
const a5Acc = a5Correct.reduce((s, v) => s + v, 0) / pages.length;
console.log('A4 accuracy (recomputed):', a4Acc.toFixed(4));
console.log('A5 accuracy (recomputed):', a5Acc.toFixed(4));
console.log('Point gap (A4-A5):', ((a4Acc - a5Acc) * 100).toFixed(2), 'points');

// Paired bootstrap: resample page indices with replacement, recompute both
// accuracies on the SAME resampled indices each time (paired), take the
// difference. This respects that A4 and A5 are scored on the same items.
function bootstrapGapCI(resamples = 10000, seed = 20260828) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const n = pages.length;
  const diffs = [];
  for (let r = 0; r < resamples; r++) {
    let a4sum = 0, a5sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rnd() * n);
      a4sum += a4Correct[idx];
      a5sum += a5Correct[idx];
    }
    diffs.push((a4sum - a5sum) / n);
  }
  diffs.sort((a, b) => a - b);
  const lo = diffs[Math.floor(0.025 * resamples)];
  const hi = diffs[Math.floor(0.975 * resamples)];
  const mean = diffs.reduce((s, v) => s + v, 0) / resamples;
  return { mean, lo, hi };
}

const { mean, lo, hi } = bootstrapGapCI();
console.log(`Paired bootstrap gap (A4-A5): mean ${(mean * 100).toFixed(2)} points, 95% CI [${(lo * 100).toFixed(2)}, ${(hi * 100).toFixed(2)}]`);

// McNemar's test on the discordant pairs (A4 right/A5 wrong vs A4 wrong/A5 right)
let b = 0, c = 0; // b: A4 correct, A5 wrong; c: A4 wrong, A5 correct
for (let i = 0; i < pages.length; i++) {
  if (a4Correct[i] === 1 && a5Correct[i] === 0) b++;
  if (a4Correct[i] === 0 && a5Correct[i] === 1) c++;
}
const chi2 = b + c > 0 ? ((Math.abs(b - c) - 1) ** 2) / (b + c) : 0; // continuity-corrected
console.log(`McNemar discordant pairs: A4-right/A5-wrong=${b}, A4-wrong/A5-right=${c}, chi2(1)=${chi2.toFixed(2)}`);

// Per-page accuracy deltas for the other re-scored tiers, for the arithmetic
// check in the review (A3 and A4's actual gains).
const a1Correct = pages.map((r) => (r.langSkipsKeyword || !r.keyword.primary ? null : (r.keyword.primary === r.true_category ? 1 : 0)));
const a3Correct = pages.map((r) => (r.llm === r.true_category ? 1 : 0));
console.log('A3 accuracy (LLM-only, recomputed):', (a3Correct.reduce((s, v) => s + v, 0) / pages.length).toFixed(4));
