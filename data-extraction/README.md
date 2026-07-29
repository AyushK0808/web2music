# WEB2MUSIC — Feature A: Site Data Extraction & Similarity Engine

Content-script modules implementing the first three components of Feature A
from the WEB2MUSIC research guide.

## Files

| File | Purpose |
|---|---|
| `Textextractor.js` | Extracts clean, boilerplate-free article text from the page DOM (nav/footer/ad stripping + text-density scoring) before it's embedded. Also reads page metadata: meta `description` (with og/twitter fallbacks) and document `lang`. |
| `Embeddingmodel.js` | Converts cleaned text into a semantic embedding vector, with a switchable backend: `local` (`all-MiniLM-L6-v2`, 384-dim, in-browser via Transformers.js), `openai` (`text-embedding-3-small`, API), or `service` (offloads the API call to the Docker microservice so no key lives in the page). Also exposes `cosineSimilarity()`. |
| `Colorextractor.js` | Extracts dominant page hues via area-weighted HSL histogram bucketing over computed CSS background colors, plus an overall `colorEnergy` score **and** a representative `{ hue, saturation, lightness }` triple for Feature B's colour-bias step. |
| `behaviorTracker.js` | Stateful capture of browsing behaviour: throttled scroll/mousemove listeners (≤10/sec scroll, ≤20/sec mouse) exposing rolling `scrollSpeed` / `cursorSpeed` (px/s) via `.snapshot()`. |
| `Readability.js` | Flesch Reading Ease scoring (`flesch` 0–100 and `readingComplexity` 0–1), numerically compatible with Feature B1's own `computeReadingComplexity`. |
| `pageData.js` | **The Handoff-1 assembler.** `buildPageData()` runs the extractors + behaviour + metadata + readability + embedding and returns the single, validated object Feature B's `runB1()` consumes. Also: `validatePageData()` (safe defaults + `handoffVersion`/`extractedAt`, mirroring Feature D's `d1_validate.py`), an embedding cache keyed by URL + text-hash + backend/model, `runWhenIdle()` (debounce + `requestIdleCallback`), a `fullyLocal` no-network mode, and `getExtractionTelemetry()` per-stage latency/failure-rate. |
| `docker/` | Containerised OpenAI embedding microservice — keeps the API key server-side (see `docker/README.md`). |

## Usage

The simplest path — let the orchestrator do everything and hand Feature B a
ready-to-validate `PageData`:

```js
const { buildPageData } = window.Web2MusicPageData;

const pageData = await buildPageData({ embeddingConfig: { backend: 'local' } });
// pageData → send as the Handoff-1 payload to Feature B's runB1()
```

Off the critical path (debounced + idle-scheduled, e.g. from a MutationObserver):

```js
const { createPageDataScheduler } = window.Web2MusicPageData;
const schedule = createPageDataScheduler({ embeddingConfig: { backend: 'service' } });
new MutationObserver(() => schedule().then(sendToFeatureB)).observe(document.body, { childList: true, subtree: true });
```

Or drive the individual modules yourself:

```js
const { extractPageText } = window.Web2MusicTextExtractor;
const { getEmbedding, cosineSimilarity } = window.Web2MusicEmbedding;
const { extractDominantColors } = window.Web2MusicColorExtractor;

const page = extractPageText();                       // { title, mainText, description, lang, wordCount, url }
const embedding = await getEmbedding(page.mainText, { backend: 'local' });
const colors = extractDominantColors();               // { dominantHues, colorEnergy, achromaticRatio, representativeColor }
```

## Handoff-1 shape (what `buildPageData()` returns)

```js
{
  rawText, title, description, url, lang,   // text + metadata
  colors: { hue, saturation, lightness },   // representative colour
  scrollSpeed, cursorSpeed,                 // behaviour (px/s)
  embedding,                                // number[]
  isImageOnly, wordCount,                   // non-text fallback signal (edge case #15)
  flesch, readingComplexity, colorEnergy,   // additive enrichment (B ignores unknowns)
  handoffVersion, extractedAt,              // handoff stamp
}
```

