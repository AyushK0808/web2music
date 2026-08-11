/**
 * localZeroShot.js — C-02: the distilled MNLI checkpoint, runnable from Node.
 *
 * The extension already runs this model in a Web Worker
 * (ui/src/zeroshot.worker.js). The ablation harness is a Node script, so it
 * needs the same model behind the same interface without a browser. This is
 * that: a `classify()` function matching the shape
 * `b1_zeroShotCategory.classifyCategoryZeroShot` expects for its `local`
 * backend, so A6 goes through exactly the code path A2/A5 go through and the
 * comparison is between checkpoints rather than between code paths.
 *
 * The model id defaults to the same constant the worker defaults to. If they
 * ever diverge, A6 stops describing the shipped local tier — so the check
 * below reads the worker source and fails loudly rather than silently
 * measuring a different model from the one the extension would run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = path.resolve(__dirname, '../../ui/src/zeroshot.worker.js');

/** The checkpoint the shipped local tier uses, read from the worker itself. */
export function shippedLocalModelId() {
  const src = fs.readFileSync(WORKER_SRC, 'utf8');
  const m = src.match(/const DEFAULT_MODEL_ID\s*=\s*["']([^"']+)["']/);
  if (!m) {
    throw new Error(
      `Could not read DEFAULT_MODEL_ID from ${WORKER_SRC}. A6 is supposed to be "the shipped `
      + `local tier"; if that constant has moved, fix this reader rather than hardcoding a `
      + `model id here — a hardcoded one is how A6 quietly stops describing the shipped system.`,
    );
  }
  return m[1];
}

/**
 * Build a classify() for the `local` backend.
 *
 * The pipeline is created once and reused: loading a distilled BART is tens of
 * seconds, and paying that per page would make the A6 column a measurement of
 * model loading.
 */
export async function createLocalClassifier({ model = null, quantized = true, log = () => {} } = {}) {
  const modelId = model || shippedLocalModelId();
  log(`[A6] loading ${modelId} (quantized=${quantized}) — first run downloads the checkpoint`);

  const { pipeline, env } = await import('@xenova/transformers');
  // Node has a real filesystem cache; unlike the extension there is no CSP
  // constraint here, so the defaults are fine except for the cache location,
  // which is pinned so a reproducibility bundle can say where the weights came
  // from.
  env.cacheDir = process.env.W2M_MODEL_CACHE
    || path.resolve(__dirname, '../../.model-cache');

  const started = Date.now();
  let classifier;
  try {
    classifier = await pipeline('zero-shot-classification', modelId, { quantized });
  } catch (e) {
    // A 401 here is not a credentials problem on this machine — it is the
    // model repo having gone away, which is exactly how the previous default
    // (Xenova/distilbart-mnli-12-1) broke. Say so, because "Unauthorized
    // access to file" reads like a local misconfiguration and sends whoever
    // hits it looking in the wrong place for an afternoon.
    if (/401|Unauthorized/i.test(e.message)) {
      throw new Error(
        `${modelId} returned 401 to an anonymous download. Check whether the repo still exists `
        + `(curl -o /dev/null -w '%{http_code}' https://huggingface.co/api/models/${modelId}); `
        + `if it is gated or gone, pick a live checkpoint and update DEFAULT_MODEL_ID in `
        + `ui/src/zeroshot.worker.js — the extension's local tier is broken in exactly the same `
        + `way if this fails. Original: ${e.message}`,
      );
    }
    throw e;
  }
  log(`[A6] loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  let calls = 0;
  let totalMs = 0;

  const classify = async ({ text, labels, hypothesisTemplate }) => {
    const t0 = Date.now();
    const out = await classifier(text, labels, {
      hypothesis_template: hypothesisTemplate || 'This web page is about {}.',
      multi_label: false,
    });
    calls += 1;
    totalMs += Date.now() - t0;
    // transformers.js returns { sequence, labels, scores } — already the shape
    // parseZeroShotResult expects, same as the proxy backend normalises to.
    return { labels: out.labels, scores: out.scores };
  };

  return {
    classify,
    modelId,
    stats: () => ({ calls, total_ms: totalMs, mean_ms: calls ? totalMs / calls : null }),
  };
}
