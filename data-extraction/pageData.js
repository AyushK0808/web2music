const { extractPageText } = (typeof module !== 'undefined' && module.exports)
  ? require('./textExtractor') : window.Web2MusicTextExtractor;
const { extractDominantColors } = (typeof module !== 'undefined' && module.exports)
  ? require('./colorExtractor') : window.Web2MusicColorExtractor;
const { getEmbedding, buildCacheKey } = (typeof module !== 'undefined' && module.exports)
  ? require('./embeddingModel') : window.Web2MusicEmbedding;
const { scoreReadingComplexity } = (typeof module !== 'undefined' && module.exports)
  ? require('./Readability') : window.Web2MusicReadability;

// Dev-only in-memory cache. Production swaps this Map for ChromaDB/pgvector
// per Feature A's Vector Database suggestion — the cache-key shape below is
// what matters, not the storage backend.
const cache = new Map();

/**
 * Lightweight non-cryptographic hash (djb2) — fine for a cache key
 * fingerprint, not for anything security-sensitive.
 */
function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16);
}

function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
}

function elapsed(start) {
  return Math.round(now() - start);
}

/**
 * Runs the full Feature A pipeline for one page: text/metadata extraction,
 * color extraction, reading-complexity scoring, and embedding — with a
 * cache lookup keyed on url + text-hash + backend + model (NOT url+text
 * alone, since a 384-dim local vector and a 1536-dim OpenAI vector are not
 * interchangeable and must never collide in the cache).
 *
 * @param {Document} doc
 * @param {object} config - passed through to getEmbedding(); also selects
 *   which backend/model the cache key is built against.
 */
async function processPage(doc, config = {}) {
  const timings = {};
  const failures = {};

  const tText = now();
  const pageText = extractPageText(doc);
  timings.textExtractionMs = elapsed(tText);

  const tColor = now();
  let colors;
  try {
    colors = extractDominantColors(doc.body);
  } catch (err) {
    failures.colorExtraction = err.message;
    colors = { dominantHues: [], colorEnergy: 0, achromaticRatio: 1 };
  }
  timings.colorExtractionMs = elapsed(tColor);

  const readingComplexity = scoreReadingComplexity(pageText.mainText, pageText.lang);

  const backend = config.backend || 'local';
  const model = backend === 'openai'
    ? (config.openaiModel || 'text-embedding-3-small')
    : (config.localModel || 'Xenova/all-MiniLM-L6-v2');

  const textHash = hashText(pageText.mainText || pageText.title || '');
  const cacheKey = buildCacheKey(pageText.url, textHash, backend, model);

  if (cache.has(cacheKey)) {
    return { ...cache.get(cacheKey), cacheHit: true, timings };
  }

  const tEmbed = now();
  let embedding = null;
  try {
    embedding = await getEmbedding(pageText.mainText, config);
  } catch (err) {
    failures.embedding = err.message;
  }
  timings.embeddingMs = elapsed(tEmbed);

  const result = {
    url: pageText.url,
    title: pageText.title,
    description: pageText.description,
    lang: pageText.lang,
    wordCount: pageText.wordCount,
    readingComplexity,
    colors,
    embedding,
    cacheHit: false,
    timings,
    failures: Object.keys(failures).length ? failures : null,
  };

  // Only cache successful embeddings — a null/failed embedding cached under
  // this key would silently poison every future cache hit for this page.
  if (embedding) {
    cache.set(cacheKey, result);
  }

  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { processPage, hashText, cache };
} else if (typeof window !== 'undefined') {
  window.Web2MusicPageData = { processPage, hashText };
}