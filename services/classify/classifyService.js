/*
 * classifyService.js — containerised GroqCloud chat-completions proxy for
 * Feature B (mood + category classification).
 *
 * B1/B2 already build the exact classification prompts they always have
 * (buildClassificationPrompt in b2_moodClassifier.js, the category prompt in
 * b1_contentUnderstanding.js's callCategoryLLMClassifier — including the
 * prompt-injection delimiters and output validation). This container's only
 * job is to hold GROQ_API_KEY server-side and forward the already-built
 * request to GroqCloud, so the key never enters the browser/extension
 * bundle. It does NOT duplicate any prompt-building, delimiter-escaping, or
 * output-validation logic — all of that stays in feature_b/*.js and is
 * reused unchanged regardless of which backend ("direct" vs "proxy") is
 * selected there.
 *
 *   POST /v1/chat/completions   <same body shape as Groq's OpenAI-compatible API>
 *     → whatever Groq returns, forwarded verbatim (status + JSON)
 *   POST /v1/zero-shot          B1.5's page-type tier — see below
 *   GET  /health  → 200 { "ok": true, "keyConfigured": boolean, "zeroShotConfigured": boolean }
 *
 * Same pattern as Feature A's services/embed/embedService.js, which
 * does the equivalent for the OpenAI embedding key.
 *
 * ── /v1/zero-shot ─────────────────────────────────────────────────────────
 * Runs facebook/bart-large-mnli zero-shot classification for Feature B's
 * tier-1.5 page-type classifier (feature_b/b1_zeroShotCategory.js) via the
 * HuggingFace Inference API, with HF_API_TOKEN held server-side for the same
 * reason GROQ_API_KEY is.
 *
 * It lives in this container rather than in a new one because it is the same
 * shape of problem — a third-party model endpoint that needs a secret the
 * extension must not carry — and because B1 already talks to this host, so
 * the extension gains no new origin, no new host permission, and no second
 * health check.
 *
 * The route normalises HF's response to { labels, scores } (descending) so
 * the browser-local transformers.js backend and this one are interchangeable
 * from B1.5's point of view.
 *
 *   POST /v1/zero-shot
 *     { "text": "...", "labels": ["...", ...],
 *       "hypothesis_template": "This web page is about {}.",
 *       "multi_label": false, "model": "facebook/bart-large-mnli" }
 *     → 200 { "labels": [...], "scores": [...], "model": "..." }
 *
 * Env:
 *   GROQ_API_KEY   (required for /v1/chat/completions) — injected by docker compose from .env
 *   HF_API_TOKEN   (required for /v1/zero-shot)        — HuggingFace read token
 *   ZERO_SHOT_MODEL (optional) — defaults to facebook/bart-large-mnli
 *   PORT           (optional) — listen port, defaults to 8078
 *
 * No npm dependencies: uses Node 18+ built-in global fetch and the http module.
 */

'use strict';

const http = require('http');

const PORT = parseInt(process.env.PORT, 10) || 8078;
const API_KEY = process.env.GROQ_API_KEY || '';
const HF_TOKEN = process.env.HF_API_TOKEN || '';
const ZERO_SHOT_MODEL = process.env.ZERO_SHOT_MODEL || 'facebook/bart-large-mnli';

/**
 * A cold HF Inference endpoint returns 503 while the model loads, which for
 * bart-large-mnli is tens of seconds on the free tier. B1.5's own client
 * gives up after 8s and falls through to the LLM tier, so this waits for at
 * most one short retry rather than holding a request open past that — the
 * point is that the *second* page classified is fast, not that the first one
 * blocks until the model is warm.
 */
const HF_TIMEOUT_MS = 6000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // Local-only dev convenience; tighten/remove for real deployments.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('payload too large')); // 1 MB guard
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Forwards the client's already-built chat-completions request body to Groq,
// with the real key attached server-side, and returns the raw status + body
// text so the caller can relay it byte-for-byte without reinterpreting it.
async function forwardToGroq(rawBody) {
  if (!API_KEY) {
    const err = new Error('GROQ_API_KEY not configured in the container environment.');
    err.status = 500;
    throw err;
  }

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      // This is a server-to-server call (container → Groq), not a browser
      // request, so no CORS opt-in of any kind is relevant here.
    },
    body: rawBody,
  });

  const text = await resp.text();
  return { status: resp.status, text };
}

