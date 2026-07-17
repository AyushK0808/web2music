/**
 * record_groq_fixtures.js — captures REAL GroqCloud API responses as golden
 * fixtures for feature_b_test.js's fixture-based parsing tests (fix 15).
 *
 * The main test suite's mocked fetch responses are hand-typed — they encode
 * what we ASSUME Groq's response shape looks like, not what it actually is.
 * If Groq's real format ever drifts (a field renamed, nesting changed, a new
 * wrapper object, ...), the hand-typed mocks would keep "passing" while the
 * real integration silently broke. This script calls the real API using the
 * exact same functions B1/B2 use in production, and saves the raw response
 * verbatim. The fixture-based tests in feature_b_test.js then replay that
 * captured response through our parsing code — so parsing correctness is
 * checked against a real recorded response, not our own assumptions.
 *
 * Run manually (needs a real key — costs a small amount of free-tier quota,
 * two classification calls):
 *   GROQ_API_KEY=gsk_... node manual_tests/record_groq_fixtures.js
 *
 * Re-run this periodically (before a release, or if Groq changes something)
 * to refresh the fixtures and actually catch drift, rather than assuming it
 * hasn't happened.
 */

import { callCategoryLLMClassifier } from "../feature_b/b1_contentUnderstanding.js";
import { callLLMClassifier } from "../feature_b/b2_moodClassifier.js";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

const apiKey = process.env.GROQ_API_KEY || "";
if (!apiKey) {
  console.error("GROQ_API_KEY is required to record fixtures. Example:");
  console.error("  GROQ_API_KEY=gsk_... node manual_tests/record_groq_fixtures.js");
  process.exit(1);
}

mkdirSync(FIXTURES_DIR, { recursive: true });

// Wraps the real fetch so the request goes out for real, but the raw
// response body (before our own parsing touches it) is captured verbatim
// into `sink` — the fixture we want is exactly what Groq sent, unmodified.
function recordingFetch(realFetch, sink) {
  return async (url, opts) => {
    const res = await realFetch(url, opts);
    const text = await res.text();
    sink.status = res.status;
    sink.body = JSON.parse(text);
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) };
  };
}

async function recordCategoryFixture() {
  const sink = {};
  const realFetch = global.fetch;
  global.fetch = recordingFetch(realFetch, sink);
  try {
    const category = await callCategoryLLMClassifier(
      {
        keywords: ["bioluminescence", "organism", "deep-sea", "chemical"],
        title: "Bioluminescent Deep-Sea Creatures",
        summary: "An article exploring how deep-sea organisms produce light through chemical reactions in their bodies.",
      },
      apiKey,
    );
    console.log("Recorded category classification result:", category);
  } finally {
    global.fetch = realFetch;
  }
  return sink;
}

async function recordMoodFixture() {
  const sink = {};
  const realFetch = global.fetch;
  global.fetch = recordingFetch(realFetch, sink);
  try {
    const mood = await callLLMClassifier(
      {
        summary: "A calm article about slow mornings and quiet tea rituals.",
        keywords: ["calm", "tea", "morning", "ritual"],
        category: { primary: "Health" },
        scrollSpeed: 20,
        cursorSpeed: 30,
      },
      apiKey,
    );
    console.log("Recorded mood classification result:", mood);
  } finally {
    global.fetch = realFetch;
  }
  return sink;
}

const categoryFixture = await recordCategoryFixture();
const moodFixture = await recordMoodFixture();

if (categoryFixture.status !== 200 || moodFixture.status !== 200) {
  console.error("One or both recording calls did not return 200 — not overwriting fixtures with a bad capture.");
  console.error("category status:", categoryFixture.status, "| mood status:", moodFixture.status);
  process.exit(1);
}

writeFileSync(join(FIXTURES_DIR, "groq_category_response.json"), JSON.stringify(categoryFixture, null, 2) + "\n");
writeFileSync(join(FIXTURES_DIR, "groq_mood_response.json"), JSON.stringify(moodFixture, null, 2) + "\n");

console.log("Fixtures written to", FIXTURES_DIR);
