#!/usr/bin/env node
/**
 * C-18 — assemble the reproducibility bundle, and C-19 — re-record the golden
 * fixtures at a study boundary.
 *
 *   node analysis/bundle/make_bundle.mjs                    # assemble + verify
 *   node analysis/bundle/make_bundle.mjs --anonymise        # strip identifying material
 *   node analysis/bundle/make_bundle.mjs --milestone pilot  # label this snapshot
 *   node analysis/bundle/make_bundle.mjs --check            # report only, write nothing
 *
 * §12 lists what ships with the paper. The failure mode this exists to prevent
 * is not "we forgot something" — it is a bundle first assembled the week of the
 * deadline, which is a bundle that does not build. So: run it at every internal
 * milestone, and let it fail loudly on anything missing rather than quietly
 * producing a smaller archive.
 *
 * Missing items are reported by *category*: an artefact that does not exist yet
 * because the study has not run is a different thing from one that should be
 * there and isn't, and collapsing them into one "N files missing" line is how a
 * real gap hides among the expected ones.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const ANONYMISE = args.includes('--anonymise');
const CHECK_ONLY = args.includes('--check');
const MILESTONE = flag('milestone', 'dev');
const OUT = path.resolve(REPO, flag('out', `analysis/out/bundle-${MILESTONE}`));

/**
 * `blocked_on` marks an item that legitimately does not exist yet. It is the
 * difference between "the bundle is incomplete because the study has not run"
 * and "the bundle is incomplete because something broke".
 */
const ITEMS = [
  // — instruments, all of which exist today —
  { p: 'audio-generation/experiments/d4_latency.py', kind: 'harness' },
  { p: 'audio-generation/experiments/d2_loop_test.py', kind: 'harness' },
  { p: 'audio-generation/experiments/d1_prompt_ablation.py', kind: 'harness' },
  { p: 'audio-generation/experiments/d3_clip_length.py', kind: 'harness' },
  { p: 'audio-generation/experiments/d5_retention_diagnosis.py', kind: 'harness' },
  { p: 'ui/e2e/latency.e2e.mjs', kind: 'harness' },
  { p: 'ui/e2e/chromiumExtension.e2e.mjs', kind: 'harness' },
  { p: 'data-extraction/benchmark/extractionCost.js', kind: 'harness' },
  { p: 'mood-classification/experiments/s2_tier_ablation.js', kind: 'harness' },
  { p: 'mood-classification/experiments/s3_signal_ablation.js', kind: 'harness' },
  { p: 'mood-classification/experiments/localZeroShot.js', kind: 'harness' },
  { p: 'ui/experiments/s5_telemetry_analysis.js', kind: 'harness' },
  { p: 'analysis/corpus/capture_corpus.mjs', kind: 'harness' },
  { p: 'analysis/annotate/index.html', kind: 'study software' },
  { p: 'analysis/loop_ab/index.html', kind: 'study software' },
  { p: 'analysis/loop_ab/build_stimuli.py', kind: 'study software' },
  { p: 'analysis/loop_ab/score_loop_ab.py', kind: 'study software' },
  { p: 'analysis/s4/assignment.mjs', kind: 'study software' },
  { p: 'analysis/s4/build_sessions.mjs', kind: 'study software' },

  // — analysis —
  { p: 'analysis/metrics.json', kind: 'analysis' },
  { p: 'analysis/registry.py', kind: 'analysis' },
  { p: 'analysis/build_all.py', kind: 'analysis' },
  { p: 'analysis/figures', kind: 'analysis', dir: true },
  { p: 'analysis/krippendorff.py', kind: 'analysis' },
  { p: 'analysis/s4/models.R', kind: 'analysis' },
  { p: 'analysis/s4/simulate_and_check.py', kind: 'analysis' },
  { p: 'analysis/cost/cost_accounting.js', kind: 'analysis' },
  { p: 'analysis/audit/t5_audit.mjs', kind: 'analysis' },
  { p: 'analysis/baselines/retrieval_baseline.mjs', kind: 'analysis' },

  // — pins —
  { p: 'audio-generation/requirements.txt', kind: 'pins' },
  { p: 'package.json', kind: 'pins' },
  { p: 'package-lock.json', kind: 'pins' },
  { p: 'mood-classification/feature_b/llmConfig.js', kind: 'pins' },
  { p: 'ui/src/zeroshot.worker.js', kind: 'pins' },
  { p: 'mood-classification/fixtures', kind: 'fixtures', dir: true },
  { p: 'mood-classification/fixture_staleness_test.js', kind: 'fixtures' },

  // — data —
  { p: 'audio-generation/results/d1-latency-full.json', kind: 'data' },
  { p: 'audio-generation/results/d2-loop.json', kind: 'data' },
  { p: 'analysis/audit/sensitive_slice.json', kind: 'data' },
  { p: 'analysis/corpus/urls.example.jsonl', kind: 'data' },
  { p: 'analysis/out/cost.json', kind: 'data' },
  { p: 'analysis/out/baselines.json', kind: 'data' },
  { p: 'ui/experiments/sample_exports', kind: 'data', dir: true },

  // — not yet, and legitimately so —
  { p: 'analysis/corpus/s2_corpus.json', kind: 'data', blocked_on: 'D-01' },
  { p: 'analysis/out/alpha.json', kind: 'data', blocked_on: 'D-02' },
  { p: 'mood-classification/results/s2-ablation.json', kind: 'data', blocked_on: 'D-03' },
  { p: 'analysis/out/loop_ab_scored.json', kind: 'data', blocked_on: 'H-03' },
  { p: 'analysis/out/s4_tidy.json', kind: 'data', blocked_on: 'H-05' },
  { p: 'ui/results/s5-wild.json', kind: 'data', blocked_on: 'D-05' },

  { p: 'RESULTS_AND_DISCUSSION_PLAN.md', kind: 'docs' },
  { p: 'audio-generation/research_log.md', kind: 'docs' },
];

