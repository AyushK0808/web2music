// ui/src/telemetry.js — local-only telemetry ring buffer.
//
// urlHash, not url — SHA-256 the URL before storing. No participant's
// browsing history exists in plaintext, and it never leaves their machine
// until they explicitly export it (popup "Export" button).
const MAX_EVENTS = 2000;
const STORAGE_KEY = "w2mTelemetry";

let _sessionId = null;
function sessionId() {
  if (!_sessionId) _sessionId = crypto.randomUUID();
  return _sessionId;
}

export async function urlHash(url) {
  if (!url) return null;
  const bytes = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
  await chrome.storage.local.remove(STORAGE_KEY);
}
