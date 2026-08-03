/*
 * VectorStore.js — Feature A's vector database + similarity threshold.
 *
 * This is the "Similarity Engine" half of Feature A. Feature A already turns a
 * page into an embedding; this stores those embeddings and answers the question
 * the rest of the pipeline actually cares about:
 *
 *   "Have we seen a page enough like this one before?"
 *
 * If yes, Feature B's LLM call and Feature C's generation can be skipped and the
 * previous mood/track reused — which is the difference between a cheap revisit
 * and paying for the whole pipeline again.
 *
 * ── Namespacing (not optional) ──
 * Vectors from different models are NOT comparable. A 384-dim MiniLM vector and
 * a 1536-dim text-embedding-3-small vector describe different spaces, and even
 * two same-dimension models put different meanings in each axis. So every record
 * is namespaced by `backend:model:dims` and searches never cross namespaces.
 * This is the same failure the embedding cache in pageData.js guards against —
 * a stale wrong-model vector is worse than a cache miss, because it returns
 * confident nonsense instead of an error.
 *
 * ── Storage ──
 * Pluggable adapter, because this has to run in two places:
 *   - createMemoryAdapter()    — Node/tests, and a safe fallback.
 *   - createIndexedDBAdapter() — the extension; survives browser restarts.
 * chrome.storage.local is deliberately not used: it serialises everything to JSON
 * on every write and has a modest quota, which suits settings, not a growing
 * vector index.
 *
 * ── Cost ──
 * Brute-force scan. Vectors are unit-normalised on write, so similarity is a
 * plain dot product and a scan of a few thousand 384-dim vectors is well under a
 * frame. No ANN index (HNSW/IVF) — at this scale it would add real complexity
 * and a dependency to save time we are not spending. Revisit that only if
 * `maxEntries` needs to grow past ~10k.
 *
 * Usage:
 *   const store = createVectorStore({ threshold: 0.85 });
 *   await store.upsert({ url, vector, backend: 'local', model: 'Xenova/all-MiniLM-L6-v2', title });
 *   const { matches, best, isRevisit } = await store.search(vector, { backend, model });
 */

'use strict';

/*
 * NOTE ON TOP-LEVEL NAMES: every module in this directory is loaded as a content
 * script into the SAME page global scope, so two files declaring `const X` at top
 * level is a SyntaxError that breaks all of Feature A. (This file originally used
 * `DEFAULT_CONFIG`, colliding with Embeddingmodel.js — Node's per-module scope
 * hid it entirely, and it only surfaced in a real browser.) Prefix top-level
 * names here, and see globals_test.js, which fails on any new collision.
 */

/* ── Similarity thresholds ────────────────────────────────────────────────── */
/*
 * Cosine similarity on normalised sentence embeddings, calibrated for MiniLM-
 * class models. These are starting points to tune against real pages, not
 * universal constants — different embedding models spread their scores
 * differently, so re-check them if the backend changes.
 */
const SIMILARITY_PRESETS = {
  // Near-identical content: the same article, a revisit, a URL with different
  // tracking params. Safe to reuse the previous mood/track outright.
  duplicate: 0.95,
  // Same subject matter: another article about the same topic. Reusing the mood
  // is usually right; regenerating the track may still be worthwhile.
  sameTopic: 0.85,
  // Loosely related: same domain of interest. Useful as a hint, too weak to
  // skip work on.
  related: 0.70,
};

const VECTOR_STORE_DEFAULTS = {
  threshold: SIMILARITY_PRESETS.sameTopic,
  // Reuse-outright cutoff, reported separately as `isRevisit`.
  revisitThreshold: SIMILARITY_PRESETS.duplicate,
  topK: 5,
  // Cap on stored vectors. 2000 × 384 floats ≈ 3 MB as f64 — comfortable, and
  // still a sub-millisecond scan.
  maxEntries: 2000,
  dbName: 'web2music-vectors',
  storeName: 'vectors',
};

