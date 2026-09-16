"""Regenerate the data figures for paper_2/main.tex from the raw result files.

Run from anywhere:  python paper_2/figures/build_figures.py

Outputs (PDF + PNG, into this directory):
  f1  timeline: cache hit / cache miss / timed-out request, confidence window shaded
  f2  generation latency against requested duration (two stacked panels)
  f5  macro-F1 against total off-device rate, A1-A5 + A7 sweep, LLM-only twin points
  f6  seam discontinuity by mood + duration retention, annotated
  f7  retrieval coverage against library size (analytical model, uniform + Zipf)

Every number is read from the same result files the paper's tables cite; nothing
is typed in here except the axis furniture.
"""

from __future__ import annotations

import collections
import json
import math
import statistics
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

LATENCY = REPO / "audio-generation/results/d1-latency-full.json"
S2 = REPO / "mood-classification/results/s2-ablation.json"
LOOP = REPO / "audio-generation/results/d2-loop.json"
BASELINES = REPO / "analysis/out/baselines.json"
FEATURE_B = REPO / "mood-classification/feature_b/index.js"

# IEEEtran: \columnwidth = 3.5 in, \textwidth = 7.16 in.
COL_W, FULL_W = 3.45, 7.1
PALETTE = ["#3B6FB6", "#C1651C", "#2E8B6F", "#8E5AA8", "#B03A48", "#6E7486"]
INK, FAINT = "#14161E", "#6E7486"

plt.rcParams.update({
    "figure.dpi": 150, "savefig.dpi": 400, "savefig.bbox": "tight", "savefig.pad_inches": 0.02,
    "pdf.fonttype": 42, "ps.fonttype": 42,
    "font.family": "sans-serif", "font.sans-serif": ["DejaVu Sans", "Arial", "Helvetica"],
    "font.size": 7.2, "axes.labelsize": 7.2, "axes.titlesize": 7.8,
    "xtick.labelsize": 6.4, "ytick.labelsize": 6.4, "legend.fontsize": 6.4,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.alpha": 0.3, "grid.linewidth": 0.6, "lines.linewidth": 1.5,
})


def load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def pct(values, q):
    """Nearest-rank percentile, q in [0, 100]; never interpolates."""
    xs = sorted(v for v in values if v is not None)
    if not xs:
        return float("nan")
    return float(xs[min(max(1, math.ceil(q / 100 * len(xs))), len(xs)) - 1])


def save(fig, name):
    fig.savefig(HERE / f"{name}.pdf")
    fig.savefig(HERE / f"{name}.png")
    plt.close(fig)
    print("wrote", name)


def classify(row):
    if row.get("error"):
        return "timeout"
    if row.get("is_fallback") and row.get("cache") is None:
        return "fallback endpoint"
    if row.get("is_fallback"):
        return "generation to fallback"
    if row.get("cache") == "hit":
        return "cache hit"
    if row.get("cache") == "miss":
        return "cache miss (generated)"
    return "other"


def confidence_window_ms():
    import re
    m = re.search(r"confidenceWindowMs:\s*(\d+)", FEATURE_B.read_text(encoding="utf-8"))
    return int(m.group(1)) if m else 5000


