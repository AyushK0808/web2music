"""F8 — in-the-wild: attenuation, transitions per hour, cache hit rate, escalation.

N = 12 with unequal exposure supports description, not inference, so this figure
plots **one dot per participant** on every panel and draws the median as a line.
No error bars, no confidence intervals, no test: the plan is explicit that S5 is
descriptive, and a figure that looks inferential will be read as inferential
regardless of what the caption says.

The escalation panel is the one that answers a question the lab cannot: the S2
corpus is curated and its tier distribution is a guess about which pages occur.
This is the measurement.
"""

from __future__ import annotations

import os

from analysis.registry import Artefact
from analysis.figures import _common as C

DEFAULT = "ui/results/s5-wild.json"
SOURCE = os.environ.get("W2M_S5_RESULTS", DEFAULT)

ARTEFACT = Artefact(
    id="F8",
    kind="figure",
    title="In-the-wild behaviour over the deployment",
    section="5.6",
    priority=7,
    metrics=["attenuation_rate", "cache_hit_rate", "escalation_rate", "exposure_rate",
             "disabled_rate", "disables_per_hour", "skip_rate", "mood_correction_rate"],
    inputs=[SOURCE],
)

PANELS = [
    ("attenuation_rate", "auto-mute / duck\nshare of session"),
    ("transitions_per_hour", "mood transitions\nper hour"),
    ("cache_hit_rate", "cache hit rate"),
    ("tier_escalation_rate", "escalation past\nthe keyword tier"),
    ("llm_exposure_rate", "page text leaving\nthe device"),
    ("disables_per_hour", "voluntary disables\nper hour"),
]


def build(ctx):
    data = ctx.load_json(ARTEFACT.inputs[0])
    ctx.metric("attenuation_rate")
    sessions = data["sessions"]

    fig, axes = C.plt.subplots(1, len(PANELS), figsize=(C.FULL_W, 2.0), sharey=False)
    rng_seed = 7
    values = {}
    for ax, (key, label) in zip(axes, PANELS):
        vals = [s[key] for s in sessions if s.get(key) is not None]
        values[key] = C.summary(vals)
        if vals:
            # deterministic jitter so the same export always draws the same figure
            xs = [0.5 + ((i * 37 + rng_seed) % 21 - 10) / 100 for i in range(len(vals))]
            ax.plot(xs, vals, "o", ms=3.2, color=C.PALETTE[0], alpha=0.75)
            med = C.pct(vals, 50)
            ax.plot([0.30, 0.70], [med, med], "-", color=C.PALETTE[1], lw=1.5)
        ax.set_xlim(0.15, 0.85)
        ax.set_xticks([])
        ax.set_title(label, fontsize=6.6, loc="center")
        ax.tick_params(labelsize=6)
    axes[0].set_ylabel(f"one dot = one participant (n={len(sessions)})", fontsize=6.4)
    C.plt.tight_layout(w_pad=0.6)
    C.save_fig(fig, ctx.path(""))

    smoke = "smoke" in ARTEFACT.inputs[0]
    note = ("F8. Descriptive only: one dot per participant, median as a bar, no intervals and no "
            "tests — N is too small and exposure too unequal for inference.")
    if smoke:
        note += " BUILT FROM A SYNTHETIC SMOKE EXPORT — not a deployment."
    ctx.path("-caption").with_suffix(".txt").write_text(note, encoding="utf-8")

    return {"source": ARTEFACT.inputs[0], "smoke": smoke, "n_sessions": len(sessions),
            "panels": values, "tier_counts": data.get("summary", {}).get("tier_counts")}
