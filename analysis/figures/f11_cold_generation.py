"""F11 -- cold-generation time against requested clip duration, CPU vs Apple M4.

Standalone script (like F9). CPU points are the three duration-sweep requests
in d1-latency-full.json that reached MusicGen (one per cell); its 28 s cell
never completed inside the 300 s client timeout and is drawn as censored. M4
points are the cache-miss, non-fallback requests of d4-cold-rerun.json's
duration section (ten per cell). Plotted value is d3_generate p50; labels are
the real-time factor.

Run from the repo root:
    python -m analysis.figures.f11_cold_generation
"""

from __future__ import annotations

import collections
import json
from pathlib import Path

from analysis.figures import _common as C

REPO = Path(__file__).resolve().parent.parent.parent
CPU_PATH = REPO / "audio-generation" / "results" / "d1-latency-full.json"
M4_PATH = REPO / "audio-generation" / "results" / "d4-cold-rerun.json"
OUT_PATH = REPO / "paper" / "figures" / "coldgen"

CPU_TIMEOUT_S = 300
CPU_TIMEOUTS_28S = 12


def generate_p50(rows, require_miss=False):
    by = collections.defaultdict(list)
    for r in rows:
        t = r.get("timings")
        if not isinstance(t, dict) or "d3_generate_ms" not in t:
            continue
        if require_miss and (r.get("is_fallback") or r.get("cache") != "miss" or r.get("error")):
            continue
        by[r["duration_seconds"]].append(t["d3_generate_ms"] / 1000)
    return {d: (C.pct(xs, 50), len(xs)) for d, xs in sorted(by.items())}


def build():
    cpu = generate_p50(json.loads(CPU_PATH.read_text(encoding="utf-8"))["sections"]["duration"])
    m4 = generate_p50(json.loads(M4_PATH.read_text(encoding="utf-8"))["sections"]["duration"],
                      require_miss=True)

    fig, ax = C.plt.subplots(figsize=(C.COL_W, 2.3))
    red, green = C.PALETTE[4], C.PALETTE[2]

    ax.plot([5, 32], [5, 32], color=C.FAINT, lw=1.0)
    ax.text(31, 23, "real time", ha="right", va="top", fontsize=6.5, color=C.FAINT)

    for series, colour, marker, label, dy in (
        (cpu, red, "s", "Intel i7-1255U, CPU (n=1 per cell)", 7),
        (m4, green, "o", "Apple M4, MPS (n=10 per cell)", -11),
    ):
        xs = list(series)
        ys = [series[d][0] for d in xs]
        ax.plot(xs, ys, marker + "-", ms=5, color=colour, label=label)
        for d, y in zip(xs, ys):
            ax.annotate(f"{y / d:.1f}×", (d, y), xytext=(0, dy), textcoords="offset points",
                        ha="center", fontsize=6.5, color=colour)

    ax.plot([28], [CPU_TIMEOUT_S], "^", ms=6, color=red)
    ax.annotate(f"28 s: >{CPU_TIMEOUT_S} s\n(censored, n={CPU_TIMEOUTS_28S})", (28, CPU_TIMEOUT_S),
                xytext=(-6, -4), textcoords="offset points", ha="right", va="top",
                fontsize=6.5, color=red)

    ax.set_yscale("log")
    ax.set_yticks([10, 30, 100, 300])
    ax.set_yticklabels(["10", "30", "100", "300"])
    ax.set_xticks([10, 15, 20, 28])
    ax.set_xlim(8, 30.5)
    ax.set_ylim(8, 600)
    ax.set_xlabel("requested clip duration (s)")
    ax.set_ylabel("cold generation, p50 (s)")
    ax.legend(frameon=False, loc="upper left", fontsize=6.5)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    C.save_fig(fig, OUT_PATH)

    result = {"cpu": cpu, "m4": m4}
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    build()
