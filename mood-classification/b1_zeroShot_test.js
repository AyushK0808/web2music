/**
 * Feature B — B1.5 zero-shot page-type classifier (bart-large-mnli)
 * Run with: node b1_zeroShot_test.js
 *
 * Kept out of feature_b_test.js because that file installs and tears down a
 * `global.chrome` fake for its integration section; this one stubs
 * `global.fetch` instead and the two would trip over each other.
 *
 * The properties worth pinning:
 *   - the tier abstains rather than guessing (score AND margin gates), which
 *     is the entire reason it can sit in front of the LLM tier safely;
 *   - it never throws, whatever the backend does — B1 must always reach its
 *     next tier;
 *   - the cascade order and the `source` label, which is what the paper's
 *     tier-usage breakdown is computed from.
 */

import { strict as assert } from "assert";
import {
  CATEGORY_HYPOTHESES,
  HYPOTHESIS_TEMPLATE,
  DEFAULT_ZERO_SHOT_MODEL,
  MAX_INPUT_CHARS,
  assertLabelCoverage,
  zeroShotLabels,
  buildZeroShotInput,
  parseZeroShotResult,
  normaliseZeroShotConfig,
  classifyCategoryZeroShot,
} from "./feature_b/b1_zeroShotCategory.js";
import { CATEGORY_KEYWORDS, resolveContentCategory, runB1 } from "./feature_b/b1_contentUnderstanding.js";

/** Build a { labels, scores } payload from a category → score map. */
function payload(scoresByCategory) {
  const entries = Object.entries(scoresByCategory);
  return {
    labels: entries.map(([c]) => CATEGORY_HYPOTHESES[c]),
    scores: entries.map(([, s]) => s),
  };
}

/** A local backend that always answers with the given payload. */
const answering = (p) => async () => p;

// ── Label set ───────────────────────────────────────────────────────────────

console.log("B1.5: every B1 category has a hypothesis phrase, and no extras");
assertLabelCoverage(Object.keys(CATEGORY_KEYWORDS));
assert.equal(zeroShotLabels().length, Object.keys(CATEGORY_KEYWORDS).length);

console.log("B1.5: assertLabelCoverage actually fails on drift");
assert.throws(() => assertLabelCoverage([...Object.keys(CATEGORY_KEYWORDS), "Cryptozoology"]), /missing hypotheses/);

console.log("B1.5: hypotheses are sentence fragments, not bare category names");
for (const [category, phrase] of Object.entries(CATEGORY_HYPOTHESES)) {
  assert(phrase.length > category.length, `${category}: "${phrase}" is no more informative than the label`);
  assert.equal(phrase, phrase.toLowerCase(), `${category}: hypothesis should read as lowercase prose`);
}
assert(HYPOTHESIS_TEMPLATE.includes("{}"), "the template must have a substitution slot");
assert.equal(DEFAULT_ZERO_SHOT_MODEL, "facebook/bart-large-mnli");

// ── Input construction ──────────────────────────────────────────────────────

console.log("B1.5: buildZeroShotInput puts the title first and keywords last");
const input = buildZeroShotInput({
  title: "Sourdough starter troubleshooting",
  summary: "Why your starter is not rising.",
  keywords: ["flour", "hydration", "levain"],
});
assert(input.startsWith("Sourdough starter troubleshooting"));
assert(input.includes("Keywords: flour, hydration, levain"));

console.log("B1.5: buildZeroShotInput truncates to the model's premise budget, keeping the title");
const long = buildZeroShotInput({ title: "Important Title", summary: "x".repeat(5000) });
assert.equal(long.length, MAX_INPUT_CHARS);
assert(long.startsWith("Important Title"), "truncation must cut the tail, never the title");

console.log("B1.5: buildZeroShotInput tolerates a completely empty page");
assert.equal(buildZeroShotInput({}), "");
assert.equal(buildZeroShotInput(), "");

// ── Result parsing ──────────────────────────────────────────────────────────

console.log("B1.5: parseZeroShotResult ranks by score regardless of array order");
const parsed = parseZeroShotResult(payload({ Food: 0.2, Health: 0.7, News: 0.1 }));
assert.equal(parsed.category, "Health");
assert.equal(parsed.runnerUp, "Food");
assert(Math.abs(parsed.margin - 0.5) < 1e-9);

console.log("B1.5: parseZeroShotResult ignores labels that aren't ours");
const withJunk = parseZeroShotResult({
  labels: ["something the model made up", CATEGORY_HYPOTHESES.Travel],
  scores: [0.9, 0.1],
});
assert.equal(withJunk.category, "Travel", "an unknown label must not win");

console.log("B1.5: parseZeroShotResult rejects malformed payloads instead of throwing");
for (const bad of [
  null,
  {},
  { labels: [], scores: [] },
  { labels: ["a"], scores: [] },
  { labels: ["only-unknown-labels"], scores: [0.9] },
]) {
  assert.equal(parseZeroShotResult(bad), null, `${JSON.stringify(bad)} should parse to null`);
}

