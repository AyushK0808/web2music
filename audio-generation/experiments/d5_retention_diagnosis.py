#!/usr/bin/env python3
"""C-09 (analysis half) — is short duration retention a detector artefact?

    RETAIN_PRETRIM_EVERY=20 python main.py        # collect, over normal traffic
    python experiments/d5_retention_diagnosis.py --samples pretrim-samples

The §5.3 open question is whether the median clip retaining ~0.503 of its
requested duration is the loop detector failing or the audio genuinely not
being self-similar further out. That was undecidable from ``audio-cache/``
because it stores clips post-trim. With the retained samples it becomes four
concrete tests, each of which can come out either way:

1. **Decay.** Does chroma self-similarity fall systematically with distance,
   biasing argmax early? Reported as Spearman rho per clip and pooled. A
   previous attempt on three surviving clips found no support (+0.383, −0.130,
   +0.140); this repeats it on a real sample.
2. **Headroom.** How much better is the chosen peak than the best candidate in
   the *second half* of the clip? If the late peak is nearly as good, the
   detector is leaving usable audio on the floor and the objective could be
   changed; if it is much worse, the short loop is correct.
3. **Snapping.** How far does bar snapping move the cut, and does it move it
   systematically earlier? A snap that mostly shortens is a fixable bias.
4. **Floor effects.** How often does the cut land within a beat or two of
   MIN_LOOP_SECONDS, i.e. the constraint rather than the audio is deciding?

The script deliberately does not change the loop objective. The plan is right
that doing so invalidates all 130 cached clips and every §5.3 number with them,
and none of these tests is worth that unless it comes back conclusive.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

import numpy as np


def spearman(x, y) -> float | None:
    """Rank correlation without a scipy dependency (audio-generation pins a
    minimal requirements set and this script should run inside that venv)."""
    n = len(x)
    if n < 3:
        return None

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = ranks(x), ranks(y)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return num / den if den else None


def analyse_sample(meta: dict) -> dict | None:
    sims = np.array(meta.get("similarity_curve", []), dtype=float)
    valid = np.isfinite(sims) & (sims > -1.0)
    if valid.sum() < 10:
        return None

    idx = np.flatnonzero(valid)
    vals = sims[idx]

    # 1. decay
    rho = spearman(idx.tolist(), vals.tolist())

    # 2. headroom: chosen peak vs the best in the back half of the searchable range
    half = idx[len(idx) // 2]
    late = vals[idx >= half]
    peak = float(vals.max())
    late_peak = float(late.max()) if late.size else float("nan")

    # 3. snapping
    snap = meta.get("snap_shift_ms")

    # 4. floor
    min_loop_ms = meta.get("min_loop_seconds", 3.0) * 1000
    loop_ms = meta.get("loop_point_ms")
    source_ms = meta.get("source_duration_ms")

    return {
        "captured_at": meta.get("captured_at"),
        "source_duration_ms": source_ms,
        "loop_point_ms": loop_ms,
        "retention_of_source": meta.get("retention_of_source"),
        "similarity_decay_rho": rho,
        "peak_similarity": peak,
        "late_half_peak_similarity": late_peak,
        "headroom": peak - late_peak if late_peak == late_peak else None,
        "snap_shift_ms": snap,
        "at_min_loop_floor": (loop_ms is not None
                              and loop_ms <= min_loop_ms + 500),
        "outcome": meta.get("outcome"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", default="pretrim-samples")
    ap.add_argument("--out", default="results/d5-retention.json")
    args = ap.parse_args()

    d = Path(args.samples)
    files = sorted(d.glob("*.json")) if d.exists() else []
    if not files:
        print(f"No retained samples in {d}/.\n"
              f"Collect some first:  RETAIN_PRETRIM_EVERY=20 python main.py\n"
              f"The instrument (C-09) is in place; this is the analysis waiting on data.")
        return 2

    rows = [r for r in (analyse_sample(json.loads(f.read_text(encoding='utf-8')))
                        for f in files) if r]
    if not rows:
        print(f"{len(files)} sample(s) found but none had a usable similarity curve.")
        return 2

    def col(k):
        return [r[k] for r in rows if r.get(k) is not None]

    rhos = col("similarity_decay_rho")
    headroom = col("headroom")
    snaps = col("snap_shift_ms")
    retention = col("retention_of_source")
    floor = sum(1 for r in rows if r.get("at_min_loop_floor"))

    summary = {
        "n_samples": len(rows),
        "decay": {
            "median_rho": statistics.median(rhos) if rhos else None,
            "share_negative": (sum(1 for r in rhos if r < 0) / len(rhos)) if rhos else None,
            "verdict": _decay_verdict(rhos),
        },
        "headroom": {
            "median": statistics.median(headroom) if headroom else None,
            "share_small": (sum(1 for h in headroom if h < 0.05) / len(headroom))
            if headroom else None,
        },
        "snapping": {
            "median_shift_ms": statistics.median(snaps) if snaps else None,
            "share_shortening": (sum(1 for s in snaps if s < 0) / len(snaps)) if snaps else None,
        },
        "floor": {"share_at_min_loop": floor / len(rows)},
        "retention_of_source": {
            "median": statistics.median(retention) if retention else None,
            "min": min(retention) if retention else None,
            "max": max(retention) if retention else None,
        },
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "per_clip": rows}, indent=2), encoding="utf-8")

    print(f"n = {len(rows)} retained samples\n")
    print(f"  decay        median rho {summary['decay']['median_rho']:+.3f}  "
          f"({summary['decay']['share_negative']:.0%} negative)  -> {summary['decay']['verdict']}")
    print(f"  headroom     median {summary['headroom']['median']:.3f}  "
          f"({summary['headroom']['share_small']:.0%} of clips have a late peak within 0.05)")
    print(f"  bar snapping median shift {summary['snapping']['median_shift_ms']:+.0f} ms  "
          f"({summary['snapping']['share_shortening']:.0%} shorten the loop)")
    print(f"  floor        {summary['floor']['share_at_min_loop']:.0%} of cuts land at "
          f"MIN_LOOP_SECONDS, i.e. decided by the constraint not the audio")
    print(f"\nWrote {out}")
    return 0


def _decay_verdict(rhos) -> str:
    if not rhos:
        return "no data"
    med = statistics.median(rhos)
    share_neg = sum(1 for r in rhos if r < 0) / len(rhos)
    if med < -0.3 and share_neg > 0.7:
        return ("supported — similarity decays with distance, so argmax is biased early "
                "and the loop objective is a candidate for change")
    if abs(med) < 0.15:
        return ("not supported — no systematic decay; short loops are more likely correct "
                "behaviour on non-self-similar audio than a detector defect")
    return "inconclusive — report the distribution, do not change the objective on it"


if __name__ == "__main__":
    raise SystemExit(main())
