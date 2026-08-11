"""F7 — fit ratings by condition: violin plus per-participant lines.

The per-participant lines are not decoration. The claim in C1 is a
within-subjects contrast (ADAPTIVE − SHUFFLED), and a violin alone shows the
marginal distributions of a comparison that was never marginal. Faint lines
connecting each participant's four means show the reader the paired structure
the model actually uses.

Consumes the tidy export written by ``analysis/s4/export_s4.mjs`` (C-13).
"""

from __future__ import annotations

import collections
import statistics

from analysis.registry import Artefact
from analysis.figures import _common as C

ARTEFACT = Artefact(
    id="F7",
    kind="figure",
    title="Fit ratings by condition",
    section="5.4",
    priority=2,
    metrics=["fit_rating", "liking_rating", "shuffle_near_miss_rate"],
    inputs=["analysis/out/s4_tidy.json"],
)

ORDER = ["SILENCE", "PLAYLIST", "SHUFFLED", "ADAPTIVE"]


def build(ctx):
    rows = ctx.load_json(ARTEFACT.inputs[0])["responses"]
    ctx.metric("fit_rating")

    # A fit rating under SILENCE is undefined, not missing: there was no music
    # to suit the page. Conditions with no ratings are dropped from the figure
    # and named in the caption, rather than plotted as an empty violin or —
    # worse — imputed to the scale midpoint, which would read as "the silent
    # condition was judged averagely appropriate".
    all_conditions = [c for c in ORDER if any(r["condition"] == c for r in rows)]
    by_cond_all = {c: [r["fit"] for r in rows if r["condition"] == c and r.get("fit") is not None]
                   for c in all_conditions}
    conditions = [c for c in all_conditions if by_cond_all[c]]
    omitted = [c for c in all_conditions if not by_cond_all[c]]
    by_cond = {c: by_cond_all[c] for c in conditions}
    if not conditions:
        raise ValueError("no condition has any fit ratings — F7 has nothing to draw")
    per_pt = collections.defaultdict(dict)
    for c in conditions:
        vals = collections.defaultdict(list)
        for r in rows:
            if r["condition"] == c and r.get("fit") is not None:
                vals[r["participant"]].append(r["fit"])
        for pid, vs in vals.items():
            per_pt[pid][c] = statistics.fmean(vs)

    fig, ax = C.plt.subplots(figsize=(C.COL_W, 2.5))
    xs = range(1, len(conditions) + 1)
    parts = ax.violinplot([by_cond[c] for c in conditions], positions=list(xs), showextrema=False,
                          widths=0.8)
    for b in parts["bodies"]:
        b.set_facecolor(C.PALETTE[0])
        b.set_alpha(0.22)
        b.set_edgecolor("none")

    for pid, means in per_pt.items():
        ys = [means.get(c) for c in conditions]
        if any(y is None for y in ys):
            continue
        ax.plot(list(xs), ys, "-", color=C.FAINT, lw=0.4, alpha=0.45, zorder=2)

    for i, c in enumerate(conditions, start=1):
        med = statistics.median(by_cond[c])
        ax.plot([i - 0.28, i + 0.28], [med, med], "-", color=C.PALETTE[1], lw=1.8, zorder=4)

    ax.set_xticks(list(xs))
    ax.set_xticklabels(conditions, fontsize=6.8)
    ax.set_ylabel("fit rating (1–7)")
    ax.set_ylim(0.6, 7.4)
    C.save_fig(fig, ctx.path(""))

    if omitted:
        ctx.path("-caption").with_suffix(".txt").write_text(
            "F7. " + ", ".join(omitted) + " carries no fit rating by design — there was no music "
            "to judge — so it is absent from this figure rather than plotted as an empty or "
            "imputed distribution. It still appears in T4, where comprehension and workload are "
            "defined for it.", encoding="utf-8")

    summary = {c: C.summary(by_cond[c]) for c in conditions}
    contrast = None
    if "ADAPTIVE" in per_pt.get(next(iter(per_pt), ""), {}) or True:
        paired = [(m["ADAPTIVE"], m["SHUFFLED"]) for m in per_pt.values()
                  if "ADAPTIVE" in m and "SHUFFLED" in m]
        if len(paired) > 1:
            diffs = [a - s for a, s in paired]
            sd = statistics.stdev(diffs)
            contrast = {
                "n_pairs": len(paired),
                "mean_difference": statistics.fmean(diffs),
                "dz": (statistics.fmean(diffs) / sd) if sd else None,
                "note": "Descriptive only. The confirmatory test is the CLMM in analysis/s4/models.R.",
            }

    return {"n_responses": len(rows), "conditions": conditions,
            "conditions_without_fit_ratings": omitted, "by_condition": summary,
            "adaptive_minus_shuffled": contrast, "n_participants": len(per_pt)}
