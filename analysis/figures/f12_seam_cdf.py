"""F12 -- distribution of the energy jump across the loop seam, by cut method.

Standalone script (like F9), over the n=113 usable clips of
d6-crossfade-loop-sweep-n141.json: the production chroma-similarity cut at the
50 ms default and at 500 ms, against the measured-seam selector at 50 ms.

Run from the repo root:
    python -m analysis.figures.f12_seam_cdf
"""

from __future__ import annotations

import json
from pathlib import Path

from analysis.figures import _common as C

REPO = Path(__file__).resolve().parent.parent.parent
IN_PATH = REPO / "audio-generation" / "results" / "d6-crossfade-loop-sweep-n141.json"
OUT_PATH = REPO / "paper" / "figures" / "seamcdf"

FLOOR_DB = 0.01  # log axis; a seam measured at exactly 0 dB is drawn here


def build():
    data = json.loads(IN_PATH.read_text(encoding="utf-8"))
    clips = [c for c in data["clips"] if c.get("crossfade_sweep") and c.get("seam_minimising")]

    series = [
        ("chroma cut, 50 ms (default)", C.PALETTE[4],
         [abs(c["crossfade_sweep"]["50"]["energy_delta_db"]) for c in clips]),
        ("chroma cut, 500 ms", C.PALETTE[1],
         [abs(c["crossfade_sweep"]["500"]["energy_delta_db"]) for c in clips]),
        ("measured-seam cut, 50 ms", C.PALETTE[2],
         [abs(c["seam_minimising"]["chosen_seam"]["energy_delta_db"]) for c in clips]),
    ]

    fig, ax = C.plt.subplots(figsize=(C.COL_W, 2.2))
    label_pos = {0: (2.6, 0.30), 1: (2.6, 0.08), 2: (0.012, 0.80)}
    result = {"n": len(clips)}
    for i, (label, colour, xs) in enumerate(series):
        xs = sorted(max(FLOOR_DB, x) for x in xs)
        ys = [(k + 1) / len(xs) for k in range(len(xs))]
        ax.step(xs, ys, where="post", color=colour, lw=1.6)
        p50 = C.pct(xs, 50)
        x, y = label_pos[i]
        ax.text(x, y, f"{label}\np50 {p50:.2f} dB", fontsize=6.5, color=colour, va="bottom")
        result[label] = {"p50": p50, "p95": C.pct(xs, 95),
                         "share_above_1db": sum(v > 1 for v in xs) / len(xs)}

    ax.axhline(0.5, color=C.FAINT, lw=0.8)
    ax.set_xscale("log")
    ax.set_xticks([0.01, 0.1, 1, 10])
    ax.set_xticklabels(["0.01", "0.1", "1", "10"])
    ax.set_xlim(FLOOR_DB, 20)
    ax.set_ylim(0, 1.02)
    ax.set_xlabel(f"|energy jump| across loop seam (dB), n={len(clips)} clips")
    ax.set_ylabel("fraction of clips")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    C.save_fig(fig, OUT_PATH)

    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    build()
