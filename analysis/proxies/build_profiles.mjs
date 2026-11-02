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
import { setLlmCache } from '../../mood-classification/feature_b/llmCache.js';
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
const llmCfg = { backend: 'proxy', serviceUrl: `${classifyBase}/v1/chat/completions` };
const local = await createLocalClassifier({ model: flag('local-model'), log: (m) => console.log(m) });
const zeroShot = { enabled: true, backend: 'local', classify: local.classify, model: local.modelId };

const pages = flagAll('corpus').flatMap((f) => JSON.parse(fs.readFileSync(path.resolve(REPO, f), 'utf8')).pages ?? [])
  .filter((p) => p.pageData);
console.log(`[profiles] ${pages.length} page(s)`);

const out = [];
let skippedSensitive = 0, failed = 0;
for (const [i, p] of pages.entries()) {
  try {
    const b1 = await runB1(p.pageData, llmCfg, { zeroShot });
    if (b1.isSensitive) { skippedSensitive++; continue; }
    const b2 = await runB2(b1, llmCfg, { sensitiveContentMode: 'silence' });
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
console.log(`[profiles] wrote ${out.length} profile(s) to ${outFile} (skipped ${skippedSensitive} sensitive, ${failed} failed)`);
