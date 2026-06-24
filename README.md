# Feature B — Mood & Context Classification (AI Layer)

## Position in the pipeline

```
Feature A (Site Data Extraction)
    │
    │  Handoff 1: PageData (JSON)
    ▼
Feature B ◄── YOU ARE HERE
    │
    │  Handoff 2: MusicProfile + Prompt (JSON)
    ▼
Feature D (AI Audio Generation)
```

---

## Sub-modules

| File | Stage | Responsibility |
|------|-------|----------------|
| `b1_contentUnderstanding.js` | B1 | Clean text, extract keywords, classify content category, detect sensitive pages |
| `b2_moodClassifier.js`       | B2 | Two-tier mood detection (heuristic + LLM), colour & behaviour bias |
| `b3_musicProfileGenerator.js`| B3 | Map mood → BPM, key, instruments, reverb, ambience, style |
| `b4_promptEngineer.js`       | B4 | Convert profile → natural-language audio prompt for MusicGen/StableAudio |
| `index.js`                   | Orchestrator | Chain B1→B2→B3→B4, confidence interval, Chrome message wiring |
| `feature_b.test.js`          | Tests | Unit tests for all 4 stages + integration |

---

## Handoff 1 Input (from Feature A)

```json
{
  "rawText":     "first 400-500 words from page",
  "title":       "Page Title",
  "description": "meta description",
  "url":         "https://example.com/article",
  "lang":        "en",
  "colors": {
    "hue":        210,
    "saturation": 0.5,
    "lightness":  0.6
  },
  "scrollSpeed":  120,
  "cursorSpeed":  300,
  "embedding":    [0.12, -0.34, ...]
}
```

---

## Handoff 2 Output (to Feature D)

```json
{
  "musicProfile": {
    "mood":            "focused",
    "musicCategory":   "Productive / Flow State / Focused",
    "bpm":             88,
    "key":             "D minor",
    "energy":          0.42,
    "intensity":       0.38,
    "valence":         0.4,
    "reverb":          0.30,
    "ambience":        0.40,
    "timbre":          "clear, precise, minimal",
    "instruments":     ["piano", "minimalist synth", "light percussion", "bass drone"],
    "style":           "lo-fi study, minimal electronic, deep focus",
    "dynamics":        "steady pulse, no sudden peaks",
    "tempo":           "andante moderato",
    "atmosphereTags":  "concentration, deep work",
    "listeningContext":"mid-morning educational session",
    "timeOfDay":       "mid-morning",
    "sensitiveOverride": false
  },
  "prompt": "lo-fi study, minimal electronic, deep focus. Instruments: piano, minimalist synth, light percussion, bass drone. clear, precise, minimal timbre, steady pulse, no sudden peaks. Key: D minor, 88 BPM. moderate energy, steady flow, dry, close-mic sound, subtle background warmth. Mood: focused. Context: mid-morning educational session. No vocals. Seamlessly loopable. Instrumental only.",
  "targetModel":    "musicgen",
  "handoffVersion": "2.0",
  "generatedAt":    1718567423000,
  "contentCategory":"Educational",
  "pageType":       "educational"
}
```

---

## Mood classification tiers

```
Tier 1 (always runs, ~0ms)
│  Keyword heuristic + colour HSL bias + scroll/cursor behaviour bias
│  → blended score across 11 moods
│
└─► confidence ≥ 0.5 → DONE (no API call needed)
    confidence < 0.5 →
        Tier 2 (LLM call, ~1-3s)
        │  Claude claude-sonnet-4-6 with structured JSON response
        └─► parsed result or fallback to Tier 1 on failure
```

---

## Edge cases handled

| Spec # | Description | Handling |
|--------|-------------|----------|
| #1  | Confidence interval (5 second mood stability) | `shouldTransition()` in index.js |
| #2  | Sensitive content override (crisis, grief, etc.) | `checkSensitiveContent()` in B1, `sensitiveOverride` in B2 |
| #4  | Active tab filtering | Active tab check in `registerFeatureBListener()` |
| #13 | LLM API offline / timeout | `callLLMClassifier()` 8s timeout + null return → tier-1 fallback |
| #15 | Image-only pages (Pinterest etc.) | `isImageOnly` flag — skips LLM, uses colour + behaviour only |
| #16 | Payment / banking pages | `isPaymentPage` bypass → calm music immediately |
| #21 | Chrome internal pages | `isChromeInternal` bypass → calm music |

---

## Setup

```js
// In background.js
import { configureFeatureB, registerFeatureBListener } from "./feature_b/index.js";

chrome.storage.sync.get(["llmApiKey", "targetModel"], (settings) => {
  configureFeatureB({
    apiKey:      settings.llmApiKey   ?? "",
    targetModel: settings.targetModel ?? "musicgen",
  });
});

registerFeatureBListener();
```

---

## Running tests

```bash
node --experimental-vm-modules feature_b/feature_b.test.js
```