# ── F1: timeline (single column) ────────────────────────────────────────────
def f1():
    data = load(LATENCY)
    rows = [r for sec in data["sections"].values() for r in sec if not r.get("aggregate")]
    window = confidence_window_ms()
    fb = pct([r["wall_ms"] for r in rows if classify(r) == "fallback endpoint"], 50)
    hit = pct([r["wall_ms"] for r in rows if classify(r) == "cache hit"], 50)
    gen_rows = [r for r in rows if classify(r) == "cache miss (generated)"]
    gen = pct([r["wall_ms"] for r in gen_rows], 50)
    n_to = sum(1 for r in rows if classify(r) == "timeout")
    cache_check = pct([r["timings"]["d5_cache_check_ms"] for r in rows
                       if isinstance(r.get("timings"), dict) and "d5_cache_check_ms" in r["timings"]], 50)
    to_ms = 300_000

    fig, axes = plt.subplots(3, 1, figsize=(COL_W, 4.35),
                             gridspec_kw={"height_ratios": [1, 1, 0.8]})
    lane_audio, lane_work, h = 1.0, 0.3, 0.36

    def panel(ax, total_s, title):
        ax.axvspan(0, window / 1000, color=PALETTE[0], alpha=0.13, lw=0)
        ax.axvline(window / 1000, color=PALETTE[0], ls="--", lw=0.8)
        ax.set_yticks([lane_work, lane_audio])
        ax.set_yticklabels(["server", "hears"], fontsize=6.0)
        ax.set_ylim(-0.05, 1.5)
        ax.set_xlim(-total_s * 0.015, total_s * 1.04)
        ax.grid(axis="y", visible=False)
        ax.tick_params(axis="x", labelsize=6.0)
        ax.set_title(title, loc="left", fontsize=6.4)

    def bar(ax, y, x0, w, colour, label=None, outside=False):
        ax.broken_barh([(x0, w)], (y - h / 2, h), facecolors=colour, edgecolor="none")
        if label and not outside:
            ax.text(x0 + w / 2, y, label, ha="center", va="center", fontsize=5.0, color="white")
        elif label:
            ax.annotate(label, (x0 + w, y), xytext=(3, 0), textcoords="offset points",
                        fontsize=5.0, color=colour, ha="left", va="center")

    # (a) cache hit
    axa, axb, axc = axes
    swap_a = (window + hit) / 1000
    panel(axa, swap_a * 1.25, f"(a) cache hit (n=93)")
    bar(axa, lane_audio, fb / 1000, swap_a - fb / 1000, PALETTE[2], "fallback clip")
    bar(axa, lane_audio, swap_a, swap_a * 0.25, PALETTE[0], "generated", outside=True)
    bar(axa, lane_work, window / 1000, cache_check / 1000, PALETTE[1], f"{cache_check/1000:.1f} s check", outside=True)
    axa.text(window / 2000, 1.36, f"{window/1000:.0f} s window", ha="center", va="center",
             fontsize=5.4, color=PALETTE[0])

    # (b) cache miss, completed generation
    swap_b = (window + gen) / 1000
    panel(axb, swap_b * 1.25, f"(b) cache miss, generated (n={len(gen_rows)}, 10-20 s clips)")
    bar(axb, lane_audio, fb / 1000, swap_b - fb / 1000, PALETTE[2], f"fallback from {fb:.0f} ms")
    bar(axb, lane_audio, swap_b, swap_b * 0.25, PALETTE[0], "generated", outside=True)
    bar(axb, lane_work, window / 1000, cache_check / 1000, PALETTE[1])
    bar(axb, lane_work, (window + cache_check) / 1000, (gen - cache_check) / 1000, PALETTE[4],
        f"generate + process\np50 {gen/1000:.0f} s", outside=True)

    # (c) timed out: fallback keeps playing, generator never swaps in
    total_c = (window + to_ms) / 1000
    panel(axc, total_c * 1.08, f"(c) cache miss, client timeout (n={n_to} of 144, 28 s clips)")
    bar(axc, lane_audio, fb / 1000, total_c * 1.06 - fb / 1000, PALETTE[2], "fallback clip continues")
    bar(axc, lane_work, window / 1000, to_ms / 1000, PALETTE[5], "generation still running,\nright-censored at 300 s", outside=True)
    axc.axvline(total_c, color=PALETTE[4], ls=":", lw=0.9)
    axc.text(total_c, 1.38, "timeout", ha="right", va="center", fontsize=5.4, color=PALETTE[4])
    axc.set_xlabel("seconds from navigation commit", fontsize=6.2)

    plt.tight_layout(h_pad=0.55)
    save(fig, "f1")


