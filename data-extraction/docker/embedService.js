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
 *
 * No npm dependencies: uses Node 18+ built-in global fetch and the http module.
 */

'use strict';

const http = require('http');

const PORT = parseInt(process.env.PORT, 10) || 8077;
const DEFAULT_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const API_KEY = process.env.OPENAI_API_KEY || '';

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

server.listen(PORT, () => {
  console.log(`[embedService] listening on :${PORT} (model=${DEFAULT_MODEL}, key=${API_KEY ? 'set' : 'MISSING'})`);
});
