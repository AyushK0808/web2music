/**
 * Feature B — Unit Tests
 * Run with: node --experimental-vm-modules feature_b.test.js
 * (or Jest with ESM support)
 *
 * Tests cover all 4 sub-modules and the orchestrator edge cases.
 */

import { strict as assert } from "assert";

// ── B1 Tests ──────────────────────────────────────────────────────────────────
import {
  cleanText,
  extractKeywords,
  classifyContentCategory,
  checkSensitiveContent,
  summariseContent,
  runB1,
} from "./feature_b/b1_contentUnderstanding.js";

console.log("B1: cleanText");
assert.equal(cleanText("<p>Hello &amp; world!</p>"), "Hello & world!");
assert.equal(cleanText("  multiple   spaces  "), "multiple spaces");
assert.equal(cleanText("Visit https://example.com for more"), "Visit for more");

console.log("B1: extractKeywords");
const kws = extractKeywords("machine learning is a subset of artificial intelligence and deep learning");
assert(kws.includes("machine") || kws.includes("learning") || kws.includes("artificial"));
assert(!kws.includes("is"));
assert(!kws.includes("of"));

console.log("B1: classifyContentCategory");
const catResult = classifyContentCategory(["stock", "invest", "portfolio", "market"], "Finance News");
assert.equal(catResult.primary, "Finance");

console.log("B1: checkSensitiveContent");
assert(checkSensitiveContent("This page discusses suicide prevention resources"));
assert(checkSensitiveContent("Information about eating disorder treatment"));
assert(!checkSensitiveContent("This is a recipe for pasta"));

console.log("B1: summariseContent");
const summary = summariseContent("First sentence here. Second sentence here. Third sentence here.");
assert(summary.includes("First sentence"));
assert(summary.includes("Second sentence"));
assert(!summary.includes("Third sentence")); // only first 2

console.log("B1: runB1 — sensitive page bypass");
const sensitiveResult = runB1({
  rawText: "This article discusses suicide and self-harm.",
  title: "Mental Health Crisis",
  url: "https://example.com/crisis",
});
assert(sensitiveResult.isSensitive === true);

console.log("B1: runB1 — payment page bypass");
const paymentResult = runB1({
  rawText: "Enter your card details",
  title: "Checkout",
  url: "https://shop.com/pay/checkout",
});
assert(paymentResult._bypass === "payment_page");

console.log("B1: runB1 — chrome internal bypass");
const chromeResult = runB1({
  rawText: "",
  title: "New Tab",
  url: "chrome://newtab",
});
assert(chromeResult._bypass === "chrome_internal");

// ── B2 Tests ──────────────────────────────────────────────────────────────────
import { runB2, MOODS } from "./feature_b/b2_moodClassifier.js";

console.log("B2: sensitive content override");
const b2SensitiveResult = await runB2(
  { isSensitive: true, keywords: [], cleanedText: "", colors: {}, scrollSpeed: 0, cursorSpeed: 0, readingComplexity: 0.5, category: {} },
  null
);
assert.equal(b2SensitiveResult.mood, MOODS.UPLIFTING);
assert(b2SensitiveResult.sensitiveOverride === true);

console.log("B2: payment bypass");
const b2PaymentResult = await runB2({ _bypass: "payment_page", meta: {} }, null);
assert.equal(b2PaymentResult.mood, MOODS.CALM);

console.log("B2: keyword mood detection");
const b2FocusedResult = await runB2(
  {
    isSensitive: false,
    keywords: ["study", "research", "focus", "code", "task"],
    cleanedText: "study code focus work research",
    colors: { hue: 220, saturation: 0.5, lightness: 0.6 },
    scrollSpeed: 50,
    cursorSpeed: 100,
    readingComplexity: 0.7,
    category: { primary: "Educational", secondary: null },
    meta: { url: "https://docs.example.com" },
    isImageOnly: false,
  },
  null
);
assert(["focused", "calm"].includes(b2FocusedResult.mood)); // either valid for this signal mix

// ── B3 Tests ──────────────────────────────────────────────────────────────────
import { runB3 } from "./feature_b/b3_musicProfileGenerator.js";

console.log("B3: music profile structure");
const moodCtx = {
  mood: "focused", pageType: "educational",
  energyHint: 0.4, valenceHint: 0.2,
  scrollSpeed: 80, cursorSpeed: 150,
  colors: { hue: 210, saturation: 0.4, lightness: 0.6 },
  category: { primary: "Educational" },
};
const profile = runB3(moodCtx);
assert(profile.bpm >= 60 && profile.bpm <= 130);
assert(profile.energy >= 0 && profile.energy <= 1);
assert(profile.reverb >= 0 && profile.reverb <= 1);
assert(Array.isArray(profile.instruments) && profile.instruments.length > 0);
assert(typeof profile.key === "string");
assert(profile.musicCategory.includes("Productive") || profile.musicCategory.includes("Focused"));

console.log("B3: BPM scales with energy");
const lowEnergyProfile  = runB3({ ...moodCtx, energyHint: 0.1 });
const highEnergyProfile = runB3({ ...moodCtx, energyHint: 0.9 });
assert(highEnergyProfile.bpm >= lowEnergyProfile.bpm);

// ── B4 Tests ──────────────────────────────────────────────────────────────────
import { runB4, buildFallbackPrompt } from "./feature_b/b4_promptEngineer.js";

console.log("B4: prompt generation — musicgen");
const handoff2 = runB4(profile, { targetModel: "musicgen" });
assert(typeof handoff2.prompt === "string" && handoff2.prompt.length > 20);
assert(handoff2.musicProfile.mood === "focused");
assert(handoff2.targetModel === "musicgen");
assert(typeof handoff2.handoffVersion === "string");

console.log("B4: prompt generation — stable-audio");
const saHandoff = runB4(profile, { targetModel: "stable-audio" });
assert(typeof saHandoff.prompt.positive === "string");
assert(typeof saHandoff.prompt.negative === "string");
assert(saHandoff.prompt.negative.includes("vocals"));

console.log("B4: fallback prompt — night");
const fallback = buildFallbackPrompt("night");
assert(fallback.isFallback === true);
assert(fallback.musicProfile.mood === "calm");
assert(typeof fallback.prompt === "string");

// ── Integration test (no Chrome APIs — mock the config) ───────────────────────
import { runFeatureB, configureFeatureB, resetConfidenceWindow } from "./feature_b/index.js";

console.log("Integration: confidence interval — first call returns null");
resetConfidenceWindow();
configureFeatureB({ apiKey: "", targetModel: "musicgen" });
const firstCall = await runFeatureB({
  rawText: "study code focus research", title: "Docs", url: "https://docs.test.com",
  scrollSpeed: 50, cursorSpeed: 100,
});
assert(firstCall === null, "First call should return null (confidence window not yet met)");

console.log("Integration: fallback on error");
const errorResult = await runFeatureB(null); // null input → should fallback gracefully
assert(errorResult !== null);
assert(errorResult.isFallback === true);

console.log("\n✅ All Feature B tests passed.");
