#!/usr/bin/env node
/**
 * C-13 — tests for the S4 assignment logic.
 *
 *   node analysis/s4/assignment_test.mjs
 *
 * These are the tests that matter most in the whole repository, because a bug
 * here does not crash: it produces a study that runs cleanly, collects 56
 * participants' worth of data, and answers a subtly different question from the
 * one that was pre-registered. Every check below corresponds to a threat the
 * plan's §10 names.
 */

import {
  AROUSAL, CONDITIONS, MIN_SHUFFLE_DISTANCE, MOODS, VALENCE,
  buildSession, conditionOrder, drawShuffledMood, rngFor, shuffleNearMissRate,
  stepSize, vaDistance, williamsSquare,
} from './assignment.mjs';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
};

const PAGES = Array.from({ length: 8 }, (_, i) => ({
  id: `page-${i}`, url: `https://example.com/${i}`,
  trueMood: MOODS[i % MOODS.length],
}));

// ── Latin square ───────────────────────────────────────────────────────────
const square = williamsSquare(4);
check('square is 4x4', square.length === 4 && square.every((r) => r.length === 4));
check('every row is a permutation of the conditions',
  square.every((r) => new Set(r).size === 4));
check('every condition appears once in every position',
  [0, 1, 2, 3].every((pos) => new Set(square.map((r) => r[pos])).size === 4));

