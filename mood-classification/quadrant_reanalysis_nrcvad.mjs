// V-B follow-up: repeat the quadrant collapse using published valence/arousal
// norms (NRC-VAD, Mohammad 2018) instead of the system's own per-mood
// valence hint and BPM-range midpoint, per the reviewer's request that the
// first pass tested this taxonomy's own geometry rather than Russell's.
//
// Source: NRC-VAD-Lexicon.txt (Mohammad, ACL 2018), 0..1 scale, midpoint 0.5.
// 'focused' is not in the lexicon; 'focus' (its lemma) is used in its place,
// noted explicitly since it is the one substitution made.
import fs from 'node:fs';
import path from 'node:path';

const NRC_VAD = {
  calm:      { v: 0.875, a: 0.100 },
  focused:   { v: 0.690, a: 0.382 }, // lexicon has 'focus', not 'focused'
  joyful:    { v: 0.990, a: 0.740 },
  energetic: { v: 0.847, a: 0.868 },
  sad:       { v: 0.225, a: 0.333 },
  dark:      { v: 0.198, a: 0.398 },
  nostalgic: { v: 0.458, a: 0.351 },
  curious:   { v: 0.635, a: 0.600 },
  tense:     { v: 0.396, a: 0.439 },
  uplifting: { v: 0.771, a: 0.548 },
  neutral:   { v: 0.469, a: 0.184 },
};
const MOODS = Object.keys(NRC_VAD);

// Midpoint split at 0.5, the scale's own defined neutral point -- not a
// sample median fit to these 11 words, so the split is not chosen to
// engineer a particular quadrant balance.
const quadrant = {};
for (const mood of MOODS) {
  const { v, a } = NRC_VAD[mood];
  const positiveValence = v >= 0.5;
  const highArousal = a >= 0.5;
  quadrant[mood] = highArousal
    ? (positiveValence ? 'Q1-excited' : 'Q2-tense')
    : (positiveValence ? 'Q4-calm' : 'Q3-sad');
}
console.log('Per-mood NRC-VAD valence/arousal and quadrant (0.5 midpoint split):');
for (const m of MOODS) console.log(`  ${m.padEnd(10)} v=${NRC_VAD[m].v.toFixed(3)}  a=${NRC_VAD[m].a.toFixed(3)}  -> ${quadrant[m]}`);
console.log('\nQuadrant membership:');
for (const q of ['Q1-excited', 'Q2-tense', 'Q3-sad', 'Q4-calm']) {
  console.log(`  ${q}: ${MOODS.filter((m) => quadrant[m] === q).join(', ') || '(empty)'}`);
}

// ---- Same nominal-alpha algorithm as krippendorff.py / the first pass ----
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
console.log('\nAnnotators:', annotations.map((a) => a.annotator).join(', '));

const allIds = [...new Set(annotations.flatMap((a) => Object.keys(a.labels)))].sort();

const rawMoodUnits = {};
for (const id of allIds) rawMoodUnits[id] = annotations.map((a) => a.labels[id]?.mood ?? null);
const rawAlpha = nominalAlpha(rawMoodUnits);
console.log('\nSanity check, raw 11-way mood alpha (should be ~0.195):', rawAlpha?.toFixed(3));

const quadUnits = {};
for (const id of allIds) {
  quadUnits[id] = annotations.map((a) => {
    const mood = a.labels[id]?.mood;
    return mood ? quadrant[mood] : null;
  });
}
const quadAlpha = nominalAlpha(quadUnits);
const [lo, hi] = bootstrapAlphaCI(quadUnits);
console.log('\nNRC-VAD quadrant-collapsed alpha:', quadAlpha?.toFixed(3), `95% CI [${lo?.toFixed(3)}, ${hi?.toFixed(3)}]`);

const dist = {};
for (const vals of Object.values(quadUnits)) for (const v of vals) if (v) dist[v] = (dist[v] || 0) + 1;
console.log('Quadrant label distribution across all annotator-judgements:', dist);
