/*
 * pageData.js — Feature A → Feature B Handoff-1 assembler.
 *
 * This is the single orchestrator that turns Feature A's three mismatched
 * extractor return shapes (text, colours, embedding) plus browsing behaviour
 * and page metadata into the ONE object Feature B's runB1() expects. It mirrors
 * Feature D's d1_validate.py philosophy: fill any missing field with a safe
 * default, then stamp handoffVersion + extractedAt so B can validate the
 * handoff before trusting it.
 *
 * Handoff-1 shape consumed by feature_b/b1_contentUnderstanding.js#runB1:
 *   {
 *     rawText:     string,          // first ~500 words of main content
 *     title:       string,
 *     description: string,          // meta description
 *     url:         string,
 *     lang:        string,
 *     colors:      { hue, saturation, lightness },
 *     scrollSpeed: number,          // px/s
 *     cursorSpeed: number,          // px/s
 *     embedding:   number[],        // semantic vector
 *     // ── additive enrichment (B ignores unknown fields) ──
 *     isImageOnly: boolean,         // edge case #15 non-text fallback
 *     wordCount:   number,
 *     flesch:      number,          // 0–100 reading ease
 *     readingComplexity: number,    // 0–1, higher = harder
 *     colorEnergy: number,
 *     handoffVersion: string,
 *     extractedAt: string,          // ISO timestamp
 *   }
 *
 * Works in a browser content script (window globals) and under Node/jsdom
 * (CommonJS require), so it can be exercised by playground.js without a bundler.
 */

const HANDOFF_VERSION = '1.0.0';
const DEFAULT_RAW_TEXT_WORD_LIMIT = 500;

/* ── Dependency resolution (browser globals OR Node require) ──────────────── */

function getDeps() {
  if (typeof module !== 'undefined' && module.exports) {
    // Node / jsdom
    return {
      extractPageText: require('./Textextractor.js').extractPageText,
      extractDominantColors: require('./Colorextractor.js').extractDominantColors,
      embedding: require('./Embeddingmodel.js'),
      scoreReadability: require('./Readability.js').scoreReadability,
      behavior: require('./behaviorTracker.js'),
    };
  }
  // Browser
  const w = window;
  return {
    extractPageText: w.Web2MusicTextExtractor && w.Web2MusicTextExtractor.extractPageText,
    extractDominantColors: w.Web2MusicColorExtractor && w.Web2MusicColorExtractor.extractDominantColors,
    embedding: w.Web2MusicEmbedding,
    scoreReadability: w.Web2MusicReadability && w.Web2MusicReadability.scoreReadability,
    behavior: w.Web2MusicBehaviorTracker,
  };
}

/* ── Safe defaults (mirrors d1_validate.py) ──────────────────────────────── */

const PAGE_DATA_DEFAULTS = {
  rawText: '',
  title: '',
  description: '',
  url: '',
  lang: 'en',
  colors: { hue: 0, saturation: 0, lightness: 0.5 },
  scrollSpeed: 0,
  cursorSpeed: 0,
  embedding: [],
  isImageOnly: false,
  wordCount: 0,
  flesch: 50,
  readingComplexity: 0.5,
  colorEnergy: 0,
};

/**
 * validatePageData — fill any missing/ill-typed field with a safe default and
 * stamp handoffVersion + extractedAt. Never throws; always returns a complete,
 * B-consumable object. Call this on anything before sending it as Handoff 1.
 */
function validatePageData(partial = {}) {
  const out = {};

  for (const [key, def] of Object.entries(PAGE_DATA_DEFAULTS)) {
    const val = partial[key];
    if (val === undefined || val === null) {
      out[key] = clone(def);
      continue;
    }
    out[key] = val;
  }

  // ── Coerce & clamp critical numeric/shape fields ──
  out.colors = normalizeColors(out.colors);
  out.scrollSpeed = toFiniteNumber(out.scrollSpeed, 0);
  out.cursorSpeed = toFiniteNumber(out.cursorSpeed, 0);
  out.wordCount = toFiniteNumber(out.wordCount, 0);
  out.colorEnergy = clamp01(toFiniteNumber(out.colorEnergy, 0));
  out.readingComplexity = clamp01(toFiniteNumber(out.readingComplexity, 0.5));
  out.flesch = toFiniteNumber(out.flesch, 50);
  out.isImageOnly = Boolean(out.isImageOnly);
  out.embedding = Array.isArray(out.embedding) ? out.embedding : [];
  out.lang = String(out.lang || 'en');

  // Preserve any additive fields the caller added that we don't model here.
  for (const key of Object.keys(partial)) {
    if (!(key in out) && key !== 'handoffVersion' && key !== 'extractedAt') {
      out[key] = partial[key];
    }
  }

  out.handoffVersion = HANDOFF_VERSION;
  out.extractedAt = new Date().toISOString();
  return out;
}

