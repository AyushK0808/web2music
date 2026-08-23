/**
 * Feature B — B1 sensitivity zero-shot tier (§5.1 / §5.5 fix)
 * Run with: node b1_sensitivity_test.js
 *
 * Kept out of feature_b_test.js for the same reason b1_zeroShot_test.js is:
 * this file stubs global.fetch, feature_b_test.js installs/tears down a
 * global.chrome fake, and the two would trip over each other.
 *
 * What's being pinned down:
 *   - classifySensitivityZeroShot has the same "disabled/unavailable/
 *     unconfident all return null, never throws" contract as the category
 *     tier it's modelled on.
 *   - resolveSensitivity() is a strict no-op when zero-shot is disabled —
 *     it must reproduce checkSensitiveContent()'s verdict exactly, since
 *     that's the tier's real-world default until a service is deployed.
 *   - the promotion/demotion cascade logic is correct: given a zero-shot
 *     backend that reads crisis-vs-reference framing correctly, every
 *     documented failure case in analysis/audit/sensitive_slice.json
 *     (the false negatives AND false positives the checklist names by id)
 *     resolves correctly. This proves the mechanism, not the real model's
 *     accuracy — that needs a live entailment service, which this repo
 *     doesn't have running in this environment (see t5_audit.mjs's
 *     --with-zero-shot flag for how to measure it once one is up).
 *   - a hard-severe term (suicide, self-harm, sexual assault, domestic
 *     violence, terrorism, mass shooting) is never demoted, even if the
 *     zero-shot backend disagrees — the one-way safety floor.
 */

import { strict as assert } from "assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENSITIVITY_HYPOTHESES,
  DEFAULT_SENSITIVITY_MIN_SCORE,
  DEFAULT_SENSITIVITY_MIN_MARGIN,
  parseSensitivityResult,
  classifySensitivityZeroShot,
} from "./feature_b/b1_zeroShotCategory.js";
import { checkSensitiveContent, resolveSensitivity, runB1 } from "./feature_b/b1_contentUnderstanding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** A local backend that always answers with the given { labels, scores } payload. */
const answering = (p) => async () => p;

function sidePayload(side, { score = 0.8, otherScore = 0.1 } = {}) {
  const winner = side === "crisis" ? SENSITIVITY_HYPOTHESES.crisis : SENSITIVITY_HYPOTHESES.reference;
  const loser = side === "crisis" ? SENSITIVITY_HYPOTHESES.reference : SENSITIVITY_HYPOTHESES.crisis;
  return { labels: [winner, loser], scores: [score, otherScore] };
}

// ── parseSensitivityResult ────────────────────────────────────────────────

console.log("sensitivity: parseSensitivityResult picks the higher-scoring side");
{
  const parsed = parseSensitivityResult(sidePayload("crisis", { score: 0.7, otherScore: 0.2 }));
  assert.equal(parsed.side, "crisis");
  assert(Math.abs(parsed.margin - 0.5) < 1e-9);
}

console.log("sensitivity: parseSensitivityResult rejects a payload missing either hypothesis");
assert.equal(
  parseSensitivityResult({ labels: [SENSITIVITY_HYPOTHESES.crisis], scores: [0.9] }),
  null,
);
assert.equal(parseSensitivityResult(null), null);
assert.equal(parseSensitivityResult({}), null);

// ── classifySensitivityZeroShot: same contract as the category tier ────────

const CONTENT = { title: "I don't want to be here anymore", summary: "Some nights I think about ending it all.", keywords: [] };

console.log("sensitivity: disabled by default — no backend is ever touched");
{
  let called = false;
  assert.equal(
    await classifySensitivityZeroShot(CONTENT, { classify: async () => { called = true; return {}; } }),
    null,
  );
  assert.equal(called, false);
}

console.log("sensitivity: a confident crisis result is returned");
{
  const r = await classifySensitivityZeroShot(CONTENT, {
    enabled: true,
    classify: answering(sidePayload("crisis", { score: 0.75, otherScore: 0.1 })),
  });
  assert.equal(r.side, "crisis");
  assert.equal(r.backend, "local");
}

console.log("sensitivity: abstains below the score floor");
assert.equal(
  await classifySensitivityZeroShot(CONTENT, {
    enabled: true,
    classify: answering(sidePayload("crisis", { score: 0.3, otherScore: 0.25 })),
  }),
  null,
);

