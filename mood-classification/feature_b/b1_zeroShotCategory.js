/**
 * FEATURE B — B1.5: Zero-shot page-type classification (BART-large-MNLI)
 *
 * Sits between B1's tier-1 keyword heuristic and its tier-2 generative-LLM
 * escalation:
 *
 *   tier 1   keyword hits          free, instant, ~zero recall on pages whose
 *                                  vocabulary isn't in CATEGORY_KEYWORDS
 *   tier 1.5 zero-shot NLI  <— new one model, no prompt, no generation, no
 *                                  hallucinated label possible (the label set
 *                                  is the model's output space, not something
 *                                  it is asked to spell correctly)
 *   tier 2   Groq chat LLM         most capable, most expensive, and the only
 *                                  tier that sends page text to a third party
 *
 * Why this tier is worth its cost — the three things it fixes about the pair
 * either side of it:
 *   - tier 1 fails silently on paraphrase. A page about "gut microbiome
 *     enterotypes" has no Health keyword in it; the heuristic returns null and
 *     every such page fell through to the network.
 *   - tier 2 is a *generative* classifier: it can emit a category that isn't
 *     in the list (callCategoryLLMClassifier has to validate against
 *     categoryNames and discard), it costs a round trip, and it is the point
 *     where page content leaves the machine. NLI entailment scoring can do
 *     neither of the first two, and with the local backend, not the third.
 *   - neither of them produces a *calibrated* number. Zero-shot gives a score
 *     per candidate label, so "the model is not sure" is representable
 *     (MIN_SCORE / MIN_MARGIN below) instead of being flattened into a guess.
 *
 * ── The model ─────────────────────────────────────────────────────────────
 * facebook/bart-large-mnli, the standard zero-shot-classification checkpoint:
 * each candidate label is turned into a hypothesis ("This web page is about
 * cooking and food.") and scored for entailment against the page text, then
 * the entailment logits are softmaxed across labels. 13 labels means 13
 * forward passes of a 400M-parameter model per page, which is the whole
 * reason there are two backends:
 *
 *   backend: "proxy"  (default)  POST <classify service>/v1/zero-shot, which
 *                                holds the HF token server-side and runs the
 *                                full facebook/bart-large-mnli. Same container
 *                                and same "the key never enters the browser"
 *                                argument as the Groq proxy this sits beside.
 *   backend: "local"             an injected classify() — in the extension,
 *                                transformers.js in the offscreen document
 *                                (ui/src/zeroshot.worker.js). Nothing leaves
 *                                the machine. Practical only with a small
 *                                MNLI checkpoint; a quantised bart-large-mnli
 *                                is ~400 MB and 13 WASM passes per page, so
 *                                the worker defaults to a distilled model and
 *                                takes the full one only if asked.
 *
 * Both backends return the HuggingFace zero-shot shape — { labels, scores },
 * descending by score — so everything below this line is backend-agnostic.
 *
 * The tier is OFF unless configured (see configureFeatureB's zeroShot block).
 * Every failure mode — unreachable service, timeout, malformed response,
 * unconfident result — returns null and lets B1 carry on to tier 2, exactly
 * like callCategoryLLMClassifier does. It never throws.
 */

"use strict";

// Deliberately imports nothing from b1_contentUnderstanding.js: that module
// imports *this* one, and a cycle whose top level reads the other side's
// bindings is a live footgun. The one thing that has to stay in sync with
// CATEGORY_KEYWORDS is checked by assertLabelCoverage(), which is handed the
// category list by its caller instead of reaching for it.

/** The one model this tier is written against. */
export const DEFAULT_ZERO_SHOT_MODEL = "facebook/bart-large-mnli";