function normalizeColors(colors) {
  const c = colors && typeof colors === 'object' ? colors : {};
  let hue = toFiniteNumber(c.hue, 0);
  hue = ((hue % 360) + 360) % 360; // wrap into [0, 360)
  return {
    hue,
    saturation: clamp01(toFiniteNumber(c.saturation, 0)),
    lightness: clamp01(toFiniteNumber(c.lightness, 0.5)),
  };
}

/* ── Embedding cache keyed by URL + text-hash ─────────────────────────────── */
/*
 * Embedding is the expensive step. Revisits and near-identical pages should not
 * pay for it twice. Cache keyed by `${url}::${djb2(text)}` — same URL with the
 * same cleaned text (a revisit) is an exact hit; a real content change produces
 * a new hash and re-embeds. cosineSimilarity (already in Embeddingmodel) remains
 * available for callers that want fuzzy cache-hit comparisons across keys.
 */
const MAX_CACHE_ENTRIES = 50;
const _embeddingCache = new Map();

function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function cacheKey(url, text) {
  return `${url || ''}::${djb2(text || '')}`;
}

function cacheGet(key) {
  if (!_embeddingCache.has(key)) return null;
  // refresh LRU recency
  const val = _embeddingCache.get(key);
  _embeddingCache.delete(key);
  _embeddingCache.set(key, val);
  return val;
}

function cacheSet(key, value) {
  if (_embeddingCache.has(key)) _embeddingCache.delete(key);
  _embeddingCache.set(key, value);
  while (_embeddingCache.size > MAX_CACHE_ENTRIES) {
    _embeddingCache.delete(_embeddingCache.keys().next().value); // evict oldest
  }
}

function clearPageDataCache() {
  _embeddingCache.clear();
}

/* ── isImageOnly heuristic (edge case #15) ────────────────────────────────── */

function estimateImageOnly(doc, wordCount) {
  let imgCount = 0;
  if (doc && typeof doc.querySelectorAll === 'function') {
    imgCount = doc.querySelectorAll('img, picture, figure, canvas, video, [role="img"]').length;
  }
  // Almost no text at all → image-only. Or a little text but image-dominated
  // (Pinterest-style gallery). Feature B skips the text LLM path on this flag.
  return wordCount < 15 || (wordCount < 50 && imgCount >= 5);
}

/* ── Main assembler ───────────────────────────────────────────────────────── */

/**
 * buildPageData — run the three extractors + behaviour + metadata + readability,
 * then assemble and validate the exact Handoff-1 object Feature B consumes.
 *
 * @param {Object} [options]
 * @param {Document} [options.doc]              DOM document (defaults to global `document`).
 * @param {Object}   [options.embeddingConfig]  Passed to getEmbedding (backend, keys, etc.).
 * @param {Object}   [options.behaviorTracker]  A tracker with .snapshot(); defaults to the
 *                                               module singleton. Pass a stub in tests.
 * @param {boolean}  [options.useCache=true]     Reuse a cached embedding for the same url+text.
 * @param {number}   [options.rawTextWordLimit]  Words kept in `rawText` (default 500).
 * @returns {Promise<Object>} Validated Handoff-1 PageData.
 */
