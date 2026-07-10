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

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.openaiModel,
      input: text,
    }),
  });

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
  const response = await fetch(config.serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: config.openaiModel }),
  });

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
    );
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
