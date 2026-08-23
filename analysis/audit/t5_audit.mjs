#!/usr/bin/env node
/**
 * C-11 — T5, the responsible-behaviour audit, generated from the test suite.
 *
 *   node analysis/audit/t5_audit.mjs
 *   node analysis/audit/t5_audit.mjs --with-e2e     # also runs the Chromium harness (slow)
 *   node analysis/audit/t5_audit.mjs --with-zero-shot [serviceUrl]  # also audits the §5.1/§5.5
 *       fix (resolveSensitivity's zero-shot tier) against a live entailment service, default
 *       serviceUrl http://localhost:8078/v1/zero-shot (services/classify must be up — see
 *       `npm run up`). Without this flag the keyword-only numbers below are unchanged, since
 *       there's no live service to reach in most environments this script runs in.
 *
 * One row per policy: what it is, what triggers it, which test covers it, and
 * that test's live pass/fail *right now*. The point of generating it rather
 * than writing it is drift: a hand-maintained audit table describes the system
 * as it was on the day someone typed it, and the claim in C5 is about the
 * system as it is.
 *
 * The second half is what pre-mortem #10 actually demands — the sensitive
 * detector's false-negative and false-positive rates on an adversarial slice,
 * including the failure modes b2_moodClassifier.js's own ethics note admits to.
 * We report those rather than wait to be asked, because a limitation the paper
 * states first reads as calibration and the same limitation found by a reviewer
 * reads as an oversight. Since the §5.1/§5.5 fix, that keyword-only number is
 * the pre-fix baseline, not the shipped detector's ceiling — --with-zero-shot
 * reports the post-fix numbers alongside it once a service is available to
 * measure them against.
 *
 * Writes analysis/out/audit.json, which analysis/figures/t5_audit.py turns
 * into the table.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkSensitiveContent,
  resolveSensitivity,
  analyseMetadata,
} from '../../mood-classification/feature_b/b1_contentUnderstanding.js';
import { decideAttenuation, ATTENUATION } from '../../ui/src/audioTabs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const OUT = path.join(REPO, 'analysis/out');

const withE2E = process.argv.includes('--with-e2e');
const withZeroShotIdx = process.argv.indexOf('--with-zero-shot');
const withZeroShot = withZeroShotIdx !== -1;
const zeroShotServiceUrl = withZeroShot
  ? (process.argv[withZeroShotIdx + 1] && !process.argv[withZeroShotIdx + 1].startsWith('--')
      ? process.argv[withZeroShotIdx + 1]
      : 'http://localhost:8078/v1/zero-shot')
  : null;

// ── The policies. Each names the test that covers it. ──────────────────────
const POLICIES = [
  {
    id: 'crisis-silence',
    policy: 'Crisis and sensitive content yields silence, not mood music',
    trigger: 'checkSensitiveContent(): one severe term, or two distinct ambiguous terms',
    implementation: 'mood-classification/feature_b/b2_moodClassifier.js runB2 (sensitiveContentMode="silence")',
    test: { cmd: 'npm', args: ['run', 'test', '-w', 'mood-classification'], label: 'feature_b_test.js' },
  },
  {
    id: 'sensitive-never-leaves-device',
    policy: 'Text of a sensitive page never reaches either LLM tier',
    trigger: 'isSensitive short-circuits B1 category escalation and B2 mood escalation',
    implementation: 'b1_contentUnderstanding.js runB1 / b2_moodClassifier.js runB2',
    test: { cmd: 'npm', args: ['run', 'test', '-w', 'mood-classification'], label: 'feature_b_test.js' },
  },
  {
    id: 'audible-tab-auto-mute',
    policy: 'Pages already playing audio are not competed with',
    trigger: 'decideAttenuation(): active tab audible → mute; another tab audible → duck',
    implementation: 'ui/src/audioTabs.js',
    test: { cmd: 'node', args: ['ui/audioTabs_test.js'], label: 'audioTabs_test.js' },
  },
  {
    id: 'payment-bypass',
    policy: 'Payment, banking and checkout pages are bypassed entirely',
    trigger: 'analyseMetadata(): /\\b(payment|checkout|bank|banking|wallet|invoice|billing)\\b/i on url + title',
    implementation: 'b1_contentUnderstanding.js analyseMetadata',
    test: { cmd: 'npm', args: ['run', 'test', '-w', 'mood-classification'], label: 'feature_b_test.js' },
  },
  {
    id: 'chrome-internal-bypass',
    policy: 'chrome:// and chrome-extension:// pages are bypassed',
    trigger: 'analyseMetadata(): /^chrome(-extension)?:\\/\\//i on url',
    implementation: 'b1_contentUnderstanding.js analyseMetadata',
    test: { cmd: 'npm', args: ['run', 'test', '-w', 'mood-classification'], label: 'feature_b_test.js' },
  },
  {
    id: 'url-hashing',
    policy: 'No browsing history leaves the device in plaintext',
    trigger: 'Every telemetry event stores urlHash (SHA-256), never the URL',
    implementation: 'ui/src/telemetry.js',
    test: { cmd: 'node', args: ['ui/offscreen_routing_test.js'], label: 'offscreen_routing_test.js' },
  },
  {
    id: 'fixture-drift',
    policy: 'A silent tier-2 model change is detectable, not merely feared',
    trigger: 'Golden fixtures re-checked against the pinned Groq model string',
    implementation: 'mood-classification/fixture_staleness_test.js',
    test: { cmd: 'node', args: ['mood-classification/fixture_staleness_test.js'], label: 'fixture_staleness_test.js' },
  },
];

if (withE2E) {
  POLICIES.push({
    id: 'end-to-end-silence',
    policy: 'The silence path survives in a real browser, not only in unit tests',
    trigger: 'Sensitive page loaded in Chromium with the built extension',
    implementation: 'ui/e2e/chromiumExtension.e2e.mjs (sensitive case)',
    test: { cmd: 'npm', args: ['run', 'test:e2e'], label: 'chromiumExtension.e2e.mjs' },
  });
}

// ── Run each distinct test once, reuse the result across policies ──────────
function runTest(t) {
  const started = Date.now();
  try {
    const stdout = execFileSync(t.cmd, t.args, {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', timeout: 15 * 60 * 1000,
    });
    return { status: 'pass', ms: Date.now() - started, tail: tail(stdout) };
  } catch (e) {
    return {
      status: 'FAIL', ms: Date.now() - started,
      tail: tail(`${e.stdout || ''}\n${e.stderr || ''}`) || e.message,
    };
  }
}

const tail = (s) => (s || '').trim().split('\n').slice(-4).join('\n');

// ── The adversarial slice ─────────────────────────────────────────────────
// summariseSlice() computes the FN/FP breakdown for one detector function
// (id: page -> boolean) — shared between the keyword-only baseline and the
// post-§5.1/§5.5-fix zero-shot pass below, so the two are directly comparable.
function summariseSlice(slice, perPage) {
  const positives = perPage.filter((p) => p.expected);
  const negatives = perPage.filter((p) => !p.expected);
  const fn = positives.filter((p) => !p.detected);
  const fp = negatives.filter((p) => p.detected);

  const bySlice = {};
  for (const p of perPage) {
    const s = (bySlice[p.slice] ||= { n: 0, correct: 0 });
    s.n += 1;
    if (p.outcome === 'correct') s.correct += 1;
  }

  return {
    provenance: slice.provenance,
    n: perPage.length,
    n_sensitive: positives.length,
    n_benign: negatives.length,
    false_negative_rate: positives.length ? fn.length / positives.length : null,
    false_positive_rate: negatives.length ? fp.length / negatives.length : null,
    false_negatives: fn.map((p) => ({ id: p.id, slice: p.slice })),
    false_positives: fp.map((p) => ({ id: p.id, slice: p.slice })),
    by_slice: bySlice,
    per_page: perPage,
  };
}

async function auditSensitive() {
  const slice = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'sensitive_slice.json'), 'utf8'),
  );

  // Keyword-only baseline — checkSensitiveContent() alone, unchanged by the
  // §5.1/§5.5 fix (it's still the tier-1 detector; resolveSensitivity below
  // is what escalates past it). This is the pre-fix number the paper's
  // limitations section quotes (FN 0.455, FP 0.333 at time of writing).
  const keywordPerPage = slice.pages.map((p) => {
    const detected = checkSensitiveContent(`${p.text} ${p.title}`);
    return { id: p.id, slice: p.slice, expected: p.sensitive, detected,
             outcome: p.sensitive === detected ? 'correct'
                    : p.sensitive ? 'false negative' : 'false positive' };
  });
  const keyword = summariseSlice(slice, keywordPerPage);

  if (!withZeroShot) return { keyword };

  // Post-fix pass: resolveSensitivity() against a live entailment service —
  // the same local/proxy backend the category classifier uses, never the
  // Groq tier-2 LLM. Requires services/classify up (`npm run up`); reports
  // a clear per-page error rather than silently falling back to the keyword
  // verdict, so a misconfigured --with-zero-shot run doesn't get reported as
  // "the fix didn't help" when actually the service was just unreachable.
  process.stderr.write(`[t5_audit] --with-zero-shot: auditing resolveSensitivity() against ${zeroShotServiceUrl} …\n`);
  const zsPerPage = [];
  for (const p of slice.pages) {
    const text = `${p.text} ${p.title}`;
    let detected = null, error = null;
    try {
      const r = await resolveSensitivity(
        text, { title: p.title, summary: p.text, keywords: [] },
        { zeroShot: { enabled: true, backend: 'proxy', serviceUrl: zeroShotServiceUrl } },
      );
      detected = r.isSensitive;
    } catch (e) {
      error = e.message;
    }
    zsPerPage.push({
      id: p.id, slice: p.slice, expected: p.sensitive, detected, error,
      outcome: error ? 'error' : (p.sensitive === detected ? 'correct'
                : p.sensitive ? 'false negative' : 'false positive'),
    });
  }
  const errored = zsPerPage.filter((p) => p.error);
  const zeroShot = summariseSlice(slice, zsPerPage.filter((p) => !p.error));
  if (errored.length) zeroShot.errors = errored.map((p) => ({ id: p.id, error: p.error }));

  return { keyword, zero_shot: zeroShot };
}

// ── Two policies are cheap enough to assert directly, so we do ────────────
function directAssertions() {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, status: ok ? 'pass' : 'FAIL', detail });

  const pay = analyseMetadata({ url: 'https://shop.example.com/checkout', title: 'Checkout' });
  push('payment page detected', pay.isPaymentPage === true, JSON.stringify(pay.isPaymentPage));
  const notPay = analyseMetadata({ url: 'https://example.com/payload-formats', title: 'Payload formats' });
  push('"payload" is not a payment page', notPay.isPaymentPage === false, JSON.stringify(notPay.isPaymentPage));
  const chr = analyseMetadata({ url: 'chrome://extensions', title: 'Extensions' });
  push('chrome:// bypassed', chr.isChromeInternal === true, JSON.stringify(chr.isChromeInternal));

  const active = decideAttenuation({ activeTabId: 1, activeTabUrl: 'https://youtube.com/watch?v=x', playingTabIds: [1] });
  push('active audible tab → mute', active.level === ATTENUATION.MUTE, JSON.stringify(active));
  const other = decideAttenuation({ activeTabId: 1, activeTabUrl: 'https://example.com', playingTabIds: [2] });
  push('background audible tab → duck', other.level === ATTENUATION.DUCK, JSON.stringify(other));
  const quiet = decideAttenuation({ activeTabId: 1, activeTabUrl: 'https://example.com', playingTabIds: [] });
  push('silent browsing → no attenuation', quiet.level === ATTENUATION.CLEAR, JSON.stringify(quiet));
  const media = decideAttenuation({ activeTabId: 1, activeTabUrl: 'https://youtube.com/', playingTabIds: [] });
  push('silent media site → duck, never mute', media.level === ATTENUATION.DUCK, JSON.stringify(media));

  return checks;
}

// ── Main ──────────────────────────────────────────────────────────────────
const cache = new Map();
const policies = POLICIES.map((p) => {
  const key = `${p.test.cmd} ${p.test.args.join(' ')}`;
  if (!cache.has(key)) {
    process.stderr.write(`[t5_audit] running ${p.test.label} …\n`);
    cache.set(key, runTest(p.test));
  }
  const r = cache.get(key);
  return { ...p, test: { ...p.test, ...r } };
});

const sensitive = await auditSensitive();
const direct = directAssertions();

const report = {
  generated_at: new Date().toISOString(),
  git_sha: (() => {
    try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); }
    catch { return null; }
  })(),
  with_e2e: withE2E,
  policies,
  direct_assertions: direct,
  sensitive,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(report, null, 2));

// ── Console summary ───────────────────────────────────────────────────────
console.log('\n' + '='.repeat(78));
console.log('T5 — RESPONSIBLE-BEHAVIOUR AUDIT');
console.log('='.repeat(78));
for (const p of policies) {
  console.log(`${p.test.status === 'pass' ? '  ok ' : ' FAIL'}  ${p.policy}`);
  console.log(`        covered by ${p.test.label} (${p.test.ms} ms)`);
  if (p.test.status !== 'pass') console.log(`        ${p.test.tail.replace(/\n/g, '\n        ')}`);
}
console.log('\n  direct assertions:');
for (const c of direct) console.log(`${c.status === 'pass' ? '    ok ' : '   FAIL'}  ${c.name}`);

function printSliceResult(label, s) {
  console.log(`\n  sensitive-content detector — ${label}:`);
  console.log(`    n=${s.n}  (${s.n_sensitive} sensitive, ${s.n_benign} benign)`);
  console.log(`    false-negative rate ${s.false_negative_rate.toFixed(3)}` +
              `   false-positive rate ${s.false_positive_rate.toFixed(3)}`);
  for (const f of s.false_negatives) console.log(`      FN  ${f.id}  [${f.slice}]`);
  for (const f of s.false_positives) console.log(`      FP  ${f.id}  [${f.slice}]`);
  if (s.errors?.length) {
    console.log(`    ${s.errors.length} page(s) errored (service unreachable?) and were excluded from the rates above:`);
    for (const e of s.errors) console.log(`      ERR ${e.id}  ${e.error}`);
  }
}

printSliceResult('adversarial slice, keyword tier only (pre-§5.1/§5.5-fix baseline)', sensitive.keyword);
if (sensitive.zero_shot) {
  printSliceResult('adversarial slice, resolveSensitivity() incl. zero-shot tier (post-fix)', sensitive.zero_shot);
} else {
  console.log('\n  (pass --with-zero-shot [serviceUrl] with services/classify up to also audit the §5.1/§5.5 fix)');
}
console.log('='.repeat(78));
console.log(`\nWrote ${path.join(OUT, 'audit.json')}`);

const failed = policies.some((p) => p.test.status !== 'pass') || direct.some((c) => c.status !== 'pass');
process.exit(failed ? 1 : 0);
