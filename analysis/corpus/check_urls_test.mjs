#!/usr/bin/env node
/**
 * L-3 / L-6 / S-E — validate and freeze the held-out test URL list BEFORE any
 * classifier has run on it.
 *
 *   node analysis/corpus/check_urls_test.mjs analysis/corpus/urls-test.jsonl
 *   node analysis/corpus/check_urls_test.mjs analysis/corpus/urls-test.jsonl --cutoff 2025-06-01 --min-post-cutoff 80
 *   node analysis/corpus/check_urls_test.mjs --self-test
 *
 * Extra fields on top of the urls.example.jsonl schema:
 *   source       required. Where the URL came from. Allowed: search-template (a fixed query
 *                template per category), tranco, curlie, wikipedia-random, news-rss,
 *                helpline-directory (the real crisis/support pages). Anything else, and in
 *                particular "llm" or "assistant", is rejected: no URL is suggested by an LLM.
 *   query        required for search-template / helpline-directory / curlie (the logged query or
 *                directory path); optional otherwise.
 *   published    ISO date the page was published (for the contamination slice, L-6).
 *   true_category  the category the page was collected FOR. Used only as a sanity check on
 *                agreement with the blind labels; it is never shown to annotators.
 *
 * Checks (non-zero exit on any failure):
 *   - every line parses; ids and URLs are unique
 *   - every source is allowed and every source that needs a query has one
 *   - wikipedia-random is at most 25% of the list
 *   - at least --min-per-category (20) pages for each of the 13 categories
 *   - at least --min-post-cutoff (80) pages with published > --cutoff
 *   - at least --min-sensitive (50) helpline-directory pages (the black-box set)
 * Prints a SHA-256 of the file so the freeze commit message can quote it.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATEGORY_KEYWORDS } from '../../mood-classification/feature_b/b1_contentUnderstanding.js';

export const ALLOWED_SOURCES = new Set(['search-template', 'tranco', 'curlie', 'wikipedia-random', 'news-rss', 'helpline-directory']);
const NEEDS_QUERY = new Set(['search-template', 'curlie', 'helpline-directory']);
const BANNED = /llm|assistant|claude|gpt|chatgpt|model-suggested/i;

export function parseJsonl(text) {
  const rows = [];
  const errors = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    try { rows.push({ ...JSON.parse(t), _line: i + 1 }); }
    catch (e) { errors.push(`line ${i + 1}: not valid JSON (${e.message})`); }
  });
  return { rows, errors };
}

export function validate(rows, { cutoff = null, minPostCutoff = 80, minPerCategory = 20, minSensitive = 50, categories = Object.keys(CATEGORY_KEYWORDS) } = {}) {
  const errors = [];
  const ids = new Set(), urls = new Set();
  for (const r of rows) {
    const where = `line ${r._line} (${r.id ?? '?'})`;
    if (!r.id || !r.url) errors.push(`${where}: id and url are required`);
    if (ids.has(r.id)) errors.push(`${where}: duplicate id`);
    if (urls.has(r.url)) errors.push(`${where}: duplicate url`);
    ids.add(r.id); urls.add(r.url);
    if (!r.source) errors.push(`${where}: empty source (every URL must say where it came from)`);
    else if (BANNED.test(r.source) || BANNED.test(r.query ?? '')) errors.push(`${where}: source "${r.source}" looks LLM-suggested`);
    else if (!ALLOWED_SOURCES.has(r.source)) errors.push(`${where}: source "${r.source}" is not one of ${[...ALLOWED_SOURCES].join(', ')}`);
    if (NEEDS_QUERY.has(r.source) && !r.query) errors.push(`${where}: source ${r.source} requires a logged query`);
  }

  const n = rows.length || 1;
  const wiki = rows.filter((r) => r.source === 'wikipedia-random').length;
  if (wiki / n > 0.25) errors.push(`wikipedia-random is ${(100 * wiki / n).toFixed(1)}% of the list (limit 25%)`);

  const perCat = Object.fromEntries(categories.map((c) => [c, rows.filter((r) => r.true_category === c).length]));
  for (const [c, k] of Object.entries(perCat)) if (k < minPerCategory) errors.push(`category ${c}: ${k} page(s), need >= ${minPerCategory}`);

  const sensitive = rows.filter((r) => r.source === 'helpline-directory').length;
  if (sensitive < minSensitive) errors.push(`only ${sensitive} helpline-directory page(s), need >= ${minSensitive} for the black-box set`);

  let post = null;
  if (cutoff) {
    post = rows.filter((r) => r.published && r.published > cutoff).length;
    if (post < minPostCutoff) errors.push(`only ${post} page(s) published after ${cutoff}, need >= ${minPostCutoff} (L-6)`);
  }
  const mix = {};
  for (const r of rows) mix[r.source ?? '(none)'] = (mix[r.source ?? '(none)'] || 0) + 1;
  return { errors, summary: { n: rows.length, source_mix: mix, per_category: perCat, post_cutoff: post, sensitive } };
}

function selfTest() {
  const good = (i, extra = {}) => ({ _line: i, id: `p${i}`, url: `https://e.com/${i}`, source: 'tranco', true_category: 'News', ...extra });
  const rows = Array.from({ length: 30 }, (_, i) => good(i));
  const cats = ['News'];
  let r = validate(rows, { categories: cats, minSensitive: 0 });
  if (r.errors.length) throw new Error(`clean list rejected: ${r.errors.join('; ')}`);
  r = validate([...rows, good(99, { source: 'llm-suggested' })], { categories: cats, minSensitive: 0 });
  if (!r.errors.some((e) => /LLM-suggested/.test(e))) throw new Error('LLM source not rejected');
  r = validate([...rows, good(98, { source: '' })], { categories: cats, minSensitive: 0 });
  if (!r.errors.some((e) => /empty source/.test(e))) throw new Error('empty source not rejected');
  r = validate([...rows, good(97, { source: 'search-template' })], { categories: cats, minSensitive: 0 });
  if (!r.errors.some((e) => /requires a logged query/.test(e))) throw new Error('missing query not rejected');
  r = validate(rows.map((x, i) => (i < 12 ? { ...x, source: 'wikipedia-random' } : x)), { categories: cats, minSensitive: 0 });
  if (!r.errors.some((e) => /wikipedia-random is/.test(e))) throw new Error('wikipedia cap not enforced');
  r = validate(rows, { categories: cats, minSensitive: 0, cutoff: '2025-06-01', minPostCutoff: 5 });
  if (!r.errors.some((e) => /published after/.test(e))) throw new Error('post-cutoff minimum not enforced');
  r = validate([...rows, good(5)], { categories: cats, minSensitive: 0 });
  if (!r.errors.some((e) => /duplicate/.test(e))) throw new Error('duplicates not rejected');
  console.log('self-test ok');
}

function main(argv) {
  if (argv.includes('--self-test')) { selfTest(); return 0; }
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: check_urls_test.mjs <urls-test.jsonl> [--cutoff YYYY-MM-DD] [--min-post-cutoff N]'); return 2; }
  const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
  const text = fs.readFileSync(file, 'utf8');
  const { rows, errors: parseErrors } = parseJsonl(text);
  const { errors, summary } = validate(rows, {
    cutoff: opt('cutoff', null), minPostCutoff: Number(opt('min-post-cutoff', 80)),
    minPerCategory: Number(opt('min-per-category', 20)), minSensitive: Number(opt('min-sensitive', 50)),
  });
  const all = [...parseErrors, ...errors];
  console.log(JSON.stringify(summary, null, 2));
  console.log(`sha256 ${crypto.createHash('sha256').update(text).digest('hex')}`);
  if (all.length) { console.error(`\n${all.length} problem(s):\n  ${all.join('\n  ')}`); return 1; }
  console.log('\nurl list OK — commit it before running any classifier on these pages');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
