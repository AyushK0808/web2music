#!/usr/bin/env node
/**
 * C-13 — emit N participants' session assignments as JSON on stdout.
 *
 *   node analysis/s4/build_sessions.mjs --n 56 --pages '[{"id":"p0",...}]'
 *   node analysis/s4/build_sessions.mjs --n 56 --pages-file analysis/s4/pages.json
 *
 * A thin shell around assignment.mjs so the study runner, the simulator and
 * any future analysis all build sessions from one implementation. The
 * simulation in simulate_and_check.py calls this rather than reimplementing
 * the design in Python — a parallel implementation would let the check pass
 * against a design the study does not actually run.
 */

import fs from 'node:fs';
import { buildSession, shuffleNearMissRate } from './assignment.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const n = parseInt(flag('n', '56'), 10);
const pagesFile = flag('pages-file', null);
const pagesJson = flag('pages', null);
const prefix = flag('prefix', 'p');

const pages = pagesFile
  ? JSON.parse(fs.readFileSync(pagesFile, 'utf8'))
  : JSON.parse(pagesJson || '[]');

if (!pages.length) {
  console.error('No pages. Pass --pages-file or --pages with '
    + '[{"id","url","trueMood","comprehension"}].');
  process.exit(2);
}

const sessions = Array.from({ length: n }, (_, i) => buildSession({
  participantId: `${prefix}${String(i + 1).padStart(3, '0')}`,
  participantIndex: i,
  pages,
}));

if (args.includes('--summary')) {
  const nm = shuffleNearMissRate(sessions);
  console.error(`${n} sessions, ${pages.length} pages/block`);
  console.error(`shuffled near-miss rate ${(nm.near_miss_rate * 100).toFixed(1)}% over `
    + `${nm.n_trials} trials (min distance ${nm.min_distance.toFixed(3)}, `
    + `median ${nm.median_distance.toFixed(3)})`);
}

process.stdout.write(JSON.stringify(sessions));