async function buildPageData(options = {}) {
  const deps = getDeps();
  const {
    doc = (typeof document !== 'undefined' ? document : undefined),
    embeddingConfig = {},
    behaviorTracker,
    useCache = true,
    rawTextWordLimit = DEFAULT_RAW_TEXT_WORD_LIMIT,
  } = options;

  const warnings = [];

  // 1) Text + metadata
  let page = { title: '', mainText: '', description: '', lang: 'en', wordCount: 0, url: '' };
  try {
    page = deps.extractPageText(doc) || page;
  } catch (err) {
    warnings.push(`text: ${err.message}`);
  }

  const rawText = firstWords(page.mainText || '', rawTextWordLimit);

  // 2) Colours → representative { hue, saturation, lightness }
  let colorResult = { representativeColor: PAGE_DATA_DEFAULTS.colors, colorEnergy: 0 };
  try {
    if (deps.extractDominantColors && doc && doc.body) {
      colorResult = deps.extractDominantColors(doc.body) || colorResult;
    }
  } catch (err) {
    warnings.push(`colors: ${err.message}`);
  }

  // 3) Behaviour snapshot (scroll/cursor px/s)
  let behavior = { scrollSpeed: 0, cursorSpeed: 0 };
  try {
    const tracker = behaviorTracker
      || (deps.behavior && deps.behavior.getDefaultTracker && deps.behavior.getDefaultTracker());
    if (tracker && typeof tracker.snapshot === 'function') {
      behavior = tracker.snapshot();
    }
  } catch (err) {
    warnings.push(`behavior: ${err.message}`);
  }

  // 4) Readability
  let readability = { flesch: 50, readingComplexity: 0.5 };
  try {
    if (deps.scoreReadability) readability = deps.scoreReadability(page.mainText || '');
  } catch (err) {
    warnings.push(`readability: ${err.message}`);
  }

  // 5) Embedding (expensive — cache by url + text-hash)
  let embedding = [];
  const key = cacheKey(page.url, rawText);
  if (useCache) {
    const hit = cacheGet(key);
    if (hit) embedding = hit;
  }
  if (embedding.length === 0 && rawText.trim() && deps.embedding && deps.embedding.getEmbedding) {
    try {
      const result = await deps.embedding.getEmbedding(page.mainText || rawText, embeddingConfig);
      embedding = result.vector || [];
      if (useCache && embedding.length) cacheSet(key, embedding);
    } catch (err) {
      warnings.push(`embedding: ${err.message}`);
    }
  }

  const isImageOnly = estimateImageOnly(doc, page.wordCount || 0);

  const assembled = {
    rawText,
    title: page.title || '',
    description: page.description || '',
    url: page.url || '',
    lang: page.lang || 'en',
    colors: colorResult.representativeColor || PAGE_DATA_DEFAULTS.colors,
    scrollSpeed: behavior.scrollSpeed,
    cursorSpeed: behavior.cursorSpeed,
    embedding,
    isImageOnly,
    wordCount: page.wordCount || 0,
    flesch: readability.flesch,
    readingComplexity: readability.readingComplexity,
    colorEnergy: colorResult.colorEnergy || 0,
  };

  if (warnings.length) assembled.warnings = warnings;

  return validatePageData(assembled);
}

/* ── Performance budget: debounce + requestIdleCallback ───────────────────── */

/**
 * runWhenIdle — wrap an expensive fn so it runs off the critical path: coalesce
 * rapid calls with a debounce, then defer the real work to requestIdleCallback
 * when available (falls back to immediate). Keeps buildPageData from janking the
 * page on every DOM mutation. All calls coalesced into one run resolve together.
 *
 * @param {Function} fn
 * @param {Object}   [opts]
 * @param {number}   [opts.debounceMs=250]
 * @returns {(...args) => Promise<any>}
 */
function runWhenIdle(fn, { debounceMs = 250 } = {}) {
  let timer = null;
  let idleHandle = null;
  let pending = [];

  const hasIdle = typeof requestIdleCallback === 'function';

  return function scheduled(...args) {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const waiters = pending;
        pending = [];
        const run = () =>
          Promise.resolve()
            .then(() => fn(...args))
            .then(
              (v) => waiters.forEach((w) => w.resolve(v)),
              (e) => waiters.forEach((w) => w.reject(e))
            );
        if (hasIdle) {
          if (idleHandle) cancelIdleCallback(idleHandle);
          idleHandle = requestIdleCallback(run);
        } else {
          run();
        }
      }, debounceMs);
    });
  };
}

/**
 * createPageDataScheduler — convenience: a runWhenIdle-wrapped buildPageData.
 * Attach its returned function to a MutationObserver / navigation handler.
 */
function createPageDataScheduler(options = {}, { debounceMs = 300 } = {}) {
  return runWhenIdle(() => buildPageData(options), { debounceMs });
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildPageData,
    validatePageData,
    runWhenIdle,
    createPageDataScheduler,
    clearPageDataCache,
    HANDOFF_VERSION,
  };
} else if (typeof window !== 'undefined') {
  window.Web2MusicPageData = {
    buildPageData,
    validatePageData,
    runWhenIdle,
    createPageDataScheduler,
    clearPageDataCache,
    HANDOFF_VERSION,
  };
}

/* ── Small pure helpers ───────────────────────────────────────────────────── */

function firstWords(text, limit) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  return words.length <= limit ? text.trim() : words.slice(0, limit).join(' ');
}

function toFiniteNumber(x, fallback) {
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function clone(v) {
  return (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
}
