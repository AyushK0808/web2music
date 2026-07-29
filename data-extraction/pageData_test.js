/*
 * pageData_test.js — asserted integration tests for the Handoff-1 assembler.
 *
 * Covers the wiring playground.js only eyeballs: the similarity engine end to
 * end through buildPageData(), plus a regression guard on the text-extraction
 * fix (the old leaf-biased density scorer returned ~1% of a page's text).
 *
 * Run: npm test
 */

'use strict';

const { JSDOM } = require('jsdom');
const { createVectorStore, createMemoryAdapter } = require('./VectorStore.js');

function makeDom(html, url) {
  const dom = new JSDOM(html, { url });
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;
  // A hashing bag-of-WORDS vectoriser. An earlier version of this stub summed
  // character codes, which gave any two long English texts a cosine of ~0.99 —
  // it could not tell espresso from glaciers, so it could not test that
  // unrelated pages *fail* to match. Hashing words means disjoint vocabularies
  // land in different buckets and come out near-orthogonal.
  dom.window.transformersPipeline = async () => async (text) => {
    const dims = 64;
    const vec = new Array(dims).fill(0);
    for (const word of String(text).toLowerCase().match(/[a-z]+/g) || []) {
      let hash = 5381;
      for (let i = 0; i < word.length; i++) hash = ((hash << 5) + hash + word.charCodeAt(i)) | 0;
      vec[Math.abs(hash) % dims] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return { data: vec.map(v => v / norm) };
  };
  return dom;
}

const ARTICLE = (body) => `<!DOCTYPE html><html lang="en"><head><title>T</title></head>
<body><article>${body}</article></body></html>`;

const LONG = 'Espresso is a concentrated coffee brewed by forcing hot water through finely ground beans under pressure. '.repeat(12);
const OTHER = 'Glaciers are persistent bodies of dense ice that form where snow accumulation exceeds ablation over many years. '.repeat(12);

(async () => {
  const store = createVectorStore({ adapter: createMemoryAdapter(), threshold: 0.5 });
  const tracker = { snapshot: () => ({ scrollSpeed: 0, cursorSpeed: 0 }) };
  const opts = { embeddingConfig: { backend: 'local' }, behaviorTracker: tracker, vectorStore: store, useCache: false };

  let ok = 0, bad = 0;
  const t = (name, cond, detail) => {
    if (cond) { ok++; console.log('  ✅ ' + name); }
    else { bad++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
  };

  const { buildPageData } = require('./pageData.js');

  // 1) First page: nothing to match yet, but it gets recorded.
  let dom = makeDom(ARTICLE(LONG), 'https://a.com/espresso');
  const first = await buildPageData({ ...opts, doc: dom.window.document });
  t('first page has no similar pages', Array.isArray(first.similarPages) && first.similarPages.length === 0,
    JSON.stringify(first.similarPages));
  t('first page is not a revisit', first.isRevisit === false);
  t('first page got embedded', first.embedding.length === 64);
  t('first page was stored', (await store.size()) === 1, String(await store.size()));
  t('no warnings', !first.warnings, JSON.stringify(first.warnings));

  // 2) Same content at a different URL → should be recognised as a revisit.
  dom = makeDom(ARTICLE(LONG), 'https://b.com/espresso-copy');
  const dup = await buildPageData({ ...opts, doc: dom.window.document });
  t('duplicate content finds a match', dup.similarPages.length >= 1,
    JSON.stringify(dup.similarPages));
  t('duplicate is flagged isRevisit', dup.isRevisit === true, 'score=' + dup.nearestScore);
  t('match points at the original url',
    dup.similarPages[0] && dup.similarPages[0].url === 'https://a.com/espresso',
    dup.similarPages[0] && dup.similarPages[0].url);
  t('nearestScore is ~1 for identical text', dup.nearestScore > 0.99, String(dup.nearestScore));

  // 3) Unrelated content should not be a revisit.
  dom = makeDom(ARTICLE(OTHER), 'https://c.com/glaciers');
  const diff = await buildPageData({ ...opts, doc: dom.window.document });
  t('unrelated page is not a revisit', diff.isRevisit === false, 'score=' + diff.nearestScore);

  // 4) Revisiting the SAME url must not self-match.
  dom = makeDom(ARTICLE(LONG), 'https://a.com/espresso');
  const again = await buildPageData({ ...opts, doc: dom.window.document });
  t('same url does not match itself',
    !again.similarPages.some(m => m.url === 'https://a.com/espresso'),
    JSON.stringify(again.similarPages.map(m => m.url)));

  // 5) Opting out entirely.
  dom = makeDom(ARTICLE(LONG), 'https://d.com/x');
  const off = await buildPageData({ ...opts, doc: dom.window.document, vectorStore: false });
  t('vectorStore:false omits similarity fields',
    off.similarPages === undefined && off.isRevisit === undefined);

  // 6) Telemetry should include the similarity stage.
  const { getExtractionTelemetry } = require('./pageData.js');
  const tel = getExtractionTelemetry();
  t('similarity stage is timed', tel.similarity && tel.similarity.count >= 4,
    tel.similarity && String(tel.similarity.count));
  t('similarity stage had no failures', tel.similarity && tel.similarity.failures === 0);

  // 7) Text extraction fix: the article body should be captured, not a fragment.
  t('extracted the article text, not a fragment', first.wordCount > 100, String(first.wordCount));
  t('did not trip isImageOnly on a text page', first.isImageOnly === false);

  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
