const DEFAULT_CONFIG = {
  backend: 'local',
  openaiModel: 'text-embedding-3-small',
  openaiApiKey: null,
  localModel: 'Xenova/all-MiniLM-L6-v2',
  maxInputChars: 8000,
  // 'service' backend: offload the API call to a local Docker microservice
  // (docker/embedService.js) so the OpenAI key lives in the container's env,
  // never in the extension bundle or page context.
  serviceUrl: 'http://localhost:8077/embed',
  // Feature B's LLM calls use 8s AbortControllers; A's network backends had none
  // and could hang forever on a stalled connection. Match that budget here.
  fetchTimeoutMs: 8000,
  // Must match the embed service's SERVICE_SECRET env var, if it has one set.
  serviceSecret: null,
};

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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

  const response = await fetchWithTimeout('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.openaiModel,
      input: text,
    }),
  }, config.fetchTimeoutMs);

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

async function embedWithService(text, config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.serviceSecret) headers['X-Service-Secret'] = config.serviceSecret;

  const response = await fetchWithTimeout(config.serviceUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: text, model: config.openaiModel }),
  }, config.fetchTimeoutMs);

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Embedding service request failed (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.vector)) {
    throw new Error('Embedding service returned an unexpected payload (no `vector`).');
  }
  return {
    vector: data.vector,
    dimensions: data.dimensions || data.vector.length,
    backend: 'service',
    model: data.model || config.openaiModel,
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
    ).catch((err) => {
      // A rejected pipeline load must not be cached forever — clear it so the
      // next call gets a fresh attempt instead of failing every time after.
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
  if (config.backend === 'service') {
    return embedWithService(truncated, config);
  }
  return embedWithLocalModel(truncated, config);
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
  module.exports = { getEmbedding, cosineSimilarity, DEFAULT_CONFIG };
} else if (typeof window !== 'undefined') {
  window.Web2MusicEmbedding = { getEmbedding, cosineSimilarity };
}