/* ── Vector math ──────────────────────────────────────────────────────────── */

function isFiniteVector(vector) {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array) &&
      !(vector instanceof Float64Array)) {
    return false;
  }
  if (vector.length === 0) return false;
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) return false;
  }
  return true;
}

/**
 * normalizeVector — scale to unit length so similarity is a dot product.
 * Returns null for a zero/degenerate vector, which has no direction and so no
 * meaningful similarity to anything.
 */
function normalizeVector(vector) {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i] * vector[i];
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) return null;

  const out = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/** dot — assumes both inputs are already unit-normalised. */
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function namespaceOf(backend, model, dims) {
  return `${backend || 'local'}:${model || 'unknown'}:${dims}`;
}

/*
 * Strip tracking/fragment noise so the same article at three URLs is one record
 * rather than three. Kept conservative: only well-known tracking params are
 * dropped, since query strings are load-bearing on plenty of sites (?q=, ?id=).
 */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
];

function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
    // Normalise a trailing slash on the bare-path case only.
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return String(rawUrl); // not a parseable URL (about:, chrome-extension:, …)
  }
}

/* ── Storage adapters ─────────────────────────────────────────────────────── */

/**
 * createMemoryAdapter — in-process store. Used by Node/tests, and as the
 * fallback when IndexedDB is unavailable (private windows, hardened profiles).
 */
function createMemoryAdapter() {
  const records = new Map(); // id → record

  return {
    name: 'memory',
    async get(id) {
      return records.get(id) || null;
    },
    async put(record) {
      records.set(record.id, record);
    },
    async remove(id) {
      records.delete(id);
    },
    async allInNamespace(namespace) {
      const out = [];
      for (const record of records.values()) {
        if (record.namespace === namespace) out.push(record);
      }
      return out;
    },
    async allRecords() {
      return Array.from(records.values());
    },
    async count() {
      return records.size;
    },
    async clear() {
      records.clear();
    },
  };
}

/**
 * createIndexedDBAdapter — persistent browser storage. Records are keyed by
 * `${namespace}::${canonicalUrl}` and indexed by namespace so a search reads
 * only comparable vectors instead of the whole database.
 */
function createIndexedDBAdapter({ dbName, storeName } = {}) {
  const name = dbName || VECTOR_STORE_DEFAULTS.dbName;
  const store = storeName || VECTOR_STORE_DEFAULTS.storeName;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(store)) {
          const objectStore = db.createObjectStore(store, { keyPath: 'id' });
          objectStore.createIndex('namespace', 'namespace', { unique: false });
          objectStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((err) => {
      // Don't cache a failed open — a later attempt may succeed.
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  /*
   * Run `fn` against the object store and resolve with its IDBRequest result
   * once the transaction commits. Resolving on transaction.oncomplete rather
   * than request.onsuccess matters for writes: onsuccess fires before the commit,
   * so resolving there could report success for a transaction that later aborts.
   */
  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      let request;
      try {
        request = fn(transaction.objectStore(store));
      } catch (err) {
        reject(err);
        return;
      }
      // Writes (put/delete/clear) leave result undefined — that's expected.
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }));
  }

  return {
    name: 'indexeddb',
    async get(id) {
      return (await tx('readonly', (s) => s.get(id))) || null;
    },
    async put(record) {
      await tx('readwrite', (s) => s.put(record));
    },
    async remove(id) {
      await tx('readwrite', (s) => s.delete(id));
    },
    async allInNamespace(namespace) {
      return (await tx('readonly', (s) => s.index('namespace').getAll(namespace))) || [];
    },
    async allRecords() {
      return (await tx('readonly', (s) => s.getAll())) || [];
    },
    async count() {
      return (await tx('readonly', (s) => s.count())) || 0;
    },
    async clear() {
      await tx('readwrite', (s) => s.clear());
    },
  };
}

