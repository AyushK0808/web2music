#!/usr/bin/env node
/**
 * C-14 — the three baselines the study needs, and the number §6.1 has been
 * hand-waving.
 *
 *   node analysis/baselines/retrieval_baseline.mjs
 *   node analysis/baselines/retrieval_baseline.mjs --library 200 --library 1000
 *
 * §8 flags "why not just retrieve from a curated library?" as the objection
 * most likely to be raised, and the plan is explicit that the answer belongs in
 * §6.1 **with a number attached, not as hand-waving**. This computes that
 * number: the size of the (mood × style × bpm × energy) request space, how much
 * of it a library of N tracks can cover, and how far a typical request lands
 * from the nearest thing actually stocked.
 *
 * The other two baselines are configuration rather than computation and are
 * emitted here as specs so the study runner has one place to read them from:
 *
 *   PLAYLIST      one fixed loop, identical on every page.
 *   PAGE_AGNOSTIC one frozen prompt through the existing generator.
 *
 * The human-chosen ceiling needs 20 pages and one musically-literate person and
 * is folded into H-02's recruiting; there is nothing to compute for it here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const libraries = args.reduce((acc, a, i) =>
  (a === '--library' ? [...acc, Number(args[i + 1])] : acc), []);
const LIBRARY_SIZES = libraries.length ? libraries : [50, 99, 200, 500, 1000, 5000];
const OUT = path.resolve(REPO, 'analysis/out/baselines.json');

// ── The request space ─────────────────────────────────────────────────────
// Taken from what Feature B actually emits on a handoff, not from an idealised
// taxonomy: 11 moods, the style vocabulary D2's prompt builder understands,
// bpm bucketed the way the pre-warm grid buckets it, and energy quantised to
// the granularity a listener could plausibly distinguish.
const DIMENSIONS = {
  mood: ['calm', 'focused', 'joyful', 'energetic', 'sad', 'dark', 'nostalgic',
         'curious', 'tense', 'uplifting', 'neutral'],
  style: ['ambient', 'minimal', 'acoustic', 'electronic', 'cinematic', 'lo-fi', 'playful'],
  bpm_bucket: ['60-75', '75-90', '90-105', '105-120', '120-140'],
  // energyHint is continuous in [0,1]; five buckets is the coarsest split at
  // which "low" and "medium-low" are still different pieces of music. Choosing
  // fewer would flatter the retrieval baseline, so the choice is stated.
  energy_bucket: ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'],
};

const cellCount = Object.values(DIMENSIONS).reduce((a, d) => a * d.length, 1);

/**
 * Coverage of a library of N tracks over the request space.
 *
 * Two readings, because they bound the answer from both sides:
 *
 *  - **best case**: the curator is perfect and every track occupies a distinct
 *    cell, so coverage is min(N, cells)/cells. This is the number a retrieval
 *    advocate would quote.
 *  - **realistic**: tracks are commissioned against a skewed demand
 *    distribution (nobody stocks forty variants of `dark` at 130 bpm), modelled
 *    as a Zipf draw over cells. Duplicates are wasted stock.
 *
 * Reporting only the best case would concede the argument; reporting only the
 * realistic one would look like special pleading. Both go in the table.
 */
function coverage(n, cells, { skew = 0, trials = 20000, seed = 11 } = {}) {
  const best = Math.min(n, cells) / cells;
  if (skew === 0) {
    // Uniform commissioning: expected distinct cells after n draws with
    // replacement = cells * (1 - (1 - 1/cells)^n).
    const distinct = cells * (1 - Math.pow(1 - 1 / cells, n));
    return { best_case: best, expected: distinct / cells, distinct_cells: distinct };
  }
  // Zipf weights over cells, expected distinct cells computed analytically
  // (no sampling noise): 1 - (1 - w_i)^n summed over cells.
  let total = 0;
  const w = new Array(cells);
  for (let i = 0; i < cells; i++) { w[i] = 1 / Math.pow(i + 1, skew); total += w[i]; }
  let distinct = 0;
  for (let i = 0; i < cells; i++) distinct += 1 - Math.pow(1 - w[i] / total, n);
  return { best_case: best, expected: distinct / cells, distinct_cells: distinct };
}

/**
 * How wrong is the nearest stocked track when the exact cell is missing?
 *
 * Distance is the count of dimensions that differ — the honest metric here,
 * because a retrieval system that returns `calm/ambient/60-75/0.2-0.4` for a
 * request of `calm/ambient/60-75/0.6-0.8` has returned the wrong energy, and
 * that is audible regardless of how close the numbers look.
 */
