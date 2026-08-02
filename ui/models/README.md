# Vendored embedding model

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

The ONNX WASM runtime itself (`ort-wasm*.wasm`, `transformers.min.js`) lives in
`ui/onnx/` and comes from `node_modules/@xenova/transformers/dist/` — re-copy
it after any `@xenova/transformers` version bump:

```bash
cp node_modules/@xenova/transformers/dist/ort-wasm*.wasm ui/onnx/
cp node_modules/@xenova/transformers/dist/transformers.min.js ui/onnx/
```
