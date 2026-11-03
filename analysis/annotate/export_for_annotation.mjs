#!/usr/bin/env node
/**
 * C-9 / L-1 — build the file the annotation tool loads, from an allowlist.
 *
 *   node analysis/annotate/export_for_annotation.mjs <corpus.json> <out.json>
 *   node analysis/annotate/export_for_annotation.mjs --check <file.json>
 *
 * Gold labels must come from people who cannot see what the system predicted
 * or which category a page was collected for. The corpus files carry both
 * (true_category, outcome, extraction telemetry, embeddings, slice names that
 * reveal the adversarial design), so the annotation file is built by copying
 * ONLY the fields below. Anything else is dropped; it is never a blocklist.
 *
 * `--check` re-validates an existing annotation file and exits non-zero if any
 * other field is present, so the same rule guards a file that was produced by
 * hand.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The only per-page fields an annotator may be shown. */
export const PAGE_FIELDS = Object.freeze(['id', 'url', 'title', 'text']);
/** The only top-level fields of the file. */
export const TOP_FIELDS = Object.freeze(['exported_at', 'n_pages', 'pages']);

/** Pull the four allowed fields out of either corpus page shape. */
export function toAnnotationPage(page) {
  const pd = page.pageData ?? {};
  return {
    id: String(page.id),
    url: page.url ?? pd.url ?? '',
    title: pd.title ?? page.title ?? '',
    text: pd.rawText ?? page.text ?? '',
  };
}

export function buildAnnotationFile(corpus, now = new Date()) {
  const pages = (corpus.pages ?? [])
    .filter((p) => p.pageData || p.text)
    .map(toAnnotationPage);
  return { exported_at: now.toISOString(), n_pages: pages.length, pages };
}

/** Throws unless `file` contains nothing outside the allowlists. */
export function assertAnnotationSafe(file) {
  const extraTop = Object.keys(file).filter((k) => !TOP_FIELDS.includes(k));
  if (extraTop.length) throw new Error(`annotation file has non-allowlisted top-level field(s): ${extraTop.join(', ')}`);
  if (!Array.isArray(file.pages)) throw new Error('annotation file has no pages array');
  file.pages.forEach((p, i) => {
    const extra = Object.keys(p).filter((k) => !PAGE_FIELDS.includes(k));
    if (extra.length) throw new Error(`page ${i} (${p.id}) has non-allowlisted field(s): ${extra.join(', ')}`);
    for (const k of PAGE_FIELDS) {
      if (typeof p[k] !== 'string') throw new Error(`page ${i} (${p.id}) field ${k} is not a string`);
    }
  });
  return true;
}

function main(argv) {
  if (argv[0] === '--check') {
    const file = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
    assertAnnotationSafe(file);
    console.log(`ok: ${file.pages.length} page(s), only ${PAGE_FIELDS.join('/')}`);
    return 0;
  }
  const [src, dst] = argv;
  if (!src || !dst) {
    console.error('usage: export_for_annotation.mjs <corpus.json> <out.json> | --check <file.json>');
    return 2;
  }
  const out = buildAnnotationFile(JSON.parse(fs.readFileSync(src, 'utf8')));
  assertAnnotationSafe(out);
  fs.writeFileSync(dst, JSON.stringify(out, null, 2));
  console.log(`wrote ${dst}: ${out.n_pages} page(s)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
