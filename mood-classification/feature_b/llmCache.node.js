/**
 * Node-side backend for llmCache.js (C-10): an append-only JSONL file, one
 * {key, kind, model, request, response, at} record per line. Append-only so a
 * crashed run never corrupts earlier responses, and so the file can be released
 * as-is alongside the results (it holds raw model output for the test pages).
 *
 *   import { setLlmCache } from "./llmCache.js";
 *   import { createJsonlCache } from "./llmCache.node.js";
 *   setLlmCache(createJsonlCache("analysis/llm-cache/gpt-oss-20b.jsonl", "readwrite"));
 */

import fs from "node:fs";
import path from "node:path";

export function createJsonlCache(file, mode = "readwrite") {
  if (!["record", "readwrite", "replay"].includes(mode)) throw new Error(`unknown llm-cache mode: ${mode}`);
  const entries = new Map();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        entries.set(rec.key, rec);
      } catch { /* a torn final line from a crash is skipped, not fatal */ }
    }
  } else if (mode === "replay") {
    throw new Error(`llm-cache replay requested but ${file} does not exist`);
  }
  if (mode !== "replay") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  return {
    mode,
    size: () => entries.size,
    async get(key) { return entries.get(key) ?? null; },
    async put(rec) {
      entries.set(rec.key, rec);
      fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    },
  };
}

/** Cache configured from the environment: W2M_LLM_CACHE=<file>, W2M_LLM_CACHE_MODE=<mode>. */
export function createCacheFromEnv(env = process.env) {
  if (!env.W2M_LLM_CACHE) return null;
  return createJsonlCache(env.W2M_LLM_CACHE, env.W2M_LLM_CACHE_MODE || "readwrite");
}
