"""F2 — generation latency against requested clip length, with the real-time-factor line.

The plan wants this to answer "does a shorter clip that arrives sooner beat a
longer one that loops sooner". The duration sweep in ``d1-latency-full.json``
answers it only partly: most of its cells were served from cache or fell back,
so the RTF line rests on the handful of requests that actually reached MusicGen.
The figure marks those cells rather than interpolating through them, because an
RTF line drawn through cache hits is a line about the cache.
"""

from __future__ import annotations

import collections

from analysis.registry import Artefact
from analysis.figures import _common as C
from analysis.figures.t1_latency import classify

ARTEFACT = Artefact(
    id="F2",
    kind="figure",
    title="Generation latency vs requested duration, with real-time factor",
    section="5.1",
    priority=6,
    metrics=["rtf", "d_stage_ms", "fallback_rate"],
    inputs=["audio-generation/results/d1-latency-full.json"],
)


def build(ctx):
    data = ctx.load_json(ARTEFACT.inputs[0])
    ctx.metric("rtf")
    rows = [r for r in data["sections"].get("duration", []) if not r.get("aggregate")]

    by_dur = collections.defaultdict(list)
    for r in rows:
        by_dur[r["duration_seconds"]].append(r)

    durations = sorted(by_dur)
    wall_p50, gen_p50, rtf, counts = [], [], [], {}
    for d in durations:
        rs = by_dur[d]
        walls = [r["wall_ms"] for r in rs if "wall_ms" in r]
        gens = [r["timings"]["d3_generate_ms"] for r in rs
                if isinstance(r.get("timings"), dict) and "d3_generate_ms" in r["timings"]]
        wall_p50.append(C.pct(walls, 50) / 1000 if walls else float("nan"))
        gen_p50.append(C.pct(gens, 50) / 1000 if gens else float("nan"))
        rtf.append((C.pct(gens, 50) / 1000 / d) if gens else float("nan"))
        counts[d] = {
            "n": len(rs),
            "n_generated": len(gens),
            "classes": dict(collections.Counter(classify(r) for r in rs)),
        }

    fig, (ax, ax2) = C.plt.subplots(1, 2, figsize=(C.FULL_W, 2.3))

    ax.plot(durations, wall_p50, "o-", color=C.PALETTE[0], label="client wall clock (p50)")
    ax.plot(durations, gen_p50, "s-", color=C.PALETTE[4], label="d3_generate (p50)")
    for d, y in zip(durations, wall_p50):
        if counts[d]["n_generated"] == 0:
            ax.plot([d], [y], "o", mfc="white", mec=C.FAINT, ms=6, zorder=5)
    ax.set_xlabel("requested duration (s)")
    ax.set_ylabel("seconds")
    ax.set_yscale("log")
    ax.set_title("latency", loc="left")
    ax.legend(frameon=False, loc="best")

    have = [(d, v) for d, v in zip(durations, rtf) if v == v]
    if have:
        ax2.plot([d for d, _ in have], [v for _, v in have], "o-", color=C.PALETTE[1])
    ax2.axhline(1.0, color=C.FAINT, ls=":", lw=0.9)
    ax2.text(durations[-1], 1.05, "real time", ha="right", va="bottom", fontsize=6.5, color=C.FAINT)
    ax2.set_xlabel("requested duration (s)")
    ax2.set_ylabel("real-time factor")
    ax2.set_yscale("log")
    ax2.set_title("cost per second of audio", loc="left")

    C.save_fig(fig, ctx.path(""))

    generated_cells = sum(1 for d in durations if counts[d]["n_generated"] > 0)
    note = (f"Open markers are duration cells in which no request reached MusicGen "
            f"({generated_cells} of {len(durations)} cells produced generation timings). "
            f"The RTF line is drawn only where it is measured.")
    ctx.path("-caption").with_suffix(".txt").write_text("F2. " + note, encoding="utf-8")

    return {
        "durations": durations,
        "wall_p50_s": wall_p50,
        "generate_p50_s": gen_p50,
        "rtf": rtf,
        "cells": counts,
        "generated_cells": generated_cells,
    }