/* ── Qdrant adapter (Docker) ───────────────────────────────────────────────── */
/*
 * A real vector database, for when the in-browser store is the wrong tool:
 * corpus-scale work (embedding thousands of pages for the §6/§7 evaluations)
 * where the IndexedDB path's `maxEntries` cap and client-side scan stop making
 * sense. Search runs server-side here — that is the entire point.
 *
 * Start it with:  docker compose -f docker/docker-compose.yml --profile research up -d qdrant
 *
 * Two structural details worth knowing:
 *
 * 1. ONE COLLECTION PER NAMESPACE. A Qdrant collection has a fixed vector size,
 *    and our namespaces deliberately differ in dimensionality (384-dim MiniLM vs
 *    1536-dim OpenAI). So `backend:model:dims` maps to a collection name, which
 *    also gets the cross-model isolation for free — a query physically cannot
 *    reach vectors from another model.
 *
 * 2. POINT IDS MUST BE UINT64 OR UUID. Our ids are strings (`namespace::url`),
 *    so each is hashed to a deterministic UUID and the readable id is kept in the
 *    payload. SHA-256 based, so it's stable across processes and collision
 *    resistance doesn't rely on a 32-bit hash.
 *
 * Intended for Node / a trusted service context. Pointing a content script
 * straight at Qdrant is a bad idea: it needs permissive CORS and would expose the
 * whole database to any page that can reach the port. Keep IndexedDB in the
 * extension, or front Qdrant with a hardened proxy the way services/embed/embedService.js
 * fronts the OpenAI key.
 */

const QDRANT_DEFAULTS = {
  url: 'http://127.0.0.1:6333',
  apiKey: null,
  collectionPrefix: 'web2music_',
  fetchTimeoutMs: 8000,
};

