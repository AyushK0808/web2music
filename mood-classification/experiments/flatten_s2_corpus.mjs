#!/usr/bin/env node
/**
 * Item 52 prep: analysis/corpus/s2_corpus.json nests title/rawText/lang
 * under pageData (it's the raw capture record, extraction telemetry and
 * all); s2_tier_ablation.js expects the flat {id, lang, title, rawText,
 * true_category} shape s2_smoke_corpus.json already uses. This produces
 * that flat file from the real 260-page corpus so --corpus can point at
 * it directly, instead of guessing a file that doesn't actually match
 * the script's own expected input shape.
 *
 * Only pages with outcome === "captured" carry a real pageData (bypassed/
 * navigation-failed pages don't) -- those are dropped here with a count
 * printed, not silently included as null-text records.
 *
 * Usage:
 *   node flatten_s2_corpus.mjs analysis/corpus/s2_corpus.json analysis/corpus/s2_corpus_flat.json
 */
import fs from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('Usage: node flatten_s2_corpus.mjs <in.json> <out.json>');
  process.exit(1);
}

const corpus = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const dropped = [];
const pages = [];

for (const p of corpus.pages) {
  if (p.outcome !== 'captured' || !p.pageData) {
    dropped.push({ id: p.id, outcome: p.outcome });
    continue;
  }
  pages.push({
    id: p.id,
    lang: p.pageData.lang ?? null,
    title: p.pageData.title ?? '',
    rawText: p.pageData.rawText ?? '',
    true_category: p.true_category ?? null,
  });
}

const out = {
  _notice: `Flattened from ${inPath} for s2_tier_ablation.js's expected shape. ` +
    `${dropped.length} of ${corpus.pages.length} source pages dropped (not captured / no pageData).`,
  pages,
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}: ${pages.length} pages (dropped ${dropped.length})`);
if (dropped.length) {
  console.log('dropped:', dropped.map((d) => `${d.id} (${d.outcome})`).join(', '));
}
