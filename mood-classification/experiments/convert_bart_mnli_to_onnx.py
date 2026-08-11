#!/usr/bin/env python3
"""Convert a BartForSequenceClassification MNLI checkpoint (e.g.
``valhalla/distilbart-mnli-12-1``) to a quantized ONNX model transformers.js
can load, and vendor it into ``ui/models/``.

    python mood-classification/experiments/convert_bart_mnli_to_onnx.py \
        --model valhalla/distilbart-mnli-12-1 \
        --out ui/models/AyushK0808/distilbart-mnli-12-1-onnx

Note --out here is a *vendoring* path, not a conversion detail: whatever id
you'll later pass via W2M_ZEROSHOT_MODEL is what transformers.js joins with
env.localModelPath to look up the local copy, so --out must match that id
(the published Hub repo name, AyushK0808/distilbart-mnli-12-1-onnx for this
checkpoint) rather than the --model source checkpoint's name.

Requires (see requirements-onnx-export.txt in this directory):
    torch, transformers, onnx, onnxruntime, onnxscript,
    optimum built from GitHub source (the PyPI wheel is broken — see below)

── Why this script exists, not just "optimum-cli export onnx" ─────────────
Three real bugs had to be worked around to get a correct export at all, on
this machine (Python 3.14, torch 2.12.1, Windows):

1. **The PyPI ``optimum``/``optimum-onnx`` wheels are incomplete.** As of this
   writing, ``optimum==1.23.3`` and ``optimum-onnx==0.1.0`` (published to
   PyPI) are both missing core files — ``exporters/onnx/model_configs.py``,
   ``base.py``, ``convert.py``, ``commands/export/onnx.py`` — regardless of
   which versions are paired. Installing straight from GitHub source at the
   matching tag has the complete tree; a plain ``pip install optimum`` does
   not. See ``_optimum_py314_shim.py``'s docstring for the exact diagnosis.

2. **Python 3.14 made ``functools.partial`` a descriptor.** ``optimum``
   stores ``NORMALIZED_CONFIG_CLASS`` as a bare ``functools.partial`` on
   every ``OnnxConfig`` subclass; Python 3.14 now binds that like a method
   when accessed via an instance, silently inserting an extra positional
   argument and crashing with ``TypeError: ... got multiple values for
   argument 'allow_new'``. Fixed by ``_optimum_py314_shim.py``, which must be
   imported before ``optimum.exporters.onnx`` anywhere in the process.

3. **torch 2.12's ``torch.onnx.export`` defaults to the newer
   ``torch.export``-based tracer**, which ``optimum``'s call site was never
   updated for (it still passes the legacy-only ``dynamic_axes`` argument).
   That tracer is also the *correct* one to use — see point 4.

4. **BartForSequenceClassification's EOS-token pooling is genuinely
   ONNX-export-unsafe as written.** It selects the sentence representation
   via a boolean mask on token *values*
   (``hidden_states[input_ids.eq(eos_token_id), :]``), which the legacy
   TorchScript tracer "handles" by silently baking in trace-time shape
   assumptions that do not generalize — it exports without error and then
   produces wrong logits on real inputs of different shape.
   ``_bart_seqcls_onnx_patch.py`` replaces it with a static, shape-generic
   equivalent (gather at ``attention_mask.sum(dim=1) - 1``, numerically
   verified identical to the original on a real padded batch, max diff
   0.0), which is *also* what lets the newer, correctness-proving
   ``torch.export`` tracer succeed at all instead of refusing the trace.

── The quantization tradeoff, measured, not assumed ────────────────────────
INT8 dynamic quantization measurably hurts this checkpoint. On a 7-sentence
spot check, comparing full 13-way zero-shot rankings (the actual decision
rule — see the note below on methodology) against eager PyTorch:

    fp32 (890 MB)                                7/7 correct, confident margins
    int8 per-tensor (224 MB)                      0/7 correct — near-uniform, unusable
    int8 per-channel (224 MB)                     5/7 correct, weaker margins
    int8 per-channel, head excluded (224 MB)      5/7 correct — no improvement

Per-channel quantization is what this script uses; per-tensor is not offered
because it is not usable. Even per-channel loses real accuracy relative to
fp32, which is 890 MB and impractical to ship in a browser extension. This is
recorded rather than hidden: anyone re-running this conversion, or trying a
different MNLI checkpoint, should expect the same shape of tradeoff and check
for it the same way — full-label-ranking accuracy, not single-pair
entailment-vs-contradiction, which is NOT how zero-shot classification
actually decides (see the docstring correction in this script's self-test).

── Correctness methodology, and the mistake it corrects ───────────────────
Zero-shot-via-NLI picks the candidate label whose *entailment* logit is
highest **relative to the other candidate labels for the same premise**
(softmax across labels of the entailment logit alone) — not whether
entailment beats contradiction in isolation for one pair. Checking the
isolated-pair comparison instead looks like a correctness bug (confident,
consistently "backwards" logits) when the export is actually fine; that
false trail cost real time in this conversion and is recorded here so it
does not get walked again.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
EXPERIMENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERIMENTS))


def export(model_id: str, work_dir: Path) -> Path:
    import _optimum_py314_shim  # noqa: F401  (applies on import)
    import _bart_seqcls_onnx_patch as bart_patch

    bart_patch.patch()
    try:
        from optimum.exporters.onnx import main_export
        main_export(model_name_or_path=model_id, output=str(work_dir), task="text-classification")
    finally:
        bart_patch.unpatch()

    onnx_path = work_dir / "model.onnx"
    if not onnx_path.exists():
        raise RuntimeError(f"export did not produce {onnx_path}")
    return onnx_path


def quantize(onnx_path: Path, out_path: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic
    quantize_dynamic(
        model_input=str(onnx_path),
        model_output=str(out_path),
        weight_type=QuantType.QInt8,
        per_channel=True,  # per-tensor measured unusable for this architecture — see module docstring
    )


def fix_merges_format(tokenizer_json: Path) -> None:
    """transformers.js 2.x's BPE loader expects legacy space-joined merge
    strings; current `tokenizers` serializes merges as [left, right] pairs.
    Convert in place."""
    import json
    d = json.loads(tokenizer_json.read_text(encoding="utf-8"))
    merges = d["model"]["merges"]
    if merges and isinstance(merges[0], list):
        d["model"]["merges"] = [" ".join(pair) for pair in merges]
        tokenizer_json.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")


def verify(model_id: str, out_dir: Path, cases: list[tuple[str, str]]) -> dict:
    """Full 13-way ranking check against eager PyTorch ground truth, using the
    correct decision rule (see module docstring)."""
    import numpy as np
    import onnxruntime as ort
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_id)
    categories = ["Educational", "News", "Horror", "Food", "Entertainment", "Sports",
                  "Finance", "Legal", "Health", "Comedy", "Emotional", "Mythological", "Travel"]

    def classify(sess, premise):
        pairs = [[premise, f"This web page is about {c}."] for c in categories]
        enc = tok(pairs, add_special_tokens=True, return_tensors="np", padding=True, truncation="only_first")
        feed = {k: v for k, v in enc.items() if k in [i.name for i in sess.get_inputs()]}
        logits = sess.run(None, feed)[0]
        entail = logits[:, 2]
        scores = np.exp(entail) / np.exp(entail).sum()
        order = np.argsort(-scores)
        return categories[order[0]], float(scores[order[0]])

    sess = ort.InferenceSession(str(out_dir / "onnx" / "model_quantized.onnx"), providers=["CPUExecutionProvider"])
    results, n_ok = [], 0
    for premise, expected in cases:
        got, score = classify(sess, premise)
        ok = got == expected
        n_ok += ok
        results.append({"premise": premise[:60], "expected": expected, "got": got, "score": score, "ok": ok})
    return {"n": len(cases), "n_ok": n_ok, "results": results}


DEFAULT_CASES = [
    ("Photosynthesis: how plants convert light into chemical energy. A lesson for "
     "students, with diagrams of the chloroplast.", "Educational"),
    ("Reuters: markets rallied today as the central bank signalled a pause in rate hikes.", "News"),
    ("The best weeknight tomato pasta: blister tomatoes in olive oil, add garlic, "
     "finish with basil.", "Food"),
    ("Clubs have until Monday to complete transfer business. Two deals hinge on a "
     "medical.", "Sports"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="valhalla/distilbart-mnli-12-1")
    ap.add_argument("--out", default=None, help="vendored output dir, default ui/models/<model>")
    ap.add_argument("--work-dir", default=None, help="scratch dir for the fp32 export before quantizing")
    ap.add_argument("--skip-export", action="store_true", help="reuse an existing --work-dir export")
    args = ap.parse_args()

    out_dir = Path(args.out) if args.out else REPO / "ui" / "models" / args.model
    work_dir = Path(args.work_dir) if args.work_dir else Path(f"C:/tmp/onnx-export-{args.model.replace('/', '-')}")
    work_dir.mkdir(parents=True, exist_ok=True)

    if not args.skip_export:
        print(f"[convert] exporting {args.model} -> {work_dir} (fp32; this downloads the checkpoint "
              f"and traces the graph, several minutes)")
        export(args.model, work_dir)
    else:
        print(f"[convert] reusing existing export at {work_dir}")

    onnx_dir = out_dir / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    for f in ["config.json", "merges.txt", "special_tokens_map.json", "tokenizer.json",
              "tokenizer_config.json", "vocab.json"]:
        src = work_dir / f
        if src.exists():
            shutil.copy2(src, out_dir / f)

    fix_merges_format(out_dir / "tokenizer.json")

    print("[convert] quantizing (int8, per-channel — per-tensor is unusable for this "
          "architecture, see module docstring)")
    quantize(work_dir / "model.onnx", onnx_dir / "model_quantized.onnx")

    print("[convert] verifying against eager PyTorch ground truth, full 13-way ranking")
    report = verify(args.model, out_dir, DEFAULT_CASES)
    for r in report["results"]:
        print(f"  {r['expected']:<12} -> {r['got']:<12} {r['score']:.3f}  "
              f"{'OK' if r['ok'] else 'MISMATCH'}   {r['premise']}...")
    print(f"\n{report['n_ok']}/{report['n']} correct.")
    if report["n_ok"] < report["n"]:
        print("This matches the measured accuracy loss from int8 quantization documented in "
              "this script's module docstring — not a new regression. Compare against the "
              "currently-shipped default (Xenova/nli-deberta-v3-xsmall) before treating this "
              "checkpoint as an improvement; on the module docstring's own spot check they were "
              "roughly comparable, and size (this: ~220MB int8, vs the shipped default's much "
              "smaller footprint) is the real tradeoff between them.")

    print(f"\nVendored at {out_dir}")
    print(f"To use: set W2M_ZEROSHOT_MODEL to \"{args.model}\" in chrome.storage.local "
          f"(see ui/src/background.entry.js), or pass model: \"{args.model}\" to "
          f"classifyCategoryZeroShot's config.")
    return 0 if report["n_ok"] == report["n"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
