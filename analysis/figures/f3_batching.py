"""F3 — speedup from issuing k requests concurrently.

The metrics dictionary calls this ``batching_speedup`` and §6.2 would like to
read it as MusicGen batching. In ``d1-latency-full.json`` every concurrency
request was a cache hit, so what the numbers actually show is that the HTTP and
cache path parallelises almost perfectly (speedup ≈ k) — which says nothing
about the generator. The figure plots the measurement and labels it for what it
is; the alternative is a plot that quietly answers a different question from the
one its caption asks.
"""

from __future__ import annotations

import collections

from analysis.registry import Artefact
from analysis.figures import _common as C

ARTEFACT = Artefact(
    id="F3",
    kind="figure",
    title="Speedup vs concurrency k",
    section="5.1",
    priority=8,
    metrics=["batching_speedup", "cache_hit_rate"],
    inputs=["audio-generation/results/d1-latency-full.json"],
    notes="Appendix candidate — plan §6 cuts F3 first.",
)


def build(ctx):
    data = ctx.load_json(ARTEFACT.inputs[0])
    m = ctx.metric("batching_speedup")
    rows = data["sections"].get("concurrency", [])
    agg = sorted((r for r in rows if r.get("aggregate")), key=lambda r: r["level"])
    per_request = [r for r in rows if not r.get("aggregate")]

    classes = collections.Counter(r.get("cache") for r in per_request)
    all_hits = classes.get("miss", 0) == 0 and classes.get("hit", 0) > 0

    ks = [r["level"] for r in agg]
    speedup = [r["speedup"] for r in agg]

    fig, ax = C.plt.subplots(figsize=(C.COL_W, 2.1))
    ax.plot(ks, ks, ls=":", color=C.FAINT, lw=0.9, label="linear")
    ax.plot(ks, speedup, "o-", color=C.PALETTE[0], label="measured")
    ax.set_xlabel("concurrent requests k")
    ax.set_ylabel("sequential / concurrent")
    ax.set_xticks(ks)
    ax.legend(frameon=False, loc="upper left")
    C.save_fig(fig, ctx.path(""))

    note = ("F3. Every request in this sweep was a cache hit, so the near-linear speedup "
            "describes the request and cache path, not MusicGen batching. Reporting it as "
            "batching requires a cold-cache re-run.") if all_hits else "F3. Speedup vs concurrency."
    ctx.path("-caption").with_suffix(".txt").write_text(note, encoding="utf-8")

    return {
        "levels": ks,
        "speedup": speedup,
        "concurrent_wall_ms": [r["concurrent_wall_ms"] for r in agg],
        "sequential_wall_ms": [r["sequential_wall_ms"] for r in agg],
        "all_cache_hits": all_hits,
        "cache_classes": dict(classes),
        "registry_caveat": m.caveat,
    }