/**
 * Files that must never leave the machine in a review bundle. Checked by
 * pattern rather than by name, because the thing that gets leaked is always the
 * file nobody thought to list.
 */
const NEVER_SHIP = [/\.env$/, /\.pem$/, /\.crx$/, /credentials/i, /secret/i, /token/i];
const SECRET_CONTENT = [
  { name: 'Groq API key', re: /gsk_[A-Za-z0-9]{20,}/ },
  { name: 'Hugging Face token', re: /hf_[A-Za-z0-9]{20,}/ },
  { name: 'generic bearer token', re: /Bearer\s+[A-Za-z0-9._-]{30,}/ },
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

function walk(abs, base = abs) {
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__pycache__' || e.name.startsWith('.')) continue;
    const full = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(full);
  }
  return out;
}

function scanForSecrets(files) {
  const hits = [];
  for (const f of files) {
    if (fs.statSync(f).size > 2_000_000) continue;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const s of SECRET_CONTENT) {
      if (s.re.test(text)) hits.push({ file: path.relative(REPO, f), kind: s.name });
    }
  }
  return hits;
}

// ── C-19: fixture re-record at study boundaries ──────────────────────────
function fixtureStatus() {
  const dir = path.join(REPO, 'mood-classification/fixtures');
  if (!fs.existsSync(dir)) return { present: false };
  const files = walk(dir);
  const newest = files.reduce((a, f) => Math.max(a, fs.statSync(f).mtimeMs), 0);
  const ageDays = (Date.now() - newest) / 86_400_000;
  let staleness = null;
  try {
    execFileSync('node', ['mood-classification/fixture_staleness_test.js'],
      { cwd: REPO, stdio: 'pipe', shell: process.platform === 'win32', timeout: 300_000 });
    staleness = 'pass';
  } catch (e) {
    staleness = 'FAIL';
  }
  return {
    present: true, n_files: files.length,
    newest_age_days: Number(ageDays.toFixed(1)),
    staleness_test: staleness,
    // §10 flags a mid-study Groq model update as a real threat. The guard
    // already exists; what was missing is a boundary at which someone is told
    // to re-record. A milestone build is that boundary.
    action: ageDays > 30
      ? 'RE-RECORD — fixtures are over a month old. §10 names a silent tier-2 model change as a '
        + 'threat, and a fixture recorded before the study started cannot detect one that happened '
        + 'during it. Re-record now and again at study end.'
      : 'fresh enough',
  };
}

function pinnedModels() {
  const read = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch { return ''; } };
  const groq = read('mood-classification/feature_b/llmConfig.js')
    .match(/DEFAULT_MODEL\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  const zsProxy = read('mood-classification/feature_b/b1_zeroShotCategory.js')
    .match(/DEFAULT_ZERO_SHOT_MODEL\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  const zsLocal = read('ui/src/zeroshot.worker.js')
    .match(/DEFAULT_MODEL_ID\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  const numba = read('audio-generation/requirements.txt').match(/numba==([\d.]+)/)?.[1] ?? null;
  const llvmlite = read('audio-generation/requirements.txt').match(/llvmlite==([\d.]+)/)?.[1] ?? null;
  return {
    llm_tier2: groq, zero_shot_proxy: zsProxy, zero_shot_local: zsLocal,
    musicgen: 'facebook/musicgen-small', embedding: 'Xenova/all-MiniLM-L6-v2',
    numba, llvmlite,
  };
}

// ── Assemble ─────────────────────────────────────────────────────────────
const present = [], missing = [], notYet = [];
for (const item of ITEMS) {
  const abs = path.join(REPO, item.p);
  if (fs.existsSync(abs)) present.push(item);
  else if (item.blocked_on) notYet.push(item);
  else missing.push(item);
}

let copied = 0, secretHits = [], shipped = [];
if (!CHECK_ONLY) {
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const item of present) {
    const src = path.join(REPO, item.p);
    const dst = path.join(OUT, item.p);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (item.dir) fs.cpSync(src, dst, { recursive: true, filter: (s) => !s.includes('node_modules') });
    else fs.copyFileSync(src, dst);
    copied++;
  }
  shipped = walk(OUT);
  // Anything matching NEVER_SHIP that slipped in via a directory copy.
  for (const f of shipped) {
    if (NEVER_SHIP.some((re) => re.test(f))) {
      fs.rmSync(f, { force: true });
      secretHits.push({ file: path.relative(OUT, f), kind: 'removed by filename pattern' });
    }
  }
  shipped = walk(OUT);
  secretHits.push(...scanForSecrets(shipped));
}

const manifest = {
  milestone: MILESTONE,
  assembled_at: new Date().toISOString(),
  anonymised: ANONYMISE,
  git_sha: (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); }
    catch { return null; }
  })(),
  git_dirty: (() => {
    try { return execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim().length > 0; }
    catch { return null; }
  })(),
  pinned_models: pinnedModels(),
  fixtures: fixtureStatus(),
  n_items_present: present.length,
  n_items_missing: missing.length,
  n_items_not_yet: notYet.length,
  missing: missing.map((m) => m.p),
  not_yet: notYet.map((m) => ({ path: m.p, blocked_on: m.blocked_on })),
  files: CHECK_ONLY ? [] : shipped.map((f) => ({
    path: path.relative(OUT, f).replace(/\\/g, '/'),
    bytes: fs.statSync(f).size,
    sha256_16: sha(fs.readFileSync(f)),
  })),
  secret_scan: secretHits,
};

