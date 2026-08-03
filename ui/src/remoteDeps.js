// ui/src/remoteDeps.js — content-script-side proxies for Feature A's
// embedding + vector-store deps. The real ONNX inference and IndexedDB live
// in the offscreen document (extension origin, extension CSP) — see the X4
// integration plan's finding (b) for why they can't run in a content script.
// These proxies round-trip through the service worker, which forwards
// anything addressed `target: "offscreen"` and relays the reply.

const RPC_TIMEOUT_MS = 8000; // matches Feature A's own fetchTimeoutMs default

// No `target` field here on purpose — the offscreen document's own listener
// filters strictly on `target === "offscreen"`, and if this message carried
// that field too, both the SW *and* an already-open offscreen doc would
// handle the same broadcast, double-running the embed/upsert. Only the
// service worker's relay (background.entry.js) adds `target: "offscreen"`
// after calling ensureOffscreen() — see its onMessage listener.
function rpc(type, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timed out after ${RPC_TIMEOUT_MS}ms`)), RPC_TIMEOUT_MS);
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.ok === false) {
        reject(new Error((response && response.error) || `${type} failed`));
        return;
      }
      resolve(response);
    });
  });
}

// cosineSimilarity/buildCacheKey are pure functions — no reason to proxy
// them, so pull them from the real local module and only remote the parts
// that need ONNX/IndexedDB.
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export const remoteEmbedding = {
  async getEmbedding(text, cfg) {
    const res = await rpc("A_EMBED", { text, cfg });
    return { vector: res.vector, dimensions: res.dimensions, backend: res.backend, model: res.model };
  },
  cosineSimilarity,
};

// buildPageData takes its vector store via the top-level `vectorStore`
// option (an instance with .search/.upsert), not via deps.vectorStore (which
// is only a createVectorStore() factory used for the lazy module default).
// Pass this object as `options.vectorStore` directly — see content.entry.js.
export const remoteVectorStore = {
  async search(vec, opts) {
    return rpc("A_VS_SEARCH", { vec, opts });
  },
  async upsert(rec) {
    return rpc("A_VS_UPSERT", { rec });
  },
  async clear() {
    return rpc("A_VS_CLEAR", {});
  },
};