console.log("sensitivity: abstains on a near-tie even when the score clears the floor");
assert.equal(
  await classifySensitivityZeroShot(CONTENT, {
    enabled: true,
    classify: answering(sidePayload("crisis", { score: 0.5, otherScore: 0.48 })),
  }),
  null,
  "0.50 vs 0.48 is a coin flip",
);

console.log("sensitivity: thresholds are independently overridable from the category tier's");
{
  const r = await classifySensitivityZeroShot(CONTENT, {
    enabled: true,
    sensitivityMinScore: 0.1,
    sensitivityMinMargin: 0.01,
    classify: answering(sidePayload("crisis", { score: 0.5, otherScore: 0.48 })),
  });
  assert.equal(r.side, "crisis");
}
assert.equal(DEFAULT_SENSITIVITY_MIN_SCORE, 0.45);
assert.equal(DEFAULT_SENSITIVITY_MIN_MARGIN, 0.08);

console.log("sensitivity: a backend that throws degrades to null, never propagates");
assert.equal(
  await classifySensitivityZeroShot(CONTENT, { enabled: true, classify: async () => { throw new Error("worker died"); } }),
  null,
);

console.log("sensitivity: a page with almost no text is skipped before spending a forward pass");
{
  let spent = false;
  assert.equal(
    await classifySensitivityZeroShot({ title: "Hi" }, { enabled: true, classify: async () => { spent = true; return sidePayload("crisis"); } }),
    null,
  );
  assert.equal(spent, false);
}

console.log("sensitivity: the proxy backend POSTs exactly the two contrastive labels");
{
  const seen = {};
  global.fetch = async (url, opts) => {
    seen.url = url;
    seen.body = JSON.parse(opts.body);
    return { ok: true, json: async () => sidePayload("reference", { score: 0.6, otherScore: 0.2 }) };
  };
  const r = await classifySensitivityZeroShot(CONTENT, { enabled: true, backend: "proxy", serviceUrl: "http://localhost:8078/v1/zero-shot" });
  assert.equal(r.side, "reference");
  assert.deepEqual(seen.body.labels.sort(), [SENSITIVITY_HYPOTHESES.crisis, SENSITIVITY_HYPOTHESES.reference].sort());
  delete global.fetch;
}

// ── resolveSensitivity: disabled tier is a strict no-op ─────────────────────

console.log("cascade: zero-shot disabled -> resolveSensitivity matches checkSensitiveContent exactly");
{
  const texts = [
    "If you are having thoughts of suicide, help is available.",
    "The Great Depression began with the 1929 crash. Unemployment reached twenty-five percent and the resulting economic depression reshaped a generation of policy.",
    "A master's in grief counselling prepares graduates for hospice and bereavement work.",
    "Blister the tomatoes in olive oil until they collapse.",
  ];
  for (const text of texts) {
    const direct = checkSensitiveContent(text);
    const resolved = await resolveSensitivity(text, { title: "", summary: text, keywords: [] }, {});
    assert.equal(resolved.isSensitive, direct, `mismatch for: ${text.slice(0, 40)}...`);
    assert.equal(resolved.zeroShot, null);
  }
}

// ── cascade: promotion / demotion / hard-severe floor ───────────────────────

console.log("cascade: keyword-negative + confident zero-shot crisis -> promoted");
{
  const text = "Some nights I think about ending it all. I just want the noise to stop.";
  assert.equal(checkSensitiveContent(text), false, "precondition: keyword tier finds nothing here");
  const r = await resolveSensitivity(text, { title: "", summary: text, keywords: [] }, {
    zeroShot: { enabled: true, classify: answering(sidePayload("crisis", { score: 0.7, otherScore: 0.15 })) },
  });
  assert.equal(r.isSensitive, true);
  assert.equal(r.source, "zero-shot-promoted");
}

console.log("cascade: keyword-negative + zero-shot abstains -> stays not-sensitive");
{
  const text = "Some nights I think about ending it all.";
  const r = await resolveSensitivity(text, { title: "", summary: text, keywords: [] }, {
    zeroShot: { enabled: true, classify: answering(sidePayload("crisis", { score: 0.3, otherScore: 0.25 })) },
  });
  assert.equal(r.isSensitive, false);
  assert.equal(r.source, "keyword-declined");
}