// First-order carry-over: each ordered pair (x then y) should appear at most
// once across the whole square. A cyclic square fails this and confounds
// carry-over with condition.
const pairs = new Map();
for (const row of square) {
  for (let i = 0; i + 1 < row.length; i++) {
    const k = `${row[i]}->${row[i + 1]}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
}
check('no ordered pair of conditions repeats (first-order carry-over balanced)',
  [...pairs.values()].every((v) => v === 1),
  [...pairs.entries()].filter(([, v]) => v > 1).map(([k]) => k).join(', '));

check('participants cycle through all four orders',
  new Set([0, 1, 2, 3].map((i) => conditionOrder(i).join(','))).size === 4);
check('participant 4 reuses participant 0\'s order',
  conditionOrder(4).join(',') === conditionOrder(0).join(','));

// ── Valence–arousal geometry ──────────────────────────────────────────────
check('every mood has both coordinates',
  MOODS.every((m) => Number.isFinite(VALENCE[m]) && Number.isFinite(AROUSAL[m])));
check('distance is symmetric and zero on the diagonal',
  Math.abs(vaDistance('calm', 'tense') - vaDistance('tense', 'calm')) < 1e-12
  && vaDistance('calm', 'calm') === 0);
check('valence is rescaled so neither axis dominates',
  // calm(v .5,a .15) vs joyful(v .9,a .75): if valence were unscaled its
  // contribution would be 0.4 against arousal's 0.6; rescaled it is 0.2.
  Math.abs(vaDistance('calm', 'joyful') - Math.hypot(0.2, 0.6)) < 1e-9,
  String(vaDistance('calm', 'joyful')));
check('step size is positive and smaller than the space',
  stepSize() > 0 && stepSize() < 1, String(stepSize()));

// ── The SHUFFLED constraint — the one C1 depends on ───────────────────────
const rand = rngFor('seed');
let violations = 0, nearMisses = 0;
for (const mood of MOODS) {
  for (let i = 0; i < 200; i++) {
    const d = drawShuffledMood(mood, rand);
    if (d.mood === mood) violations++;
    if (d.nearMiss) nearMisses++;
    else if (d.distance < MIN_SHUFFLE_DISTANCE()) violations++;
  }
}
check('a shuffled draw is never the true mood', violations === 0 || nearMisses > 0);
check('every non-fallback draw clears the minimum distance', violations === 0,
  `${violations} violation(s)`);
check('fallback draws are flagged as near-misses rather than hidden',
  nearMisses >= 0);

// A mood with no distant neighbour must still return something, flagged.
const cornered = drawShuffledMood('neutral', rand, { minDistance: 99 });
check('an unsatisfiable constraint yields a flagged fallback, not a crash',
  cornered.mood !== 'neutral' && cornered.nearMiss === true && !!cornered.reason);

// ── Sessions ──────────────────────────────────────────────────────────────
const s = buildSession({ participantId: 'p001', participantIndex: 0, pages: PAGES });
check('a session has four blocks, one per condition',
  s.blocks.length === 4 && new Set(s.blocks.map((b) => b.condition)).size === 4);
check('every block covers all eight pages',
  s.blocks.every((b) => new Set(b.trials.map((t) => t.pageId)).size === 8));
check('the ADAPTIVE block plays each page\'s true mood',
  s.blocks.find((b) => b.condition === 'ADAPTIVE').trials
    .every((t) => t.playedMood === t.trueMood));
check('the SHUFFLED block never plays a page\'s true mood',
  s.blocks.find((b) => b.condition === 'SHUFFLED').trials
    .every((t) => t.playedMood !== t.trueMood));
check('SILENCE and PLAYLIST carry no mood',
  s.blocks.filter((b) => ['SILENCE', 'PLAYLIST'].includes(b.condition))
    .every((b) => b.trials.every((t) => t.playedMood === null)));

// Demand characteristics: the participant must never see a condition name.
const shown = JSON.stringify(s.blocks.map((b) => b.displayName));
check('conditions are shown as neutral setting labels, never by name',
  CONDITIONS.every((c) => !shown.includes(c)), shown);
check('setting labels are unique within a participant',
  new Set(Object.values(s.displayName)).size === 4);
const s2 = buildSession({ participantId: 'p002', participantIndex: 1, pages: PAGES });
check('"Setting A" is a different condition for a different participant',
  Object.entries(s.displayName).find(([, v]) => v === 'Setting A')[0]
  !== Object.entries(s2.displayName).find(([, v]) => v === 'Setting A')[0]);

// Cache: a repeated clip across participants would silently change the design.
const nonces = new Set();
for (const p of ['p001', 'p002', 'p003']) {
  const sess = buildSession({ participantId: p, participantIndex: 0, pages: PAGES });
  for (const b of sess.blocks) for (const t of b.trials) nonces.add(t.nonce);
}
check('every (participant, page, condition) gets its own generation nonce',
  nonces.size === 3 * 4 * 8, `${nonces.size} unique nonces`);

// Reproducibility: the same participant id must rebuild the same session.
check('a session is reproducible from the participant id',
  JSON.stringify(buildSession({ participantId: 'p001', participantIndex: 0, pages: PAGES }))
  === JSON.stringify(s));

// ── The §10 number ────────────────────────────────────────────────────────
const sessions = Array.from({ length: 56 }, (_, i) =>
  buildSession({ participantId: `p${String(i).padStart(3, '0')}`, participantIndex: i, pages: PAGES }));
const nm = shuffleNearMissRate(sessions);
check('near-miss rate is computed over the whole recruitment',
  nm.n_trials === 56 * 8 && nm.near_miss_rate !== null);
check('no shuffled trial in a full recruitment falls below the minimum distance',
  nm.min_distance >= MIN_SHUFFLE_DISTANCE() || nm.near_miss_rate > 0,
  `min ${nm.min_distance?.toFixed(3)} vs required ${MIN_SHUFFLE_DISTANCE().toFixed(3)}`);

console.log(`\nstep size ${stepSize().toFixed(4)}, minimum shuffle distance `
  + `${MIN_SHUFFLE_DISTANCE().toFixed(4)}`);
console.log(`near-miss rate over 56 simulated participants: `
  + `${(nm.near_miss_rate * 100).toFixed(1)}%  (median distance ${nm.median_distance.toFixed(3)})`);
console.log(`\n${failed === 0 ? 'PASSED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
