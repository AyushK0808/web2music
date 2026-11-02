"""S-I (relative half) — how big is the loop seam compared with the clip's own variation? (R4 #2)

    python analysis/proxies/seam_relative.py --clips-dir audio-generation/results/d6-loop-seeds-clips \
        --out audio-generation/results/seam-relative.json
    python analysis/proxies/seam_relative.py --clips-dir audio-generation/fallback_clips --win-ms 250
    python analysis/proxies/seam_relative.py --self-test

An absolute seam size in dB says little about whether a seam would stand out:
a clip that swells and fades by 3 dB every second hides a 3 dB seam, and a flat
drone does not. So each delivered clip's seam is ranked against the same
quantity measured everywhere else in the SAME clip.

For a clip of N windows of `win_ms` (default 250 ms = the crossfade length):
  seam         |dE| and |dc| between the last window and the first window (what a
               listener crosses at every loop repeat)
  interior     |dE| and |dc| between every pair of adjacent windows inside the
               clip, taken on a hop of win_ms/5 so the distribution is not sparse
  percentile   the fraction of interior changes that are SMALLER than the seam
  within-p95   the seam is within the clip's own 95th percentile of interior change

Reported over clips: the share of seams within their clip's own 95th percentile,
and the median seam percentile, each with a bootstrap CI, for energy and for
spectral centroid and for both together. These are signal measurements, not
perception: the paper says "gapless" is shown (gapless.e2e.mjs) and that nothing
here claims the seam is inaudible.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def window_stats(x, sr, start, n):
    """(RMS in dB, spectral centroid in Hz) of x[start:start+n]."""
    import numpy as np
    seg = x[start:start + n]
    rms = float(np.sqrt(np.mean(seg ** 2)) + 1e-12)
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    centroid = float((freqs * spec).sum() / (spec.sum() + 1e-12))
    return 20 * math.log10(rms), centroid


def relative_seam(x, sr, win_ms=250):
    """Seam vs interior distribution for one mono float signal. None if too short."""
    import numpy as np
    n = int(sr * win_ms / 1000)
    hop = max(1, n // 5)
    if len(x) < 6 * n:
        return None
    last = window_stats(x, sr, len(x) - n, n)
    first = window_stats(x, sr, 0, n)
    seam_e, seam_c = abs(last[0] - first[0]), abs(last[1] - first[1])

    starts = list(range(0, len(x) - 2 * n + 1, hop))
    stats = {s: window_stats(x, sr, s, n) for s in starts + [s + n for s in starts]}
    de = [abs(stats[s][0] - stats[s + n][0]) for s in starts]
    dc = [abs(stats[s][1] - stats[s + n][1]) for s in starts]
    pe = sum(1 for v in de if v < seam_e) / len(de)
    pc = sum(1 for v in dc if v < seam_c) / len(dc)
    p95e = float(np.percentile(de, 95))
    p95c = float(np.percentile(dc, 95))
    return {"seam_dE_db": seam_e, "seam_dc_hz": seam_c, "pct_dE": pe, "pct_dc": pc,
            "interior_p95_dE_db": p95e, "interior_p95_dc_hz": p95c,
            "within_p95_dE": seam_e <= p95e, "within_p95_dc": seam_c <= p95c,
            "within_p95_both": seam_e <= p95e and seam_c <= p95c, "n_interior": len(de)}


def load_mono(path):
    import numpy as np
    try:
        import soundfile as sf
        x, sr = sf.read(str(path), dtype="float32", always_2d=False)
    except Exception:
        import librosa
        x, sr = librosa.load(str(path), sr=None, mono=True)
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    return np.asarray(x, dtype="float32"), int(sr)


def bootstrap(values, stat=statistics.fmean, n_boot=10000, seed=0):
    vals = [float(v) for v in values]
    if not vals:
        return {"n": 0, "point": None, "ci95": None}
    rng = random.Random(seed)
    n = len(vals)
    boots = sorted(stat([vals[rng.randrange(n)] for _ in range(n)]) for _ in range(n_boot))
    return {"n": n, "point": stat(vals), "ci95": [boots[int(0.025 * n_boot)], boots[min(n_boot - 1, int(0.975 * n_boot))]]}


def summarise(rows):
    ok = [r for r in rows if "seam_dE_db" in r]
    return {
        "n_clips": len(ok), "n_skipped": len(rows) - len(ok),
        "share_within_p95_energy": bootstrap([r["within_p95_dE"] for r in ok]),
        "share_within_p95_centroid": bootstrap([r["within_p95_dc"] for r in ok]),
        "share_within_p95_both": bootstrap([r["within_p95_both"] for r in ok]),
        "median_percentile_energy": bootstrap([r["pct_dE"] for r in ok], statistics.median),
        "median_percentile_centroid": bootstrap([r["pct_dc"] for r in ok], statistics.median),
        "median_seam_dE_db": bootstrap([r["seam_dE_db"] for r in ok], statistics.median),
        "wording": "signal measurement relative to each clip's own variation; no audibility claim",
    }


def _self_test():
    import numpy as np
    sr = 16000
    t = np.arange(sr * 10) / sr
    rng = np.random.default_rng(0)
    # stationary noise: seam is like any other place -> typically within the clip's p95
    noise = (rng.standard_normal(len(t)) * 0.1).astype("float32")
    r = relative_seam(noise, sr)
    assert r and r["within_p95_both"], r
    # a clip that fades out to silence: seam (quiet tail -> loud head) is far outside its own variation
    fade = (np.sin(2 * math.pi * 220 * t) * np.linspace(1.0, 0.001, len(t))).astype("float32")
    r2 = relative_seam(fade, sr)
    assert r2 and not r2["within_p95_dE"] and r2["pct_dE"] > 0.95, r2
    # a clip that already swells by 6 dB all the time hides a 3 dB seam
    swell = (np.sin(2 * math.pi * 220 * t) * (0.5 + 0.4 * np.sin(2 * math.pi * 0.5 * t))).astype("float32")
    r3 = relative_seam(swell, sr)
    assert r3 and r3["within_p95_dE"], r3
    assert relative_seam(noise[: sr], sr) is None, "too short -> None"
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips-dir", default="audio-generation/fallback_clips")
    ap.add_argument("--win-ms", type=int, default=250)
    ap.add_argument("--out", default=None)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return 0

    d = (REPO / args.clips_dir) if not Path(args.clips_dir).is_absolute() else Path(args.clips_dir)
    clips = sorted(list(d.rglob("*.ogg")) + list(d.rglob("*.opus")))
    if not clips:
        print(f"no clips under {d}", file=sys.stderr)
        return 2
    rows = []
    for p in clips:
        try:
            x, sr = load_mono(p)
            r = relative_seam(x, sr, args.win_ms) or {"skipped": "too short"}
        except Exception as e:
            r = {"error": f"{type(e).__name__}: {e}"}
        rows.append({"clip": str(p.relative_to(d)), **r})
    summary = summarise(rows)
    print(json.dumps(summary, indent=2))
    if args.out:
        out = (REPO / args.out) if not Path(args.out).is_absolute() else Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"config": {"clips_dir": str(args.clips_dir), "win_ms": args.win_ms},
                                   "summary": summary, "clips": rows}, indent=2), encoding="utf-8")
        print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