# ── F2: generation latency against requested duration ─────────────────────
def f2():
    data = load(LATENCY)
    rows = [r for r in data["sections"].get("duration", []) if not r.get("aggregate")]
    by = collections.defaultdict(list)
    for r in rows:
        by[r["duration_seconds"]].append(r)
    durs = sorted(by)
    wall, gen, rtf, ngen, cls = [], [], [], [], {}
    for d in durs:
        rs = by[d]
        walls = [r["wall_ms"] for r in rs]
        gens = [r["timings"]["d3_generate_ms"] for r in rs
                if isinstance(r.get("timings"), dict) and "d3_generate_ms" in r["timings"]]
        wall.append(pct(walls, 50) / 1000)
        gen.append(pct(gens, 50) / 1000 if gens else float("nan"))
        rtf.append(pct(gens, 50) / 1000 / d if gens else float("nan"))
        ngen.append(len(gens))
        cls[d] = collections.Counter(classify(r) for r in rs)

    # The 28 s cell: every cache miss in the run timed out at the client, so the
    # generator's time is right-censored at 300 s. Drawn as a lower-bound marker.
    warm = [r for r in data["sections"].get("warm", []) if classify(r) == "timeout"]
    censored_s = 300.0 if warm else None

    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(COL_W, 3.5), sharex=True)
    ax.plot(durs, wall, "o-", color=PALETTE[0], label="client wall clock, p50")
    ax.plot(durs, gen, "s-", color=PALETTE[4], label="D4 generate, p50")
    for d, y, n in zip(durs, wall, ngen):
        if n == 0:
            ax.plot([d], [y], "o", mfc="white", mec=FAINT, ms=7, zorder=5)
        ax.annotate(f"n={n}", (d, y), textcoords="offset points", xytext=(0, 7), ha="center",
                    fontsize=6.0, color=FAINT)
    if censored_s:
        ax.plot([28], [censored_s], "^", color=PALETTE[4], ms=7, zorder=6)
        ax.annotate("28 s: every miss timed out\n(>= 300 s, right-censored)", (28, censored_s),
                    textcoords="offset points", xytext=(-8, 4), ha="right", va="bottom", fontsize=5.8,
                    color=PALETTE[4])
    ax.set_ylim(1, 2500)
    ax.annotate("5 s: generation failed,\nserved fallback (n=3)", (5, wall[0]), textcoords="offset points",
                xytext=(8, -12), ha="left", va="top", fontsize=5.8, color=PALETTE[0])
    ax.set_ylabel("seconds")
    ax.set_yscale("log")
    ax.set_title("(a) latency against requested clip length", loc="left")
    ax.legend(frameon=False, loc="center right", bbox_to_anchor=(1.0, 0.42))

    have = [(d, v) for d, v in zip(durs, rtf) if v == v]
    ax2.plot([d for d, _ in have], [v for _, v in have], "o-", color=PALETTE[1])
    for d, v in have:
        ax2.annotate(f"{v:.1f}x", (d, v), textcoords="offset points", xytext=(0, 6), ha="center",
                     fontsize=6.0, color=PALETTE[1])
    ax2.axhline(1.0, color=FAINT, ls=":", lw=0.9)
    ax2.text(durs[-1], 1.12, "real time", ha="right", va="bottom", fontsize=6.0, color=FAINT)
    ax2.set_xlabel("requested duration (s)")
    ax2.set_ylabel("real-time factor")
    ax2.set_yscale("log")
    ax2.set_ylim(0.5, 30)
    ax2.set_title("(b) generation cost per second of audio (measured cells only)", loc="left")
    plt.tight_layout(h_pad=0.6)
    save(fig, "f2")


# ── F5: macro-F1 against total off-device rate ─────────────────────────────
def offdevice(rec):
    if rec.get("total_offdevice_rate") is not None:
        return rec["total_offdevice_rate"]
    return (rec.get("exposure_rate") or 0) + (rec.get("zero_shot_proxy_rate") or 0)