async function qdrantFetch(baseUrl, apiKey, timeoutMs, method, urlPath, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['api-key'] = apiKey;

    const response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    // 404 is a normal "not found" for point/collection reads; callers decide.
    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Qdrant ${method} ${urlPath} failed (${response.status}): ${detail}`);
    }
    const text = await response.text();
    // Not every endpoint returns JSON — /readyz and /healthz are text/plain
    // ("all shards are ready"), so a blanket JSON.parse would throw on them.
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, ok: response.ok, json, text };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Qdrant ${method} ${urlPath} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Deterministic UUID (v5-shaped) from an arbitrary string, via SHA-256. */
async function stringToUuid(input) {
  const cryptoObj = typeof globalThis !== 'undefined' && globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle) {
    throw new Error('Qdrant adapter needs WebCrypto (Node 18+ or a browser) for point ids.');
  }
  const bytes = new TextEncoder().encode(input);
  const digest = new Uint8Array(await cryptoObj.subtle.digest('SHA-256', bytes));
  const b = digest.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
         `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Qdrant collection names allow [A-Za-z0-9_-]; namespaces contain ':' and '/'. */
function sanitizeCollectionName(prefix, namespace) {
  return prefix + namespace.replace(/[^A-Za-z0-9_-]+/g, '_');
}

function createQdrantAdapter(userConfig = {}) {
  const config = { ...QDRANT_DEFAULTS, ...userConfig };
  const { url, apiKey, fetchTimeoutMs, collectionPrefix } = config;
  const call = (method, urlPath, body) =>
    qdrantFetch(url, apiKey, fetchTimeoutMs, method, urlPath, body);

  // Collections we've already ensured exist, to skip a round-trip per write.
  const ensured = new Set();

  async function ensureCollection(namespace, dims) {
    const collection = sanitizeCollectionName(collectionPrefix, namespace);
    if (ensured.has(collection)) return collection;

    const existing = await call('GET', `/collections/${collection}`);
    if (existing.status === 404) {
      // Cosine distance, matching the store's similarity convention. Vectors are
      // already unit-normalised on write, so Qdrant's cosine equals our dot.
      await call('PUT', `/collections/${collection}`, {
        vectors: { size: dims, distance: 'Cosine' },
      });
    }
    ensured.add(collection);
    return collection;
  }

  function toRecord(point) {
    if (!point) return null;
    const payload = point.payload || {};
    return {
      id: payload.id,
      namespace: payload.namespace,
      url: payload.url,
      originalUrl: payload.originalUrl,
      vector: point.vector || null,
      dims: payload.dims,
      backend: payload.backend,
      model: payload.model,
      title: payload.title || '',
      mood: payload.mood,
      metadata: payload.metadata,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    };
  }

  async function listCollections() {
    const res = await call('GET', '/collections');
    const collections = (res.json && res.json.result && res.json.result.collections) || [];
    return collections
      .map(c => c.name)
      .filter(name => name.startsWith(collectionPrefix));
  }

  return {
    name: 'qdrant',
    // Server-side storage: the client-side entry cap is not meaningful here, and
    // enforcing it would defeat the reason for using a real database.
    unbounded: true,

    async get(id) {
      // `id` encodes its namespace as the part before '::'.
      const namespace = String(id).split('::')[0];
      const collection = sanitizeCollectionName(collectionPrefix, namespace);
      const pointId = await stringToUuid(id);
      const res = await call('GET',
        `/collections/${collection}/points/${pointId}?with_payload=true&with_vector=true`);
      if (res.status === 404 || !res.json || !res.json.result) return null;
      return toRecord(res.json.result);
    },

    async put(record) {
      const collection = await ensureCollection(record.namespace, record.dims);
      const pointId = await stringToUuid(record.id);
      // wait=true so a subsequent search sees the write (Qdrant indexes async).
      await call('PUT', `/collections/${collection}/points?wait=true`, {
        points: [{
          id: pointId,
          vector: record.vector,
          payload: {
            id: record.id,
            namespace: record.namespace,
            url: record.url,
            originalUrl: record.originalUrl,
            dims: record.dims,
            backend: record.backend,
            model: record.model,
            title: record.title,
            mood: record.mood,
            metadata: record.metadata,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
        }],
      });
    },

    async remove(id) {
      const namespace = String(id).split('::')[0];
      const collection = sanitizeCollectionName(collectionPrefix, namespace);
      const pointId = await stringToUuid(id);
      await call('POST', `/collections/${collection}/points/delete?wait=true`,
        { points: [pointId] });
    },

    /**
     * Native server-side search — the reason to use Qdrant at all. Returns
     * scored matches directly instead of shipping every vector to the client.
     */
    async searchNative(vector, { namespace, threshold, topK, excludeUrl }) {
      const collection = sanitizeCollectionName(collectionPrefix, namespace);
      const body = {
        vector,
        limit: topK,
        with_payload: true,
        score_threshold: threshold,
      };
      if (excludeUrl) {
        body.filter = { must_not: [{ key: 'url', match: { value: excludeUrl } }] };
      }
      const res = await call('POST', `/collections/${collection}/points/search`, body);
      // A namespace with nothing in it yet has no collection — not an error.
      if (res.status === 404) return { matches: [], searched: 0 };

      const hits = (res.json && res.json.result) || [];
      return {
        matches: hits.map(hit => ({
          url: (hit.payload && hit.payload.url) || '',
          score: hit.score,
          title: (hit.payload && hit.payload.title) || '',
          mood: hit.payload && hit.payload.mood,
          metadata: hit.payload && hit.payload.metadata,
          updatedAt: hit.payload && hit.payload.updatedAt,
        })),
        // Qdrant does not report how many points it examined; the count of
        // comparable vectors is the honest analogue of the scan adapters' value.
        searched: await this.countInNamespace(namespace),
      };
    },

    async countInNamespace(namespace) {
      const collection = sanitizeCollectionName(collectionPrefix, namespace);
      const res = await call('POST', `/collections/${collection}/points/count`, { exact: true });
      if (res.status === 404) return 0;
      return (res.json && res.json.result && res.json.result.count) || 0;
    },

    async allInNamespace(namespace) {
      const collection = sanitizeCollectionName(collectionPrefix, namespace);
      const out = [];
      let offset = null;
      for (;;) {
        const res = await call('POST', `/collections/${collection}/points/scroll`, {
          limit: 256, offset, with_payload: true, with_vector: true,
        });
        if (res.status === 404) break;
        const result = res.json && res.json.result;
        if (!result) break;
        for (const point of result.points || []) out.push(toRecord(point));
        if (!result.next_page_offset) break;
        offset = result.next_page_offset;
      }
      return out;
    },

    async allRecords() {
      const out = [];
      for (const collection of await listCollections()) {
        const namespace = collection.slice(collectionPrefix.length);
        // Collection names are sanitised, so recover records via their payload.
        const records = await this.allInNamespace(namespace);
        for (const record of records) out.push(record);
      }
      return out;
    },

    async count() {
      let total = 0;
      for (const collection of await listCollections()) {
        const res = await call('POST', `/collections/${collection}/points/count`, { exact: true });
        total += (res.json && res.json.result && res.json.result.count) || 0;
      }
      return total;
    },

    async clear() {
      for (const collection of await listCollections()) {
        await call('DELETE', `/collections/${collection}`);
        ensured.delete(collection);
      }
    },

    /** True when the server is reachable — handy for a startup check. */
    async health() {
      try {
        const res = await call('GET', '/readyz');
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

/** Pick persistent storage when the environment actually supports it. */
function defaultAdapter(config) {
  if (typeof indexedDB !== 'undefined') {
    try {
      return createIndexedDBAdapter(config);
    } catch {
      // fall through to memory
    }
  }
  return createMemoryAdapter();
}

/* ── The store ────────────────────────────────────────────────────────────── */

/**
 * createVectorStore — the similarity engine.
 *
 * @param {Object} [userConfig]
 * @param {number} [userConfig.threshold]        Min cosine similarity to count as a match.
 * @param {number} [userConfig.revisitThreshold] At/above this, treat as the same page.
 * @param {number} [userConfig.topK]             Max matches returned.
 * @param {number} [userConfig.maxEntries]       Cap on stored vectors (oldest evicted).
 * @param {Object} [userConfig.adapter]          Storage adapter; defaults to IndexedDB→memory.
 */
function createVectorStore(userConfig = {}) {
  const config = { ...VECTOR_STORE_DEFAULTS, ...userConfig };
  const adapter = config.adapter || defaultAdapter(config);

  function recordId(namespace, canonicalUrl) {
    return `${namespace}::${canonicalUrl}`;
  }

  /**
   * upsert — store (or replace) a page's vector. Returns the stored record, or
   * null if the input wasn't usable.
   */
  async function upsert({ url, vector, backend, model, title, mood, metadata } = {}) {
    if (!isFiniteVector(vector)) return null;
    const normalized = normalizeVector(vector);
    if (!normalized) return null; // zero vector — no direction, no similarity

    const namespace = namespaceOf(backend, model, normalized.length);
    const canonicalUrl = canonicalizeUrl(url);
    const now = Date.now();

    const existing = await adapter.get(recordId(namespace, canonicalUrl));
    const record = {
      id: recordId(namespace, canonicalUrl),
      namespace,
      url: canonicalUrl,
      originalUrl: url || '',
      vector: normalized,
      dims: normalized.length,
      backend: backend || 'local',
      model: model || 'unknown',
      title: title || (existing && existing.title) || '',
      mood: mood !== undefined ? mood : (existing && existing.mood),
      metadata: metadata !== undefined ? metadata : (existing && existing.metadata),
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
    };

    await adapter.put(record);
    await evictIfNeeded();
    return record;
  }

  /**
   * search — nearest stored pages within the same namespace.
   *
   * @returns {Promise<{ matches, best, isRevisit, searched, namespace }>}
   *   matches   — [{ url, score, title, mood, updatedAt }] over threshold, best first
   *   best      — highest match, or null
   *   isRevisit — best.score >= revisitThreshold (safe to reuse outright)
   *   searched  — how many comparable vectors were scanned
   */
  async function search(vector, options = {}) {
    const {
      backend, model,
      threshold = config.threshold,
      revisitThreshold = config.revisitThreshold,
      topK = config.topK,
      excludeUrl,
    } = options;

    const empty = {
      matches: [], best: null, isRevisit: false, searched: 0, namespace: null,
    };
    if (!isFiniteVector(vector)) return empty;
    const normalized = normalizeVector(vector);
    if (!normalized) return empty;

    const namespace = namespaceOf(backend, model, normalized.length);
    const excluded = excludeUrl ? canonicalizeUrl(excludeUrl) : null;

    // A real vector database does this server-side; only fall back to shipping
    // every vector to the client when the adapter has no native search.
    if (typeof adapter.searchNative === 'function') {
      const native = await adapter.searchNative(normalized, {
        namespace, threshold, topK, excludeUrl: excluded,
      });
      const matches = native.matches || [];
      const best = matches.length ? matches[0] : null;
      return {
        matches,
        best,
        isRevisit: Boolean(best && best.score >= revisitThreshold),
        searched: native.searched || 0,
        namespace,
      };
    }

    const candidates = await adapter.allInNamespace(namespace);

    const scored = [];
    for (const record of candidates) {
      if (excluded && record.url === excluded) continue;
      // Defensive: a namespace pins dimensionality, but a corrupted/hand-edited
      // record must not silently produce a garbage dot product.
      if (!record.vector || record.vector.length !== normalized.length) continue;
      const score = dot(normalized, record.vector);
      if (score >= threshold) {
        scored.push({
          url: record.url,
          score,
          title: record.title || '',
          mood: record.mood,
          metadata: record.metadata,
          updatedAt: record.updatedAt,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const matches = scored.slice(0, topK);
    const best = matches.length ? matches[0] : null;

    return {
      matches,
      best,
      isRevisit: Boolean(best && best.score >= revisitThreshold),
      searched: candidates.length,
      namespace,
    };
  }

  /**
   * evictIfNeeded — drop least-recently-updated records once over capacity.
   * Eviction spans every namespace: the cap is on total storage, so trimming
   * only the namespace currently being written would let an abandoned namespace
   * (an old model the user switched away from) pin the store at its limit
   * forever.
   */
  async function evictIfNeeded() {
    // Server-backed stores declare themselves unbounded: capping them at a
    // client-sized limit would defeat the point of using a real database.
    if (adapter.unbounded) return 0;
    const total = await adapter.count();
    if (total <= config.maxEntries) return 0;
    if (typeof adapter.allRecords !== 'function') return 0;

    const records = await adapter.allRecords();
    if (!records.length) return 0;

    records.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    const toRemove = records.slice(0, Math.max(0, records.length - config.maxEntries));
    for (const record of toRemove) await adapter.remove(record.id);
    return toRemove.length;
  }

  return {
    config,
    adapter,
    upsert,
    search,
    async get(url, { backend, model, dims } = {}) {
      if (!dims) return null;
      return adapter.get(recordId(namespaceOf(backend, model, dims), canonicalizeUrl(url)));
    },
    async remove(url, { backend, model, dims } = {}) {
      if (!dims) return;
      await adapter.remove(recordId(namespaceOf(backend, model, dims), canonicalizeUrl(url)));
    },
    async size() {
      return adapter.count();
    },
    async clear() {
      await adapter.clear();
    },
  };
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

const api = {
  createVectorStore,
  createMemoryAdapter,
  createIndexedDBAdapter,
  createQdrantAdapter,
  normalizeVector,
  canonicalizeUrl,
  SIMILARITY_PRESETS,
  VECTOR_STORE_DEFAULTS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.Web2MusicVectorStore = api;
}
