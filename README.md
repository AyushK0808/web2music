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
## Testing & Validation

### Main test suite

Run all Feature B tests (B1, B2, B3, B4, and integration):

```bash
npm test
```

This runs ~20 assertions covering content cleaning, mood detection (both tiers), music profile generation, prompt engineering, and the 5-second confidence interval.

### Manual exploration scripts

All exploratory test scripts are organized in `manual-tests/` for validation and debugging:

```bash
# Test mood detection with real LLM (requires Anthropic API key)
$env:ANTHROPIC_API_KEY="sk-ant-your-key"
node manual-tests/try_tier_check.js

# Test full pipeline on real websites
node manual-tests/try_real_site.js https://en.wikipedia.org/wiki/Indus_Valley_Civilisation

# Test signal impact on final prompt generation
node manual-tests/try_signal_in_prompt.js

# Debug content category classification
node manual-tests/try_category_debug.js https://example.com

# Test raw Anthropic API connectivity
node manual-tests/try_anthropic_raw.js
```

### Signal capture prototype

To prototype scroll and cursor speed capture (same logic as content_script.js will use):

1. Open `manual-tests/signal_capture_test.html` in a browser (double-click in File Explorer).
2. Move your mouse and scroll on the page.
3. Watch the live dashboard update with speed measurements (green/yellow/red colour bands).
4. Verify throttling is working: event rate counters should never exceed 20/sec (mouse) or 10/sec (scroll).

---

## Known issues found & fixed during testing

### 1. HTML entity decoding in cleanText()
**Issue:** `&amp;` was being deleted instead of decoded to `&`.
**Fix:** Added explicit entity decode steps before the catch-all strip.
**Impact:** Pages with special characters in content now classify correctly.

### 2. Substring matching in content category classification
**Issue:** Keyword `"cook"` was matching `"cookies"` (browser cookies), and `"eat"` was matching `"wheat"`.
**Fix:** Changed `.includes(kw)` to `.startsWith(kw)` for whole-word boundaries.
**Added:** Minimum 2-keyword-hit threshold to avoid single-word false positives.
**Impact:** Indus Valley Civilization articles no longer misclassify as "Food."

### 3. Mood scoring scale mismatch
**Issue:** Keyword hits (raw integers: 1, 2, 3...) were competing directly against behavioural biases (tiny decimals: 0.1–0.2), so keyword matches always dominated regardless of scroll/cursor speed.
**Fix:** Normalized keyword hits to the same 0–1 scale as behaviour signals (1 keyword ≈ 0.25 weight).
**Impact:** Scroll and cursor speed now meaningfully influence mood detection on keyword-ambiguous pages.

---

## No Python, no databases needed

Feature B is pure JavaScript. Vector databases (ChromaDB, Supabase) and Python tools are used by Feature A (embedding) and Feature D (audio generation), not Feature B. All testing and development uses only Node.js.

---
## Project structure

```
feature_b/
├── index.js                         # Orchestrator: chains B1→B2→B3→B4
├── b1_contentUnderstanding.js       # Text cleaning, keyword extraction, category classification
├── b2_moodClassifier.js             # Two-tier mood detection (heuristic + LLM)
├── b3_musicProfileGenerator.js      # Mood → BPM, key, instruments, reverb, ambience
└── b4_promptEngineer.js             # Profile → natural-language audio prompt

manual-tests/
├── signal_capture_test.html         # Browser prototype: scroll/cursor speed capture
├── try_tier_check.js                # Validate Tier-1 vs Tier-2 LLM escalation
├── try_real_site.js                 # Full pipeline on real website content
├── try_signal_in_prompt.js          # Verify scroll/cursor speed affects final prompt
├── try_category_debug.js            # Debug content category classification
├── try_anthropic_raw.js             # Test Anthropic API connectivity directly
├── try_it_out.js                    # Quick test with synthetic data
└── try_signal_test.js               # Test energy/intensity scaling with behaviour signals

feature_b_test.js                    # Main test suite (20+ assertions)
background_integration.js            # Reference: wiring into Chrome extension
package.json                         # Node.js project config
README.md                            # This file
```
## Extending Feature B

Documented future improvements are in the PoC document (section 7):

- **7.3:** Use Feature A's page embedding for similarity-based Tier-1 mood refinement.
- **7.4:** Deploy a lightweight fine-tuned model (~50–100M params) via ONNX/TensorFlow.js instead of calling the full LLM for Tier-2.
- **7.5:** Implement dynamic instrument layering instead of static per-mood lists.
- **7.6:** Build an automated evaluation framework to score mood→prompt→music coherence.
