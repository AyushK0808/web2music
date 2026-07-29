/*
 * qdrant_test.js — the Qdrant (Docker) adapter against a REAL server.
 *
 * Skips cleanly with exit 0 when Qdrant isn't running, so `npm test` stays
 * useful without Docker. To run it for real:
 *
 *   cd data-extraction/docker && docker compose up -d qdrant
 *   npm run test:qdrant
 *
 * Worth testing against the live server rather than a mock: the things most
 * likely to be wrong are Qdrant's own contracts — that point ids must be
 * UUID/uint64, that a collection's vector size is fixed, that `wait=true` is
 * needed before a search can see a write, and that cosine scores come back on
 * the same scale the store's thresholds assume. A mock would just encode my
 * assumptions and pass.
 */

'use strict';

const {
  createVectorStore, createQdrantAdapter, SIMILARITY_PRESETS,
} = require('./VectorStore.js');

const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
// Accept either name: QDRANT__SERVICE__API_KEY is what the container itself
// reads, so a developer who enabled auth already has it exported.
const QDRANT_API_KEY =
  process.env.QDRANT_API_KEY || process.env.QDRANT__SERVICE__API_KEY || null;
// A dedicated prefix so a run can never touch real data, and cleanup is total.
const PREFIX = 'w2mtest_';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function heading(text) {
  console.log(`\n${'─'.repeat(70)}\n${text}\n${'─'.repeat(70)}`);
}

function vec(seed, dims = 8) {
  const out = new Array(dims);
  for (let i = 0; i < dims; i++) out[i] = Math.sin((i + 1) * 0.7 + seed) + 1.5;
  return out;
}

const LOCAL = { backend: 'local', model: 'Xenova/all-MiniLM-L6-v2' };