/**
 * Hypothesis phrasing per category. NLI scores a *sentence*, so the bare
 * category name is a bad candidate label: "News" as a hypothesis ("This web
 * page is about News.") is close to contentless, and "Emotional" /
 * "Mythological" as adjectives-turned-nouns barely parse. These are the
 * phrases the entailment head actually sees; the keys are what B1 speaks.
 *
 * Keep in sync with CATEGORY_KEYWORDS — the assertion in
 * assertLabelCoverage() below fails loudly if a category is added there and
 * not here, rather than letting that category become unreachable at this tier.
 */
export const CATEGORY_HYPOTHESES = {
  Educational:   "learning, study, or explaining a subject",
  News:          "current events, politics, or news reporting",
  Horror:        "horror, fear, or something frightening",
  Food:          "cooking, recipes, or food",
  Entertainment: "movies, music, games, or celebrities",
  Sports:        "sports, athletes, or a competition",
  Finance:       "money, markets, investing, or business finance",
  Legal:         "law, courts, or legal matters",
  Health:        "health, medicine, or wellbeing",
  Comedy:        "comedy, jokes, or something funny",
  Emotional:     "love, relationships, or personal feelings",
  Mythological:  "mythology, religion, history, or spirituality",
  Travel:        "travel, nature, or places to visit",
};

/** The sentence frame the labels are substituted into. */
export const HYPOTHESIS_TEMPLATE = "This web page is about {}.";

/**
 * bart-large-mnli truncates at 1024 tokens, and the premise is the page text.
 * ~4 chars/token, minus room for the hypothesis, and cut well short of the
 * limit anyway: the signal for "what is this page about" is overwhelmingly in
 * the title and opening, and every extra character is paid 13 times over
 * (once per candidate label).
 */
export const MAX_INPUT_CHARS = 1200;

/**
 * Confidence gates. Below either one the tier abstains (returns null) and B1
 * escalates to tier 2 rather than committing to a coin flip.
 *
 * MIN_SCORE alone is not enough: softmax over 13 labels makes 0.45 vs 0.44 a
 * near-tie that still clears a 0.40 floor, and the resulting category is
 * noise. MIN_MARGIN is what rejects that — the top label has to actually
 * separate from the runner-up.
 */
export const DEFAULT_MIN_SCORE = 0.45;
export const DEFAULT_MIN_MARGIN = 0.10;

/** Matches B1/B2's own LLM timeout, for the same reason: never stall a page. */
export const DEFAULT_TIMEOUT_MS = 8000;

const LABEL_TO_CATEGORY = new Map(
  Object.entries(CATEGORY_HYPOTHESES).map(([category, label]) => [label, category])
);

/**
 * assertLabelCoverage — throws if CATEGORY_HYPOTHESES and the caller's
 * category list have drifted apart. Called by the tests with
 * Object.keys(CATEGORY_KEYWORDS), not at import time: a missing hypothesis is
 * a source-level mistake worth failing a test run over, not a reason to take
 * down the extension at load.
 *
 * @param {string[]} categories  the authoritative category names (B1's)
 */
export function assertLabelCoverage(categories) {
  const hypotheses = Object.keys(CATEGORY_HYPOTHESES);
  const missing = categories.filter((c) => !hypotheses.includes(c));
  const extra = hypotheses.filter((h) => !categories.includes(h));
  if (missing.length || extra.length) {
    throw new Error(
      `Zero-shot label set has drifted from the B1 category list — ` +
      `missing hypotheses for [${missing.join(", ")}], ` +
      `unknown categories [${extra.join(", ")}]`
    );
  }
  return true;
}

/** The candidate labels, in CATEGORY_KEYWORDS order. */
export function zeroShotLabels() {
  return Object.values(CATEGORY_HYPOTHESES);
}

/**
 * buildZeroShotInput — the premise the model classifies.
 *
 * Title first and keywords last, because truncation cuts from the end: on a
 * long page the title is the single highest-signal string available and must
 * never be the part that gets dropped.
 */
