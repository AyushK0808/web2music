// ui/src/embed.worker.js — Web Worker hosting transformers.js + MiniLM ONNX.
//
// Spawned once from the offscreen document (not the SW — MV3 service workers
// can't spawn Web Workers reliably, and this keeps ONNX inference off the
// audio thread so it can't cause playback dropouts). Talks to its parent via
// postMessage only; knows nothing about chrome.runtime.

import { pipeline, env } from "@xenova/transformers";

// Zero network calls, ever — the whole point of vendoring the model. Paths
// are resolved relative to this worker's own script URL, which esbuild
// places at dist/embed.worker.js alongside dist/onnx/ and dist/models/.
env.allowRemoteModels = false;
const EXT_URL = self.location.href.replace(/embed\.worker\.js.*$/, "");
env.localModelPath = `${EXT_URL}models/`;
env.backends.onnx.wasm.wasmPaths = `${EXT_URL}onnx/`;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let _extractorPromise = null;
function getExtractor() {
  if (!_extractorPromise) {
    _extractorPromise = pipeline("feature-extraction", MODEL_ID, { quantized: true });
  }
  return _extractorPromise;
}

// Warm the model on worker startup so the first real page's embedding isn't
// paying the full load cost — see offscreenExtract.js's warm-up call.
getExtractor().catch((err) => console.error("[embed.worker] warm-up failed:", err));

self.onmessage = async (event) => {
  const { id, type, text } = event.data || {};
  if (type !== "EMBED") return;

  try {
    const extractor = await getExtractor();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    self.postMessage({
      id,
      ok: true,
      vector: Array.from(output.data),
      dimensions: output.dims[output.dims.length - 1],
      backend: "local",
      model: MODEL_ID,
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