async function main() {
  const adapter = createQdrantAdapter({
    url: QDRANT_URL, apiKey: QDRANT_API_KEY, collectionPrefix: PREFIX,
  });

  if (!(await adapter.health())) {
    console.log(`\nQdrant not reachable at ${QDRANT_URL} — skipping.`);
    console.log('Start it with: npm run qdrant:up\n');
    process.exit(0);
  }

  // health() alone is not enough: /readyz bypasses authentication, so a
  // misconfigured API key looks "up" and then 401s on the first real call.
  // Prove the database is actually usable before claiming it is.
  try {
    await adapter.count();
  } catch (err) {
    if (/401/.test(String(err.message))) {
      console.log(`\nQdrant at ${QDRANT_URL} is running but rejected our credentials (401).`);
      console.log('Set QDRANT_API_KEY to the key the container was started with,');
      console.log('or start it without one (npm run qdrant:up). Skipping.\n');
      process.exit(0);
    }
    throw err;
  }

  console.log(`\nQdrant is up and usable at ${QDRANT_URL}` +
              `${QDRANT_API_KEY ? ' (authenticated)' : ''}`);

  await adapter.clear(); // leave nothing behind from an earlier run

  try {
    const store = createVectorStore({ adapter, threshold: 0.5 });

    heading('server-side search');
    check('uses the adapter\'s native search, not a client scan',
      typeof adapter.searchNative === 'function');
    check('declares itself unbounded (no client-side entry cap)', adapter.unbounded === true);

    check('search on an absent collection is empty, not an error',
      (await store.search(vec(1), LOCAL)).best === null);

    await store.upsert({ url: 'https://a.com/coffee', vector: vec(1), title: 'Coffee', ...LOCAL });
    await store.upsert({ url: 'https://a.com/tea', vector: vec(5), title: 'Tea', ...LOCAL });

    // Qdrant indexes asynchronously; put() uses wait=true so this must be visible.
    check('a write is immediately searchable (wait=true)',
      (await store.search(vec(1), LOCAL)).best !== null);
    check('count reflects both points', (await store.size()) === 2, String(await store.size()));

    const identical = await store.search(vec(1), LOCAL);
    check('identical vector scores ~1.0 on Qdrant\'s cosine',
      identical.best && Math.abs(identical.best.score - 1) < 1e-5,
      identical.best && String(identical.best.score));
    check('score scale matches the store\'s thresholds (isRevisit fires)',
      identical.isRevisit === true);
    check('payload round-trips the title', identical.best && identical.best.title === 'Coffee');
    check('reports how many comparable vectors exist', identical.searched === 2,
      String(identical.searched));

    heading('threshold + filter are applied server-side');
    check('score_threshold excludes weak matches',
      (await store.search(vec(5.4), { ...LOCAL, threshold: 0.9999 })).matches.length === 0);
    check('a low threshold admits more',
      (await store.search(vec(5.4), { ...LOCAL, threshold: 0.1 })).matches.length >= 1);
    check('topK caps results',
      (await store.search(vec(1), { ...LOCAL, threshold: 0.1, topK: 1 })).matches.length === 1);
    const sorted = await store.search(vec(1), { ...LOCAL, threshold: 0.1, topK: 10 });
    check('ordering is descending by score',
      sorted.matches.every((m, i) => i === 0 || sorted.matches[i - 1].score >= m.score));

    const excluded = await store.search(vec(1), { ...LOCAL, excludeUrl: 'https://a.com/coffee' });
    check('excludeUrl filter applied by the server',
      !excluded.matches.some(m => m.url === 'https://a.com/coffee'),
      JSON.stringify(excluded.matches.map(m => m.url)));

    heading('per-namespace collections (fixed vector size per collection)');
    // Different dims must not land in the same collection — Qdrant would reject
    // the write outright, which is exactly the isolation we want.
    await store.upsert({ url: 'https://a.com/wide', vector: vec(2, 16), ...LOCAL });
    check('a different dimensionality is accepted into its own collection',
      (await store.size()) === 3, String(await store.size()));
    check('8-dim query only sees 8-dim vectors',
      (await store.search(vec(1, 8), { ...LOCAL, threshold: -1, topK: 50 })).matches.length === 2);
    check('16-dim query only sees 16-dim vectors',
      (await store.search(vec(2, 16), { ...LOCAL, threshold: -1, topK: 50 })).matches.length === 1);

    // Same dims, different model → different collection → no crossover.
    await store.upsert({
      url: 'https://a.com/other', vector: vec(1, 8),
      backend: 'local', model: 'Xenova/all-mpnet-base-v2',
    });
    const crossModel = await store.search(vec(1, 8), { ...LOCAL, threshold: -1, topK: 50 });
    check('same dims + different model does not cross over',
      !crossModel.matches.some(m => m.url === 'https://a.com/other'),
      JSON.stringify(crossModel.matches.map(m => m.url)));

    heading('ids, updates, housekeeping');
    const before = await store.size();
    await store.upsert({ url: 'https://a.com/coffee', vector: vec(1), title: 'Coffee v2', ...LOCAL });
    check('re-upserting the same url updates in place', (await store.size()) === before,
      `${before} → ${await store.size()}`);
    check('the update is reflected',
      (await store.search(vec(1), LOCAL)).best.title === 'Coffee v2');

    // A long unicode URL exercises the string→UUID hashing path.
    const messy = 'https://a.com/café/中文?q=' + 'x'.repeat(300);
    check('a long unicode url upserts (string→UUID id hashing)',
      (await store.upsert({ url: messy, vector: vec(9), ...LOCAL })) !== null);
    check('and is retrievable by similarity',
      (await store.search(vec(9), { ...LOCAL, threshold: 0.99 })).best !== null);

    await store.remove('https://a.com/tea', { ...LOCAL, dims: 8 });
    check('remove deletes the point',
      !(await store.search(vec(5), { ...LOCAL, threshold: 0.99 }))
        .matches.some(m => m.url === 'https://a.com/tea'));

    check('presets are usable as-is', SIMILARITY_PRESETS.duplicate === 0.95);

    await store.clear();
    check('clear removes every test collection', (await store.size()) === 0,
      String(await store.size()));

  } finally {
    // Never leave test collections behind, even on failure.
    await adapter.clear().catch(() => {});
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('═'.repeat(70));
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nQdrant test run crashed:', err);
  process.exit(1);
});