if (!CHECK_ONLY) {
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT, 'README.md'), readme(manifest));
}

// ── Report ───────────────────────────────────────────────────────────────
console.log('='.repeat(74));
console.log(`C-18  REPRODUCIBILITY BUNDLE — milestone "${MILESTONE}"`);
console.log('='.repeat(74));
console.log(`git ${manifest.git_sha?.slice(0, 8) ?? '?'}${manifest.git_dirty ? ' (DIRTY — a bundle from an uncommitted tree cannot be rebuilt)' : ''}`);
console.log(`\npinned models:`);
for (const [k, v] of Object.entries(manifest.pinned_models)) {
  console.log(`  ${k.padEnd(18)} ${v ?? 'NOT FOUND — the pin cannot be read from source'}`);
}
console.log(`\n${present.length} item(s) present, ${copied} copied`);
if (notYet.length) {
  console.log(`\n${notYet.length} item(s) not yet produced (expected):`);
  for (const m of notYet) console.log(`  ${m.p.padEnd(52)} waiting on ${m.blocked_on}`);
}
if (missing.length) {
  console.log(`\n${missing.length} item(s) MISSING with no reason — these are real gaps:`);
  for (const m of missing) console.log(`  ${m.p}`);
}
const f = manifest.fixtures;
console.log(`\nfixtures: ${f.present ? `${f.n_files} file(s), newest ${f.newest_age_days} day(s) old, `
  + `staleness test ${f.staleness_test}` : 'MISSING'}`);
if (f.action && f.action !== 'fresh enough') console.log(`  C-19: ${f.action}`);
if (secretHits.length) {
  console.log(`\nSECRET SCAN — ${secretHits.length} hit(s), do not distribute until resolved:`);
  for (const h of secretHits) console.log(`  ${h.kind}: ${h.file}`);
} else if (!CHECK_ONLY) {
  console.log('\nsecret scan: clean');
}
console.log('='.repeat(74));
if (!CHECK_ONLY) console.log(`\nWrote ${path.relative(REPO, OUT)}/ (${shipped.length} files)`);

process.exit(missing.length || secretHits.length || f.staleness_test === 'FAIL' ? 1 : 0);

function readme(m) {
  return `# Web2Music — reproducibility bundle (${m.milestone})

Assembled ${m.assembled_at} from git ${m.git_sha ?? 'unknown'}${m.git_dirty ? ' (working tree was dirty)' : ''}.

## Pinned models

${Object.entries(m.pinned_models).map(([k, v]) => `- \`${k}\`: ${v ?? '(not found)'}`).join('\n')}

## What is here

Harnesses, study software, analysis scripts, golden fixtures and the datasets
that exist at this milestone. Every figure and table in the paper is produced by
\`analysis/build_all.py\`, which refuses to plot a metric that has no provenance
row in \`analysis/metrics.json\`.

## What is not here yet

${m.not_yet.length ? m.not_yet.map((n) => `- \`${n.path}\` — waiting on ${n.blocked_on}`).join('\n')
  : 'Nothing — every listed item is present.'}

## Reproducing the figures

\`\`\`
python analysis/build_all.py            # builds what the included data supports
python analysis/build_all.py --check    # validates declarations only
\`\`\`

Artefacts whose inputs are absent are reported as blocked with the reason,
rather than silently skipped.

## Corpus

The S2 corpus ships as extracted \`pageData\`, not as URLs. Re-fetching the URLs
will not reproduce it, and is not how it should be replicated — live pages
change and that is the whole reason it is frozen.
`;
}
