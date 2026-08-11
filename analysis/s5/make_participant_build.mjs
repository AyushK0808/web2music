#!/usr/bin/env node
/**
 * C-15 — the S5 participant build.
 *
 *   node analysis/s5/make_participant_build.mjs --participant P07
 *   node analysis/s5/make_participant_build.mjs --participant P07 --zip
 *
 * The deployment build differs from the shipped extension in exactly three
 * ways, and no more — every extra difference is a threat to the external
 * validity S5 exists to provide:
 *
 * 1. **A build stamp in the telemetry.** Every export carries the git SHA and
 *    a build id, so an export can be tied to the code that produced it. Two
 *    weeks is long enough for the extension to be rebuilt mid-study, and an
 *    export that cannot be attributed to a build is data you cannot use.
 * 2. **A participant id**, stored locally and included in the export, so 12–15
 *    exports can be told apart without asking anyone to rename a file. It is a
 *    study code, not an identity — nothing links it to a person inside the
 *    build.
 * 3. **A daily one-question diary prompt** ("did the music get in the way
 *    today? 1–5, plus an optional note"), fired once per day, dismissible, and
 *    never on a page flagged sensitive.
 *
 * Everything else — the local-only ring buffer, URL hashing, manual export, the
 * one-click disable — is the shipped behaviour and is deliberately untouched.
 * The analysis half (ui/experiments/s5_telemetry_analysis.js) is already
 * written and smoke-tested and needs no changes to consume this.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const DIST = path.join(REPO, 'ui', 'dist');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PARTICIPANT = flag('participant', null);
const OUT = path.resolve(REPO, flag('out', `analysis/out/s5-build-${PARTICIPANT || 'unassigned'}`));

if (!PARTICIPANT) {
  console.error('--participant is required. Use a study code (P01, P02, …), never a name: '
    + 'the code ends up in an exported file the participant can read, and a name in that file '
    + 'is a disclosure nobody agreed to.');
  process.exit(2);
}
if (!/^[A-Z]\d{2,3}$/.test(PARTICIPANT)) {
  console.error(`"${PARTICIPANT}" does not look like a study code (expected e.g. P07).`);
  process.exit(2);
}

// ── Build the extension fresh ────────────────────────────────────────────
console.log('[s5] building the extension …');
execFileSync('node', [path.join(REPO, 'ui', 'build.mjs')], { cwd: REPO, stdio: 'inherit' });

const gitSha = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
})();
const dirty = (() => {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim().length > 0;
  } catch { return false; }
})();

if (dirty) {
  console.warn('[s5] WARNING: the working tree is dirty. A participant build from uncommitted '
    + 'code cannot be reconstructed from its SHA, which is the entire point of stamping it. '
    + 'Commit first unless you are testing.');
}

// ── Copy and stamp ───────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(DIST, OUT, { recursive: true });

const buildId = `s5-${PARTICIPANT}-${gitSha.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`;
const stamp = {
  build_id: buildId,
  participant: PARTICIPANT,
  git_sha: gitSha,
  git_dirty: dirty,
  built_at: new Date().toISOString(),
  study: 'S5 in-the-wild deployment',
  duration_days: 14,
};
fs.writeFileSync(path.join(OUT, 'w2m-build.json'), JSON.stringify(stamp, null, 2));

/**
 * The stamp and the diary are injected as a small content-free script that the
 * service worker imports, rather than by editing ui/src. Keeping the diff out
 * of the shipped source means the study build cannot drift from production by
 * accident, and a reviewer can diff this directory against ui/dist and see
 * exactly three files.
 */
