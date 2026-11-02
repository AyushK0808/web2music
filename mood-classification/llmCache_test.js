/**
 * LLM response cache (C-10 / L-5) — Unit Tests
 * Run with: node mood-classification/llmCache_test.js
 *
 * What matters: a replay must never reach the network, a hit must be returned
 * byte-for-byte, failed calls must never be cached, and with no cache installed
 * the LLM call path is exactly what it was.
 */

import { strict as assert } from "assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setLlmCache, cachedLlmFetch, llmCacheStats } from "./feature_b/llmCache.js";
import { createJsonlCache } from "./feature_b/llmCache.node.js";
import { callCategoryLLMClassifier } from "./feature_b/b1_contentUnderstanding.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w2m-llmcache-"));
const body = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hello" }] });
const okRes = (data) => ({ ok: true, status: 200, json: async () => data });

await test("no cache installed: the fetch function is called and its response returned untouched", async () => {
  setLlmCache(null);
  const res = okRes({ x: 1 });
  assert.equal(await cachedLlmFetch("t", body, async () => res), res);
});

await test("readwrite: first call queries and stores, second call is served from the cache", async () => {
  const file = path.join(tmp, "a.jsonl");
  setLlmCache(createJsonlCache(file, "readwrite"));
  let calls = 0;
  const fetchFn = async () => { calls++; return okRes({ answer: "calm" }); };
  const r1 = await cachedLlmFetch("t", body, fetchFn);
  const r2 = await cachedLlmFetch("t", body, fetchFn);
  assert.deepEqual(await r1.json(), { answer: "calm" });
  assert.deepEqual(await r2.json(), { answer: "calm" });
  assert.equal(calls, 1);
  assert.deepEqual(llmCacheStats(), { hits: 1, misses: 0, stored: 1, mode: "readwrite" });
  const rec = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(rec.model, "m1");
  assert.equal(rec.request, body);
  assert.match(rec.key, /^[0-9a-f]{64}$/);
});

await test("the cache survives a restart: a new process reads what the old one wrote", async () => {
  setLlmCache(createJsonlCache(path.join(tmp, "a.jsonl"), "replay"));
  const r = await cachedLlmFetch("t", body, async () => { throw new Error("network must not be touched"); });
  assert.deepEqual(await r.json(), { answer: "calm" });
});

await test("replay: a miss throws instead of querying the live model, and is counted", async () => {
  setLlmCache(createJsonlCache(path.join(tmp, "a.jsonl"), "replay"));
  let touched = false;
  await assert.rejects(
    cachedLlmFetch("t", JSON.stringify({ model: "m1", other: true }), async () => { touched = true; return okRes({}); }),
    /replay miss/,
  );
  assert.equal(touched, false);
  assert.equal(llmCacheStats().misses, 1);
});

await test("record: always queries, even when an entry exists", async () => {
  setLlmCache(createJsonlCache(path.join(tmp, "a.jsonl"), "record"));
  let calls = 0;
  await cachedLlmFetch("t", body, async () => { calls++; return okRes({ answer: "new" }); });
  assert.equal(calls, 1);
});

await test("failed responses are returned as-is and never cached", async () => {
  const file = path.join(tmp, "b.jsonl");
  setLlmCache(createJsonlCache(file, "readwrite"));
  const bad = { ok: false, status: 429, json: async () => ({}) };
  assert.equal(await cachedLlmFetch("t", body, async () => bad), bad);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "", "");
});

await test("a torn final line (crash mid-write) does not break loading", async () => {
  const file = path.join(tmp, "c.jsonl");
  fs.writeFileSync(file, JSON.stringify({ key: "k", response: { ok: 1 } }) + "\n{\"key\":\"broken");
  const cache = createJsonlCache(file, "replay");
  assert.equal(cache.size(), 1);
});

await test("end to end: B1's category LLM call is answered from the cache with no network", async () => {
  const file = path.join(tmp, "d.jsonl");
  setLlmCache(createJsonlCache(file, "readwrite"));
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return okRes({ choices: [{ message: { content: JSON.stringify({ category: "Educational" }) } }] });
  };
  const input = { keywords: ["vote", "election"], title: "Election night", summary: "Results are in." };
  const cfg = { backend: "proxy", serviceUrl: "http://localhost:8078/v1/chat/completions", model: "m1" };
  try {
    assert.equal(await callCategoryLLMClassifier(input, cfg), "Educational");
    globalThis.fetch = async () => { throw new Error("network must not be touched on replay"); };
    setLlmCache(createJsonlCache(file, "replay"));
    assert.equal(await callCategoryLLMClassifier(input, cfg), "Educational");
    assert.equal(calls, 1);
    assert.equal(llmCacheStats().hits, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

setLlmCache(null);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
