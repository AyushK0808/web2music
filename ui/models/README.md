# Vendored models

## Embedding model

`Xenova/all-MiniLM-L6-v2`, quantized ONNX, used by `ui/src/embed.worker.js` for
fully local (zero network call) 384-dim embeddings inside the offscreen
document. Committed to the repo (see root `.gitignore`) so `git clone && npm
install && npm run build` works with no separate download step.

To re-download from scratch:

```bash
mkdir -p ui/models/Xenova/all-MiniLM-L6-v2/onnx
BASE="https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main"
cd ui/models/Xenova/all-MiniLM-L6-v2
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt; do
  curl -sL -o "$f" "$BASE/$f"
done
curl -sL -o "onnx/model_quantized.onnx" "$BASE/onnx/model_quantized.onnx"
```

## Zero-shot page-type model (optional, NOT vendored)

`ui/src/zeroshot.worker.js` backs Feature B's tier-1.5 page-type classifier
(`mood-classification/feature_b/b1_zeroShotCategory.js`). Nothing is committed
for it, and that is deliberate:

* The tier is **off by default** — with `zeroShotEnabled` unset, this worker is
  never even spawned, and B1 runs the same keyword → LLM cascade it always has.
* The checkpoint the tier is written against, `facebook/bart-large-mnli`, is
  ~1.6 GB (~400 MB quantized). Committing that to the repo, or downloading it
  on install, is not a reasonable default for an extension — so the full model
  is served by the **proxy backend** instead (`services/classify`'s
  `POST /v1/zero-shot`, HF token held server-side).
* The **local backend** downloads a distilled MNLI checkpoint
  (`Xenova/distilbart-mnli-12-1`) from the hub on first use. This is the only
  place in the extension that fetches a model at runtime; `allowRemoteModels`
  stays `false` in `embed.worker.js`.

To make the local backend fully offline, vendor a checkpoint here and it will
be preferred over the hub (`allowLocalModels` is already on):

```bash
MODEL="Xenova/distilbart-mnli-12-1"   # or Xenova/bart-large-mnli for the eval
mkdir -p "ui/models/$MODEL/onnx"
BASE="https://huggingface.co/$MODEL/resolve/main"
cd "ui/models/$MODEL"
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json vocab.json merges.txt; do
  curl -sL -o "$f" "$BASE/$f"
done
for f in encoder_model_quantized.onnx decoder_model_merged_quantized.onnx model_quantized.onnx; do
  curl -sfL -o "onnx/$f" "$BASE/onnx/$f" || true   # which files exist varies by checkpoint
done
```

Switch checkpoints without rebuilding by setting `zeroShotModel` in
`chrome.storage.local`; see `ui/src/background.entry.js`.

## ONNX runtime

The ONNX WASM runtime itself (`ort-wasm*.wasm`, `transformers.min.js`) lives in
`ui/onnx/` and comes from `node_modules/@xenova/transformers/dist/` — re-copy
it after any `@xenova/transformers` version bump:

```bash
cp node_modules/@xenova/transformers/dist/ort-wasm*.wasm ui/onnx/
cp node_modules/@xenova/transformers/dist/transformers.min.js ui/onnx/
```
