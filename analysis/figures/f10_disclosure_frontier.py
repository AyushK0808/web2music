"""F10 -- macro-F1 against total off-device rate, with the local-gate frontier.

Standalone script (like F9). Replays the cascade over the stored per-page tier
outputs in s2-ablation-a6-full.json -- the same pure replay as
``simulateCascade`` in mood-classification/experiments/s2_tier_ablation.js --
sweeping the local zero-shot stage's gate (minScore x minMargin) of A6b. The
hosted-gate sweep (A7) and the A1-A6b points are read from the file as stored.

Run from the repo root:
    python -m analysis.figures.f10_disclosure_frontier
"""

from __future__ import annotations

import json
from pathlib import Path

from analysis.figures import _common as C

REPO = Path(__file__).resolve().parent.parent.parent
IN_PATH = REPO / "mood-classification" / "results" / "s2-ablation-a6-full.json"
OUT_PATH = REPO / "paper" / "figures" / "frontier"

MIN_SCORES = [round(0.05 * i, 2) for i in range(19)]
MIN_MARGINS = [0.0, 0.05, 0.10, 0.20]


def decide(r, min_score, min_margin):
    if r["isSensitive"]:
        return r["keyword"]["primary"] or "Entertainment", "skipped-sensitive"
    if r["keyword"]["primary"] and not r["langSkipsKeyword"]:
        return r["keyword"]["primary"], "keyword"
    zs = r.get("zeroShotLocal")
    if zs and zs["score"] >= min_score and zs["margin"] >= min_margin:
        return zs["category"], "zero-shot"
    if r["llm"]:
        return r["llm"], "llm"
    return "Entertainment", "default"


def macro_f1(pairs, categories):
    per = {c: [0, 0, 0] for c in categories}
    for truth, pred in pairs:
        if pred == truth:
            per[truth][0] += 1
        else:
            per[truth][2] += 1
            if pred in per:
                per[pred][1] += 1
    f1s = []
    for tp, fp, fn in per.values():
        if tp + fp + fn == 0:
            continue
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        f1s.append(2 * p * r / (p + r) if p + r else 0.0)
    return sum(f1s) / len(f1s)


def local_gate(pages, categories, min_score, min_margin):
    out = [decide(r, min_score, min_margin) for r in pages]
    pairs = [(r["true_category"], c) for r, (c, _) in zip(pages, out) if r["true_category"]]
    # The local stage sends nothing, so only LLM decisions leave the device.
    off = sum(s == "llm" for _, s in out) / len(pages)
    return off, macro_f1(pairs, categories)


def upper_frontier(points):
    best, front = -1.0, []
    for x, y in sorted(points):
        if y > best:
            front.append((x, y))
            best = y
    return front


def build():
    data = json.loads(IN_PATH.read_text(encoding="utf-8"))
    pages = data["per_page"]
    categories = sorted({p["true_category"] for p in pages if p["true_category"]})
    configs = {c["name"].split()[0]: c for c in data["configs"]}

    grid = [local_gate(pages, categories, s, m) for s in MIN_SCORES for m in MIN_MARGINS]
    front = upper_frontier(grid)

    fig, ax = C.plt.subplots(figsize=(C.COL_W, 2.45))
    hosted, local = C.PALETTE[0], C.PALETTE[2]

    ax.scatter([s["exposure_rate"] + s["zero_shot_proxy_rate"] for s in data["a7_sweep"]],
               [s["macro_f1"] for s in data["a7_sweep"]],
               s=14, color=C.FAINT, zorder=3, label="hosted gate sweep")
    ax.plot([x for x, _ in front], [y for _, y in front], "o-", ms=3.5, lw=1.3, color=local,
            zorder=2, label="local gate sweep, frontier")

    for key in ("A1", "A2", "A3", "A4", "A5"):
        c = configs[key]
        ax.scatter(c["total_offdevice_rate"], c["macro_f1"], s=36, color=hosted, zorder=4,
                   label="A1–A5 (hosted or none)" if key == "A1" else None)
    for key in ("A6", "A6b"):
        c = configs[key]
        ax.scatter(c["total_offdevice_rate"], c["macro_f1"], s=40, marker="D", color=local,
                   zorder=5, label="A6, A6b (local zero-shot)" if key == "A6" else None)

    offsets = {"A1": (6, -3), "A2": (-14, -10), "A3": (-12, 6), "A4": (6, 0),
               "A5": (6, -10), "A6": (6, -3), "A6b": (-12, 6)}
    for key, (dx, dy) in offsets.items():
        c = configs[key]
        ax.annotate(key, (c["total_offdevice_rate"], c["macro_f1"]), xytext=(dx, dy),
                    textcoords="offset points", fontsize=7.5, fontweight="bold",
                    color=local if key.startswith("A6") else hosted)

    a4, a6b = configs["A4"], configs["A6b"]
    ax.annotate("", xy=(a6b["total_offdevice_rate"] + 0.02, a6b["macro_f1"]),
                xytext=(a4["total_offdevice_rate"] - 0.02, a4["macro_f1"]),
                arrowprops={"arrowstyle": "->", "color": local, "lw": 1.1})
    cut = 1 - a6b["total_offdevice_rate"] / a4["total_offdevice_rate"]
    ax.text((a4["total_offdevice_rate"] + a6b["total_offdevice_rate"]) / 2, 0.735,
            f"−{cut:.0%} off-device,\nsame macro-F1", ha="center", va="bottom",
            fontsize=7, color=local)

    ax.set_xlim(-0.04, 1.06)
    ax.set_ylim(0.28, 0.80)
    ax.set_xlabel("total off-device rate (hosted zero-shot + LLM)")
    ax.set_ylabel("macro-F1, 13 categories")
    ax.legend(frameon=False, loc="lower right", fontsize=6.5, handletextpad=0.3,
              borderaxespad=0.2, labelspacing=0.3)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    C.save_fig(fig, OUT_PATH)

    result = {"frontier": [{"offdevice": round(x, 3), "macro_f1": round(y, 3)} for x, y in front]}
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    build()