console.log("B1.5: a single label reports its own score as the margin");
const solo = parseZeroShotResult({ labels: [CATEGORY_HYPOTHESES.Legal], scores: [0.8] });
assert.equal(solo.margin, 0.8);
assert.equal(solo.runnerUp, null);

// ── Config ──────────────────────────────────────────────────────────────────

console.log("B1.5: config defaults — disabled, proxy backend, bart-large-mnli");
const defaults = normaliseZeroShotConfig();
assert.equal(defaults.enabled, false);
assert.equal(defaults.backend, "proxy");
assert.equal(defaults.model, DEFAULT_ZERO_SHOT_MODEL);

console.log("B1.5: injecting a classify() implies the local backend");
assert.equal(normaliseZeroShotConfig({ classify: async () => ({}) }).backend, "local");

// ── The tier itself ─────────────────────────────────────────────────────────

const CONTENT = { title: "Gut microbiome enterotypes explained", summary: "What the research says.", keywords: ["microbiome", "bacteria"] };

console.log("B1.5: disabled by default — no backend is ever touched");
let called = false;
assert.equal(
  await classifyCategoryZeroShot(CONTENT, { classify: async () => { called = true; return {}; } }),
  null
);
assert.equal(called, false, "a disabled tier must not call its backend");

console.log("B1.5: a confident, well-separated result is returned");
const confident = await classifyCategoryZeroShot(CONTENT, {
  enabled: true,
  classify: answering(payload({ Health: 0.72, Educational: 0.15, Food: 0.06 })),
});
assert.equal(confident.category, "Health");
assert.equal(confident.backend, "local");
assert(confident.ms >= 0);

console.log("B1.5: abstains below the score floor (top label wins but nothing is confident)");
assert.equal(
  await classifyCategoryZeroShot(CONTENT, {
    enabled: true,
    classify: answering(payload({ Health: 0.20, Educational: 0.05 })),
  }),
  null
);

console.log("B1.5: abstains on a near-tie even when the score clears the floor");
assert.equal(
  await classifyCategoryZeroShot(CONTENT, {
    enabled: true,
    classify: answering(payload({ Health: 0.48, Educational: 0.46 })),
  }),
  null,
  "0.48 vs 0.46 is a coin flip — the margin gate exists for exactly this"
);

console.log("B1.5: thresholds are overridable (the paper's sensitivity sweep needs this)");
const loose = await classifyCategoryZeroShot(CONTENT, {
  enabled: true,
  minScore: 0.1,
  minMargin: 0.01,
  classify: answering(payload({ Health: 0.48, Educational: 0.46 })),
});
assert.equal(loose.category, "Health");

console.log("B1.5: a backend that throws degrades to null, never propagates");
assert.equal(
  await classifyCategoryZeroShot(CONTENT, {
    enabled: true,
    classify: async () => { throw new Error("worker died"); },
  }),
  null
);

console.log("B1.5: a backend that hangs is cut off by the timeout, not awaited forever");
const hangStart = Date.now();
assert.equal(
  await classifyCategoryZeroShot(CONTENT, {
    enabled: true,
    timeoutMs: 60,
    classify: () => new Promise(() => {}),
  }),
  null
);
assert(Date.now() - hangStart < 2000, "the timeout must fire, not the test's patience");

console.log("B1.5: backend 'local' with no classify() is a config error, not a crash");
assert.equal(await classifyCategoryZeroShot(CONTENT, { enabled: true, backend: "local" }), null);

console.log("B1.5: a page with almost no text is skipped before spending 13 forward passes");
let spent = false;
assert.equal(
  await classifyCategoryZeroShot({ title: "Hi" }, {
    enabled: true,
    classify: async () => { spent = true; return payload({ News: 0.9 }); },
  }),
  null
);
assert.equal(spent, false);

console.log("B1.5: the proxy backend POSTs text + labels + template to the configured URL");
{
  const seen = {};
  global.fetch = async (url, opts) => {
    seen.url = url;
    seen.body = JSON.parse(opts.body);
    return { ok: true, json: async () => payload({ Finance: 0.81, News: 0.09 }) };
  };
  const viaProxy = await classifyCategoryZeroShot(
    { title: "Bond yields and the carry trade", summary: "A primer.", keywords: ["yield", "carry"] },
    { enabled: true, backend: "proxy", serviceUrl: "http://localhost:8078/v1/zero-shot" }
  );
  assert.equal(viaProxy.category, "Finance");
  assert.equal(viaProxy.backend, "proxy");
  assert.equal(seen.url, "http://localhost:8078/v1/zero-shot");
  assert.equal(seen.body.model, DEFAULT_ZERO_SHOT_MODEL);
  assert.equal(seen.body.hypothesis_template, HYPOTHESIS_TEMPLATE);
  assert.equal(seen.body.multi_label, false);
  assert.equal(seen.body.labels.length, Object.keys(CATEGORY_HYPOTHESES).length);
  delete global.fetch;
}

