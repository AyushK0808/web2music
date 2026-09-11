// Item 44: sensitive-detector threshold sweep / ROC over the existing
// 47-page adversarial slice. Reuses resolveSensitivity()'s keyword-tier
// term counts (severe/ambiguous/hard) via the public API -- the zero-shot
// tier inside it no-ops without network config, so this makes no network
// calls. No new labelling: same 47-page slice t5_audit.mjs already uses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSensitivity } from '../mood-classification/feature_b/b1_contentUnderstanding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'analysis', 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const slice = JSON.parse(fs.readFileSync(path.join(REPO, 'analysis/audit/sensitive_slice.json'), 'utf8'));
const pages = slice.pages;

const counted = [];
for (const p of pages) {
  const text = `${p.title} ${p.text}`;
  const r = await resolveSensitivity(text, {}, {}); // zero-shot disabled by default -> no network
  counted.push({ id: p.id, truth: p.sensitive, slice: p.slice, severe: r.keyword.severe, ambiguous: r.keyword.ambiguous, hard: r.keyword.hard });
}

function scoreAt(severeThresh, ambigThresh) {
  let tp=0, fp=0, tn=0, fn=0;
  for (const c of counted) {
    const pred = c.severe >= severeThresh || c.ambiguous >= ambigThresh;
    if (c.truth && pred) tp++;
    else if (c.truth && !pred) fn++;
    else if (!c.truth && pred) fp++;
    else tn++;
  }
  const fnr = tp+fn>0 ? fn/(tp+fn) : null;
  const fpr = fp+tn>0 ? fp/(fp+tn) : null;
  const tpr = tp+fn>0 ? tp/(tp+fn) : null;
  return { severeThresh, ambigThresh, tp, fp, tn, fn, fnr, fpr, tpr };
}

console.log('=== Item 44: threshold sweep (severe-term thresh x ambiguous-term thresh), n=47 (29 sensitive, 18 benign) ===');
console.log('severeThresh ambigThresh   TP  FP  TN  FN    FNR    FPR    TPR');
const rows = [];
for (const sT of [1, 2]) {
  for (const aT of [1, 2, 3, 4]) {
    const s = scoreAt(sT, aT);
    rows.push(s);
    console.log(`${String(sT).padStart(6)} ${String(aT).padStart(12)}   ${String(s.tp).padStart(2)}  ${String(s.fp).padStart(2)}  ${String(s.tn).padStart(2)}  ${String(s.fn).padStart(2)}   ${s.fnr.toFixed(3)}  ${s.fpr.toFixed(3)}  ${s.tpr.toFixed(3)}`);
  }
}

// shipped operating point (severe>=1 covers hard+demotable, ambiguous>=2)
const shipped = scoreAt(1, 2);
console.log('\nShipped operating point (severe>=1, ambiguous>=2):', JSON.stringify(shipped));

fs.writeFileSync(path.join(OUT_DIR, 'item44_sweep.json'), JSON.stringify({ per_page: counted, sweep: rows, shipped }, null, 2));
