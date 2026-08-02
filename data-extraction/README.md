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
| `VectorStore.js` | **The similarity engine.** Persistent vector database (IndexedDB in the extension, in-memory in Node/tests) with cosine search, configurable similarity thresholds, and per-model namespacing. Answers "have we seen a page like this before?" so a revisit can reuse a previous mood/track instead of re-running the pipeline. |
| [`../services/embed/`](../services/embed/README.md) | Containerised OpenAI embedding microservice — keeps the API key server-side. Built from the repo root's `docker/docker-compose.yml` (`research` profile). |
| `benchmark/` | Real-browser extraction-cost harness for the §6 systems eval. |

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

## Similarity engine (vector DB + thresholds)

`buildPageData()` uses it automatically — the extra fields are additive, so
Feature B ignores them until it wants them:

```js
const pageData = await buildPageData();
pageData.isRevisit     // true → safe to reuse the previous mood/track
pageData.nearestScore  // cosine similarity of the closest stored page
pageData.similarPages  // [{ url, score, title, mood }], best first
```

Pass `vectorStore: false` to disable it, or supply your own store to tune it:

```js
const { createVectorStore, SIMILARITY_PRESETS } = window.Web2MusicVectorStore;

const store = createVectorStore({
  threshold: SIMILARITY_PRESETS.sameTopic,       // 0.85 — counts as a match
  revisitThreshold: SIMILARITY_PRESETS.duplicate, // 0.95 — reuse outright
  maxEntries: 2000,                               // oldest evicted past this
});
const pageData = await buildPageData({ vectorStore: store });
```

Presets: `duplicate` 0.95 (same article/revisit), `sameTopic` 0.85 (same subject),
`related` 0.70 (loosely related — a hint, too weak to skip work on). These are
calibrated for MiniLM-class models and are **starting points to tune against real
pages**, not universal constants; re-check them if the embedding backend changes.

Two properties worth knowing:

- **Per-model namespacing.** Records are keyed by `backend:model:dims` and
  searches never cross namespaces, because vectors from different models are not
  comparable — a 384-dim MiniLM vector and a 1536-dim OpenAI vector describe
  different spaces, and even same-dimension models put different meanings on each
  axis. Comparing them returns confident nonsense rather than an error, which is
  worse than a miss. Same guard as the embedding cache key.
- **URL canonicalisation.** Tracking params (`utm_*`, `gclid`, `fbclid`, …) and
  fragments are stripped so one article at three URLs is one record. Meaningful
  query strings (`?q=`, `?id=`) are preserved.

### Storage backends

| Backend | Adapter | Use for |
|---|---|---|
| IndexedDB | `createIndexedDBAdapter` (default in browser) | the extension — zero setup, survives restarts |
| In-memory | `createMemoryAdapter` (default in Node) | tests, and the fallback when IndexedDB is blocked |
| **Qdrant** | `createQdrantAdapter` | corpus-scale work — the §6/§7 evaluations |

The first two search by brute-force scan: vectors are unit-normalised on write so
similarity is a plain dot product, and a few thousand 384-dim vectors scan in well
under a frame. No ANN index at that scale — it would add a dependency and real
complexity to save time we aren't spending.

### Qdrant (Docker) — the scale-up path

For corpus work the in-browser store is the wrong tool: `maxEntries` caps it and
the scan happens client-side. Qdrant runs the search **server-side**, which is the
entire point of using it.

```bash
npm run qdrant:up          # docker compose up -d qdrant
npm run test:qdrant        # 25 assertions against the real server
npm run qdrant:down
```

```js
const { createVectorStore, createQdrantAdapter } = require('./VectorStore.js');

const store = createVectorStore({
  adapter: createQdrantAdapter({ url: 'http://127.0.0.1:6333' }),
});
const pageData = await buildPageData({ vectorStore: store });
```

Three implementation details you'd otherwise trip over:

- **One collection per namespace.** A Qdrant collection has a *fixed* vector size,
  and our namespaces deliberately differ in dimensionality (384 vs 1536). So
  `backend:model:dims` maps to a collection name — which gets the cross-model
  isolation for free, since a query physically cannot reach another model's vectors.
