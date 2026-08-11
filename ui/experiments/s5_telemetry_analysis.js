#!/usr/bin/env node
/**
 * s5_telemetry_analysis.js — §5.6 / C5: turn exported telemetry rings into
 * the in-the-wild numbers plan §3 S5 asks for.
 *
 * Plan §13 step 11 (S5 deployment) is blocked on ethics approval and
 * recruiting 12-15 participants — nothing here can substitute for that. But
 * `ui/src/telemetry.js`'s ring buffer, the popup export button, and every
 * event this script consumes were already fully implemented and unit-tested
 * before this script existed (confirmed by reading background.entry.js's
 * recordTelemetry call sites) — the plan's Appendix A itself says so
 * ("Telemetry ring buffer: Implemented ... no analysis script yet"). This is
 * that analysis script, so the deployment has somewhere to send its output
 * on day one instead of that being built after the fact under time pressure.
 *
 * Input: one or more JSON files, each shaped exactly like
 * `exportTelemetry()`'s return value — { sessionId, exportedAt, events }.
 * One file per participant-session is the expected shape (the popup's
 * export button produces exactly one), so pass every export from every
 * participant and every session as separate files; this script does the
 * cross-file aggregation.
 *
 * Usage:
 *   node experiments/s5_telemetry_analysis.js export1.json export2.json ...
 *   node experiments/s5_telemetry_analysis.js --glob "exports/*.json" --out results/s5-wild.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function round(v, d = 3) {
  return v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(d));
}

function loadExports(files) {
  const exports = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(raw.events)) {
      console.warn(`[s5_telemetry_analysis] ${f}: no events[] array, skipping`);
      continue;
    }
    exports.push({ file: f, sessionId: raw.sessionId, exportedAt: raw.exportedAt, events: raw.events });
  }
  return exports;
}

// ── Per-session metrics ─────────────────────────────────────────────────

function analyseSession(exp) {
  const events = [...exp.events].sort((a, b) => a.ts - b.ts);
  if (events.length === 0) {
    return { file: exp.file, sessionId: exp.sessionId, n_events: 0 };
  }

  const spanMs = events[events.length - 1].ts - events[0].ts;
  const spanHours = spanMs / 3_600_000;

  const byStage = {};
  for (const e of events) {
    byStage[e.stage] = byStage[e.stage] || [];
    byStage[e.stage].push(e);
  }

  // ── mood transitions: B_decision/runFeatureB where meta.transitioned ──
  const decisions = (byStage.B_decision || []).filter((e) => e.event === 'runFeatureB');
  const transitions = decisions.filter((e) => e.meta?.transitioned === true);
  const transitionsPerHour = spanHours > 0 ? transitions.length / spanHours : null;

  // ── auto-mute / attenuation: playback/attenuation, level = clear|duck|mute ──
  const attenuationEvents = (byStage.playback || []).filter((e) => e.event === 'attenuation');
  const attenuatedTimeMs = sumDwellTime(attenuationEvents, events[events.length - 1].ts,
    (e) => e.meta?.level && e.meta.level !== 'clear');
  const attenuationRate = spanMs > 0 ? attenuatedTimeMs / spanMs : null;
  const attenuationReasons = countBy(attenuationEvents, (e) => e.meta?.reason);

  // ── cache hit rate: D_generate/generate, meta.cache === 'hit' ──
  const generations = (byStage.D_generate || []).filter((e) => e.event === 'generate');
  const cacheHits = generations.filter((e) => e.meta?.cache === 'hit').length;
  const fallbacks = generations.filter((e) => e.meta?.isFallback === true).length;
  const cacheHitRate = generations.length ? cacheHits / generations.length : null;
  const fallbackRate = generations.length ? fallbacks / generations.length : null;

  // ── tier escalation: B1's cascade `source`, recorded on every B_decision ──
  // Denominator is every decision with a recorded source, not just committed
  // transitions -- a tier fires on each page regardless of whether the mood
  // ended up changing. Decisions from an export predating the field carry
  // categorySource: null and are excluded rather than counted as "keyword",
  // so an old export reads as n=0 instead of as a falsely cheap cascade.
  const tiered = decisions.filter((e) => typeof e.meta?.categorySource === 'string');
  const tierCounts = countBy(tiered, (e) => e.meta.categorySource);
  // "Escalated" = the page reached a tier that exposes its text to a remote
  // model. The keyword tier is local, and skipped-sensitive/bypass never
  // send anything anywhere -- exposure is the quantity C3/§6.3 argues about.
  const escalated = tiered.filter((e) => e.meta.categorySource === 'zero-shot' || e.meta.categorySource === 'llm').length;
  const llmExposed = tiered.filter((e) => e.meta.categorySource === 'llm').length;
  const tierEscalationRate = tiered.length ? escalated / tiered.length : null;
  const llmExposureRate = tiered.length ? llmExposed / tiered.length : null;

  // ── user_control: skip/regenerate rate, mood-correction rate, mute presses ──
  const userControl = byStage.user_control || [];
  const regenerates = userControl.filter((e) => e.event === 'user_regenerate').length;
  const moodCorrections = userControl.filter((e) => e.event === 'mood_correction').length;
  const mutes = userControl.filter((e) => e.event === 'user_mute' && e.meta?.muted === true).length;
  const volumeChanges = userControl.filter((e) => e.event === 'user_volume').length;

  // ── voluntary disable: toggle-off presses, and time spent disabled ──────
  // NOT an uninstall rate. Chrome deletes chrome.storage.local (and this ring
  // buffer with it) on uninstall, so an uninstall can never be in an export
  // by construction. Reported as what it is; see §3 S5.
  const toggles = userControl.filter((e) => e.event === 'user_enabled_toggle');
  const disables = toggles.filter((e) => e.meta?.enabled === false).length;
  const disabledTimeMs = sumDwellTime(toggles, events[events.length - 1].ts, (e) => e.meta?.enabled === false);
  const disabledRate = spanMs > 0 ? disabledTimeMs / spanMs : null;
  const disablesPerHour = spanHours > 0 ? disables / spanHours : null;

  const skipRatePerHour = spanHours > 0 ? regenerates / spanHours : null;
  // Denominator is committed mood transitions, not raw page visits -- a
  // correction only makes sense relative to how many times the mood
  // actually changed under the participant (plan §4: "corrections per
  // committed transition").
  const moodCorrectionRate = transitions.length > 0 ? moodCorrections / transitions.length : null;

  return {
    file: exp.file,
    sessionId: exp.sessionId,
    n_events: events.length,
    span_hours: round(spanHours, 2),
    transitions: transitions.length,
    transitions_per_hour: round(transitionsPerHour),
    attenuation_rate: round(attenuationRate),
    attenuation_reasons: attenuationReasons,
    generations: generations.length,
    cache_hit_rate: round(cacheHitRate),
    fallback_rate: round(fallbackRate),
    tier_decisions: tiered.length,
    tier_counts: tierCounts,
    tier_escalation_rate: round(tierEscalationRate),
    llm_exposure_rate: round(llmExposureRate),
    disables,
    disables_per_hour: round(disablesPerHour),
    disabled_rate: round(disabledRate),
    regenerates,
    skip_rate_per_hour: round(skipRatePerHour),
    mood_corrections: moodCorrections,
    mood_correction_rate: round(moodCorrectionRate),
    mutes,
    volume_changes: volumeChanges,
  };
}

/**
 * How long the session spent in an attenuated state, by treating each
 * matching event as "attenuation state changed here" and summing the time
 * until the next attenuation event (or session end). Point-in-time
 * telemetry events don't carry a duration field, so this is the only way to
 * reconstruct dwell time from a change-log.
 */
