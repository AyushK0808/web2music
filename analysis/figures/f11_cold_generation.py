"""F11 -- cold-generation time against requested clip duration: RTX 5060 GPU, the same machine
with the GPU disabled (CPU), and Apple M4.

Standalone script (like F9). GPU points are d4-duration-5060.json (33 cache-miss requests per
cell), CPU points d4-duration-cpu2.json (12 per cell; no timeouts), M4 points d4-cold-rerun.json
(ten per cell). Plotted value is the p50 of the d3 generate time; labels are the real-time factor.

Run from the repo root:
    python -m analysis.figures.f11_cold_generation
"""

from __future__ import annotations

import collections
import json
from pathlib import Path

from analysis.figures import _common as C

REPO = Path(__file__).resolve().parent.parent.parent
GPU_PATH = REPO / "audio-generation" / "results" / "d4-duration-5060.json"
CPU_PATH = REPO / "audio-generation" / "results" / "d4-duration-cpu2.json"
M4_PATH = REPO / "audio-generation" / "results" / "d4-cold-rerun.json"
OUT_PATH = REPO / "paper" / "figures" / "coldgen"



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
    def load(path, require_miss):
        rows = json.loads(path.read_text(encoding="utf-8"))["sections"]["duration"]
        return generate_p50(rows, require_miss=require_miss)

    gpu, cpu, m4 = load(GPU_PATH, True), load(CPU_PATH, True), load(M4_PATH, True)

    fig, ax = C.plt.subplots(figsize=(C.COL_W, 2.3))
    blue, red, green = C.PALETTE[0], C.PALETTE[4], C.PALETTE[2]

    ax.plot([5, 32], [5, 32], color=C.FAINT, lw=1.0)
    ax.text(31, 36, "real time", ha="right", va="bottom", fontsize=6.5, color=C.FAINT)

    for series, colour, marker, label, dy in (
        (gpu, blue, "D", "RTX 5060 GPU (n=33 per cell)", -11),
        (cpu, red, "s", "same machine, CPU only (n=12 per cell)", 7),
        (m4, green, "o", "Apple M4, MPS (n=10 per cell)", 7),
    ):
        xs = list(series)
        ys = [series[d][0] for d in xs]
        ax.plot(xs, ys, marker + "-", ms=4.5, color=colour, label=label)
        for d, y in zip(xs, ys):
            ax.annotate(f"{y / d:.2f}×" if y / d < 1.5 else f"{y / d:.1f}×", (d, y), xytext=(0, dy),
                        textcoords="offset points", ha="center", fontsize=6, color=colour)

    ax.set_yscale("log")
    ax.set_yticks([5, 10, 30, 100])
    ax.set_yticklabels(["5", "10", "30", "100"])
    ax.set_xticks([8, 10, 15, 20, 28])
    ax.set_xlim(6.5, 30.5)
    ax.set_ylim(4, 300)
    ax.set_xlabel("requested clip duration (s)")
    ax.set_ylabel("cold generation, p50 (s)")
    ax.legend(frameon=False, loc="upper left", fontsize=6.5)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    C.save_fig(fig, OUT_PATH)

    result = {"gpu": gpu, "cpu": cpu, "m4": m4}
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    build()
