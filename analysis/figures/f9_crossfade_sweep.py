"""F9 -- crossfade-window sweep and seam-minimising loop-point selection.

Standalone script (not wired into the C-01 registry/build_all.py driver,
unlike F1-F8/T1-T5) because its input, results/d6-crossfade-loop-sweep.json,
is a secondary n=11 sample over the persisted fallback clips rather than a
population any other artefact shares -- see that file's own docstring for why
(C-09: raw pre-loop audio for the 141-clip Table V population is not
retained). Kept in analysis/figures/ for consistency with the other table
scripts and because it reuses `_common`'s emission helpers.

Run from the repo root:
    python -m analysis.figures.f9_crossfade_sweep
"""

from __future__ import annotations

import json
from pathlib import Path

from analysis.figures import _common as C

REPO = Path(__file__).resolve().parent.parent.parent
IN_PATH = REPO / "audio-generation" / "results" / "d6-crossfade-loop-sweep.json"
OUT_PATH = REPO / "analysis" / "out" / "f9-crossfade-sweep"


def build():
    data = json.loads(IN_PATH.read_text(encoding="utf-8"))
    a = data["experiment_a_crossfade_sweep"]
    b = data["experiment_b_seam_minimising"]

    header = ["Crossfade width", "n", "|ΔE| median (dB)", "|Δcentroid| median (Hz)"]
    rows = [[f"{w} ms", a[w]["n"], C.fmt(a[w]["energy_delta_db_median"], 2),
             C.fmt(a[w]["spectral_centroid_delta_hz_median"], 0)]
            for w in ("50", "100", "250", "500")]
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    C.booktabs(
        OUT_PATH, header=header, rows=rows,
        caption=(r"Crossfade-window sweep, production loop point held fixed "
                 r"(n=10 of 11 fallback clips; one too short for the 500\,ms "
                 r"window). Seam values are absolute differences at the loop "
                 r"seam, post-crossfade."),
        label="tab:crossfade-sweep",
        notes=data["caveat"],
    )
    C.markdown_table(OUT_PATH, header, rows, notes=data["caveat"])

    print(json.dumps({"experiment_a": a, "experiment_b": b}, indent=2))
    return {"experiment_a": a, "experiment_b": b}


if __name__ == "__main__":
    build()