/**
 * Runs one zero-shot classification against the HF Inference API and
 * normalises the result to { labels, scores }.
 *
 * HF returns exactly that shape for the zero-shot-classification task
 * already, sorted descending — this re-sorts anyway (one pass over 13
 * elements) so the contract holds even if that ever changes, and so a
 * `multi_label: true` response, whose scores are independent sigmoids rather
 * than a softmax, still arrives ranked.
 */
async function classifyZeroShot(body) {
  if (!HF_TOKEN) {
    const err = new Error('HF_API_TOKEN not configured in the container environment.');
    err.status = 500;
    throw err;
  }
  const text = typeof body.text === 'string' ? body.text : '';
  const labels = Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string') : [];
  if (!text.trim() || labels.length === 0) {
    const err = new Error('Body must include a non-empty `text` and a non-empty `labels` array.');
    err.status = 400;
    throw err;
  }

  const model = typeof body.model === 'string' && body.model ? body.model : ZERO_SHOT_MODEL;
  const parameters = { candidate_labels: labels, multi_label: Boolean(body.multi_label) };
  if (typeof body.hypothesis_template === 'string' && body.hypothesis_template.includes('{}')) {
    parameters.hypothesis_template = body.hypothesis_template;
  }

  // api-inference.huggingface.co (the old free serverless Inference API) is
  // decommissioned -- it no longer resolves in DNS at all, which surfaced
  // here as every /v1/zero-shot call failing with a bare "fetch failed" and
  // the tier silently falling through to the LLM on every single page since
  // the day this stopped resolving. HF's replacement is the "Inference
  // Providers" router; hf-inference is the provider name for HF's own
  // hosted models (as opposed to routing to a third-party provider).
  const resp = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
    method: 'POST',
    signal: AbortSignal.timeout(HF_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HF_TOKEN}`,
    },
    // wait_for_model:false — see HF_TIMEOUT_MS. A cold model 503s and B1.5
    // degrades to its next tier for that page; the load continues server-side
    // and the next page gets a warm model.
    body: JSON.stringify({ inputs: text, parameters, options: { wait_for_model: false } }),
  });

  const payload = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = new Error(payload?.error || `HuggingFace Inference API ${resp.status}`);
    err.status = resp.status === 503 ? 503 : 502;
    throw err;
  }
  // The router's zero-shot-classification response is a flat array of
  // { label, score } objects, ranked descending — not the { labels: [],
  // scores: [] } parallel-arrays shape the old api-inference.huggingface.co
  // endpoint returned. Normalised back to that shape here so B1.5
  // (parseZeroShotResult) and the local transformers.js backend, which does
  // still return parallel arrays, stay interchangeable from the caller's side.
  if (!Array.isArray(payload) || payload.some((r) => typeof r?.label !== 'string' || typeof r?.score !== 'number')) {
    const err = new Error('Unexpected HuggingFace response shape (expected an array of {label, score}).');
    err.status = 502;
    throw err;
  }

  const ranked = [...payload].sort((a, b) => b.score - a.score);

  return {
    labels: ranked.map((r) => r.label),
    scores: ranked.map((r) => r.score),
    model,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      keyConfigured: Boolean(API_KEY),
      zeroShotConfigured: Boolean(HF_TOKEN),
      zeroShotModel: ZERO_SHOT_MODEL,
    });
  }

  if (req.method === 'POST' && req.url === '/v1/zero-shot') {
    try {
      const raw = await readBody(req);
      if (!raw || !raw.trim()) return sendJson(res, 400, { error: 'Missing request body.' });
      return sendJson(res, 200, await classifyZeroShot(JSON.parse(raw)));
    } catch (err) {
      const status = err.status || (err.name === 'TimeoutError' ? 504 : 502);
      return sendJson(res, status, { error: err.message });
    }
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      const raw = await readBody(req);
      if (!raw || !raw.trim()) {
        return sendJson(res, 400, { error: 'Missing request body.' });
      }
      const { status, text } = await forwardToGroq(raw);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(text);
    } catch (err) {
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'Not found. Use POST /v1/chat/completions, POST /v1/zero-shot, or GET /health.' });
});

server.listen(PORT, () => {
  console.log(`[classifyService] listening on :${PORT} `
    + `(groq=${API_KEY ? 'set' : 'MISSING'}, hf=${HF_TOKEN ? 'set' : 'MISSING'}, zeroShotModel=${ZERO_SHOT_MODEL})`);
});