## Fully-local mode (privacy/utility tradeoff)

Pass `fullyLocal: true` to guarantee the build makes **no network calls** — the
embedding backend is forced to `local` regardless of what `embeddingConfig.backend`
requests, so page text never leaves the machine:

```js
const pageData = await buildPageData({ fullyLocal: true });
```

The cost is embedding quality (384-dim MiniLM vs. OpenAI's 1536-dim), which is the
privacy-utility ablation to quantify for §7: run the same corpus with
`fullyLocal: true` vs. a network backend and compare downstream mood-classification
accuracy. **The mode is implemented; the accuracy measurement is still to be done.**

## Extraction telemetry

Each of the five stages (`text`, `colors`, `behavior`, `readability`, `embedding`)
is timed and its failures counted, feeding the systems eval in §6:

```js
const { getExtractionTelemetry, resetExtractionTelemetry } = window.Web2MusicPageData;

getExtractionTelemetry();
// → { text: { count, failures, failureRate, avgMs, totalMs }, colors: {...}, ... }
```

Stage failures are non-fatal — they surface both here and in `pageData.warnings`,
while the field falls back to its safe default. Note that measuring real extraction
cost (e.g. across the top-100 sites) requires a **real browser**; jsdom does no
layout, so colour-extraction timings under `npm run play` are not representative.

## Config

`embeddingModel.js` reads a config object per call (no hardcoded defaults
baked into behavior beyond `DEFAULT_CONFIG`):

```js
{
  backend: 'local' | 'openai' | 'service',
  openaiModel: 'text-embedding-3-small',
  openaiApiKey: null,        // set via extension settings, never hardcode
  localModel: 'Xenova/all-MiniLM-L6-v2',
  maxInputChars: 8000,
  serviceUrl: 'http://localhost:8077/embed'   // used by the 'service' backend
}
```

The `local` backend expects `@xenova/transformers` to be bundled and exposed
as `window.transformersPipeline`. The `service` backend calls the Docker
microservice in [`docker/`](docker/README.md), which holds the OpenAI key in
its container environment — use it when you want OpenAI-quality vectors without
shipping a key into the page.

## Status

Implemented for Feature A:
- ✅ Text Extraction (`Textextractor.js`)
- ✅ Embedding Model — local / openai / service backends (`Embeddingmodel.js`)
- ✅ Colour Extraction + representative HSL (`Colorextractor.js`)
- ✅ Page metadata: description + lang (`Textextractor.js#extractMetadata`)
- ✅ Behaviour capture: scroll/cursor speed (`behaviorTracker.js`)
- ✅ Flesch Scorer (`Readability.js`)
- ✅ Feature Vector Assembly — `buildPageData()` (`pageData.js`)
- ✅ Non-Text Page fallback — `isImageOnly` flag (`pageData.js`)
- ✅ Performance Budget — `runWhenIdle()` debounce + `requestIdleCallback` (`pageData.js`)
- ✅ Embedding cache keyed by URL + text-hash + backend/model (`pageData.js`)
- ✅ Element cap / even sampling in colour extraction (`Colorextractor.js`)
- ✅ Per-stage latency + failure-rate telemetry (`pageData.js#getExtractionTelemetry`)
- ✅ Fully-local no-network mode (`buildPageData({ fullyLocal: true })`)

Measurement still outstanding (code is in place, numbers are not):
- ⬜ Extraction cost measured on the top-100 sites in a real browser (§6)
- ⬜ Accuracy cost of `fullyLocal` mode quantified vs. a network backend (§7)

Still owned elsewhere / out of scope here: Vector Database integration and
Similarity Threshold config (belong with the storage layer). The `flesch` field
is emitted but Feature B's Handoff-1 schema has no slot for it yet — additive and
safe; wire up a matching input on B's side to actually consume it.

## Verify

```bash
cd data-extraction
npm install        # jsdom (dev only)
npm run play       # runs all modules incl. the full buildPageData() assembly
```

## Source

Based on `WEB2MUSIC_RECS.pdf` — Feature A section (VinnovateIT, 2026).
