/**
 * record_integration_fixture.js — runs the REAL Feature A → Feature B
 * pipeline on a sample page and saves the genuine Handoff-2 output as a
 * fixture, so the audio-generation integration test can feed real B output
 * into validate_profile() instead of a hand-typed guess at the contract
 * shape (the same golden-fixture philosophy as record_groq_fixtures.js).
 *
 * Only the LLM call and the embedder are mocked (no network/model needed to
 * run this); everything else -- text extraction, colour extraction,
 * behaviour, B1/B2/B3/B4 -- runs for real, on real jsdom-rendered HTML.
 *
 * Run:
 *   cd mood-classification
 *   node manual_tests/record_integration_fixture.js
 *
 * Re-run whenever Feature A's Handoff-1 shape or Feature B's Handoff-2 shape
 * changes, so the fixture (and the contract it's pinning) stays current.
 */

import { JSDOM } from "jsdom";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// A page clearly in one content category (Educational -- science/research
// vocabulary clears MIN_CATEGORY_HITS=3 on its own) so tier-1 classification
// resolves deterministically without needing the LLM at all for B1. Neutral,
// unhurried tone so the "expected" mood isn't ambiguous either.
const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>How Photosynthesis Works — A Study Guide</title>
  <meta name="description" content="A tutorial explaining the science and biology behind how plants convert light into energy, for students studying botany.">
</head>
<body style="background-color: rgb(240,245,235)">
  <nav class="site-nav"><a href="/">Home</a></nav>
  <article class="post-body" style="background-color: rgb(90, 140, 90)">
    <h1>How Photosynthesis Works</h1>
    <p>This tutorial explains the biology and chemistry behind photosynthesis,
       the process plants use to convert light into chemical energy. Understanding
       this process is a core part of any introductory biology course or science
       curriculum, and forms the basis for further study in botany and ecology.</p>
    <p>Researchers and scientists have studied this process for centuries.
       A professor teaching an academic course on plant biology would explain
       that chlorophyll, found in the chloroplast, absorbs light energy during
       this process. This experiment-based understanding is now foundational
       knowledge taught in every classroom and university biology curriculum.</p>
  </article>
  <footer class="site-footer">Educational content for students.</footer>
</body>
</html>`;

const dom = new JSDOM(PAGE_HTML, { url: "https://learn.example.com/photosynthesis" });
const win = dom.window;
global.window = win;
global.document = win.document;
win.innerWidth = 1280;
win.innerHeight = 800;

win.Element.prototype.getBoundingClientRect = function () {
  if (this.tagName === "ARTICLE") return rect(1000, 700);
  if (this.tagName === "BODY") return rect(1280, 800);
  return rect(0, 0);
};
function rect(w, h) {
  return { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
}

// Deterministic mock embedder (same pattern as data-extraction/playground.js)
win.transformersPipeline = async function () {
  return async function (text) {
    const dims = 8;
    const vec = new Array(dims).fill(0);
    for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return { data: vec.map((v) => v / norm) };
  };
};

// A calm-reading behaviour profile: moderate scroll, slow cursor -- avoids
// tipping into "tense"/doomscrolling territory, matching the page's actual
// unhurried, studious tone.
const behaviorTracker = { snapshot: () => ({ scrollSpeed: 120, cursorSpeed: 80 }) };

// Deterministic LLM mock, in case either B1 or B2 escalates to tier-2 anyway
// (e.g. if tier-1 confidence doesn't clear threshold on this exact wording).
// Matches the OpenAI-compatible shape both callCategoryLLMClassifier and
// callLLMClassifier expect (see feature_b_test.js's existing mocks).
global.fetch = async (url) => {
  const isCategoryCall = String(url).includes("category") || true; // both calls hit the same Groq URL; disambiguate via response shape both can parse
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            category: "Educational",
            mood: "focused",
            pageType: "educational",
            intent: "learning",
            confidence: 0.9,
            energyHint: 0.3,
            valenceHint: 0.4,
          }),
        },
      }],
    }),
  };
};

async function main() {
  const { buildPageData } = require("../../data-extraction/pageData.js");
  const { configureFeatureB, runFeatureB } = await import("../feature_b/index.js");

  // Resolve immediately on the first call instead of needing to wait out
  // the real confidence window (same knob PR #1's tests use).
  configureFeatureB({ confidenceWindowMs: 0, apiKey: "fake-key-for-fixture-generation" });

  const pageData = await buildPageData({
    doc: win.document,
    embeddingConfig: { backend: "local" },
    behaviorTracker,
    useCache: false,
  });

  console.log("Feature A output (Handoff-1):");
  console.log("  title:", pageData.title);
  console.log("  wordCount:", pageData.wordCount);
  console.log("  colors:", JSON.stringify(pageData.colors));

  const handoff2First = await runFeatureB(pageData, "fixture-tab");
  if (handoff2First !== null) {
    throw new Error(
      "runFeatureB resolved on the FIRST call -- expected null (a mood only " +
      "becomes 'current' on a second, confirming call, even at confidenceWindowMs: 0). " +
      "Something about decideTransition's logic changed -- update this script."
    );
  }
  const handoff2 = await runFeatureB(pageData, "fixture-tab");

  if (!handoff2) {
    throw new Error(
      "runFeatureB returned null -- the confidence window didn't resolve. " +
      "Check configureFeatureB({ confidenceWindowMs: 0 }) took effect."
    );
  }

  console.log("\nFeature B output (Handoff-2):");
  console.log("  profile.mood:", handoff2.profile?.mood);
  console.log("  profile.content_category:", handoff2.profile?.content_category);
  console.log("  profile.arousal:", handoff2.profile?.arousal);
  console.log("  profile.valence:", handoff2.profile?.valence);
  console.log("  profile.atmosphere_tags:", handoff2.profile?.atmosphere_tags);
  console.log("  profile.listening_context:", handoff2.profile?.listening_context);
  console.log("  profile.time_of_day:", handoff2.profile?.time_of_day);
  console.log("  profile.sensitive_override:", handoff2.profile?.sensitive_override);
  console.log("  prompt:", handoff2.prompt);

  const FIXTURES_DIR = join(__dirname, "..", "fixtures");
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const outPath = join(FIXTURES_DIR, "integration_handoff2_sample.json");
  writeFileSync(outPath, JSON.stringify(handoff2, null, 2) + "\n");
  console.log(`\nSaved fixture: ${outPath}`);
}

main().catch((err) => {
  console.error("Failed to generate fixture:", err);
  process.exit(1);
});