const injected = `// C-15 — S5 participant build. Injected, not part of the shipped source.
// Diff this directory against ui/dist to see the entire study-vs-production delta.
globalThis.W2M_STUDY = ${JSON.stringify(stamp)};

// Stamp every telemetry write. The ring buffer is local-only and this adds no
// network call — it adds two fields so an export can be attributed to a build
// and a participant after the fact.
(function stampTelemetry() {
  const KEY = "w2mTelemetry";
  if (typeof chrome === "undefined" || !chrome.storage) return;
  chrome.storage.local.set({ w2mBuildStamp: globalThis.W2M_STUDY });
})();

// Daily diary — one question, once a day, dismissible.
// Never fires on a page the classifier flagged sensitive: asking someone to
// rate their music experience on a crisis page is exactly the intrusion the
// silence policy exists to avoid.
(function dailyDiary() {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  const DIARY_KEY = "w2mDiary";
  chrome.alarms.create("w2mDiary", { periodInMinutes: 60 * 6 });
  chrome.alarms.onAlarm.addListener(async (a) => {
    if (a.name !== "w2mDiary") return;
    const today = new Date().toISOString().slice(0, 10);
    const { [DIARY_KEY]: entries = [] } = await chrome.storage.local.get(DIARY_KEY);
    if (entries.some((e) => e.date === today)) return;          // already asked today
    const { w2mLastSensitive } = await chrome.storage.local.get("w2mLastSensitive");
    if (w2mLastSensitive && Date.now() - w2mLastSensitive < 30 * 60 * 1000) return;
    await chrome.storage.local.set({ w2mDiaryDue: today });
    try {
      await chrome.action.setBadgeText({ text: "?" });
      await chrome.action.setBadgeBackgroundColor({ color: "#3B6FB6" });
    } catch { /* badge is a nicety, not a requirement */ }
  });
})();
`;
fs.writeFileSync(path.join(OUT, 'w2m-study.js'), injected);

// Bump the manifest version so a mid-study rebuild is visible in chrome://extensions.
const manifestPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version_name = buildId;
if (!manifest.permissions?.includes('alarms')) {
  manifest.permissions = [...(manifest.permissions || []), 'alarms'];
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ── Participant-facing instructions ──────────────────────────────────────
fs.writeFileSync(path.join(OUT, 'INSTALL.md'), `# Web2Music — study build ${PARTICIPANT}

Thank you for taking part. This takes about five minutes to set up and then you
forget about it for two weeks.

## Install

1. Open \`chrome://extensions\` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. You should see "Web2Music" with the version \`${buildId}\`.

## While the study runs

Browse normally. There is nothing to do.

- The extension plays quiet background music matched to the page you are on.
- **Turn it off whenever you want** — click the icon and use the toggle. Turning
  it off is useful information for us, not a problem; please do it whenever you
  would rather it were off rather than putting up with it.
- Once a day the icon shows a **?**. Click it and answer one question: did the
  music get in the way today, 1–5, plus an optional note. It takes ten seconds
  and you can skip it.

## What is recorded

Everything stays on your machine until you choose to send it. Specifically:

- **Page addresses are never stored.** Each one is turned into a SHA-256 hash
  before anything is written down, so we can tell that you visited two different
  pages without being able to tell what either of them was.
- We record what the extension did: which mood it chose, when it changed, when
  it went quiet because a page was already playing audio, when you turned it
  off, when you skipped a track.
- **No page text, no page titles, no audio, no keystrokes.**
- Nothing is uploaded. The extension makes no network call to us at any point.

## At the end

Click the extension icon, then **Export data**. That saves one JSON file. Open
it and look at it — you are welcome to, and we would rather you did — then send
it to us. If anything in it makes you uncomfortable, tell us and we will drop it
or drop your data entirely; that is your call and it costs you nothing.

## Removing it

\`chrome://extensions\` → Remove. Everything the extension stored goes with it.
Do the export first if you want us to have your data, because uninstalling
deletes it.
`);

console.log(`\n[s5] build ${buildId}`);
console.log(`[s5] participant ${PARTICIPANT}, git ${gitSha.slice(0, 8)}${dirty ? ' (dirty)' : ''}`);
console.log(`[s5] wrote ${path.relative(REPO, OUT)}/`);
console.log(`[s5] delta vs ui/dist: w2m-build.json, w2m-study.js, manifest.json (version_name + alarms)`);

if (args.includes('--zip')) {
  const zip = `${OUT}.zip`;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zip}' -Force`],
      { stdio: 'pipe' });
    console.log(`[s5] zipped -> ${path.relative(REPO, zip)}`);
  } catch (e) {
    console.warn(`[s5] zip failed (${e.message.slice(0, 80)}); the folder is still usable.`);
  }
}
