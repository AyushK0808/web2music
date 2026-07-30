const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const HOST = '127.0.0.1'; // never 0.0.0.0 — this must not be reachable from the LAN
const SHARED_SECRET = process.env.EMBED_SERVICE_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'chrome-extension://REPLACE_WITH_EXTENSION_ID';
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1MB
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SHARED_SECRET) {
  console.warn('[embedService] EMBED_SERVICE_SECRET is not set — every request will be rejected.');
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy(); // actually close the connection — don't just stop reading
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // CORS restricted to the extension's own origin — not '*'. A wildcard
  // here means any open tab, or anything on the LAN if this ever got
  // exposed beyond localhost, could call this service and burn the
  // upstream API key.
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Embed-Secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const providedSecret = req.headers['x-embed-secret'];
  if (!SHARED_SECRET || !timingSafeEqual(providedSecret, SHARED_SECRET)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/embed') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: 'Payload too large' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!payload || typeof payload.input !== 'string' || !payload.input.trim()) {
    sendJson(res, 400, { error: '"input" (string) is required' });
    return;
  }

  if (!OPENAI_API_KEY) {
    sendJson(res, 500, { error: 'OPENAI_API_KEY not configured on server' });
    return;
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: payload.model || 'text-embedding-3-small',
        input: payload.input,
      }),
    });

    const data = await upstream.json();
    sendJson(res, upstream.status, data);
  } catch (err) {
    sendJson(res, 502, { error: 'Upstream embedding request failed', detail: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[embedService] listening on http://${HOST}:${PORT} (localhost-only, CORS locked to ${ALLOWED_ORIGIN})`);
});

module.exports = server;