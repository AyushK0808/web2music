"""F1 — the timeline: navigation → first sound → generated swap.

The argument of §6.2 is that the dominant wall-clock term is a *design*
parameter, so the confidence window is drawn shaded and labelled as an interval
we chose, not as latency we failed to remove. The constant is read out of
``mood-classification/feature_b/index.js`` rather than typed here, so the figure
cannot drift from the shipped default — the same cross-check ``latency.e2e.mjs``
performs at runtime.

Server-side segments come from the real ``d4_latency.py`` run. Client-side
segments (extract, classify, decode) are overlaid only when
``ui/results/e2e-latency.json`` exists; until ``latency.e2e.mjs`` has been run
the figure draws the server timeline alone and says so in its caption.
"""

from __future__ import annotations

import re

from analysis.registry import Artefact, REPO
from analysis.figures import _common as C
from analysis.figures.t1_latency import classify

ARTEFACT = Artefact(
    id="F1",
    kind="figure",
    title="Navigation to first sound to generated swap, with the confidence window shaded",
    section="5.1",
    priority=3,
    metrics=["time_to_first_sound", "time_to_generated_audio", "compute_ms", "d_stage_ms"],
    inputs=["audio-generation/results/d1-latency-full.json",
            "mood-classification/feature_b/index.js"],
)

E2E = "ui/results/e2e-latency.json"


def read_confidence_window_ms() -> int:
    src = (REPO / "mood-classification/feature_b/index.js").read_text(encoding="utf-8")
    m = re.search(r"confidenceWindowMs:\s*(\d+)", src)
    if not m:
        raise ValueError(
            "confidenceWindowMs not found in feature_b/index.js — F1 shades a window whose "
            "length it can no longer verify; fix the pattern rather than hardcoding 5000."
        )
    return int(m.group(1))


def build(ctx):
    data = ctx.load_json(ARTEFACT.inputs[0])
    window_ms = read_confidence_window_ms()
    ctx.metric("time_to_first_sound")

    rows = [r for entries in data["sections"].values() for r in entries if not r.get("aggregate")]
    fallback = [r["wall_ms"] for r in rows if classify(r) == "fallback endpoint"]
    hits = [r["wall_ms"] for r in rows if classify(r) == "cache hit"]
    gen = [r["wall_ms"] for r in rows if classify(r) == "cache miss (generated)"]

    fb_p50 = C.pct(fallback, 50)
    hit_p50 = C.pct(hits, 50)
    gen_p50 = C.pct(gen, 50) if gen else float("nan")

    e2e = None
    p = REPO / E2E
    if p.exists():
        import json
        e2e = json.loads(p.read_text(encoding="utf-8"))

    cache_check = C.pct([r["timings"]["d5_cache_check_ms"] for r in rows
                         if isinstance(r.get("timings"), dict) and "d5_cache_check_ms" in r["timings"]], 50)

    # Two panels on different x-scales, because the two paths differ by two
    # orders of magnitude and one shared axis makes whichever is drawn second
    # invisible. Panel (a) is the steady state — the window is most of it.
    # Panel (b) is the cold path — the window is a rounding error and the
    # fallback is doing all the work. Both facts are the §6.2 argument; only
    # separate axes let a reader see either.
    fig, (axa, axb) = C.plt.subplots(2, 1, figsize=(C.FULL_W, 2.7))
    lane_audio, lane_work, h = 1.0, 0.3, 0.26

    def panel(ax, total_s, title):
        ax.axvspan(0, window_ms / 1000, color=C.PALETTE[0], alpha=0.13, lw=0)
        ax.axvline(window_ms / 1000, color=C.PALETTE[0], ls="--", lw=0.9)
        ax.set_yticks([lane_work, lane_audio])
        ax.set_yticklabels(["pipeline", "user hears"], fontsize=7)
        ax.set_ylim(-0.05, 1.45)
        ax.set_xlim(-total_s * 0.015, total_s * 1.04)
        ax.grid(axis="y", visible=False)
        ax.set_title(title, loc="left", fontsize=7.5)

    def bar(ax, y, x0, w, colour, label=None, inside=True):
        ax.broken_barh([(x0, w)], (y - h / 2, h), facecolors=colour, edgecolor="none")
        if label:
            ax.text(x0 + w / 2, y, label, ha="center", va="center", fontsize=6.3,
                    color="white" if inside else C.INK)

    # (a) steady state: cache hit.
    swap_a = (window_ms + hit_p50) / 1000
    panel(axa, swap_a * 1.25,
          f"(a) cache hit — the confidence window is {window_ms/(window_ms+hit_p50):.0%} of the wait")
    bar(axa, lane_audio, fb_p50 / 1000, swap_a - fb_p50 / 1000, C.PALETTE[2], "fallback clip")
    bar(axa, lane_audio, swap_a, swap_a * 0.25, C.PALETTE[0], "generated", inside=True)
    bar(axa, lane_work, window_ms / 1000, cache_check / 1000, C.PALETTE[1],
        f"cache check {cache_check:.0f} ms")
    axa.text(window_ms / 2000, 1.30, f"{window_ms/1000:.0f} s confidence window (design)",
             ha="center", va="center", fontsize=6.4, color=C.PALETTE[0])

    # (b) cold path: generation.
    if gen_p50 == gen_p50:
        swap_b = (window_ms + gen_p50) / 1000
        panel(axb, swap_b * 1.25,
              f"(b) cache miss — the same window is {window_ms/(window_ms+gen_p50):.1%}; "
              f"the fallback covers {gen_p50/1000:.0f} s of generation")
        bar(axb, lane_audio, fb_p50 / 1000, swap_b - fb_p50 / 1000, C.PALETTE[2],
            f"fallback clip, audible from {fb_p50:.0f} ms")
        bar(axb, lane_audio, swap_b, swap_b * 0.25, C.PALETTE[0], "generated")
        bar(axb, lane_work, window_ms / 1000, cache_check / 1000, C.PALETTE[1])
        bar(axb, lane_work, (window_ms + cache_check) / 1000, (gen_p50 - cache_check) / 1000,
            C.PALETTE[4], f"generate + process, p50 {gen_p50/1000:.0f} s (n={len(gen)})")
    axb.set_xlabel("seconds from navigation commit")

    C.plt.tight_layout(h_pad=0.9)
    C.save_fig(fig, ctx.path(""))

    caption = (
        "F1. Server-side timeline from the CPU run. Client-side extract/classify/decode "
        "segments are absent because ui/e2e/latency.e2e.mjs has not been run; the shape of "
        "the argument does not change, but nav-to-audible is not yet measured end to end."
        if e2e is None else "F1. End-to-end timeline, client and server segments."
    )
    ctx.path("-caption").with_suffix(".txt").write_text(caption, encoding="utf-8")

    return {
        "confidence_window_ms": window_ms,
        "fallback_p50_ms": fb_p50,
        "cache_hit_p50_ms": hit_p50,
        "generated_p50_ms": gen_p50 if gen_p50 == gen_p50 else None,
        "n_generated": len(gen),
        "e2e_overlay": e2e is not None,
        "window_share_of_cache_hit_path": window_ms / (window_ms + hit_p50),
    }
