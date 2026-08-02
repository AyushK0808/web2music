/**
 * record_integration_fixtures_multi.js — extends record_integration_fixture.js's
 * golden-fixture approach across several real, distinct pages, so the
 * audio-generation e2e suite (test_full_pipeline_e2e.py) can exercise the
 * real A -> B -> D chain on more than one mood/category combination, plus
 * one intentionally-adversarial case (crisis/sensitive content).
 *
 * Same mocking boundary as record_integration_fixture.js: only the LLM call
 * and the embedder are faked (no network/model needed to run this); text
 * extraction, colour extraction, behaviour signals, and B1-B4 all run for
 * real, on real jsdom-rendered HTML.
 *
 * NOTE: B3's time-of-day/energy computation reads the real clock, so
 * re-running this script will produce slightly different numeric values
 * each time (same non-determinism record_integration_fixture.js has). That's
 * fine -- these fixtures are recorded once and checked into git as static
 * JSON; tests assert against whatever a fixture actually contains, not
 * against hand-typed expected numbers.
 *
 * Run:
 *   cd mood-classification
 *   node manual_tests/record_integration_fixtures_multi.js
 */

import { JSDOM } from "jsdom";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function rect(w, h) {
  return { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
}

// Each page is written to naturally clear MIN_CATEGORY_HITS=3 (content
// category) and land >=4 keyword hits on its intended MOOD_RULES entry, so
// tier-1 classification resolves the mood deterministically without needing
// the LLM mock's fixed response to be "correct" for that page -- the mock
// below only exists as a safety net if tier-1 confidence doesn't clear 0.5.
const PAGES = [
  {
    name: "energetic_fitness",
    url: "https://fit.example.com/hiit-workout",
    bgColor: "rgb(220, 90, 40)", // warm orange -> energetic/joyful bias
    scrollSpeed: 300,
    cursorSpeed: 750, // fast cursor -> energetic bias
    llmMood: "energetic",
    llmCategory: "Health",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>30-Minute HIIT Workout — Full-Body Gym Routine</title>
  <meta name="description" content="A high-intensity gym workout to build power and energy, with fast-paced exercises for peak fitness.">
</head>
<body style="background-color: rgb(255,245,235)">
  <nav class="site-nav"><a href="/">Home</a></nav>
  <article class="post-body" style="background-color: rgb(220, 90, 40)">
    <h1>30-Minute HIIT Workout</h1>
    <p>This gym routine is built for explosive energy and power. Every round pushes your
       adrenaline and momentum higher -- sprint intervals, fast burpees, and an intense final
       surge to failure. Grind through the pump, keep the drive dynamic, and let the workout's
       vigorous pace charge your whole body.</p>
    <p>Trainers recommend this routine for anyone chasing an active, robust fitness level.
       Exercise recovery matters too: this plan balances intensity with health-focused rest so
       your energy stays sustainable across the week, not just one explosive session.</p>
  </article>
  <footer class="site-footer">Fitness content for athletes.</footer>
</body>
</html>`,
  },
  {
    name: "tense_news",
    url: "https://news.example.com/live/regional-crisis",
    bgColor: "rgb(30, 20, 20)", // very dark -> dark/tense bias
    scrollSpeed: 1200, // fast scroll -> tense/curious bias (doomscrolling)
    cursorSpeed: 200,
    llmMood: "tense",
    llmCategory: "News",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>BREAKING: Regional Crisis Escalates as Ceasefire Talks Stall</title>
  <meta name="description" content="Breaking news coverage of an escalating regional crisis, with emergency warnings and government response.">
</head>
<body style="background-color: rgb(20,20,20)">
  <nav class="site-nav"><a href="/">Home</a></nav>
  <article class="post-body" style="background-color: rgb(30, 20, 20)">
    <h1>BREAKING: Regional Crisis Escalates</h1>
    <p>An emergency alert was issued overnight as tensions reached a breaking point along the
       contested border. Officials describe a volatile, precarious standoff, warning residents
       to brace for further disruption as the conflict threatens to spiral into open danger.</p>
    <p>The government's crisis response team convened an urgent session after reports of an
       attack near the capital triggered panic among residents. Correspondents on the ground
       describe scenes of chaos and unrest, with an evacuation warning now active for several
       districts as the standoff continues.</p>
  </article>
  <footer class="site-footer">Live news coverage.</footer>
</body>
</html>`,
  },
  {
    name: "calm_meditation",
    url: "https://wellness.example.com/guided-breathing",
    bgColor: "rgb(160, 200, 190)", // cool green -> calm bias
    scrollSpeed: 60, // slow scroll -> calm/focused bias
    cursorSpeed: 90,
    llmMood: "calm",
    llmCategory: "Health",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>A Gentle Guided Breathing Practice for Deep Relaxation</title>
  <meta name="description" content="A slow, soothing meditation and breathing practice to help you relax, unwind, and find stillness.">
</head>
<body style="background-color: rgb(235,245,240)">
  <nav class="site-nav"><a href="/">Home</a></nav>
  <article class="post-body" style="background-color: rgb(160, 200, 190)">
    <h1>A Gentle Guided Breathing Practice</h1>
    <p>Find a quiet, comfortable place to sit and let your body settle into stillness. Breathe
       slowly, letting each gentle inhale soothe your mind toward a calm, peaceful state. This
       practice is meant to feel unhurried -- there is no rush, only a soft, restful rhythm.</p>
    <p>As you continue to meditate, notice the tranquil balance between breath and body. Let
       your shoulders ease, your thoughts grow quiet, and a mellow sense of harmony settle over
       you. This is a moment of pure, composed relaxation, gentle and serene.</p>
  </article>
  <footer class="site-footer">Wellness content for mindful living.</footer>
</body>
</html>`,
  },
  {
    name: "sad_memorial",
    url: "https://community.example.com/in-memoriam",
    bgColor: "rgb(90, 95, 110)", // desaturated cool grey -> subdued
    scrollSpeed: 50,
    cursorSpeed: 60,
    llmMood: "sad",
    llmCategory: "Emotional",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>In Memoriam — Remembering a Beloved Friend</title>
  <meta name="description" content="A heartfelt tribute reflecting on loss, grief, and cherished memories after a sudden death in the community.">
</head>
<body style="background-color: rgb(230,230,235)">
  <nav class="site-nav"><a href="/">Home</a></nav>
  <article class="post-body" style="background-color: rgb(90, 95, 110)">
    <h1>In Memoriam</h1>
    <p>We gather in grief to mourn a loss that has left this community heartbroken. The sorrow
       of this sudden death is hard to put into words -- a quiet ache of loneliness where a
       familiar presence used to be, tears shared among friends who feel the same heartache.</p>
    <p>In our mourning, we hold onto memory rather than despair. Every story of laughter now
       carries a trace of sadness, every photograph a small heartbreak. We miss them, and in
       this shared grieving, we find that even sorrow can be a form of love.</p>
  </article>
  <footer class="site-footer">Community tributes.</footer>
</body>
</html>`,
  },
  {
    name: "sensitive_crisis_resource",
    url: "https://support.example.com/crisis-help",
    bgColor: "rgb(200, 210, 220)",
    scrollSpeed: 80,
    cursorSpeed: 70,
    // No llmMood/llmCategory override needed -- B1/B2 must never reach the
    // LLM at all for a sensitive page (that's the point of this fixture: it
    // proves the privacy guarantee holds on a real page, not just a
    // hand-typed isSensitive:true flag).
    llmMood: null,
    llmCategory: null,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Crisis Support — You Are Not Alone</title>
  <meta name="description" content="Confidential crisis support resources for anyone experiencing a mental health crisis, self-harm, or suicidal thoughts.">
</head>
<body style="background-color: rgb(225,230,235)">
  <nav class="site-nav"><a href="/">Home</a></nav>
  <article class="post-body" style="background-color: rgb(200, 210, 220)">
    <h1>Crisis Support Resources</h1>
    <p>If you or someone you know is having thoughts of suicide or self-harm, help is
       available right now. Trained crisis counsellors are ready to listen, confidentially and
       without judgement, whether you're in crisis yourself or supporting someone through a
       mental health crisis.</p>
    <p>This page also lists resources for domestic violence support, eating disorder recovery,
       and grief counselling after trauma or bereavement. You do not have to face this alone --
       reaching out is a sign of strength, not weakness.</p>
  </article>
  <footer class="site-footer">Confidential support, available 24/7.</footer>
</body>
</html>`,
  },
];

async function recordPage(pageSpec) {
  const dom = new JSDOM(pageSpec.html, { url: pageSpec.url });
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

  // Deterministic mock embedder (same pattern as record_integration_fixture.js)
  win.transformersPipeline = async function () {
    return async function (text) {
      const dims = 8;
      const vec = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return { data: vec.map((v) => v / norm) };
    };
  };

  const behaviorTracker = {
    snapshot: () => ({ scrollSpeed: pageSpec.scrollSpeed, cursorSpeed: pageSpec.cursorSpeed }),
  };

  // Deterministic LLM mock, only used as a safety net if tier-1 confidence
  // doesn't clear 0.5 on this page's wording. For the sensitive-content
  // page, this must NEVER be called -- checked explicitly below.
  let llmWasCalled = false;
  global.fetch = async () => {
    llmWasCalled = true;
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              category: pageSpec.llmCategory,
              mood: pageSpec.llmMood,
              pageType: "article",
              intent: "classified via LLM fallback",
              confidence: 0.9,
              energyHint: 0.3,
              valenceHint: 0.4,
            }),
          },
        }],
      }),
    };
  };

  // Reset per-tab state so each page starts from a clean transition state
  // (isolated by tabId, but fresh module import isn't happening here, so
  // give each page its own tabId instead).
  const { buildPageData } = require("../../data-extraction/pageData.js");
  const { configureFeatureB, runFeatureB } = await import("../feature_b/index.js");
  configureFeatureB({ confidenceWindowMs: 0, apiKey: "fake-key-for-fixture-generation" });

  const pageData = await buildPageData({
    doc: win.document,
    embeddingConfig: { backend: "local" },
    behaviorTracker,
    useCache: false,
  });

  const tabId = `fixture-tab-${pageSpec.name}`;
  const first = await runFeatureB(pageData, tabId);
  if (first !== null) {
    throw new Error(
      `[${pageSpec.name}] runFeatureB resolved on the FIRST call -- expected null.`
    );
  }
  const handoff2 = await runFeatureB(pageData, tabId);
  if (!handoff2) {
    throw new Error(`[${pageSpec.name}] runFeatureB returned null on the confirming call.`);
  }

  if (pageSpec.name === "sensitive_crisis_resource" && llmWasCalled) {
    throw new Error(
      "[sensitive_crisis_resource] the LLM mock was called for a sensitive page -- " +
      "B1/B2's privacy guarantee (never send sensitive text to the LLM) is broken."
    );
  }

  console.log(`\n[${pageSpec.name}]`);
  console.log("  profile.mood:", handoff2.profile?.mood);
  console.log("  profile.content_category:", handoff2.profile?.content_category);
  console.log("  profile.sensitive_override:", handoff2.profile?.sensitive_override);
  console.log("  isSilent:", handoff2.isSilent, " volume:", handoff2.volume);
  console.log("  llmWasCalled:", llmWasCalled);

  return handoff2;
}

async function main() {
  const FIXTURES_DIR = join(__dirname, "..", "fixtures", "multi");
  mkdirSync(FIXTURES_DIR, { recursive: true });

  for (const pageSpec of PAGES) {
    const handoff2 = await recordPage(pageSpec);
    const outPath = join(FIXTURES_DIR, `${pageSpec.name}.json`);
    writeFileSync(outPath, JSON.stringify(handoff2, null, 2) + "\n");
    console.log(`  Saved: ${outPath}`);
  }
}

main().catch((err) => {
  console.error("Failed to generate fixtures:", err);
  process.exit(1);
});
