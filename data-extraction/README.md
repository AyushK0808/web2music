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
