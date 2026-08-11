"""F4 — confusion matrix for the shipped cascade (A5).

Replays the cascade over the per-page tier results the S2 harness stored, using
the production gates, so the matrix is the shipped system's and not a variant's.
Rows are true categories, columns predicted; the diagonal is normalised by row
so a rare category is not invisible next to a common one.
"""

from __future__ import annotations

from analysis.registry import Artefact
from analysis.figures import _common as C
from analysis.figures._s2 import s2_results_path, smoke_warning

ARTEFACT = Artefact(
    id="F4",
    kind="figure",
    title="Confusion matrix, full cascade (A5)",
    section="5.2",
    priority=5,
    metrics=["macro_f1_category", "escalation_rate"],
    inputs=[s2_results_path()],
)

PROD_MIN_SCORE = 0.45
PROD_MIN_MARGIN = 0.10


def cascade(r, min_score=PROD_MIN_SCORE, min_margin=PROD_MIN_MARGIN, zero_shot=True):
    """Mirror of simulateCascade() in s2_tier_ablation.js."""
    if r.get("isSensitive"):
        return (r["keyword"].get("primary") or "Entertainment", "skipped-sensitive")
    if r["keyword"].get("primary") and not r.get("langSkipsKeyword"):
        return (r["keyword"]["primary"], "keyword")
    zs = r.get("zeroShot")
    if zero_shot and zs and zs["score"] >= min_score and zs["margin"] >= min_margin:
        return (zs["category"], "zero-shot")
    if r.get("llm"):
        return (r["llm"], "llm")
    return ("Entertainment", "default")


def build(ctx):
    path = ARTEFACT.inputs[0]
    data = ctx.load_json(path)
    ctx.metric("macro_f1_category")
    pages = data["per_page"]

    labels = sorted({p["true_category"] for p in pages if p.get("true_category")} |
                    {cascade(p)[0] for p in pages})
    idx = {l: i for i, l in enumerate(labels)}
    k = len(labels)
    counts = [[0] * k for _ in range(k)]
    for p in pages:
        t = p.get("true_category")
        if not t:
            continue
        counts[idx[t]][idx[cascade(p)[0]]] += 1

    norm = []
    for row in counts:
        s = sum(row)
        norm.append([v / s if s else 0.0 for v in row])

    size = max(2.6, 0.34 * k + 1.3)
    fig, ax = C.plt.subplots(figsize=(min(C.FULL_W, size + 1.1), size))
    im = ax.imshow(norm, cmap="Blues", vmin=0, vmax=1, aspect="equal")
    ax.set_xticks(range(k))
    ax.set_yticks(range(k))
    ax.set_xticklabels(labels, rotation=55, ha="right", fontsize=6)
    ax.set_yticklabels(labels, fontsize=6)
    ax.set_xlabel("predicted")
    ax.set_ylabel("true")
    ax.grid(visible=False)
    for i in range(k):
        for j in range(k):
            if counts[i][j]:
                ax.text(j, i, counts[i][j], ha="center", va="center", fontsize=5.5,
                        color="white" if norm[i][j] > 0.55 else C.INK)
    fig.colorbar(im, ax=ax, fraction=0.045, pad=0.03, label="row-normalised")
    C.save_fig(fig, ctx.path(""))

    warn = smoke_warning(path, len(pages))
    if warn:
        ctx.path("-caption").with_suffix(".txt").write_text("F4. " + warn, encoding="utf-8")

    # The pairs a reviewer will ask about.
    off = sorted(((counts[i][j], labels[i], labels[j]) for i in range(k) for j in range(k) if i != j),
                 reverse=True)[:6]
    return {
        "source": path,
        "smoke": bool(warn),
        "labels": labels,
        "counts": counts,
        "n": len(pages),
        "top_confusions": [{"true": t, "pred": p, "n": c} for c, t, p in off if c],
    }
