# WEB2MUSIC — Feature A: Site Data Extraction & Similarity Engine

Content-script modules implementing the first three components of Feature A
from the WEB2MUSIC research guide.

## Files

| File | Purpose |
|---|---|
| `textExtractor.js` | Extracts clean, boilerplate-free article text from the page DOM (nav/footer/ad stripping + text-density scoring) before it's embedded. |
| `embeddingModel.js` | Converts cleaned text into a semantic embedding vector, with a switchable backend: OpenAI `text-embedding-3-small` (1536-dim, API) or `all-MiniLM-L6-v2` (384-dim, local/in-browser via Transformers.js). Also exposes `cosineSimilarity()` for cache-hit comparisons. |
| `colorExtractor.js` | Extracts dominant page hues using area-weighted HSL histogram bucketing over computed CSS background colors, plus an overall `colorEnergy` score. |

## Usage

Load the scripts as part of the extension's content-script bundle (or via a
bundler import), then call them in sequence:

```js
const { extractPageText } = window.Web2MusicTextExtractor;
const { getEmbedding, cosineSimilarity } = window.Web2MusicEmbedding;
const { extractDominantColors } = window.Web2MusicColorExtractor;

const page = extractPageText();
const embedding = await getEmbedding(page.mainText, { backend: 'local' });
const colors = extractDominantColors();

// embedding.vector -> query against ChromaDB / Supabase pgvector
// colors.colorEnergy -> one of the normalized signals in the feature vector
```

## Config

`embeddingModel.js` reads a config object per call (no hardcoded defaults
baked into behavior beyond `DEFAULT_CONFIG`):

```js
{
  backend: 'local' | 'openai',
  openaiModel: 'text-embedding-3-small',
  openaiApiKey: null,        // set via extension settings, never hardcode
  localModel: 'Xenova/all-MiniLM-L6-v2',
  maxInputChars: 8000
}
```

The `local` backend expects `@xenova/transformers` to be bundled and exposed
as `window.transformersPipeline`.

## Changelog — review fixes applied

- `textExtractor.js`: `textDensityScore` now falls back to `textContent`
  when `innerText` is unavailable (fixes jsdom test environments always
  scoring 0).
- `textExtractor.js`: `extractPageText` null-guards `doc.body` and returns
  an empty result instead of throwing (fixes crash on frameset pages /
  pre-DOM-ready calls).
- `textExtractor.js`: `extractMetadata()` restored (`description` +
  `lang` extraction, with `og:`/`twitter:` description fallbacks and
  `<html lang>` → `content-language` meta → `'en'` fallback for lang).
  This was accidentally dropped while applying the two fixes above —
  `pageData.js` forwards both fields and `b1_contentUnderstanding.js`
  consumes them, and the §2.1/§3.1 lang-gating roadmap items depend on
  `lang` being extracted, not removed.