- **Point IDs must be uint64 or UUID.** Ours are strings (`namespace::url`), so
  each is hashed to a deterministic SHA-256-derived UUID with the readable id kept
  in the payload. Collision resistance doesn't rest on a 32-bit hash.
- **Writes use `wait=true`.** Qdrant indexes asynchronously; without it a search
  immediately after an upsert can miss the write.

Eviction is skipped for Qdrant (the adapter declares itself `unbounded`) —
enforcing a client-sized cap on a real database would defeat the purpose.

**Intended for Node or a trusted service context, not the content script.** Pointing
a page directly at Qdrant needs permissive CORS and exposes the whole database to
anything that can reach the port. Keep IndexedDB in the extension, or front Qdrant
with a hardened proxy the way `../services/embed/embedService.js` fronts the OpenAI key.

Qdrant ships with **no authentication**. Loopback-only port publishing is the real
control; to add defence in depth, export `QDRANT__SERVICE__API_KEY` before
`qdrant:up` and pass the same value as `createQdrantAdapter({ apiKey })`. Note the
compose file passes that variable through by *name* rather than as
`KEY: ${VAR:-}` — Qdrant reads an **empty** api-key as "auth enabled" and then 401s
every request while `/readyz` still returns 200, so the interpolated form silently
bricks the database whenever `.env` is absent.

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
while the field falls back to its safe default.

## Extraction-cost benchmark (§6)

Measuring real extraction cost requires a **real browser** — jsdom does no layout,
so `getBoundingClientRect()` returns zeros and colour-extraction timings under
`npm run play` are meaningless. `benchmark/extractionCost.js` drives installed
Chrome over CDP:

```bash
npm install                      # puppeteer-core (uses your installed Chrome)
npm run bench                    # full site list, ~15-25 min
npm run bench -- --limit 5       # quick smoke test
npm run bench -- --sites tranco-top100.txt --out results.json
npm run bench -- --help
```

Per site it records `buildPageData()` wall-clock, per-stage latency/failures,
colour extraction in isolation (the forced-layout risk, plus how hard the
`MAX_ELEMENTS_TO_SAMPLE` cap bites), Chrome's own layout/recalc-style counters,
and two correctness signals — whether the colour→mood signal came out live, and
**text-extraction coverage** (extracted words ÷ visible words). Reports p50/p95/max,
since the tail is what janks a page. Sites are visited sequentially; concurrent
loads would contend for CPU and corrupt the timings.

Modules are injected via CDP `Runtime.evaluate`, *not* `addScriptTag`, so the
strict CSP most large sites ship doesn't block them. The local embedder is stubbed
by default (a real MiniLM download would dominate every measurement) — pass
`--real-embedding` to opt out, and note that the `embedding` stage timing is
otherwise not a real model cost.

`benchmark/top-sites.txt` is a stand-in spread of page archetypes, **not** a
ranking — point `--sites` at a real Tranco slice for a citable sample, and record
which list and snapshot date you used.

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
microservice in [`../services/embed/`](../services/embed/README.md), which holds the OpenAI key in
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
- ✅ Real-browser extraction-cost harness (`benchmark/extractionCost.js`)
- ✅ **Vector Database integration** (`VectorStore.js`) — IndexedDB, in-memory, or Qdrant; per-model namespaced
- ✅ **Similarity Threshold config** (`SIMILARITY_PRESETS` + per-call overrides)
- ✅ Qdrant vector DB in Docker with server-side search (`../docker/docker-compose.yml`, `research` profile)
- ✅ Asserted test suite (`npm test` — 110 assertions across four files)

### ⚠️ If you add a module here, mind the shared global scope

Every file in this directory is loaded as a **content script into the same page
global scope**. Two modules declaring `const X` at top level is a `SyntaxError`
that breaks all of Feature A — and CommonJS gives each file its own scope, so
`npm test` and `npm run play` pass while only the real browser fails.

This shipped once: `VectorStore.js` and `Embeddingmodel.js` both declared
`DEFAULT_CONFIG`, and it surfaced only when the modules were injected into Chrome
(`Identifier 'DEFAULT_CONFIG' has already been declared`). `globals_test.js` now
fails on any cross-module collision and also evaluates all modules concatenated in
one scope, so this class of bug is caught in a second rather than in the field.
Prefix top-level names (`VECTOR_STORE_DEFAULTS`, not `DEFAULT_CONFIG`).

