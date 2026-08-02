/**
 * fixture_staleness_test.js — X4 integration plan, Phase 7.2/7.3.
 *
 * The checked-in fixture (fixtures/integration_handoff2_sample.json) is only
 * useful to audio-generation/tests/test_integration_handoff.py as long as its
 * shape matches what the real pipeline produces *today*. A Handoff-2 shape
 * change (a field renamed/added/removed in b4_promptEngineer.js's
 * toFeatureDProfile output) is only caught if someone remembers to re-run
 * record_integration_fixture.js — this test makes that drift fail loudly
 * instead of silently, by running the same real pipeline fresh and diffing
 * key sets against the checked-in fixture.
 *
 * Also covers the Handoff-1 side (7.3, new): buildPageData's real output
 * keys must be a superset of what runB1 actually reads, so a Feature A
 * field rename can't silently start sending B `undefined`.
 *
 * Run: cd mood-classification && node fixture_staleness_test.js
 */

import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";
import assert from "assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>How Photosynthesis Works — A Study Guide</title>
  <meta name="description" content="A tutorial explaining the science and biology behind how plants convert light into energy, for students studying botany.">
</head>
<body style="background-color: rgb(240,245,235)">
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
</body>
</html>`;

const dom = new JSDOM(PAGE_HTML, { url: "https://learn.example.com/photosynthesis" });
const win = dom.window;
global.window = win;
global.document = win.document;
win.innerWidth = 1280;
win.innerHeight = 800;
win.Element.prototype.getBoundingClientRect = function () {
  if (this.tagName === "ARTICLE") return { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 };
  if (this.tagName === "BODY") return { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 };
  return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
};

win.transformersPipeline = async function () {
  return async function (text) {
    const dims = 8;
    const vec = new Array(dims).fill(0);
    for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return { data: vec.map((v) => v / norm) };
  };
};

const behaviorTracker = { snapshot: () => ({ scrollSpeed: 120, cursorSpeed: 80 }) };

global.fetch = async () => ({
  ok: true,
  json: async () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          category: "Educational", mood: "focused", pageType: "educational",
          intent: "learning", confidence: 0.9, energyHint: 0.3, valenceHint: 0.4,
        }),
      },
    }],
  }),
});

async function main() {
  const { buildPageData } = require("../data-extraction/pageData.js");
  const { configureFeatureB, runFeatureB, runB1 } = await import("./feature_b/index.js");

  configureFeatureB({ confidenceWindowMs: 0, apiKey: "fake-key-for-staleness-check" });

  const pageData = await buildPageData({
    doc: win.document,
    embeddingConfig: { backend: "local" },
    behaviorTracker,
    useCache: false,
  });

  // ── 7.3: Handoff-1 contract — buildPageData's keys must be a superset of
  // what runB1 actually reads. Static extraction of runB1's `pageData.<x>`
  // reads would be brittle across refactors; instead, run runB1 for real and
  // require it not to throw / silently coerce due to a missing key.
  const cleaned = await runB1(pageData, { apiKey: "fake-key-for-staleness-check" });
  assert.ok(cleaned && typeof cleaned === "object", "runB1 did not return an object for a real Handoff-1 payload");
  console.log("✅ Handoff-1 contract: buildPageData's output is consumable by runB1");

  // ── 7.2: Handoff-2 fixture staleness — key-set diff against the checked-in fixture.
  const first = await runFeatureB(pageData, "staleness-check-tab");
  assert.strictEqual(first, null, "expected null on first call (confidence window semantics changed?)");
  const fresh = await runFeatureB(pageData, "staleness-check-tab");
  assert.ok(fresh, "runFeatureB returned null on the second call — confidence window didn't resolve");

  const FIXTURE_PATH = join(__dirname, "fixtures", "integration_handoff2_sample.json");
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

  const freshKeys = Object.keys(fresh.profile).sort();
  const fixtureKeys = Object.keys(fixture.profile).sort();

  const missingFromFresh = fixtureKeys.filter((k) => !freshKeys.includes(k));
  const newInFresh = freshKeys.filter((k) => !fixtureKeys.includes(k));

  assert.deepStrictEqual(
    missingFromFresh, [],
    `Handoff-2 profile fields present in the checked-in fixture but no longer produced by the ` +
    `real pipeline: [${missingFromFresh.join(", ")}]. Regenerate the fixture: ` +
    `cd mood-classification && node manual_tests/record_integration_fixture.js`
  );
  assert.deepStrictEqual(
    newInFresh, [],
    `Handoff-2 profile fields produced by the real pipeline but missing from the checked-in ` +
    `fixture: [${newInFresh.join(", ")}]. Regenerate the fixture: ` +
    `cd mood-classification && node manual_tests/record_integration_fixture.js`
  );
  console.log("✅ Handoff-2 fixture staleness: fixture's profile key set matches the live pipeline's output");

  console.log("\n✅ All fixture staleness checks passed.");
}

main().catch((err) => {
  console.error("❌ Fixture staleness check failed:", err.message);
  process.exit(1);
});