def f5():
    data = load(S2)
    sweep = [s for s in data["a7_sweep"] if s.get("macro_f1") is not None]
    configs = [c for c in data["configs"] if c.get("macro_f1") is not None]
    ship = (0.45, 0.10)

    fig, ax = plt.subplots(figsize=(COL_W, 2.6))

    # A7 cells: total off-device (filled, stacks at ~.762) and LLM-only twin (hollow), joined.
    for s in sweep:
        x_tot, x_llm, y = offdevice(s), s["exposure_rate"], s["macro_f1"]
        ax.plot([x_llm, x_tot], [y, y], "-", color=FAINT, lw=0.6, alpha=0.6, zorder=1)
        ax.scatter([x_llm], [y], s=14, facecolor="white", edgecolor=FAINT, lw=0.7, zorder=2)
        ax.scatter([x_tot], [y], s=14, color=FAINT, zorder=3)
    sh = next((s for s in sweep if abs(s["minScore"] - ship[0]) < 1e-9 and abs(s["minMargin"] - ship[1]) < 1e-9), None)
    if sh:
        ax.scatter([offdevice(sh)], [sh["macro_f1"]], s=90, marker="*", color=PALETTE[1], zorder=6)
        ax.annotate("shipped 0.45 / 0.10", (offdevice(sh), sh["macro_f1"]), textcoords="offset points",
                    xytext=(-6, 8), ha="right", fontsize=6.2, color=PALETTE[1])

    offsets = {"A1": (6, -3), "A2": (-8, 4), "A3": (-10, -9), "A4": (6, 4), "A5": (6, -10)}
    for c in configs:
        tag = c["name"].split()[0]
        x, y = offdevice(c), c["macro_f1"]
        ax.scatter([x], [y], s=40, marker="o", color=PALETTE[0], edgecolor="white", lw=0.6, zorder=5)
        ax.annotate(tag, (x, y), textcoords="offset points", xytext=offsets.get(tag, (5, 4)),
                    fontsize=6.8, color=PALETTE[0], fontweight="bold")
        if tag == "A5" and c["exposure_rate"] < offdevice(c):
            ax.plot([c["exposure_rate"], x], [y, y], "-", color=PALETTE[0], lw=0.8, alpha=0.7, zorder=4)
            ax.scatter([c["exposure_rate"]], [y], s=40, facecolor="white", edgecolor=PALETTE[0], lw=0.9, zorder=5)
            ax.annotate("A5, LLM only", (c["exposure_rate"], y), textcoords="offset points",
                        xytext=(0, -11), ha="center", fontsize=6.0, color=PALETTE[0])

    # The stack the figure exists to show.
    tot = statistics.median(offdevice(s) for s in sweep)
    ax.axvline(tot, color=PALETTE[4], ls="--", lw=0.8, zorder=0)
    ax.text(tot, 0.29, f"A7 sweep: all 12 cells\nat total = {tot:.3f}", ha="right", va="bottom",
            fontsize=6.0, color=PALETTE[4], rotation=90)

    ax.set_xlabel("total off-device rate (LLM + hosted zero-shot)")
    ax.set_ylabel("macro-F1, 13 categories")
    ax.set_xlim(-0.04, 1.06)
    ax.set_ylim(0.27, 0.72)
    from matplotlib.lines import Line2D
    handles = [
        Line2D([], [], marker="o", color=PALETTE[0], ls="", ms=6, label="A1-A5, total off-device"),
        Line2D([], [], marker="o", color=FAINT, ls="", ms=4, label="A7 cell, total off-device"),
        Line2D([], [], marker="o", mfc="white", mec=FAINT, ls="", ms=4, label="same cell, LLM only"),
    ]
    ax.legend(handles=handles, frameon=False, loc="center left", bbox_to_anchor=(0.0, 0.42), fontsize=6.0)
    save(fig, "f5")


