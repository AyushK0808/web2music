const DEFAULT_CONFIG = {
  backend: 'local',
  openaiModel: 'text-embedding-3-small',
  openaiApiKey: null,
  localModel: 'Xenova/all-MiniLM-L6-v2',
  maxInputChars: 8000,
  fetchTimeoutMs: 8000, // matches Feature B's 8s AbortController convention
};

let localPipelinePromise = null;

function truncateForEmbedding(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastPeriod = slice.lastIndexOf('. ');
  return lastPeriod > maxChars * 0.5 ? slice.slice(0, lastPeriod + 1) : slice;
}

async function embedWithOpenAI(text, config) {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI backend selected but no API key configured.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.fetchTimeoutMs);

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel,
        input: text,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`OpenAI embedding request timed out after ${config.fetchTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI embedding request failed (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  return {
    vector: data.data[0].embedding,
    dimensions: data.data[0].embedding.length,
    backend: 'openai',
    model: config.openaiModel,
  };
}

async function embedWithLocalModel(text, config) {
  if (typeof window === 'undefined' || !window.transformersPipeline) {
    throw new Error(
      'Local embedding backend requires @xenova/transformers to be loaded ' +
      '(expected window.transformersPipeline to be available).'
    );
  }

  if (!localPipelinePromise) {
    localPipelinePromise = window.transformersPipeline(
      'feature-extraction',
      config.localModel
    ).catch(err => {
      // Don't leave a rejected promise cached — clear it so the next
      // call gets a fresh attempt instead of failing forever.
      localPipelinePromise = null;
      throw err;
    });
  }
  const extractor = await localPipelinePromise;

  const output = await extractor(text, { pooling: 'mean', normalize: true });
  const vector = Array.from(output.data);

  return {
    vector,
    dimensions: vector.length,
    backend: 'local',
    model: config.localModel,
  };
}

async function getEmbedding(text, userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  if (!text || !text.trim()) {
    throw new Error('Cannot embed empty text.');
  }

  const truncated = truncateForEmbedding(text.trim(), config.maxInputChars);

  if (config.backend === 'openai') {
    return embedWithOpenAI(truncated, config);
  }
  return embedWithLocalModel(truncated, config);
}

/**
 * Cache keys must include backend + model, not just url/text-hash.
 * A 384-dim local vector and a 1536-dim OpenAI vector are not
 * interchangeable — reusing a cache entry across backends returns a
 * vector of the wrong shape/space. pageData.js should call this
 * instead of hashing url + text alone.
 */
function buildCacheKey(url, textHash, backend, model) {
  return `${url}::${textHash}::${backend}::${model}`;
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getEmbedding, cosineSimilarity, buildCacheKey, DEFAULT_CONFIG };
} else if (typeof window !== 'undefined') {
  window.Web2MusicEmbedding = { getEmbedding, cosineSimilarity, buildCacheKey };
}