Measurement still outstanding (code is in place, numbers are not):
- ⬜ Extraction cost measured over a full citable site sample (§6) — harness is
  ready (`npm run bench`); needs a Tranco slice and a recorded snapshot date
- ⬜ Accuracy cost of `fullyLocal` mode quantified vs. a network backend (§7)
- ⬜ Similarity thresholds calibrated against real revisit/near-duplicate pairs —
  the presets are reasoned defaults, not measured ones

### Fixed: severe text under-extraction (found by the benchmark)

The benchmark's first 8-site run showed **5 of 7 text-rich pages yielding < 10% of
their visible text** (median coverage ~1%), with 4 of 8 wrongly tripping
`isImageOnly` — which made Feature B skip the text path entirely.

Cause: `textDensityScore` divided text length by **descendant tag count**, and
`|| 1` meant a leaf with no descendants divided by 1. A 61-char image caption
scored 61 while the 30k-char article, spread over ~4,000 descendant tags, scored
7.5 — so the caption won by ~8×. The metric was structurally biased toward leaves.

Fix: selection now starts at the root (or a semantic container holding most of the
text) and walks *down* only while a single child still holds ≥90% of the non-link
text. That stops exactly where content fans out into sibling paragraphs — the
article container — and can never descend into one caption, since "a single child
holds ~all the text" is precisely what stops being true there. Traversal uses
`textContent` (layout-free); `innerText` is called once on the final selection.

| Page | Before | After | Visible |
|---|---|---|---|
| `en.wikipedia.org/wiki/Espresso` | 10 (a caption) | **4,508** | 4,616 |
| `en.wikipedia.org/wiki/Music` | 237 | **16,837** | 16,846 |
| `plato.stanford.edu/…/consciousness/` | 90 | **23,143** | 23,286 |

Median coverage 1.1% → **97.7%**; under-extraction 5/7 → **0/7**; `isImageOnly`
4/8 → 1/8. The text stage also got *faster* (15.6ms → 11.3ms mean) since
`innerText` no longer forces layout on every candidate.

Known remaining imperfection: **index/homepage** pages (e.g. `bbc.com/news`) have
no single article container, so the walk legitimately stops near `<body>` and some
nav chrome lands in the text (~80-89% coverage). Extra boilerplate hints reduce it;
it is not fully solved, and matters less because such pages have little prose to
characterise anyway.

## Not done

**Threshold calibration.** The presets (0.95 / 0.85 / 0.70) are reasoned defaults
for MiniLM-class models, not measured ones — they need calibration against real
revisit pairs. The benchmark's 0.925 for Espresso↔Music is an artifact of the crude
stub (shared common English words), not a real semantic score; you'd need
`--real-embedding` for a meaningful reading.

**Index pages** (`bbc.com/news`) still leak some nav chrome at 80-89% coverage — no
single article container exists to find. Documented rather than papered over.

Vector Database integration and Similarity Threshold config now live here in
`VectorStore.js` (they were previously deferred to "the storage layer"). The
`flesch`, `isRevisit`, `nearestScore` and `similarPages` fields are emitted but
Feature B's Handoff-1 schema has no slots for them yet — additive and safe; wire
up matching inputs on B's side to actually consume them. `isRevisit` is the
highest-value one: it lets B and C skip an LLM call and a generation entirely.

## Verify

```bash
cd data-extraction
npm install        # jsdom + puppeteer-core (dev only)

npm test           # 110 assertions: globals, VectorStore, buildPageData, Qdrant
                   #   (the Qdrant suite skips cleanly if it isn't running)
npm run play       # eyeball run of all modules incl. full buildPageData() assembly

npm run qdrant:up  # optional: real vector DB (Docker), then `npm test` covers it
npm run bench -- --limit 8   # real-browser extraction cost (needs Chrome)
```

`npm test` needs no Docker and no network. The Qdrant suite reports that it
skipped rather than passing silently, so an unnoticed skip can't be mistaken for
coverage.

## Source

Based on `WEB2MUSIC_RECS.pdf` — Feature A section (VinnovateIT, 2026).