console.log("B1.5: a non-200 from the proxy degrades to null");
{
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(
    await classifyCategoryZeroShot(CONTENT, { enabled: true, backend: "proxy" }),
    null
  );
  delete global.fetch;
}

// ── Cascade integration ─────────────────────────────────────────────────────

console.log("cascade: a clear keyword win never reaches the zero-shot tier");
{
  let reached = false;
  const result = await resolveContentCategory(
    ["stock", "invest", "portfolio", "market", "trading"],
    "Finance News",
    "",
    "",
    "en",
    { zeroShot: { enabled: true, classify: async () => { reached = true; return payload({ Travel: 0.99 }); } } }
  );
  assert.equal(result.source, "keyword");
  assert.equal(result.primary, "Finance");
  assert.equal(reached, false, "tier 1.5 must not run when tier 1 already decided");
}

console.log("cascade: below the keyword threshold, zero-shot decides before the LLM is ever called");
{
  const result = await resolveContentCategory(
    ["enterotypes"],
    "Gut microbiome enterotypes explained",
    "What the research says about gut bacteria populations.",
    // A key that would produce a real network call if the LLM tier were reached.
    "fake-key-that-would-error-if-called",
    "en",
    { zeroShot: { enabled: true, classify: answering(payload({ Health: 0.77, Educational: 0.11 })) } }
  );
  assert.equal(result.source, "zero-shot");
  assert.equal(result.primary, "Health");
  assert.equal(result.zeroShot.model, DEFAULT_ZERO_SHOT_MODEL);
  assert(result.zeroShot.margin > 0.6);
}

console.log("cascade: when zero-shot abstains, the LLM tier still runs (and its default still applies)");
{
  const result = await resolveContentCategory(
    ["culture"],
    "Some Article",
    "A summary.",
    "", // no key -> LLM tier declines immediately -> default
    "en",
    { zeroShot: { enabled: true, classify: answering(payload({ Health: 0.30, Educational: 0.29 })) } }
  );
  assert.equal(result.source, "default");
  assert.equal(result.primary, "Entertainment");
}

console.log("cascade: a non-English page skips the keyword tier and lands on zero-shot");
{
  const result = await resolveContentCategory(
    ["recipe", "food", "cook", "kitchen", "bake"], // would be a clean keyword win in English
    "Receta de pan de masa madre",
    "Cómo hacer pan.",
    "",
    "es",
    { zeroShot: { enabled: true, classify: answering(payload({ Food: 0.83, Travel: 0.05 })) } }
  );
  assert.equal(result.source, "zero-shot");
  assert.equal(result.primary, "Food");
}

console.log("cascade: with the tier off, behaviour is byte-for-byte the old two-tier cascade");
{
  const withOpts = await resolveContentCategory(["culture"], "Some Article", "A summary.", "", "en", {});
  const withoutOpts = await resolveContentCategory(["culture"], "Some Article", "A summary.", "", "en");
  assert.deepEqual(withOpts, withoutOpts);
  assert.equal(withOpts.source, "default");
}

console.log("cascade: runB1 threads the tier config through to the category resolver");
{
  // Deliberately vocabulary the keyword tier cannot see: no CATEGORY_KEYWORDS
  // term appears, so tier 1 abstains and tier 1.5 is the one that decides —
  // which is the exact case this tier was added for.
  const cleaned = await runB1(
    {
      rawText: "Researchers grouped human gut bacteria populations into enterotypes, clusters defined by "
        + "which genera dominate. The clustering has been debated ever since it was proposed.",
      title: "Gut microbiome enterotypes explained",
      url: "https://example.com/microbiome",
      lang: "en",
    },
    "",
    { zeroShot: { enabled: true, classify: answering(payload({ Health: 0.88, Educational: 0.04 })) } }
  );
  assert.equal(cleaned.category.source, "zero-shot",
    `expected tier 1.5 to decide, got tier "${cleaned.category.source}" (keywords: ${cleaned.keywords.join(", ")})`);
  assert.equal(cleaned.category.primary, "Health");
}

console.log("cascade: sensitive pages never reach the zero-shot tier either");
{
  let reached = false;
  const cleaned = await runB1(
    {
      rawText: "A guide to recognising suicide warning signs and how to reach a crisis line for help right now.",
      title: "Crisis support",
      url: "https://example.com/help",
      lang: "en",
    },
    "",
    { zeroShot: { enabled: true, classify: async () => { reached = true; return payload({ Health: 0.99 }); } } }
  );
  assert.equal(cleaned.isSensitive, true);
  assert.equal(cleaned.category.source, "skipped-sensitive");
  assert.equal(reached, false, "crisis-page text must not be sent to any classifier backend");
}

console.log("\n✅ All B1.5 zero-shot tests passed.");
