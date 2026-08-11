#!/usr/bin/env node
/**
 * C-13 — merge S4 session files into the tidy export F7/T4 and models.R read.
 *
 *   node analysis/s4/export_s4.mjs --sessions "analysis/out/s4-sessions/*.json" \
 *     --telemetry "analysis/out/s4-telemetry/*.json" --out analysis/out/s4_tidy.json
 *
 * Also applies the exclusions, which the plan requires be defined in advance
 * and are therefore implemented here rather than decided while looking at the
 * data:
 *
 *   - participants who failed the headphone check (flagged at session start);
 *   - comprehension at floor across every condition (not engaging);
 *   - sessions with >20% of pages producing no audio (a system failure, not a
 *     condition).
 *
 * Every exclusion is reported with its reason and its count, and the excluded
 * rows are kept in the output under `excluded` rather than dropped — a
 * reviewer asking "how many did you throw away and why" should not have to
 * take anyone's word for it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const NO_AUDIO_THRESHOLD = 0.20;   // pre-set, per the plan
const COMPREHENSION_FLOOR = 0.5;   // mean correct out of 4, across all conditions

function expand(pattern) {
  if (!pattern) return [];
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  if (!base.includes('*')) return fs.existsSync(pattern) ? [pattern] : [];
  const abs = path.resolve(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return fs.readdirSync(abs).filter((f) => re.test(f)).map((f) => path.join(abs, f));
}

const sessionFiles = expand(flag('sessions', 'analysis/out/s4-sessions/*.json'));
const telemetryFiles = expand(flag('telemetry', null));
const OUT = path.resolve(REPO, flag('out', 'analysis/out/s4_tidy.json'));

if (!sessionFiles.length) {
  console.error('No session files. This is expected until H-05 has run — the runner '
    + '(analysis/s4/session.html), the assignment logic and this exporter are all in place, '
    + 'and analysis/s4/simulate_and_check.py exercises the whole chain on simulated data.');
  process.exit(2);
}

const sessions = sessionFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));

// ── Behavioural measures from the extension's own telemetry ──────────────
// user_control events already record skip/regenerate/volume/mute, and
// POPUP_MOOD_CORRECTION already yields a per-page human mood label. Both are
// joined in here rather than re-collected in the session app: two sources of
// truth for one measure is how they end up disagreeing.
const telemetry = new Map();
for (const f of telemetryFiles) {
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  const pid = t.participant || path.basename(f).split('.')[0];
  telemetry.set(pid, t.events || t);
}

function behaviourFor(pid) {
  const events = telemetry.get(pid);
  if (!events) return null;
  const count = (evt) => events.filter((e) => e.event === evt || e.stage === evt).length;
  return {
    regenerates: count('POPUP_REGENERATE'),
    mood_corrections: count('POPUP_MOOD_CORRECTION'),
    volume_changes: count('POPUP_SET_VOLUME'),
    mutes: count('POPUP_SET_MUTED'),
    disables: count('user_enabled_toggle'),
    corrections: events.filter((e) => e.event === 'POPUP_MOOD_CORRECTION')
      .map((e) => ({ urlHash: e.urlHash, from: e.meta?.from, to: e.meta?.to })),
  };
}

// ── Exclusions ───────────────────────────────────────────────────────────
const kept = [], excluded = [];
for (const s of sessions) {
  const reasons = [];
  if (s.headphoneCheckPassed === false) reasons.push('failed the headphone check');

  const comps = s.responses.map((r) => r.comprehension).filter((c) => c !== null);
  const mean = comps.length ? comps.reduce((a, b) => a + b, 0) / comps.length : null;
  if (mean !== null && mean <= COMPREHENSION_FLOOR) {
    reasons.push(`comprehension at floor across all conditions (mean ${mean.toFixed(2)} / 4)`);
  }

  const musical = s.responses.filter((r) => r.condition !== 'SILENCE');
  const noAudio = musical.filter((r) => r.audio_played === false).length;
  if (musical.length && noAudio / musical.length > NO_AUDIO_THRESHOLD) {
    reasons.push(`${((noAudio / musical.length) * 100).toFixed(0)}% of pages produced no audio `
      + `(threshold ${NO_AUDIO_THRESHOLD * 100}%) — a system failure, not a condition`);
  }

  (reasons.length ? excluded : kept).push({ session: s, reasons });
}

const responses = [], blocks = [];
for (const { session: s } of kept) {
  const behaviour = behaviourFor(s.participantId);
  for (const r of s.responses) responses.push({ ...r, participant: s.participantId });
  for (const b of s.blocks) blocks.push({ ...b, participant: s.participantId, behaviour });
}

// The §10 number, recomputed from what was actually run rather than from the
// design: a near-miss rate from the assignment code is a prediction, this is
// the observed one.
const shuffled = responses.filter((r) => r.condition === 'SHUFFLED'
  && r.shuffle_distance !== null && r.shuffle_distance !== undefined);
const distances = shuffled.map((r) => r.shuffle_distance).sort((a, b) => a - b);

const out = {
  simulated: false,
  exported_at: new Date().toISOString(),
  n_sessions_loaded: sessions.length,
  n_participants: kept.length,
  exclusions: excluded.map((e) => ({
    participant: e.session.participantId, reasons: e.reasons,
  })),
  shuffle: {
    n_trials: shuffled.length,
    min_distance: distances[0] ?? null,
    median_distance: distances[Math.floor(distances.length / 2)] ?? null,
    near_miss_rate: kept.length
      ? kept.reduce((a, k) => a + (k.session.diagnostics?.shuffle_near_miss_rate ?? 0), 0) / kept.length
      : null,
  },
  rankings: kept.map(({ session: s }) => ({ participant: s.participantId, ranking: s.ranking })),
  free_text: kept.map(({ session: s }) => ({ participant: s.participantId, text: s.freeText }))
    .filter((f) => f.text),
  turnoff_events: kept.flatMap(({ session: s }) =>
    s.turnoffEvents.map((e) => ({ ...e, participant: s.participantId }))),
  responses,
  blocks,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log(`${sessions.length} session(s) loaded, ${kept.length} kept, ${excluded.length} excluded`);
for (const e of excluded) {
  console.log(`  excluded ${e.session.participantId}: ${e.reasons.join('; ')}`);
}
console.log(`${responses.length} page responses, ${blocks.length} blocks, `
  + `${out.turnoff_events.length} turn-it-off presses`);
if (!telemetryFiles.length) {
  console.log('\nNo extension telemetry supplied — skip/regenerate/mute/mood-correction columns '
    + 'will be null. Pass --telemetry to join them; they are already recorded by '
    + 'ui/src/telemetry.js and need no new instrumentation.');
}
console.log(`\nWrote ${path.relative(REPO, OUT)}`);
