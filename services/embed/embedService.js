/*
 * embedService.js — containerised embedding microservice for Feature A.
 *
 * The only part of Feature A that needs external API access is the OpenAI
 * embedding backend. Rather than shipping an API key into the browser/extension
 * bundle (where it would be trivially extractable), this tiny zero-dependency
 * Node HTTP server holds the key in its container environment and exposes a
 * single local endpoint the page can call:
 *
 *   POST /embed   { "input": "text to embed", "model"?: "text-embedding-3-small" }
 *     → 200        { "vector": number[], "dimensions": number, "model": string }
 *   GET  /health  → 200 { "ok": true }
 *
 * The extension's Embeddingmodel.js talks to it via backend: 'service'.
 *
 * Env:
 *   OPENAI_API_KEY   (required) — the key, injected by docker compose from .env
 *   EMBED_MODEL      (optional) — default model, defaults to text-embedding-3-small
 *   PORT             (optional) — listen port, defaults to 8077
 *   BIND_HOST        (optional) — listen address, defaults to 127.0.0.1 (loopback-only)
 *   SERVICE_SECRET   (optional) — if set, requests must send it via the
 *                                  `X-Service-Secret` header; without this any
 *                                  local process/webpage that can reach the
 *                                  port could burn the OpenAI key
 *   ALLOWED_ORIGIN   (optional) — CORS origin to allow, defaults to none (no
 *                                  browser page origin can call this directly)
 *
 * No npm dependencies: uses Node 18+ built-in global fetch and the http module.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 8077;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const DEFAULT_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const API_KEY = process.env.OPENAI_API_KEY || '';
const SERVICE_SECRET = process.env.SERVICE_SECRET || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const MAX_BODY_BYTES = 1e6; // 1 MB guard

function corsHeaders() {
  return ALLOWED_ORIGIN
    ? {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Headers': 'Content-Type, X-Service-Secret',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      }
    : {};
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeaders(),
  });
  res.end(payload);
}

function isAuthorized(req) {
  if (!SERVICE_SECRET) return true; // no secret configured — dev convenience
  const provided = req.headers['x-service-secret'] || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(SERVICE_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let destroyed = false;
    req.on('data', (chunk) => {
      if (destroyed) return;
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        destroyed = true;
        req.destroy();
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      if (!destroyed) resolve(data);
    });
    req.on('error', reject);
  });
}

async function embed(input, model) {
  if (!API_KEY) {
    const err = new Error('OPENAI_API_KEY not configured in the container environment.');
    err.status = 500;
    throw err;
  }
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: model || DEFAULT_MODEL, input }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`OpenAI embeddings failed (${resp.status}): ${text}`);
    err.status = 502;
    throw err;
  }

  const data = await resp.json();
  const vector = data.data[0].embedding;
  return { vector, dimensions: vector.length, model: model || DEFAULT_MODEL };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, keyConfigured: Boolean(API_KEY) });
  }

  if (req.method === 'POST' && req.url === '/embed') {
    if (!isAuthorized(req)) {
      return sendJson(res, 401, { error: 'Missing or invalid X-Service-Secret.' });
    }
    try {
      const raw = await readBody(req);
      const { input, model } = JSON.parse(raw || '{}');
      if (!input || !String(input).trim()) {
        return sendJson(res, 400, { error: 'Missing or empty `input`.' });
      }
      const result = await embed(String(input), model);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'Not found. Use POST /embed or GET /health.' });
});

server.listen(PORT, BIND_HOST, () => {
  console.log(
    `[embedService] listening on ${BIND_HOST}:${PORT} (model=${DEFAULT_MODEL}, ` +
    `key=${API_KEY ? 'set' : 'MISSING'}, secret=${SERVICE_SECRET ? 'set' : 'unset'})`
  );
});