console.log("cascade: ambiguous-tier keyword-positive + confident zero-shot reference -> demoted");
{
  const text = "A master's in grief counselling prepares graduates for hospice and bereavement work.";
  assert.equal(checkSensitiveContent(text), true, "precondition: 2 ambiguous hits (grief, bereavement) trip the keyword tier");
  const r = await resolveSensitivity(text, { title: "", summary: text, keywords: [] }, {
    zeroShot: { enabled: true, classify: answering(sidePayload("reference", { score: 0.65, otherScore: 0.2 })) },
  });
  assert.equal(r.isSensitive, false);
  assert.equal(r.source, "zero-shot-demoted");
}

console.log("cascade: demotable-severe (eating-disorder term) keyword-positive + reference -> demoted");
{
  const text = "This chapter surveys the diagnostic criteria for anorexia nervosa, prevalence by cohort, and family-based treatment.";
  assert.equal(checkSensitiveContent(text), true, "precondition: 'anorexia' trips the severe-term keyword tier");
  const r = await resolveSensitivity(text, { title: "", summary: text, keywords: [] }, {
    zeroShot: { enabled: true, classify: answering(sidePayload("reference", { score: 0.7, otherScore: 0.1 })) },
  });
  assert.equal(r.isSensitive, false);
  assert.equal(r.source, "zero-shot-demoted");
}

console.log("cascade: HARD severe term is never demoted, even if zero-shot disagrees");
{
  const text = "If you are having thoughts of suicide, help is available day and night.";
  const r = await resolveSensitivity(text, { title: "", summary: text, keywords: [] }, {
    zeroShot: { enabled: true, classify: answering(sidePayload("reference", { score: 0.9, otherScore: 0.05 })) },
  });
  assert.equal(r.isSensitive, true, "a hard-severe hit must survive even a confident (wrong) 'reference' verdict");
  assert.equal(r.source, "keyword-hard-severe");
}

// ── Full sweep: every documented FN/FP in the adversarial slice ─────────────

console.log("cascade: the full C-11 adversarial slice resolves correctly given a correct entailment backend");
{
  const slice = JSON.parse(fs.readFileSync(path.join(__dirname, "../analysis/audit/sensitive_slice.json"), "utf8"));

  for (const page of slice.pages) {
    const text = `${page.text} ${page.title}`;
    // An "ideal" backend: crisis wins confidently for genuinely sensitive
    // pages, reference wins confidently otherwise. This is the assumption
    // being tested — that IF entailment correctly reads crisis-vs-reference
    // framing, the cascade above turns that into the right verdict for
    // every case the checklist named (euphemism, outside-vocabulary,
    // non-English, and the clinical/academic/engineering false positives).
    const idealSide = page.sensitive ? "crisis" : "reference";
    const classify = answering(sidePayload(idealSide, { score: 0.8, otherScore: 0.1 }));

    const r = await resolveSensitivity(text, { title: page.title, summary: page.text, keywords: [] }, {
      zeroShot: { enabled: true, classify },
    });
    assert.equal(
      r.isSensitive, page.sensitive,
      `${page.id} [${page.slice}]: expected sensitive=${page.sensitive}, got ${r.isSensitive} (source=${r.source})`,
    );
  }
  console.log(`  all ${slice.pages.length} pages in the adversarial slice resolve correctly (0 FN, 0 FP)`);
}

// ── runB1 integration ────────────────────────────────────────────────────

console.log("runB1: zero-shot disabled by default -> isSensitive matches the old keyword-only behaviour");
{
  const pageData = {
    rawText: "Some nights I think about ending it all. I don't have a plan exactly, I just want the noise to stop.",
    title: "I don't want to be here anymore", description: "", url: "https://example.com/post", lang: "en",
  };
  const result = await runB1(pageData, "");
  assert.equal(result.isSensitive, false, "euphemism must NOT be caught without the zero-shot tier enabled — this is the documented, unchanged default");
  assert.equal(result.sensitivitySource, "keyword-declined");
}

console.log("runB1: zero-shot enabled -> euphemism is caught and category/mood LLMs are still skipped");
{
  const pageData = {
    rawText: "Some nights I think about ending it all. I don't have a plan exactly, I just want the noise to stop.",
    title: "I don't want to be here anymore", description: "", url: "https://example.com/post", lang: "en",
  };
  const result = await runB1(pageData, "", {
    zeroShot: { enabled: true, classify: answering(sidePayload("crisis", { score: 0.8, otherScore: 0.1 })) },
  });
  assert.equal(result.isSensitive, true);
  assert.equal(result.sensitivitySource, "zero-shot-promoted");
  assert.equal(result.category.source, "skipped-sensitive", "a promoted-sensitive page must still skip the category LLM");
}

console.log("\nAll b1_sensitivity_test.js assertions passed.");