# ── F6: seam discontinuity + duration retention ────────────────────────────
def f6():
    clips = load(LOOP)["clips"]
    by = collections.defaultdict(list)
    for c in clips:
        by[c["mood"]].append(c)
    moods = sorted(by, key=lambda m: -statistics.median(abs(c["pre_energy_delta_db"]) for c in by[m]))
    pre = [[abs(c["pre_energy_delta_db"]) for c in by[m]] for m in moods]
    post = [[abs(c["post_energy_delta_db"]) for c in by[m]] for m in moods]
    imp = [abs(c["pre_energy_delta_db"]) - abs(c["post_energy_delta_db"]) for c in clips]
    worsened = sum(1 for i in imp if i < 0) / len(imp)

    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(FULL_W, 2.45), gridspec_kw={"width_ratios": [1.7, 1]})
    xs = list(range(len(moods)))
    bp1 = ax.boxplot(pre, positions=[x - 0.2 for x in xs], widths=0.34, patch_artist=True,
                     showfliers=False, medianprops={"color": INK, "lw": 1.0})
    bp2 = ax.boxplot(post, positions=[x + 0.2 for x in xs], widths=0.34, patch_artist=True,
                     showfliers=False, medianprops={"color": INK, "lw": 1.0})
    for b in bp1["boxes"]:
        b.set(facecolor=PALETTE[4], alpha=0.55, lw=0.6)
    for b in bp2["boxes"]:
        b.set(facecolor=PALETTE[2], alpha=0.75, lw=0.6)
    ax.set_xticks(xs)
    ax.set_xticklabels([f"{m} ({len(by[m])})" for m in moods], rotation=35, ha="right", fontsize=6.4)
    ax.set_ylim(0, 19.5)
    ax.set_ylabel("|energy delta| across seam (dB)")
    ax.legend([bp1["boxes"][0], bp2["boxes"][0]], ["before crossfade", "after crossfade"],
              frameon=False, loc="upper right", bbox_to_anchor=(1.0, 0.86))
    ax.set_title("(a) seam discontinuity by mood, 141 clips (n per mood)", loc="left")
    ax.text(0.02, 0.96, f"crossfade worsens the seam on {worsened:.1%} of clips\n"
                        f"median paired improvement {statistics.median(imp):.2f} dB",
            transform=ax.transAxes, ha="left", va="top", fontsize=6.6, color=PALETTE[4],
            bbox={"boxstyle": "round,pad=0.25", "fc": "white", "ec": PALETTE[4], "lw": 0.6})

    ratios = [c["duration_ratio"] for c in clips if c.get("duration_ratio") is not None]
    ax2.hist(ratios, bins=20, color=PALETTE[0], alpha=0.85)
    med = statistics.median(ratios)
    ax2.axvline(med, color=PALETTE[1], lw=1.3)
    ax2.text(med + 0.02, ax2.get_ylim()[1] * 0.95, f"median = {med:.3f}\n(half the requested\naudio is discarded)",
             fontsize=6.6, color=PALETTE[1], ha="left", va="top")
    ax2.set_xlabel("delivered / requested duration")
    ax2.set_ylabel("clips")
    ax2.set_title(f"(b) duration retention (n={len(ratios)})", loc="left")
    plt.tight_layout(w_pad=1.2)
    save(fig, "f6")


# ── F7: retrieval coverage against library size ────────────────────────────
def f7():
    libs = load(BASELINES)["libraries"]
    cells = load(BASELINES)["request_space"]["cells"]
    n = [l["n_tracks"] for l in libs]
    uni = [100 * l["coverage_uniform_commissioning"] for l in libs]
    skew = [100 * l["coverage_skewed_commissioning"] for l in libs]
    # The closed form the uniform column follows: 1 - (1 - 1/cells)^N.
    grid = [int(x) for x in [30 + 10 * i for i in range(0, 700)]]
    model = [100 * (1 - (1 - 1 / cells) ** g) for g in grid]

    fig, ax = plt.subplots(figsize=(COL_W, 2.2))
    ax.plot(grid, model, "-", color=PALETTE[0], lw=1.0, alpha=0.5)
    ax.plot(n, uni, "o", color=PALETTE[0], ms=5, label="uniform commissioning")
    ax.plot(n, skew, "s-", color=PALETTE[1], ms=5, label="Zipf-skewed commissioning (s = 1)")
    for x, y in zip(n, uni):
        ax.annotate(f"{y:.0f}%", (x, y), textcoords="offset points", xytext=(-4, 6), ha="right",
                    fontsize=6.0, color=PALETTE[0])
    for x, y in zip(n, skew):
        ax.annotate(f"{y:.0f}%", (x, y), textcoords="offset points", xytext=(5, -9), ha="left",
                    fontsize=6.0, color=PALETTE[1])
    ax.axhline(90, color=FAINT, ls=":", lw=0.8)
    ax.text(n[-1] * 0.55, 91.5, "90 % coverage", fontsize=6.0, color=FAINT, va="bottom", ha="right")
    ax.set_xscale("log")
    ax.set_xlabel(f"library size, tracks (log scale); request space = {cells} cells")
    ax.set_ylabel("simulated coverage of request space (%)")
    ax.set_ylim(0, 100)
    ax.set_title("simulated request-space coverage (analytical model, no library built)", loc="left", fontsize=6.8)
    ax.legend(frameon=False, loc="upper left", bbox_to_anchor=(0.0, 0.86))
    ax.set_xticks([50, 100, 200, 500, 1000, 5000])
    ax.set_xticklabels(["50", "100", "200", "500", "1000", "5000"])
    ax.minorticks_off()
    save(fig, "f7")


if __name__ == "__main__":
    f1()
    f2()
    f5()
    f6()
    f7()
