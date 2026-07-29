/*
 * vectorStore_test.js — asserted tests for Feature A's similarity engine.
 *
 * Unlike playground.js (an eyeball script), these assert. Run: npm test
 *
 * The cases that matter most here are the ones that would silently return
 * confident nonsense rather than throw: cross-model comparisons, zero vectors,
 * and a page matching itself.
 */

'use strict';

const {
  createVectorStore, createMemoryAdapter, normalizeVector, canonicalizeUrl,
  SIMILARITY_PRESETS,
} = require('./VectorStore.js');

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

const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/* A deterministic vector generator: `seed` controls direction, so two calls with
 * the same seed are identical and nearby seeds are highly similar. */
function vec(seed, dims = 8) {
  const out = new Array(dims);
  for (let i = 0; i < dims; i++) {
    out[i] = Math.sin((i + 1) * 0.7 + seed) + 1.5;
  }
  return out;
}

const LOCAL = { backend: 'local', model: 'Xenova/all-MiniLM-L6-v2' };

async function main() {
  /* ── Vector math ──────────────────────────────────────────────────────── */
  heading('normalizeVector / canonicalizeUrl');

  const n = normalizeVector([3, 4]);
  check('normalises to unit length', approx(Math.hypot(n[0], n[1]), 1));
  check('preserves direction', approx(n[0], 0.6) && approx(n[1], 0.8));
  check('zero vector → null (no direction, no similarity)', normalizeVector([0, 0]) === null);
  check('all-zero long vector → null', normalizeVector([0, 0, 0, 0]) === null);

  check('strips utm params',
    canonicalizeUrl('https://a.com/p?utm_source=x&id=7') === 'https://a.com/p?id=7',
    canonicalizeUrl('https://a.com/p?utm_source=x&id=7'));
  check('strips fragment', canonicalizeUrl('https://a.com/p#section') === 'https://a.com/p');
  check('strips trailing slash', canonicalizeUrl('https://a.com/p/') === 'https://a.com/p');
  check('keeps meaningful query', canonicalizeUrl('https://a.com/s?q=jazz').includes('q=jazz'));
  check('non-URL input survives', canonicalizeUrl('about:blank') === 'about:blank');

  /* ── Basic search ─────────────────────────────────────────────────────── */
  heading('upsert / search');

  const store = createVectorStore({ adapter: createMemoryAdapter(), threshold: 0.5 });

  check('empty store returns no match',
    (await store.search(vec(1), LOCAL)).best === null);

  await store.upsert({ url: 'https://a.com/coffee', vector: vec(1), title: 'Coffee', ...LOCAL });
  await store.upsert({ url: 'https://a.com/tea', vector: vec(5), title: 'Tea', ...LOCAL });
  check('size reflects two records', (await store.size()) === 2);

  const identical = await store.search(vec(1), LOCAL);
  check('identical vector scores ~1.0', identical.best && approx(identical.best.score, 1, 1e-9),
    identical.best && String(identical.best.score));
  check('identical vector is flagged a revisit', identical.isRevisit === true);
  check('match carries title through', identical.best && identical.best.title === 'Coffee');

  const upserted = await store.upsert({ url: 'https://a.com/coffee', vector: vec(1), ...LOCAL });
  check('re-upserting same url replaces, not duplicates', (await store.size()) === 2);
  check('createdAt preserved across update', upserted.createdAt <= upserted.updatedAt);

  /* ── Self-match exclusion ─────────────────────────────────────────────── */
  heading('excludeUrl (a page must not match itself)');

  const selfSearch = await store.search(vec(1), { ...LOCAL, excludeUrl: 'https://a.com/coffee' });
  check('own record excluded',
    !selfSearch.matches.some(m => m.url === 'https://a.com/coffee'),
    JSON.stringify(selfSearch.matches.map(m => m.url)));
  check('exclusion is canonicalised too',
    !(await store.search(vec(1), { ...LOCAL, excludeUrl: 'https://a.com/coffee/?utm_source=z#x' }))
      .matches.some(m => m.url === 'https://a.com/coffee'));

  /* ── Thresholds ───────────────────────────────────────────────────────── */
  heading('similarity threshold');

  const strict = await store.search(vec(5.4), { ...LOCAL, threshold: 0.999 });
  const loose = await store.search(vec(5.4), { ...LOCAL, threshold: 0.1 });
  check('a high threshold admits fewer matches than a low one',
    strict.matches.length <= loose.matches.length,
    `strict=${strict.matches.length} loose=${loose.matches.length}`);
  check('every returned match clears the threshold',
    loose.matches.every(m => m.score >= 0.1));
  check('matches are sorted best-first',
    loose.matches.every((m, i) => i === 0 || loose.matches[i - 1].score >= m.score));
  check('revisitThreshold is independent of threshold',
    (await store.search(vec(5), { ...LOCAL, threshold: 0.1, revisitThreshold: 0.99 })).isRevisit === true);
  check('presets are ordered duplicate > sameTopic > related',
    SIMILARITY_PRESETS.duplicate > SIMILARITY_PRESETS.sameTopic &&
    SIMILARITY_PRESETS.sameTopic > SIMILARITY_PRESETS.related);

  check('topK caps results', (await store.search(vec(1), { ...LOCAL, threshold: -1, topK: 1 }))
    .matches.length === 1);

  /* ── Namespacing: the correctness-critical part ───────────────────────── */
  heading('namespace isolation (cross-model vectors must never be compared)');

  const ns = createVectorStore({ adapter: createMemoryAdapter(), threshold: -1 });
  await ns.upsert({ url: 'https://a.com/x', vector: vec(1, 8), ...LOCAL });

  const otherBackend = await ns.search(vec(1, 8), {
    backend: 'openai', model: 'text-embedding-3-small',
  });
  check('different backend → no match',
    otherBackend.matches.length === 0 && otherBackend.searched === 0,
    `searched=${otherBackend.searched}`);

  // Same backend AND same dims, differing only by model. This is the case that
  // isolates the `model` component of the namespace — the check above also
  // differs by backend, so it would still pass if model were ignored entirely.
  const otherModel = await ns.search(vec(1, 8), {
    backend: 'local', model: 'Xenova/all-mpnet-base-v2',
  });
  check('same backend + same dims, different model → no match',
    otherModel.matches.length === 0 && otherModel.searched === 0,
    `searched=${otherModel.searched}`);

  const otherDims = await ns.search(vec(1, 16), LOCAL);
  check('different dims → no match',
    otherDims.matches.length === 0 && otherDims.searched === 0,
    `searched=${otherDims.searched}`);

  check('same backend+model+dims → does match',
    (await ns.search(vec(1, 8), LOCAL)).matches.length === 1);

  await ns.upsert({ url: 'https://a.com/x', vector: vec(1, 16), ...LOCAL });
  check('same url in two namespaces coexists as two records', (await ns.size()) === 2);

  /* ── Bad input ────────────────────────────────────────────────────────── */
  heading('degenerate input is rejected, not stored');

  const bad = createVectorStore({ adapter: createMemoryAdapter() });
  check('upsert rejects zero vector', (await bad.upsert({ url: 'u', vector: [0, 0], ...LOCAL })) === null);
  check('upsert rejects empty vector', (await bad.upsert({ url: 'u', vector: [], ...LOCAL })) === null);
  check('upsert rejects NaN', (await bad.upsert({ url: 'u', vector: [1, NaN], ...LOCAL })) === null);
  check('upsert rejects Infinity', (await bad.upsert({ url: 'u', vector: [1, Infinity], ...LOCAL })) === null);
  check('upsert rejects non-array', (await bad.upsert({ url: 'u', vector: 'nope', ...LOCAL })) === null);
  check('upsert rejects missing vector', (await bad.upsert({ url: 'u', ...LOCAL })) === null);
  check('nothing was stored', (await bad.size()) === 0);
  check('search on zero vector returns empty', (await bad.search([0, 0], LOCAL)).best === null);
  check('search on garbage returns empty', (await bad.search(null, LOCAL)).best === null);

  /* ── Eviction ─────────────────────────────────────────────────────────── */
  heading('capacity cap and eviction');

  const capped = createVectorStore({ adapter: createMemoryAdapter(), maxEntries: 3, threshold: -1 });
  for (let i = 0; i < 6; i++) {
    await capped.upsert({ url: `https://a.com/${i}`, vector: vec(i), title: `p${i}`, ...LOCAL });
  }
  check('never exceeds maxEntries', (await capped.size()) === 3, String(await capped.size()));

  const survivors = (await capped.search(vec(0), { ...LOCAL, threshold: -1, topK: 99 }))
    .matches.map(m => m.url);
  check('evicts oldest, keeps newest',
    survivors.includes('https://a.com/5') && !survivors.includes('https://a.com/0'),
    JSON.stringify(survivors));

  // Eviction must span namespaces, or an abandoned model's vectors pin the cap.
  const multi = createVectorStore({ adapter: createMemoryAdapter(), maxEntries: 2, threshold: -1 });
  await multi.upsert({ url: 'https://a.com/old', vector: vec(1, 8), ...LOCAL });
  await multi.upsert({ url: 'https://a.com/n1', vector: vec(2, 16), ...LOCAL });
  await multi.upsert({ url: 'https://a.com/n2', vector: vec(3, 16), ...LOCAL });
  check('eviction crosses namespaces', (await multi.size()) === 2, String(await multi.size()));

  /* ── Housekeeping ─────────────────────────────────────────────────────── */
  heading('get / remove / clear');

  const hk = createVectorStore({ adapter: createMemoryAdapter() });
  await hk.upsert({ url: 'https://a.com/p', vector: vec(1, 8), title: 'P', ...LOCAL });
  check('get returns the record', (await hk.get('https://a.com/p', { ...LOCAL, dims: 8 })) !== null);
  check('get canonicalises the url',
    (await hk.get('https://a.com/p/?utm_source=q', { ...LOCAL, dims: 8 })) !== null);
  await hk.remove('https://a.com/p', { ...LOCAL, dims: 8 });
  check('remove deletes it', (await hk.size()) === 0);
  await hk.upsert({ url: 'https://a.com/q', vector: vec(1, 8), ...LOCAL });
  await hk.clear();
  check('clear empties the store', (await hk.size()) === 0);

  /* ── Summary ──────────────────────────────────────────────────────────── */
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('═'.repeat(70));
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