- `embeddingModel.js`: `embedWithOpenAI` now wraps its fetch in an
  `AbortController` with a configurable `fetchTimeoutMs` (default 8000ms,
  matching Feature B's convention) instead of hanging indefinitely.
- `embeddingModel.js`: a rejected `localPipelinePromise` is now cleared
  instead of being cached forever, so a transient model-load failure
  doesn't permanently break the local backend.
- `embeddingModel.js`: added `buildCacheKey(url, textHash, backend, model)`
  — `pageData.js` should use this instead of hashing `url + text` alone,
  since a 384-dim local vector and a 1536-dim OpenAI vector are not
  interchangeable.
- `textExtractor.js`: boilerplate matching switched from substring
  (`identifier.includes(hint)`, `[class*="hint"]`) to whitespace-tokenized
  whole-word matching (`classOrIdTokens()` + `stripHintedElements()`). Fixes
  false positives where `ad` matched `shadow`/`gradient`/`download`/`badge`/
  `loading`, and `menu` matched `document-menu` content wrappers.

- `syllableCounter.js` (new): shared syllable-counting heuristic. Both
  `Readability.js` and `b1_contentUnderstanding.js` now import this same
  function instead of maintaining separate copies that quietly drifted —
  empty word now returns `0` in both places (previously `Readability.js`
  returned `0` and `b1_contentUnderstanding.js` returned `1`).
- `Readability.js` (new): Flesch-Kincaid reading-complexity scorer.
  `scoreReadingComplexity(text, lang)` returns the neutral default (`0.5`)
  when `lang !== 'en'`, since Flesch is an English-only formula and scoring
  other languages with it is meaningless.
- `b1_contentUnderstanding.js` (new, Feature B stub): only the piece the
  review flagged — imports the shared `syllableCounter` instead of a local
  copy. The rest of B1 (keyword extraction, summarization) isn't built here.
- `pageData.js` (new): Feature A orchestrator. Runs text extraction → color
  extraction → reading-complexity scoring → embedding, with a cache lookup
  keyed via `buildCacheKey(url, textHash, backend, model)` — fixes the
  stale-wrong-model-vector bug from keying on `url + text-hash` alone. Also
  records per-stage timings and stage failures (feeds §6 systems eval), and
  only caches on a successful embedding (a failed embed is never cached
  under a real key, so it can't poison future lookups).
- `docker/embedService.js` (new): local embedding proxy. Binds to
  `127.0.0.1` only (never `0.0.0.0`), requires a `X-Embed-Secret` header
  checked with `crypto.timingSafeEqual`, restricts CORS to a configured
  extension origin instead of `*`, and `req.destroy()`s connections that
  exceed the 1MB body cap instead of just rejecting the promise.
- `behaviorTracker.js` (new): starts tracking at construction (content-script
  init), not lazily on first event — fixes the first Feature B handoff
  always reporting zero activity. Listens for `scroll`/`touchmove` with
  `{capture: true}` so nested scrollable containers and touch scroll are
  caught (scroll doesn't bubble, only capture-phase sees it on
  descendants); tracks horizontal scroll alongside vertical via `Math.hypot`.
- `colorExtractor.js`: re-added `MAX_ELEMENTS_TO_SAMPLE` (800) with an
  evenly-spaced `sampleElements()` step before the `getComputedStyle` +
  `getBoundingClientRect` pass, capping forced-layout cost on large DOMs.
  `extractDominantColors()` returns `sampledCount`/`totalElementCount` for
  extraction-cost telemetry.

## Declared limitations (not fixed — by design tradeoff)

- **Color extraction sees only `background-color`.** No background images,
  gradients, or `<img>` content are read, so photo-heavy pages read as
  achromatic. `parseRgba()` only handles `rgb()`/`rgba()` — not hex, named
  colors, or `oklch()`. Overlapping elements double-count area (no
  occlusion/z-index handling). Treat `colorEnergy` and `dominantHues` as a
  **hue-bias signal**, not ground truth about a page's actual visual palette.
- **Behavioral speeds are coarse proxies for affect.** Scroll/cursor px/s
  are measurable but the inference from e.g. "fast scrolling" to "tense" or
  "doomscrolling" is an unvalidated hypothesis, not an established mapping
  — this should be stated explicitly wherever these signals are used
  downstream (Feature B's mood classifier), not implied as fact.

## Not yet fixed / still open

- **§7 Fully-local-mode ablation** — tier-1-only heuristics + local
  embeddings, with the accuracy cost vs. the full pipeline quantified as a
  publishable privacy-utility tradeoff. This is an experiment-design task,
  not a code fix — needs a config flag to force fully-local mode plus an
  evaluation harness, and should be scoped as its own piece of work.
- **Telemetry is partially wired.** `pageData.js` records per-stage
  `timings` and `failures`, but nothing persists or aggregates them yet
  for the §6 systems-eval report.
- **No test suite.** Needs a `node:test` + `assert` suite (jsdom is already
  a devDependency per the roadmap) covering the pure functions across
  these files plus DOM-integration cases via jsdom.
- **Per-stage extraction latency + failure-rate telemetry.** Needs to live
  in the orchestrator (`pageData.js`), timing each stage
  (text extraction → color extraction → embedding) and recording
  success/failure — feeds the paper's §6 systems evaluation.

## Status

Implements suggestions table rows 1–3 for Feature A:
- Text Extraction
- Embedding Model
- Colour Extraction

Not yet implemented from the same table: Flesch Scorer, Feature Vector
Assembly, Vector Database integration, Similarity Threshold config,
Performance Budget (debounce/requestIdleCallback), Non-Text Page fallback.

## Source

Based on `WEB2MUSIC_RECS.pdf` — Feature A section (VinnovateIT, 2026).