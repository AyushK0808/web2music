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
 * llama-3.1-8b-instant is the default: it's fast, free-tier limits are
 * generous (14,400 requests/day as of when this was set), and the
 * classification tasks here are simple JSON-shape outputs that don't need a
 * bigger model. llama-3.3-70b-versatile is the higher-quality alternative if
 * classification accuracy matters more than request headroom — its free
 * tier is capped much lower (1,000 requests/day). Groq's free-tier limits
 * change over time; check https://console.groq.com/docs/rate-limits for the
 * current numbers before relying on either.
 *
 * Override per-call via the `model` field on the config object passed to
 * runB1/runB2 (threaded from feature_b/index.js's `_config.llmModel`), or
 * edit the default here to change it everywhere at once.
 */

"use strict";

export const DEFAULT_MODEL = "llama-3.1-8b-instant";
