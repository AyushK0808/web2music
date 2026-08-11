// ui/src/zeroshot.worker.js — Web Worker hosting transformers.js zero-shot
// classification for Feature B's tier-1.5 page-type classifier
// (mood-classification/feature_b/b1_zeroShotCategory.js).
//
// Sibling of embed.worker.js and deliberately a *separate* worker, not a
// second pipeline inside that one: an MNLI model is an order of magnitude
// larger than MiniLM, and a page classification is 13 sequence-pair forward
// passes. Sharing a worker would put every Feature A embedding behind that
// queue, and the embedding is on the critical path for the mood decision
// itself.
//
// ── Which checkpoint ──────────────────────────────────────────────────────
// The tier is written against facebook/bart-large-mnli, but that model is
// ~1.6 GB (~400 MB quantised) and 13 WASM forward passes of 400M parameters
// is tens of seconds on a laptop CPU — not something to put in front of a
// page load. So the *local* backend defaults to a distilled MNLI checkpoint
// and the full BART lives behind the proxy backend (services/classify's
// /v1/zero-shot, which runs facebook/bart-large-mnli server-side).
//
// Set W2M_ZEROSHOT_MODEL (chrome.storage.local, read by background.entry.js
// and passed through on every request) to run a different one locally —
// including Xenova/bart-large-mnli, which is what the §Results
// local-vs-proxy latency/accuracy comparison needs.
//
// Unlike embed.worker.js this worker is allowed to fetch from the network:
// no MNLI checkpoint is vendored in ui/models/ (see ui/models/README.md for
// how to vendor one and turn this back off). The first classification after
// install therefore pays a model download; the tier is opt-in precisely
// because that cost is real.

import { pipeline, env } from "@xenova/transformers";

const EXT_URL = self.location.href.replace(/zeroshot\.worker\.js.*$/, "");
env.localModelPath = `${EXT_URL}models/`;
env.backends.onnx.wasm.wasmPaths = `${EXT_URL}onnx/`;

// Prefer a vendored copy when one exists, fall back to the hub otherwise.
env.allowLocalModels = true;
env.allowRemoteModels = true;

// Single-threaded ONNX is mandatory, not a tuning choice — MV3's
// `script-src 'self' 'wasm-unsafe-eval'` CSP has no blob:, so ORT's
// multi-threaded path cannot spawn its pthread workers and the pipeline
// promise never settles. The full reasoning is in embed.worker.js; both
// workers must keep this line.
env.backends.onnx.wasm.numThreads = 1;

// Cache API rejects chrome-extension:// requests, one noisy TypeError per
// model file, and buys nothing for a local model. See embed.worker.js.
env.useBrowserCache = false;

/**
 * The on-device MNLI checkpoint: same zero-shot recipe and label semantics as
 * facebook/bart-large-mnli, small enough that 13 candidate labels is
 * survivable in WASM. Overridable per request.
 *
 * ── Why this is not distilbart-mnli any more ──────────────────────────────
 * This was `Xenova/distilbart-mnli-12-1`, and that repo now answers **401
 * Unauthorized** to anonymous downloads — so did `-12-3`. Not a network blip:
 * the HF model API returns `{"error":"Invalid username or password."}` for
 * both, while `Xenova/all-MiniLM-L6-v2` (the embedding model this extension
 * also fetches) returns 200 from the same machine at the same moment. The
 * local zero-shot backend was therefore **dead in production** — every first
 * classification would fail on the model download, `getClassifier` would drop
 * the rejected promise, and the tier would silently fall through to the LLM.
 * Identical in shape to the decommissioned `api-inference.huggingface.co`
 * endpoint that had already killed the proxy backend once.
 *
 * `Xenova/nli-deberta-v3-xsmall` is available, purpose-built for zero-shot
 * NLI in transformers.js, and measured on this repo's own 13 hypotheses at
 * ~9.5 s to load and ~420 ms for a full 13-label classification — comfortably
 * inside the tier's 8 s budget once loaded.
 * `Xenova/mobilebert-uncased-mnli` is a smaller, faster alternative that also
 * works; pass it via W2M_ZEROSHOT_MODEL to compare.
 *
 * If this constant moves, mood-classification/experiments/localZeroShot.js
 * reads it from this file rather than duplicating it, so A6 keeps describing
 * whatever the extension actually runs.
 */
const DEFAULT_MODEL_ID = "Xenova/nli-deberta-v3-xsmall";

const _pipelines = new Map();
function getClassifier(modelId) {
  if (!_pipelines.has(modelId)) {
    _pipelines.set(
      modelId,
      pipeline("zero-shot-classification", modelId, { quantized: true }).catch((err) => {
        // Drop the rejected promise so a later request can retry rather than
        // re-awaiting a permanently failed load (a first-run network blip on
        // the model download is the common case, and it is recoverable).
        _pipelines.delete(modelId);
        throw err;
      })
    );
  }
  return _pipelines.get(modelId);
}

self.onmessage = async (event) => {
  const { id, type, text, labels, hypothesisTemplate, model } = event.data || {};
  if (type !== "ZERO_SHOT") return;

  // Only ever a repo id (org/name) — this string is interpolated into a URL
  // by transformers.js, and the setting it comes from is user-writable.
  const modelId = typeof model === "string" && /^[\w.-]+\/[\w.-]+$/.test(model) ? model : DEFAULT_MODEL_ID;
  const startedAt = Date.now();

  try {
    const classifier = await getClassifier(modelId);
    const output = await classifier(text, labels, {
      hypothesis_template: hypothesisTemplate || "This web page is about {}.",
      multi_label: false,
    });

    // transformers.js returns { sequence, labels, scores } — already the
    // shape b1_zeroShotCategory.parseZeroShotResult expects, and the same
    // shape the proxy backend normalises to.
    self.postMessage({
      id,
      ok: true,
      labels: output.labels,
      scores: output.scores,
      model: modelId,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
