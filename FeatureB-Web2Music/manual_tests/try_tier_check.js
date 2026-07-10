import { runB1 } from "../feature_b/b1_contentUnderstanding.js";
import { runB2 } from "../feature_b/b2_moodClassifier.js";

const key = process.env.ANTHROPIC_API_KEY || "";

// Test 1 — obvious keywords, should stay on Tier 1
const obvious = await runB1({
  rawText: "workout gym intense training power hustle",
  title: "Fitness",
  description: "A page about intense workout routines and gym training motivation.",
}, key);
const r1 = await runB2(obvious, key);
console.log("Obvious text → tier:", r1.tier, "| mood:", r1.mood);

// Test 2 — deliberately vague, should escalate to Tier 2 if key works
const vague = await runB1({
  rawText: "It is unclear what this means going forward.",
  title: "Untitled",
  description: "A brief note that does not specify any particular outcome or direction.",
}, key);
const r2 = await runB2(vague, key);
console.log("Vague text → tier:", r2.tier, "| mood:", r2.mood, "| intent:", r2.intent);