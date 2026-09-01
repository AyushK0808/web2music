// Re-verification of the FIRST-PASS quadrant mapping (system's own per-mood
// valence hint + BPM-range midpoint), reconstructed to re-confirm the
// originally reported alpha=0.121 before citing it alongside the NRC-VAD
// result. Not a new analysis -- same method as the first pass.
import { computeValenceHint } from './feature_b/b2_moodClassifier.js';
import fs from 'node:fs';
import path from 'node:path';

const BPM_MID = {
  calm: 65, focused: 90, joyful: 120, energetic: 145, sad: 55, dark: 75,
  nostalgic: 82.5, curious: 97.5, tense: 110, uplifting: 97.5, neutral: 80,
};
const MOODS = Object.keys(BPM_MID);
const sortedBpm = Object.values(BPM_MID).slice().sort((a, b) => a - b);
const medianBpm = sortedBpm[Math.floor(sortedBpm.length / 2)];

const quadrant = {};
for (const mood of MOODS) {
  const v = computeValenceHint(mood);
  const highArousal = BPM_MID[mood] >= medianBpm;
  const positiveValence = v >= 0;
  quadrant[mood] = highArousal
    ? (positiveValence ? 'Q1-excited' : 'Q2-tense')
    : (positiveValence ? 'Q4-calm' : 'Q3-sad');
}

function nominalAlpha(units) {
  const usable = Object.fromEntries(
    Object.entries(units).map(([u, vals]) => [u, vals.filter((v) => v !== null && v !== undefined)])
      .filter(([, vals]) => vals.length >= 2)
  );
  if (Object.keys(usable).length === 0) return null;
  const coincidence = new Map();
  const key = (a, b) => a + ' ' + b;
  let nTotal = 0;
  for (const vals of Object.values(usable)) {
    const m = vals.length;
    nTotal += m;
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j) {
      const k = key(vals[i], vals[j]);
      coincidence.set(k, (coincidence.get(k) || 0) + 1 / (m - 1));
    }
  }
  if (nTotal < 2) return null;
  const values = [...new Set(Object.values(usable).flat())].sort();
  const nC = Object.fromEntries(values.map((v) => [v, values.reduce((s, w) => s + (coincidence.get(key(v, w)) || 0), 0)]));
  let dO = 0;
  for (const a of values) for (const b of values) if (a !== b) dO += coincidence.get(key(a, b)) || 0;
  let dE = 0;
  for (const a of values) for (const b of values) if (a !== b) dE += nC[a] * nC[b];
  dE /= (nTotal - 1);
  if (dE === 0) return 1.0;
  return 1 - dO / dE;
}

function bootstrapAlphaCI(units, resamples = 2000, seed = 20260810) {
  const keys = Object.keys(units);
  if (keys.length < 3) return [NaN, NaN];
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const stats = [];
  for (let r = 0; r < resamples; r++) {
    const sample = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[Math.floor(rnd() * keys.length)];
      sample[`${k}#${i}`] = units[k];
    }
    const a = nominalAlpha(sample);
    if (a !== null) stats.push(a);
  }
  if (!stats.length) return [NaN, NaN];
  stats.sort((a, b) => a - b);
  const lo = stats[Math.max(0, Math.floor(0.025 * stats.length) - 1)];
  const hi = stats[Math.min(stats.length - 1, Math.floor(0.975 * stats.length))];
  return [lo, hi];
}

const dir = path.resolve('../analysis/out/annotations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const annotations = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const allIds = [...new Set(annotations.flatMap((a) => Object.keys(a.labels)))].sort();

const quadUnits = {};
for (const id of allIds) {
  quadUnits[id] = annotations.map((a) => {
    const mood = a.labels[id]?.mood;
    return mood ? quadrant[mood] : null;
  });
}
const quadAlpha = nominalAlpha(quadUnits);
const [lo, hi] = bootstrapAlphaCI(quadUnits);
console.log('Own-taxonomy quadrant alpha:', quadAlpha?.toFixed(3), `95% CI [${lo?.toFixed(3)}, ${hi?.toFixed(3)}]`);
const dist = {};
for (const vals of Object.values(quadUnits)) for (const v of vals) if (v) dist[v] = (dist[v] || 0) + 1;
console.log('Distribution:', dist);
const total = Object.values(dist).reduce((s,v)=>s+v,0);
console.log('Total judgements:', total, 'largest share:', (Math.max(...Object.values(dist))/total*100).toFixed(1)+'%');
