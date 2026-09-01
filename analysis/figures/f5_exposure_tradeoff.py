"""F5 — accuracy against exposure: the A7 threshold sweep as a continuous dial.

The plan calls this the money figure for C3, and the reason is that it is not an
operating point but a curve: as the zero-shot abstention gates tighten, more
pages escalate to the LLM, exposure rises, and accuracy moves. Reporting the
whole curve is a stronger contribution than defending one setting.

Three things are marked on it:

* the **shipped operating point** (minScore 0.45, minMargin 0.10);
* the **Pareto front**, since most of the sweep grid is dominated and only the
  front is a real choice;
* **A6**, the local distilled configuration, at exposure exactly zero — the
  point that makes the curve reach the axis instead of stopping short of it.
"""

from __future__ import annotations

from analysis.registry import Artefact
from analysis.figures import _common as C
from analysis.figures._s2 import s2_results_path, smoke_warning

ARTEFACT = Artefact(
    id="F5",
    kind="figure",
    title="Accuracy vs exposure trade-off (A7 sweep)",
    section="5.2",
    priority=1,
    metrics=["macro_f1_category", "exposure_rate", "abstention_rate", "zs_margin"],
    inputs=[s2_results_path()],
    notes="Plan §6 cut order puts this last to be dropped.",
)

SHIPPED = (0.45, 0.10)


def offdevice(rec: dict) -> float:
    """Share of pages whose text left the device **by any route**.

    The metrics dictionary defines ``exposure_rate`` narrowly as
    ``source == "llm"``, which is right for the cost argument and wrong for
    this axis. A5's zero-shot tier runs against a hosted proxy: the page text
    goes to Hugging Face rather than to Groq, but it still goes. Plotting A5 at
    exposure 0.000 would put the shipped cascade on the privacy axis next to
    A6, the configuration that genuinely sends nothing — and that comparison is
    the whole figure.

    So the axis is proxy + LLM, and the LLM-only number stays available in T2
    for the cost discussion.
    """
    if rec.get("total_offdevice_rate") is not None:
        return rec["total_offdevice_rate"]
    return (rec.get("exposure_rate") or 0.0) + (rec.get("zero_shot_proxy_rate") or 0.0)


def pareto(points):
    """Maximal macro-F1 at minimal exposure. points: [(exposure, f1, meta)]"""
    front = []
    for p in sorted(points, key=lambda p: (p[0], -p[1])):
        if not front or p[1] > front[-1][1]:
            front.append(p)
    return front


def build(ctx):
    path = ARTEFACT.inputs[0]
    data = ctx.load_json(path)
    ctx.metric("exposure_rate")

    sweep = data.get("a7_sweep", [])
    pts = [(offdevice(s), s["macro_f1"], s) for s in sweep if s.get("macro_f1") is not None]

    fig, ax = C.plt.subplots(figsize=(C.COL_W, 2.5))

    if pts:
        ax.scatter([p[0] for p in pts], [p[1] for p in pts], s=16, color=C.FAINT, alpha=0.65,
                   label="A7 grid", zorder=2)
        front = pareto(pts)
        ax.plot([p[0] for p in front], [p[1] for p in front], "-", color=C.PALETTE[0], lw=1.3,
                label="Pareto front", zorder=3)

    ship = next((s for s in sweep if abs(s["minScore"] - SHIPPED[0]) < 1e-9
                 and abs(s["minMargin"] - SHIPPED[1]) < 1e-9), None)
    if ship:
        ax.scatter([offdevice(ship)], [ship["macro_f1"]], s=52, marker="*",
                   color=C.PALETTE[1], zorder=5, label="shipped (0.45 / 0.10)")

    # A1..A6 configurations as reference points on the same axes.
    ref = []
    for c in data.get("configs", []):
        if c.get("macro_f1") is None:
            continue
        ref.append((offdevice(c), c["macro_f1"], c["name"]))
    for x, y, name in ref:
        tag = name.split()[0]
        marker = "D" if tag == "A6" else "o"
        colour = C.PALETTE[2] if tag == "A6" else C.PALETTE[3]
        ax.scatter([x], [y], s=26, marker=marker, facecolor="none", edgecolor=colour,
                   lw=1.0, zorder=4)
        ax.annotate(tag, (x, y), textcoords="offset points", xytext=(4, 3), fontsize=6,
                    color=colour)

    ax.set_xlabel("total off-device rate\n(LLM + zero-shot proxy)")
    ax.set_ylabel("macro-F1 (13 categories)")
    ax.set_xlim(-0.03, max([p[0] for p in pts] + [r[0] for r in ref] + [0.3]) * 1.15)
    ax.legend(frameon=False, loc="lower right", fontsize=6.2)
    C.save_fig(fig, ctx.path(""))

    warn = smoke_warning(path, data["configs"][0]["n"] if data.get("configs") else 0)
    if warn:
        ctx.path("-caption").with_suffix(".txt").write_text("F5. " + warn, encoding="utf-8")

    return {
        "source": path,
        "smoke": bool(warn),
        "n_grid": len(pts),
        "pareto": [{"exposure": e, "macro_f1": f, "minScore": m["minScore"],
                    "minMargin": m["minMargin"]} for e, f, m in pareto(pts)],
        "shipped_point": ship,
        "shipped_offdevice": offdevice(ship) if ship else None,
        "reference_configs": [{"name": n, "exposure": x, "macro_f1": y} for x, y, n in ref],
        "has_a6": any(n.startswith("A6") for _x, _y, n in ref),
    }
