"""F6 — seam discontinuity, before and after the crossfade, per mood.

The pre-crossfade value is how large a jump the crossfade had to hide; the
post value is what survives. C6 lives here on the objective side, and §6.6's
prediction — dense moods (energetic, tense) seam worse than sparse ones (calm)
— is exactly what the per-mood split is for.

The second panel carries the finding from the n=141 run that the plan calls out
as needing to appear in §5.3: the median clip retains about half its requested
duration.
"""

from __future__ import annotations

import collections
import statistics

from analysis.registry import Artefact
from analysis.figures import _common as C

ARTEFACT = Artefact(
    id="F6",
    kind="figure",
    title="Seam discontinuity pre/post crossfade, and duration retention",
    section="5.3",
    priority=4,
    metrics=["seam_energy_delta_db", "seam_centroid_delta_hz", "duration_retention", "lufs"],
    inputs=["audio-generation/results/d2-loop.json"],
)


def build(ctx):
    clips = ctx.load_json(ARTEFACT.inputs[0])["clips"]
    ctx.metric("seam_energy_delta_db")

    by_mood = collections.defaultdict(list)
    for c in clips:
        by_mood[c["mood"]].append(c)
    moods = sorted(by_mood, key=lambda m: -abs(statistics.median(
        abs(c["pre_energy_delta_db"]) for c in by_mood[m])))

    fig, (ax, ax2) = C.plt.subplots(1, 2, figsize=(C.FULL_W, 2.6),
                                    gridspec_kw={"width_ratios": [1.55, 1]})

    pre = [[abs(c["pre_energy_delta_db"]) for c in by_mood[m]] for m in moods]
    post = [[abs(c["post_energy_delta_db"]) for c in by_mood[m]] for m in moods]
    xs = range(len(moods))
    bp1 = ax.boxplot(pre, positions=[x - 0.19 for x in xs], widths=0.32, patch_artist=True,
                     showfliers=False, medianprops={"color": C.INK, "lw": 1.0})
    bp2 = ax.boxplot(post, positions=[x + 0.19 for x in xs], widths=0.32, patch_artist=True,
                     showfliers=False, medianprops={"color": C.INK, "lw": 1.0})
    for b in bp1["boxes"]:
        b.set(facecolor=C.PALETTE[4], alpha=0.55, lw=0.6)
    for b in bp2["boxes"]:
        b.set(facecolor=C.PALETTE[2], alpha=0.75, lw=0.6)
    ax.set_xticks(list(xs))
    ax.set_xticklabels(moods, rotation=40, ha="right")
    ax.set_ylabel("|energy delta| across seam (dB)")
    ax.legend([bp1["boxes"][0], bp2["boxes"][0]], ["before crossfade", "after crossfade"],
              frameon=False, loc="upper right")
    ax.set_title("seam discontinuity by mood", loc="left")

    ratios = [c["duration_ratio"] for c in clips if c.get("duration_ratio") is not None]
    ax2.hist(ratios, bins=20, color=C.PALETTE[0], alpha=0.85)
    med = statistics.median(ratios)
    ax2.axvline(med, color=C.PALETTE[1], lw=1.2)
    ax2.text(med, ax2.get_ylim()[1] * 0.94, f" median {med:.3f}", fontsize=6.8, color=C.PALETTE[1],
             ha="left", va="top")
    ax2.set_xlabel("delivered / requested duration")
    ax2.set_ylabel("clips")
    ax2.set_title(f"duration retention (n={len(ratios)})", loc="left")

    C.save_fig(fig, ctx.path(""))

    def stats(key):
        vals = [abs(c[key]) for c in clips]
        return C.summary(vals)

    per_mood = {}
    for m in moods:
        cs = by_mood[m]
        per_mood[m] = {
            "n": len(cs),
            "pre_energy_p50": C.pct([abs(c["pre_energy_delta_db"]) for c in cs], 50),
            "post_energy_p50": C.pct([abs(c["post_energy_delta_db"]) for c in cs], 50),
            "pre_centroid_p50": C.pct([abs(c["pre_spectral_centroid_delta_hz"]) for c in cs], 50),
            "post_centroid_p50": C.pct([abs(c["post_spectral_centroid_delta_hz"]) for c in cs], 50),
            "duration_ratio_p50": C.pct([c["duration_ratio"] for c in cs], 50),
        }

    # The number §5.3 must print next to the pass rate.
    under_20 = sum(1 for r in ratios if r < 0.20) / len(ratios)
    lufs = [c["lufs"] for c in clips if c.get("lufs") is not None]

    header = ["Mood", "n", "|ΔE| pre (dB)", "|ΔE| post (dB)", "|Δcentroid| pre (Hz)",
              "|Δcentroid| post (Hz)", "duration ratio"]
    trows = [[m, per_mood[m]["n"], C.fmt(per_mood[m]["pre_energy_p50"], 2),
              C.fmt(per_mood[m]["post_energy_p50"], 2),
              C.fmt(per_mood[m]["pre_centroid_p50"], 0),
              C.fmt(per_mood[m]["post_centroid_p50"], 0),
              C.fmt(per_mood[m]["duration_ratio_p50"], 3)] for m in moods]
    p = ctx.path("-per-mood")
    C.booktabs(p, caption="Seam discontinuity and duration retention per mood, median values.",
               label="tab:seam-per-mood", header=header, rows=trows)
    C.markdown_table(p, header, trows)

    return {
        "n_clips": len(clips),
        "sources": dict(collections.Counter(c["source"] for c in clips)),
        "pre_energy_db": stats("pre_energy_delta_db"),
        "post_energy_db": stats("post_energy_delta_db"),
        "pre_centroid_hz": stats("pre_spectral_centroid_delta_hz"),
        "post_centroid_hz": stats("post_spectral_centroid_delta_hz"),
        "duration_ratio": C.summary(ratios),
        "duration_ratio_under_0_20": under_20,
        "lufs": C.summary(lufs),
        "per_mood": per_mood,
    }
