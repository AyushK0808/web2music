// ui/src/telemetry.js — local-only telemetry ring buffer.
//
// urlHash, not url — HMAC-SHA-256 the URL, keyed by a random per-install secret,
// before storing. A plain SHA-256 of a URL can be reversed by hashing a list of
// likely URLs (dictionary attack); without the secret the digest cannot be
// checked against any guess. The secret lives only in chrome.storage.local, is
// never exported, and is rotated by clearTelemetry(), so hashes from before a
// clear cannot be linked to hashes after it.
const MAX_EVENTS = 2000;
const STORAGE_KEY = "w2mTelemetry";
const SECRET_KEY = "w2mTelemetrySecret";

let _sessionId = null;
function sessionId() {
  if (!_sessionId) _sessionId = crypto.randomUUID();
  return _sessionId;
}

const toHex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA-256(secretHex, text) → hex. Pure apart from WebCrypto, so it is unit-testable. */
export async function hmacHex(secretHex, text) {
  const raw = new Uint8Array(secretHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

function newSecretHex() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

let _secret = null;
async function installSecret() {
  if (_secret) return _secret;
  const stored = (await chrome.storage.local.get(SECRET_KEY))[SECRET_KEY];
  if (typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored)) {
    _secret = stored;
  } else {
    _secret = newSecretHex();
    await chrome.storage.local.set({ [SECRET_KEY]: _secret });
  }
  return _secret;
}

export async function urlHash(url) {
  if (!url) return null;
  return hmacHex(await installSecret(), url);
}

/**
 * recordTelemetry — append one event to the ring buffer in chrome.storage.local.
 * @param {string} stage  e.g. "A_extract" | "B_decision" | "D_generate" | "playback" | "user_control"
 * @param {Object} fields  { event, ms, meta, urlHash: <precomputed hash, if applicable>, tabId }
 */
export async function recordTelemetry(stage, fields = {}) {
  const entry = {
    ts: Date.now(),
    sessionId: sessionId(),
    stage,
    ...fields,
  };

  const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
  existing.push(entry);
  if (existing.length > MAX_EVENTS) existing.splice(0, existing.length - MAX_EVENTS);
  await chrome.storage.local.set({ [STORAGE_KEY]: existing });
}

export async function exportTelemetry() {
  const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return { sessionId: sessionId(), exportedAt: new Date().toISOString(), events: existing };
}

export async function clearTelemetry() {
  // Dropping the secret too unlinks every hash recorded before this point.
  _secret = null;
  await chrome.storage.local.remove([STORAGE_KEY, SECRET_KEY]);
}
