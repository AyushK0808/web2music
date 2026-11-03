#!/usr/bin/env node
/**
 * C-9 — the annotation export must never leak a prediction, tier, outcome or
 * collection category to the people producing gold labels.
 *
 *   node analysis/annotate/export_for_annotation_test.mjs
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGE_FIELDS, TOP_FIELDS, assertAnnotationSafe, buildAnnotationFile,
} from './export_for_annotation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

/** A corpus page carrying every field the real corpus files carry. */
const polluted = {
  id: 'p1', url: 'https://example.com/a', slice: 'adversarial-near-miss',
  true_category: 'health', outcome: 'ok', content_hash: 'abc', word_count: 10,
  predicted_category: 'news', predicted_tier: 'llm', decided_by: 'zero-shot', mood: 'calm',
  extraction_telemetry: { total: 12 },
  pageData: {
    title: 'A page', url: 'https://example.com/a', rawText: 'Some body text.',
    embedding: [0.1, 0.2], colors: { dominant: '#fff' }, lang: 'en',
    _capture_context: { source: 'search', query: 'q' },
  },
};

test('export copies exactly the four allowlisted page fields', () => {
  const out = buildAnnotationFile({ pages: [polluted] });
  assert.deepEqual(Object.keys(out.pages[0]).sort(), [...PAGE_FIELDS].sort());
  assert.deepEqual(out.pages[0], { id: 'p1', url: 'https://example.com/a', title: 'A page', text: 'Some body text.' });
});

test('export has only allowlisted top-level fields', () => {
  const out = buildAnnotationFile({ pages: [polluted], captured_at: 'x', outcomes: { ok: 1 }, slices: {} });
  assert.deepEqual(Object.keys(out).sort(), [...TOP_FIELDS].sort());
});

test('no prediction / tier / category / outcome string survives anywhere in the serialised file', () => {
  const json = JSON.stringify(buildAnnotationFile({ pages: [polluted] }));
  for (const forbidden of ['true_category', 'predicted', 'decided_by', 'outcome', 'slice', 'adversarial', 'zero-shot', 'embedding', 'query']) {
    assert.ok(!json.includes(forbidden), `leaked: ${forbidden}`);
  }
});

test('assertAnnotationSafe rejects a page with any extra field', () => {
  for (const extra of ['true_category', 'prediction', 'tier', 'slice', 'outcome', 'pageData']) {
    const file = { pages: [{ id: 'x', url: '', title: '', text: '', [extra]: 'leak' }] };
    assert.throws(() => assertAnnotationSafe(file), new RegExp(extra));
  }
});

test('assertAnnotationSafe rejects extra top-level fields and non-string values', () => {
  assert.throws(() => assertAnnotationSafe({ pages: [], outcomes: {} }), /outcomes/);
  assert.throws(() => assertAnnotationSafe({ pages: [{ id: 'x', url: '', title: '', text: 5 }] }), /not a string/);
});

test('pages without extracted content are excluded, not exported empty', () => {
  const out = buildAnnotationFile({ pages: [polluted, { id: 'p2', url: 'u', pageData: null }] });
  assert.equal(out.n_pages, 1);
});

test('the shipped corpus exports cleanly', () => {
  const corpusPath = path.join(__dirname, '..', 'corpus', 's2_corpus.json');
  if (!fs.existsSync(corpusPath)) return;
  const out = buildAnnotationFile(JSON.parse(fs.readFileSync(corpusPath, 'utf8')));
  assertAnnotationSafe(out);
  assert.ok(out.n_pages > 0);
});

console.log(`\n${passed} passed`);