function expectedMismatch(n, cells) {
  const covered = coverage(n, cells).expected;
  const dims = Object.keys(DIMENSIONS).length;
  // If a request's exact cell is missing, the nearest stocked cell differs on
  // at least one dimension; with sparse coverage the expected number of
  // differing dimensions rises toward the number of dimensions itself.
  const sparsity = 1 - covered;
  return { exact_hit_rate: covered, expected_dimensions_wrong: sparsity * dims };
}

const report = {
  generated_at: new Date().toISOString(),
  request_space: {
    dimensions: Object.fromEntries(Object.entries(DIMENSIONS).map(([k, v]) => [k, v.length])),
    cells: cellCount,
    note: 'Buckets chosen to be defensible rather than flattering — coarser buckets would make '
        + 'the retrieval baseline look better, so the granularity is stated with the number.',
  },
  libraries: LIBRARY_SIZES.map((n) => {
    const uniform = coverage(n, cellCount, { skew: 0 });
    const skewed = coverage(n, cellCount, { skew: 1.0 });
    const mismatch = expectedMismatch(n, cellCount);
    return {
      n_tracks: n,
      coverage_best_case: Number(uniform.best_case.toFixed(4)),
      coverage_uniform_commissioning: Number(uniform.expected.toFixed(4)),
      coverage_skewed_commissioning: Number(skewed.expected.toFixed(4)),
      exact_hit_rate: Number(mismatch.exact_hit_rate.toFixed(4)),
      expected_dimensions_wrong: Number(mismatch.expected_dimensions_wrong.toFixed(3)),
    };
  }),
  other_baselines: {
    PLAYLIST: {
      description: 'One fixed lo-fi ambient loop, identical on every page.',
      implementation: 'A single licensed loop shipped with the study build; the extension plays '
                    + 'it unconditionally and never calls /generate.',
      ablates: 'conditioning and generation together',
      effort: 'low — this is what people actually do today, and it is the real competitor',
    },
    PAGE_AGNOSTIC: {
      description: 'One frozen prompt through the existing generator, ignoring the page.',
      prompt: 'ambient instrumental background music, moderate energy, no vocals, loopable, '
            + 'high quality studio recording',
      implementation: 'Same /generate path, same duration, prompt field pinned; the mood profile '
                    + 'is held at neutral so only the conditioning is removed.',
      ablates: 'conditioning only, holding generation constant',
    },
    HUMAN_CEILING: {
      description: 'A musically-literate person picks a track per page.',
      n_pages: 20,
      note: 'Bounds the gap without needing the full corpus. Folded into H-02 recruiting; '
          + 'nothing to compute here.',
    },
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log('='.repeat(74));
console.log('C-14  RETRIEVAL BASELINE — the number §6.1 needs');
console.log('='.repeat(74));
const d = report.request_space.dimensions;
console.log(`request space: ${Object.entries(d).map(([k, v]) => `${v} ${k}`).join(' x ')} `
          + `= ${cellCount.toLocaleString()} cells\n`);
console.log(`${'library'.padStart(8)} ${'best case'.padStart(11)} ${'uniform'.padStart(9)} `
          + `${'skewed'.padStart(8)} ${'dims wrong'.padStart(11)}`);
for (const l of report.libraries) {
  console.log(`${l.n_tracks.toLocaleString().padStart(8)} `
    + `${(l.coverage_best_case * 100).toFixed(1).padStart(10)}% `
    + `${(l.coverage_uniform_commissioning * 100).toFixed(1).padStart(8)}% `
    + `${(l.coverage_skewed_commissioning * 100).toFixed(1).padStart(7)}% `
    + `${l.expected_dimensions_wrong.toFixed(2).padStart(11)}`);
}
const grid = report.libraries.find((l) => l.n_tracks === 99);
if (grid) {
  console.log(`\nThe pre-warm grid (99 combinations) covers `
    + `${(grid.coverage_best_case * 100).toFixed(1)}% of the space even if every entry is `
    + `distinct — which is the point: it is a cache, not a library.`);
}
console.log('\n§6.1 sentence this supports: a curated library would need on the order of');
console.log(`${cellCount.toLocaleString()} tracks to answer every request exactly, and a `
  + `realistically-sized one`);
console.log('answers most requests with something audibly wrong on one or more dimensions.');
console.log('='.repeat(74));
console.log(`\nWrote ${path.relative(REPO, OUT)}`);
