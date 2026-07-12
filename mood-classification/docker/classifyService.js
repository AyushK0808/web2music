/*
 * classifyService.js — containerised Anthropic Messages API proxy for
 * Feature B (mood + category classification).
 *
 * B1/B2 already build the exact classification prompts they always have
 * (buildClassificationPrompt in b2_moodClassifier.js, the category prompt in
 * b1_contentUnderstanding.js's callCategoryLLMClassifier — including the
 * prompt-injection delimiters and output validation). This container's only
 * job is to hold ANTHROPIC_API_KEY server-side and forward the already-built
 * request to Anthropic, so the key never enters the browser/extension
 * bundle. It does NOT duplicate any prompt-building, delimiter-escaping, or
 * output-validation logic — all of that stays in feature_b/*.js and is
 * reused unchanged regardless of which backend ("direct" vs "proxy") is
 * selected there.
 *
 *   POST /v1/messages   <same body shape as the Anthropic Messages API>
 *     → whatever Anthropic returns, forwarded verbatim (status + JSON)
 *   GET  /health  → 200 { "ok": true, "keyConfigured": boolean }
 *
 * Same pattern as Feature A's data-extraction/docker/embedService.js, which
 * does the equivalent for the OpenAI embedding key.
 *
 * Env:
 *   ANTHROPIC_API_KEY   (required) — the key, injected by docker compose from .env
 *   PORT                (optional) — listen port, defaults to 8078
 *
 * No npm dependencies: uses Node 18+ built-in global fetch and the http module.
 */

'use strict';

const http = require('http');

const PORT = parseInt(process.env.PORT, 10) || 8078;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_VERSION = '2023-06-01';

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

// Forwards the client's already-built Messages API request body to Anthropic,
// with the real key attached server-side, and returns the raw status + body
// text so the caller can relay it byte-for-byte without reinterpreting it.
async function forwardToAnthropic(rawBody) {
  if (!API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY not configured in the container environment.');
    err.status = 500;
    throw err;
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      // No anthropic-dangerous-direct-browser-access header here — this is a
      // server-to-server call (container → Anthropic), not a browser request,
      // so the browser-CORS opt-in Anthropic requires for direct-from-browser
      // calls doesn't apply.
    },
    body: rawBody,
  });

  const text = await resp.text();
  return { status: resp.status, text };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, keyConfigured: Boolean(API_KEY) });
  }

  if (req.method === 'POST' && req.url === '/v1/messages') {
    try {
      const raw = await readBody(req);
      if (!raw || !raw.trim()) {
        return sendJson(res, 400, { error: 'Missing request body.' });
      }
      const { status, text } = await forwardToAnthropic(raw);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(text);
    } catch (err) {
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'Not found. Use POST /v1/messages or GET /health.' });
});

server.listen(PORT, () => {
  console.log(`[classifyService] listening on :${PORT} (key=${API_KEY ? 'set' : 'MISSING'})`);
});
