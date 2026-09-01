/**
 * FEATURE B — shared LLM configuration constants.
 *
 * Single source of truth for the model ID used by both of Feature B's LLM
 * calls (B1's callCategoryLLMClassifier, B2's callLLMClassifier) — previously
 * hardcoded as an identical literal in both files, so a model change had to
 * be applied in two places and could silently drift out of sync.
 *
 * Provider: GroqCloud (api.groq.com) — an OpenAI-compatible chat completions
 * API with a genuinely free developer tier (rate-limited, not trial-credit).
 *
 * Migration note (2026-08): Groq announced on 2026-06-17 that both
 * llama-3.1-8b-instant (this file's previous default) and
 * llama-3.3-70b-versatile (the higher-quality alternative this file used to
 * suggest) are deprecated. api.groq.com now 404s on llama-3.1-8b-instant
 * rather than returning the usual `400 model_decommissioned`, i.e. it has
 * been fully pulled, not just soft-deprecated with a warning. Groq's stated
 * replacement for llama-3.1-8b-instant is openai/gpt-oss-20b, set below.
 * See https://console.groq.com/docs/deprecations for the current list —
 * check it before relying on any model ID here, since Groq's deprecation
 * cadence has been roughly monthly through 2026.
 *
 * Every golden fixture recorded against the old model
 * (mood-classification/fixtures/groq_*_response.json) needs re-recording
 * against the new one — Table VI's restraint-audit claim that "a silent
 * tier-2 model change is detectable" depends on that re-recording actually
 * happening, not just on this constant being updated.
 *
 * Override per-call via the `model` field on the config object passed to
 * runB1/runB2 (threaded from feature_b/index.js's `_config.llmModel`), or
 * edit the default here to change it everywhere at once.
 */

"use strict";

export const DEFAULT_MODEL = "openai/gpt-oss-20b";

