/**
 * FEATURE B — LLM response cache (C-10 / L-5).
 *
 * The cascade's third stage is an LLM. A hosted LLM at temperature 0 is not
 * guaranteed deterministic, and its answers change whenever the provider swaps
 * a model underneath the same ID. If every replay, ablation and threshold sweep
 * queried it again, two "identical" runs could disagree and a result could not
 * be reproduced from the release. This module records every raw response the
 * first time and lets later runs read it back instead.
 *
 * Key: sha256 of the exact request body, which already contains the model ID
 * and the full prompt (and therefore the page content the prompt embeds). Two
 * requests share an entry only if they are byte-identical.
 *
 * Default: no cache installed, so nothing changes in the extension. A Node
 * harness installs one with setLlmCache(createJsonlCache(path, mode)) from
 * llmCache.node.js. Modes:
 *   "record"      always query, then store                (build the cache)
 *   "readwrite"   read if present, else query and store   (default when a path is set)
 *   "replay"      read only; a miss is an ERROR -> the caller's normal LLM-failed
 *                 path (returns null) and is counted, never silently re-queried
 *
 * Uses WebCrypto only, so it runs unchanged in Node, workers and the service
 * worker; file access lives in llmCache.node.js.
 */

"use strict";

let _cache = null;
const _stats = { hits: 0, misses: 0, stored: 0, live: 0 };

/** Install (or, with null, remove) the cache backend. */
export function setLlmCache(cache) {
  _cache = cache;
  _stats.hits = _stats.misses = _stats.stored = _stats.live = 0;
}

export function llmCacheStats() {
  return { ..._stats, mode: _cache?.mode ?? "off" };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function llmCacheKey(requestBody) {
  return sha256Hex(requestBody);
}

function responseLike(data) {
  return { ok: true, status: 200, json: async () => data, fromCache: true };
}

/**
 * cachedLlmFetch — wraps one LLM HTTP call.
 *
 * @param {string} kind         "b1-category" | "b2-mood" (recorded for auditing)
 * @param {string} requestBody  the exact JSON string about to be POSTed
 * @param {() => Promise<Response>} fetchFn  performs the real request
 * @returns {Promise<{ok:boolean,status:number,json:()=>Promise<any>}>}
 */
export async function cachedLlmFetch(kind, requestBody, fetchFn) {
  if (!_cache) return fetchFn();

  const key = await llmCacheKey(requestBody);
  if (_cache.mode !== "record") {
    const hit = await _cache.get(key);
    if (hit) {
      _stats.hits++;
      return responseLike(hit.response);
    }
    if (_cache.mode === "replay") {
      _stats.misses++;
      throw new Error(`[llm-cache] replay miss for ${kind} (${key.slice(0, 12)}…) — refusing to query the live model`);
    }
  }

  _stats.live++; // a real request was sent (on success `stored` follows; callers can tell a failed one apart)
  const res = await fetchFn();
  if (!res.ok) return res; // errors are never cached
  const data = await res.json();
  let model = null;
  try { model = JSON.parse(requestBody).model ?? null; } catch { /* not JSON: leave null */ }
  await _cache.put({ key, kind, model, request: requestBody, response: data, at: new Date().toISOString() });
  _stats.stored++;
  return { ok: true, status: res.status, json: async () => data };
}
