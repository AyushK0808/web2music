#!/usr/bin/env node
/**
 * S-D′ step 1 — run Feature B on every non-sensitive corpus page and write the
 * music profile Feature D would receive for it.
 *
 *   W2M_LLM_CACHE=analysis/llm-cache/gpt-oss-20b.jsonl W2M_LLM_CACHE_MODE=replay \
 *   node analysis/proxies/build_profiles.mjs \
 *       --corpus analysis/corpus/s2_corpus.json --corpus analysis/corpus/s2_corpus_test.json \
 *       --classify-url http://localhost:8078 --out analysis/proxies/out/profiles.json
 *
 * Uses the shipped cascade (on-device zero-shot middle stage, then the LLM stage
 * served from the response cache, C-10) followed by B2 -> B3 -> B4, with the clock
 * pinned to midday so time-of-day never differs between runs. Sensitive pages
 * (B1 flags them and B2 overrides the mood) are skipped: they get silence, so
 * there is no clip to score.
 *
 * Output: [{ id, mood, valence, arousal, profile, title, lead, category }]
 *   profile  the exact JSON body POSTed to Feature D's /generate
 *   arousal  the mood's canonical arousal position (analysis/s4/assignment.mjs);
 *            it is used only to define the shuffled control and the target for
 *            the valence/arousal agreement proxy, never given to the generator.
 *   lead     the first ~600 characters of body text, the page text CLAP is asked
 *            to match audio against.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runB1 } from '../../mood-classification/feature_b/b1_contentUnderstanding.js';
import { runB2 } from '../../mood-classification/feature_b/b2_moodClassifier.js';
import { runB3 } from '../../mood-classification/feature_b/b3_musicProfileGenerator.js';
import { runB4 } from '../../mood-classification/feature_b/b4_promptEngineer.js';
import { setLlmCache, llmCacheStats } from '../../mood-classification/feature_b/llmCache.js';
import { createCacheFromEnv } from '../../mood-classification/feature_b/llmCache.node.js';
import { createLocalClassifier } from '../../mood-classification/experiments/localZeroShot.js';
import { AROUSAL } from '../s4/assignment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const flag = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flagAll = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const cache = createCacheFromEnv();
if (cache) { setLlmCache(cache); console.log(`[profiles] LLM cache ${process.env.W2M_LLM_CACHE} (${cache.mode}, ${cache.size()} entries)`); }

const classifyBase = flag('classify-url', 'http://localhost:8078');
// --no-llm: the zero-exposure pipeline. B1 stops at keyword -> on-device zero-shot (then its
// default category) and B2 stays on its tier-1 heuristic; no text is sent to any LLM and the
// classify service is not used. An empty config is how both stages already skip the LLM.
const NO_LLM = args.includes('--no-llm');
// --llm-url / --llm-model: send B1/B2 to a local OpenAI-compatible server (e.g. Ollama's
// http://localhost:11435/v1/chat/completions) instead of the Groq proxy.
const llmUrl = flag('llm-url');
const llmModel = flag('llm-model');
const llmCfg = NO_LLM ? '' : {
  backend: 'proxy',
  serviceUrl: llmUrl ?? `${classifyBase}/v1/chat/completions`,
  ...(llmModel ? { model: llmModel } : {}),
};
if (!NO_LLM && llmUrl) console.log(`[profiles] LLM: ${llmModel ?? 'default model'} at ${llmUrl}`);
if (!NO_LLM && llmUrl) {
  // fail fast on a wrong URL/model: a 400/404 can never succeed, and B2's retries would just burn minutes per page
  const r = await fetch(llmUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: llmModel, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }) })
    .catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (!r.ok && r.status !== 429) { console.error(`[profiles] LLM preflight failed (${r.status}): ${(await r.text()).slice(0, 300)}`); process.exit(1); }
  console.log('[profiles] LLM preflight ok');
}
if (NO_LLM) console.log('[profiles] --no-llm: local-only pipeline (no LLM calls)');
const local = await createLocalClassifier({ model: flag('local-model'), log: (m) => console.log(m) });
const zeroShot = { enabled: true, backend: 'local', classify: local.classify, model: local.modelId };

const pages = flagAll('corpus').flatMap((f) => JSON.parse(fs.readFileSync(path.resolve(REPO, f), 'utf8')).pages ?? [])
  .filter((p) => p.pageData);
console.log(`[profiles] ${pages.length} page(s)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_PACING_MS = Number(process.env.PROFILES_PAGE_PACING_MS ?? 1500);
const B2_RETRIES = Number(process.env.PROFILES_B2_RETRIES ?? 5);
const B2_RETRY_BASE_MS = Number(process.env.PROFILES_B2_RETRY_BASE_MS ?? 4000);
const b2Fallbacks = [];

const out = [];
let skippedSensitive = 0, failed = 0;
for (const [i, p] of pages.entries()) {
  try {
    const b1 = await runB1(p.pageData, llmCfg, { zeroShot });
    if (b1.isSensitive) { skippedSensitive++; continue; }
    // B2 only calls the LLM when its tier-1 confidence is low; on confident pages "tier1-heuristic" is
    // the intended result. So a page is retried only if a live LLM request was actually sent and
    // failed (rate limit, timeout, bad reply) -- i.e. `live` went up but no answer was stored.
    let b2, ranLive;
    const runPageB2 = async () => {
      const before = llmCacheStats();
      b2 = await runB2(b1, llmCfg, { sensitiveContentMode: 'silence' });
      const after = llmCacheStats();
      ranLive = after.live > before.live;
      return ranLive && after.stored === before.stored;     // sent a request, got nothing usable
    };
    let failedLive = await runPageB2();
    for (let attempt = 1; failedLive && attempt <= B2_RETRIES; attempt++) {
      const waitMs = B2_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(`  ${p.id}: B2's LLM request failed -- retrying in ${waitMs}ms (${attempt}/${B2_RETRIES})`);
      await sleep(waitMs);
      failedLive = await runPageB2();
    }
    if (failedLive) b2Fallbacks.push(p.id);
    if (ranLive) await sleep(PAGE_PACING_MS);
    if (b2.sensitiveOverride || b2.mood == null) { skippedSensitive++; continue; }
    const handoff = runB4(runB3({ ...b2, hour: 12 }), { targetModel: 'musicgen' });
    out.push({
      id: p.id,
      category: b1.category?.primary ?? null,
      mood: b2.mood,
      valence: b2.valenceHint ?? null,
      arousal: AROUSAL[b2.mood] ?? 0.5,
      profile: handoff.profile,
      title: p.pageData.title ?? '',
      lead: (p.pageData.rawText ?? '').slice(0, 600),
    });
  } catch (e) {
    failed++;
    console.warn(`  ${p.id}: ${e.message}`);
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${pages.length}`);
}

const outFile = path.resolve(REPO, flag('out', 'analysis/proxies/out/profiles.json'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
if (b2Fallbacks.length) console.warn(`[profiles] WARNING: ${b2Fallbacks.length} page(s) ended on B2's tier-1 fallback, not the LLM: ${b2Fallbacks.join(', ')}`);
console.log(`[profiles] wrote ${out.length} profile(s) to ${outFile} (skipped ${skippedSensitive} sensitive, ${failed} failed)`);
