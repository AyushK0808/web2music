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

## Zero-shot page-type model

`ui/src/zeroshot.worker.js` backs Feature B's tier-1.5 page-type classifier
(`mood-classification/feature_b/b1_zeroShotCategory.js`).

* The tier is **off by default** — with `zeroShotEnabled` unset, this worker is
  never even spawned, and B1 runs the same keyword → LLM cascade it always has.
* The checkpoint the tier is written against, `facebook/bart-large-mnli`, is
  ~1.6 GB (~400 MB quantized). Committing that to the repo, or downloading it
  on install, is not a reasonable default for an extension — so the full model
  is served by the **proxy backend** instead (`services/classify`'s
  `POST /v1/zero-shot`, HF token held server-side).
* The **local backend** downloads a checkpoint from the hub on first use
  (`allowRemoteModels: true`, the one place in the extension that fetches a
  model at runtime — `embed.worker.js`'s `allowRemoteModels` stays `false`).

**Default local checkpoint: `Xenova/nli-deberta-v3-xsmall`.** The shipped
default used to be `Xenova/distilbart-mnli-12-1`; that repo (and its `-12-3`
sibling) now return **401 Unauthorized** to anonymous downloads — gated or
removed upstream, not a network issue on any particular machine
(`curl -o /dev/null -w '%{http_code}' https://huggingface.co/api/models/Xenova/distilbart-mnli-12-1`
returns 401 while the same check against `Xenova/all-MiniLM-L6-v2` returns
200). The local backend was therefore **silently dead in production**: every
first classification failed the model download and fell through to the LLM
tier without anyone noticing. `nli-deberta-v3-xsmall` is confirmed live,
loads in ~9.5 s, and classifies in ~420 ms for a full 13-label pass.

### Opt-in alternative: `valhalla/distilbart-mnli-12-1` (not vendored, not the default)

The **original** (non-mirror) checkpoint the dead `Xenova/distilbart-mnli-12-1`
was converted from, re-exported to quantized ONNX and published as
**[`AyushK0808/distilbart-mnli-12-1-onnx`](https://huggingface.co/AyushK0808/distilbart-mnli-12-1-onnx)**.
Not wired in as the default, for reasons below, but selectable via
`W2M_ZEROSHOT_MODEL`.

It is **not** vendored in this repo the way `all-MiniLM-L6-v2` is: at 215 MB the
ONNX file is past GitHub's hard 100 MB per-file push limit, so it lives on the
Hub and `ui/models/valhalla/` is gitignored. Fetch it into the tree — where
`allowLocalModels` will prefer it over the hub — with:

```bash
hf download AyushK0808/distilbart-mnli-12-1-onnx \
  --local-dir ui/models/valhalla/distilbart-mnli-12-1
```

**Converting it required working around three real bugs**, all unrelated to
this specific checkpoint and worth knowing about if converting anything else
in this environment (Python 3.14 / torch 2.12 / Windows):

1. The PyPI `optimum`/`optimum-onnx` wheels are missing core exporter files
   regardless of version pairing (confirmed empty `exporters/onnx/` tree).
   Fix: install `optimum` from GitHub source at a matching tag, not from PyPI.
2. Python 3.14 made `functools.partial` a descriptor, which breaks `optimum`'s
   `NORMALIZED_CONFIG_CLASS = SomeConfig.with_args(...)` pattern — accessing it
   via an instance now silently binds `self` as an extra positional argument.
   Fix: `mood-classification/experiments/_optimum_py314_shim.py`.
3. torch 2.12's `torch.onnx.export` defaults to the newer, symbolic-shape-
   proving `torch.export` tracer, which correctly *refuses* to trace
   `BartForSequenceClassification` as shipped — its EOS-token pooling
   (`hidden_states[input_ids.eq(eos_token_id), :]`) is genuinely
   value-dependent. Forcing the legacy tracer instead "succeeds" by silently
   baking in wrong trace-time assumptions (verified: confidently backwards
   entailment/contradiction logits on real inputs, present even in fp32,
   before any quantization). The real fix is
   `mood-classification/experiments/_bart_seqcls_onnx_patch.py`, which
   replaces the pooling with a static equivalent
   (`attention_mask.sum(dim=1) - 1`, numerically verified identical to the
   original, max diff 0.0) — that's what lets the *proving* tracer succeed
   instead of the *silently-wrong* one.

Re-run or convert a different checkpoint with:

```bash
python mood-classification/experiments/convert_bart_mnli_to_onnx.py \
  --model valhalla/distilbart-mnli-12-1
```

**Why this isn't the default: quantization tradeoff, measured.** INT8 dynamic
quantization measurably hurts this checkpoint — a 7-sentence full 13-way
ranking check against eager PyTorch fp32 ground truth:

| Variant | Size | Correct |
|---|---|---|
| fp32 | 890 MB | 7/7 |
| int8, per-tensor | 224 MB | 0/7 — near-uniform scores, unusable |
| int8, per-channel | 224 MB | 5/7 — weaker margins, real degradation |

fp32 is too large to ship; per-channel int8 (what's published) is usable but
degraded, and on the same spot check scored roughly comparable to the
much-smaller shipped default (`nli-deberta-v3-xsmall`, 3/7 on the same
sentences — small-sample, not a rigorous benchmark either way). Given that,
swapping the shipped default for a ~10x larger download without a clear
accuracy win isn't justified; it's published as a documented, opt-in
alternative instead.

Switch the local backend's checkpoint at runtime without rebuilding by setting
`zeroShotModel` in `chrome.storage.local`; see `ui/src/background.entry.js`.

## ONNX runtime

The ONNX WASM runtime itself (`ort-wasm*.wasm`, `transformers.min.js`) lives in
`ui/onnx/` and comes from `node_modules/@xenova/transformers/dist/` — re-copy
it after any `@xenova/transformers` version bump:

```bash
cp node_modules/@xenova/transformers/dist/ort-wasm*.wasm ui/onnx/
cp node_modules/@xenova/transformers/dist/transformers.min.js ui/onnx/
```