function sumDwellTime(events, sessionEndTs, predicate) {
  let total = 0;
  for (let i = 0; i < events.length; i++) {
    if (!predicate(events[i])) continue;
    const end = i + 1 < events.length ? events[i + 1].ts : sessionEndTs;
    total += Math.max(0, end - events[i].ts);
  }
  return total;
}

function countBy(events, keyFn) {
  const out = {};
  for (const e of events) {
    const k = keyFn(e) ?? 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// ── Cross-session aggregation (description only, per plan §3 S5: "N=12
// with unequal exposure supports description, not inference — report
// distributions and per-participant traces, run no significance tests") ──

function aggregate(sessions) {
  const numeric = (key) => sessions.map((s) => s[key]).filter((v) => typeof v === 'number');
  const dist = (vals) => {
    if (!vals.length) return { n: 0 };
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      n: vals.length,
      min: round(sorted[0]),
      median: round(sorted[Math.floor(sorted.length / 2)]),
      max: round(sorted[sorted.length - 1]),
      mean: round(vals.reduce((a, b) => a + b, 0) / vals.length),
    };
  };

  return {
    n_sessions: sessions.length,
    total_events: sessions.reduce((a, s) => a + (s.n_events || 0), 0),
    total_span_hours: round(sessions.reduce((a, s) => a + (s.span_hours || 0), 0)),
    transitions_per_hour: dist(numeric('transitions_per_hour')),
    attenuation_rate: dist(numeric('attenuation_rate')),
    cache_hit_rate: dist(numeric('cache_hit_rate')),
    fallback_rate: dist(numeric('fallback_rate')),
    tier_escalation_rate: dist(numeric('tier_escalation_rate')),
    llm_exposure_rate: dist(numeric('llm_exposure_rate')),
    skip_rate_per_hour: dist(numeric('skip_rate_per_hour')),
    mood_correction_rate: dist(numeric('mood_correction_rate')),
    disables_per_hour: dist(numeric('disables_per_hour')),
    disabled_rate: dist(numeric('disabled_rate')),
    // Pooled across sessions rather than distributed: per-session tier counts
    // are tiny and a median over them is less informative than the real total.
    tier_counts: sessions.reduce((acc, s) => {
      for (const [k, v] of Object.entries(s.tier_counts || {})) acc[k] = (acc[k] || 0) + v;
      return acc;
    }, {}),
  };
}

// ── Entry point ─────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  const files = args.filter((a, i) => a !== '--out' && args[i - 1] !== '--out');

  if (files.length === 0) {
    console.error('Usage: node s5_telemetry_analysis.js <export1.json> [export2.json ...] [--out results.json]\n' +
      'No files given -- pass one or more exportTelemetry() JSON dumps (the popup\'s "Export telemetry" button produces one per session).');
    process.exit(1);
  }

  const exports = loadExports(files);
  console.log(`[s5_telemetry_analysis] ${exports.length} session export(s) loaded`);

  const sessions = exports.map(analyseSession);
  for (const s of sessions) {
    console.log(`  ${path.basename(s.file).padEnd(30)} events=${String(s.n_events).padEnd(5)} ` +
      `span=${s.span_hours ?? '?'}h  transitions/h=${s.transitions_per_hour ?? '?'}  ` +
      `attenuation=${s.attenuation_rate ?? '?'}  cache_hit=${s.cache_hit_rate ?? '?'}`);
  }

  const summary = aggregate(sessions);

  console.log('\n' + '='.repeat(78));
  console.log('IN-THE-WILD TELEMETRY — SUMMARY (descriptive only, per plan §3 S5 -- no significance tests)');
  console.log('='.repeat(78));
  console.log(`  ${summary.n_sessions} session(s), ${summary.total_events} event(s), ${summary.total_span_hours}h total`);
  for (const key of ['transitions_per_hour', 'attenuation_rate', 'cache_hit_rate', 'fallback_rate',
                     'tier_escalation_rate', 'llm_exposure_rate', 'skip_rate_per_hour',
                     'mood_correction_rate', 'disables_per_hour', 'disabled_rate']) {
    const d = summary[key];
    console.log(`  ${key.padEnd(24)} median ${String(d.median).padEnd(8)} min ${String(d.min).padEnd(8)} max ${String(d.max).padEnd(8)} (n=${d.n})`);
  }
  const tc = Object.entries(summary.tier_counts);
  console.log(`  ${'tier_counts'.padEnd(24)} ${tc.length ? tc.map(([k, v]) => `${k}=${v}`).join('  ') : '(none recorded)'}`);
  console.log('='.repeat(78));
  if (!tc.length) {
    console.log('\nNo per-page tier sources in these exports. Either they predate the');
    console.log('`meta.categorySource` field on B_decision, or Feature B never ran.');
  }
  console.log('\nScope note: `disabled_rate`/`disables_per_hour` are TOGGLE-OFF rates, not');
  console.log('uninstall rates. Chrome deletes chrome.storage.local -- this ring buffer with');
  console.log('it -- when the extension is removed, so an uninstall can never appear in an');
  console.log('export. The only hook that survives, setUninstallURL, requires a network call');
  console.log('this build deliberately does not make. §3 S5 reports the measurable one.');

  if (out) {
    const outFull = path.resolve(process.cwd(), out);
    fs.mkdirSync(path.dirname(outFull), { recursive: true });
    fs.writeFileSync(outFull, JSON.stringify({ sessions, summary }, null, 2));
    console.log(`\nWrote ${outFull}`);
  }
}

main();