export function buildZeroShotInput({ title = "", summary = "", keywords = [] } = {}) {
  const parts = [];
  if (title) parts.push(String(title).trim());
  if (summary) parts.push(String(summary).trim());
  if (keywords.length) parts.push(`Keywords: ${keywords.slice(0, 12).join(", ")}`);
  return parts.join(". ").replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS);
}

/**
 * normaliseZeroShotConfig — accepts the shape configureFeatureB stores.
 * @param {Object} config
 *   { enabled?, backend?, serviceUrl?, model?, classify?, minScore?, minMargin?, timeoutMs? }
 */
export function normaliseZeroShotConfig(config = {}) {
  return {
    enabled:    config.enabled ?? false,
    backend:    config.backend ?? (typeof config.classify === "function" ? "local" : "proxy"),
    serviceUrl: config.serviceUrl ?? "http://localhost:8078/v1/zero-shot",
    model:      config.model ?? DEFAULT_ZERO_SHOT_MODEL,
    classify:   typeof config.classify === "function" ? config.classify : null,
    minScore:   Number.isFinite(config.minScore) ? config.minScore : DEFAULT_MIN_SCORE,
    minMargin:  Number.isFinite(config.minMargin) ? config.minMargin : DEFAULT_MIN_MARGIN,
    timeoutMs:  Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * parseZeroShotResult — validate a { labels, scores } payload from either
 * backend and reduce it to the winning category plus its margin.
 *
 * Deliberately does not assume the arrays are sorted (HF's pipeline sorts
 * descending, transformers.js does too, but a proxy that batches or re-serialises
 * is one refactor away from not) and ignores any label that isn't one of ours.
 *
 * @returns {{ category: string, score: number, margin: number, runnerUp: string|null }|null}
 */
export function parseZeroShotResult(raw) {
  const labels = raw?.labels;
  const scores = raw?.scores;
  if (!Array.isArray(labels) || !Array.isArray(scores) || labels.length === 0) return null;
  if (labels.length !== scores.length) return null;

  const ranked = labels
    .map((label, i) => ({ category: LABEL_TO_CATEGORY.get(label) ?? null, score: Number(scores[i]) }))
    .filter((r) => r.category !== null && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;

  const top = ranked[0];
  const runnerUp = ranked[1] ?? null;
  return {
    category: top.category,
    score: top.score,
    margin: runnerUp ? top.score - runnerUp.score : top.score,
    runnerUp: runnerUp?.category ?? null,
  };
}

/**
 * callZeroShotProxy — POST to the classify container's /v1/zero-shot.
 * Same graceful-failure contract as B1's LLM call: null on anything unexpected.
 */
async function callZeroShotProxy({ text, labels, model, serviceUrl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(serviceUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        text,
        labels,
        hypothesis_template: HYPOTHESIS_TEMPLATE,
        multi_label: false,
      }),
    });
    if (!res.ok) throw new Error(`zero-shot proxy ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * withTimeout — the local backend runs in another context (a Worker, over
 * chrome.runtime messaging), and a worker that dies mid-load never answers at
 * all. Without this the whole B pipeline waits on it forever and no music
 * ever changes; B1's own LLM tier has the same guard for the same reason.
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * classifyCategoryZeroShot — the tier itself.
 *
 * @param {{title?: string, summary?: string, keywords?: string[]}} content
 * @param {Object} config  see normaliseZeroShotConfig
 * @returns {Promise<{category, score, margin, runnerUp, ms, model, backend}|null>}
 *   null when the tier is disabled, unavailable, or not confident enough —
 *   B1 then escalates to tier 2 exactly as it did before this tier existed.
 */
export async function classifyCategoryZeroShot(content, config = {}) {
  const cfg = normaliseZeroShotConfig(config);
  if (!cfg.enabled) return null;
  if (cfg.backend === "local" && !cfg.classify) {
    console.warn("[B1.5] zero-shot backend is 'local' but no classify() was injected — skipping tier");
    return null;
  }

  const text = buildZeroShotInput(content);
  // An empty premise scores every label identically; the margin gate would
  // reject it anyway, but there is no reason to spend 13 forward passes
  // finding that out.
  if (text.length < 20) return null;

  const labels = zeroShotLabels();
  const startedAt = Date.now();

  try {
    const raw = cfg.backend === "local"
      ? await withTimeout(
          cfg.classify({ text, labels, hypothesisTemplate: HYPOTHESIS_TEMPLATE, model: cfg.model }),
          cfg.timeoutMs,
          "[B1.5] local zero-shot"
        )
      : await callZeroShotProxy({ text, labels, model: cfg.model, serviceUrl: cfg.serviceUrl, timeoutMs: cfg.timeoutMs });

    const parsed = parseZeroShotResult(raw);
    const ms = Date.now() - startedAt;
    if (!parsed) {
      console.warn("[B1.5] zero-shot returned an unusable payload — falling through to the LLM tier");
      return null;
    }

    if (parsed.score < cfg.minScore || parsed.margin < cfg.minMargin) {
      // Not a failure — this is the tier doing its job. Logged at debug
      // volume via console.debug so a run can be audited for how often the
      // abstain path fires (that rate is the §Results ablation number).
      console.debug(
        `[B1.5] abstained: ${parsed.category} score=${parsed.score.toFixed(3)} ` +
        `margin=${parsed.margin.toFixed(3)} (need >=${cfg.minScore}/${cfg.minMargin}) in ${ms}ms`
      );
      return null;
    }

    return { ...parsed, ms, model: cfg.model, backend: cfg.backend };
  } catch (err) {
    console.warn(`[B1.5] zero-shot classification failed (${err.message}) — falling through to the LLM tier`);
    return null;
  }
}

// ─── Sensitivity entailment (§5.1 / §5.5 fix) ────────────────────────────────
// checkSensitiveContent() in b1_contentUnderstanding.js is a fixed ~18-term
// English keyword list with no escalation tier of its own — unlike category
// classification above, a page it can't match just silently comes back "not
// sensitive". That's the false-negative half of the bug: euphemism ("ending
// it all"), vocabulary outside the list entirely (addiction, miscarriage, a
// terminal diagnosis), and anything non-English (the list is English words,
// so a Spanish suicide-prevention page has nothing to match) all pass
// through undetected. The false-positive half is the same list cutting the
// other way: a single clinical term ("anorexia nervosa" in a psychology
// textbook) or two ordinary words landing together in unrelated writing
// ("grief" + "bereavement" in a degree-programme listing) can trigger it.
//
// This reuses the exact same entailment model/backends as the category tier
// above — "already loaded", nothing new to deploy — scored against two
// contrastive hypotheses instead of 13 category ones. Off unless configured,
// never throws, and — like the category tier — never sends anything to the
// Groq tier-2 LLM, so b2_moodClassifier.js's "sensitive text never leaves
// the device" guarantee is unaffected by this fix.
export const SENSITIVITY_HYPOTHESES = {
  crisis: "someone's own personal experience of, or a direct appeal for "
    + "help with, suicide, self-harm, abuse, violence, addiction, a serious "
    + "or terminal illness, pregnancy loss, or acute grief",
  reference: "an academic, clinical, historical, or news discussion of a "
    + "difficult topic, not a personal crisis",
};

/**
 * Calibrated separately from DEFAULT_MIN_SCORE/MARGIN above: this is a
 * two-way contrastive decision, not a 13-way softmax, so the score
 * distribution isn't the same shape and shouldn't share thresholds by
 * accident.
 */
export const DEFAULT_SENSITIVITY_MIN_SCORE = 0.45;
export const DEFAULT_SENSITIVITY_MIN_MARGIN = 0.08;

function sensitivityLabels() {
  return [SENSITIVITY_HYPOTHESES.crisis, SENSITIVITY_HYPOTHESES.reference];
}

/**
 * parseSensitivityResult — like parseZeroShotResult, but there are always
 * exactly two sides, so the caller just needs to know which one won and by
 * how much rather than a full ranking.
 */
export function parseSensitivityResult(raw) {
  const labels = raw?.labels;
  const scores = raw?.scores;
  if (!Array.isArray(labels) || !Array.isArray(scores) || labels.length === 0) return null;
  if (labels.length !== scores.length) return null;

  const crisisIdx = labels.indexOf(SENSITIVITY_HYPOTHESES.crisis);
  const refIdx = labels.indexOf(SENSITIVITY_HYPOTHESES.reference);
  if (crisisIdx === -1 || refIdx === -1) return null;

  const crisisScore = Number(scores[crisisIdx]);
  const refScore = Number(scores[refIdx]);
  if (!Number.isFinite(crisisScore) || !Number.isFinite(refScore)) return null;

  return {
    side: crisisScore >= refScore ? "crisis" : "reference",
    score: Math.max(crisisScore, refScore),
    margin: Math.abs(crisisScore - refScore),
  };
}

/**
 * classifySensitivityZeroShot — the tier itself. Same contract as
 * classifyCategoryZeroShot: disabled, unavailable, or unconfident all return
 * null and the caller keeps whatever the keyword tier already decided.
 *
 * @param {{title?, summary?, keywords?}} content  same shape as the category tier
 * @param {Object} config  same shape as normaliseZeroShotConfig — the
 *   backend/model/timeout are reused as-is from whatever the caller already
 *   has configured for the category tier (same running service). Score/
 *   margin gates default to this tier's own constants rather than the
 *   category tier's, but can be overridden via config.sensitivityMinScore /
 *   config.sensitivityMinMargin.
 * @returns {Promise<{side: "crisis"|"reference", score, margin, ms, model, backend}|null>}
 */
export async function classifySensitivityZeroShot(content, config = {}) {
  const cfg = normaliseZeroShotConfig(config);
  if (!cfg.enabled) return null;
  if (cfg.backend === "local" && !cfg.classify) {
    console.warn("[B1.5-sensitivity] backend is 'local' but no classify() was injected — skipping tier");
    return null;
  }

  const text = buildZeroShotInput(content);
  if (text.length < 20) return null;

  const minScore = Number.isFinite(config.sensitivityMinScore) ? config.sensitivityMinScore : DEFAULT_SENSITIVITY_MIN_SCORE;
  const minMargin = Number.isFinite(config.sensitivityMinMargin) ? config.sensitivityMinMargin : DEFAULT_SENSITIVITY_MIN_MARGIN;

  const labels = sensitivityLabels();
  const startedAt = Date.now();

  try {
    const raw = cfg.backend === "local"
      ? await withTimeout(
          cfg.classify({ text, labels, hypothesisTemplate: HYPOTHESIS_TEMPLATE, model: cfg.model }),
          cfg.timeoutMs,
          "[B1.5-sensitivity] local zero-shot"
        )
      : await callZeroShotProxy({ text, labels, model: cfg.model, serviceUrl: cfg.serviceUrl, timeoutMs: cfg.timeoutMs });

    const parsed = parseSensitivityResult(raw);
    const ms = Date.now() - startedAt;
    if (!parsed) {
      console.warn("[B1.5-sensitivity] zero-shot returned an unusable payload — keeping the keyword verdict");
      return null;
    }
    if (parsed.score < minScore || parsed.margin < minMargin) {
      console.debug(
        `[B1.5-sensitivity] abstained: ${parsed.side} score=${parsed.score.toFixed(3)} ` +
        `margin=${parsed.margin.toFixed(3)} (need >=${minScore}/${minMargin}) in ${ms}ms`
      );
      return null;
    }
    return { side: parsed.side, score: parsed.score, margin: parsed.margin, ms, model: cfg.model, backend: cfg.backend };
  } catch (err) {
    console.warn(`[B1.5-sensitivity] zero-shot classification failed (${err.message}) — keeping the keyword verdict`);
    return null;
  }
}
