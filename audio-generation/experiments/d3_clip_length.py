#!/usr/bin/env python3
"""
d3_clip_length.py — C-07 / plan §7 ablation 3: does a shorter clip that arrives
sooner beat a longer one that loops less often?

    # Terminal 1
    uvicorn main:app --port 8000
    # Terminal 2
    python experiments/d3_clip_length.py --durations 5,10,15,20,28 --repeats 3
    python experiments/d3_clip_length.py --from-cache results/d2-loop.json  # offline half

`d4_latency.py --sections duration` already produces the latency half of this
question. This is the quality half, joined to it: the same duration sweep, but
measuring what comes *out* rather than how long it took.

── Why this is the highest-leverage of the three §7 ablations ──────────────
The n=141 loop run found the median clip retains only **0.503** of its
requested duration, and 12.8% retain under 0.20. If that ratio depends on the
requested length — if asking for 28 s reliably yields 14 s while asking for
10 s yields 9 s — then the shipped default is asking for audio it then throws
away, and paying full generation latency for it. That would make this ablation
change a product default rather than fill in a table, which none of the other
two can do.

The competing hypothesis is that retention is roughly constant in *absolute*
terms — the detector finds a musical phrase boundary a few seconds in
regardless of how much audio it was given — in which case the shortest clip
that still contains a phrase is strictly better and the answer is the same.
Both are testable here; the script reports the regression rather than picking.

── The product trade-off the numbers feed ────────────────────────────────
For each duration the script computes a **loop-cost**: how many times per
minute the listener hears the seam, multiplied by how audible that seam is
(post-crossfade energy delta). A short clip loops more often, so a short clip
with a good seam can still be worse than a long one with a mediocre seam. That
composite is what the §7 answer should be argued from, not from either half.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from experiments._dcommon import (  # noqa: E402
    analyse_clip, fetch_audio, health, payload_for, request, summarise,
)

DEFAULT_BASE = os.getenv("D_BASE_URL", "http://127.0.0.1:8000")


def loop_cost(duration_ms, seam_db):
    """Seam exposures per minute, weighted by how audible each one is.

    Deliberately simple and deliberately stated: 60000/duration is how often the
    seam comes round, |seam_db| is a proxy for how much it announces itself.
    The product is not a perceptual model — the AB test (C-12) is what decides
    audibility — but it is the right *shape* for the trade-off, and having it
    on the page stops the discussion collapsing into "shorter is faster".
    """
    if not duration_ms or seam_db is None:
        return None
    return (60000.0 / duration_ms) * abs(seam_db)


def run(base_url, durations, moods, repeats, timeout):
    rows = []
    for duration in durations:
        for mood in moods:
            for i in range(repeats):
                nonce = f"cl-{duration}-{mood}-{i}-{int(time.time()*1000)}"
                payload = payload_for(mood, duration_seconds=duration, nonce=nonce)
                wall_ms, body, err = request(f"{base_url}/generate", payload, timeout=timeout)

                row = {"duration_seconds": duration, "mood": mood, "iteration": i,
                       "wall_ms": round(wall_ms, 1), "error": err}
                if body:
                    meta = body.get("metadata") or {}
                    row.update(cache=body.get("cache"),
                               is_fallback=bool(meta.get("is_fallback")),
                               generation_seed=meta.get("generation_seed"),
                               timings=body.get("timings") or {},
                               audio_url=body.get("audio_url"))
                    if body.get("audio_url") and not meta.get("is_fallback"):
                        audio, aerr = fetch_audio(body["audio_url"])
                        if audio:
                            try:
                                q = analyse_clip(audio)
                                q["duration_ratio"] = round(q["duration_ms"] / (duration * 1000), 4)
                                q["loop_cost"] = loop_cost(q["duration_ms"],
                                                           q.get("post_energy_delta_db"))
                                row["quality"] = q
                            except Exception as e:
                                row["quality_error"] = f"{type(e).__name__}: {e}"
                        else:
                            row["quality_error"] = aerr
                rows.append(row)

                q = row.get("quality") or {}
                print(f"  {duration:3d}s {mood:<10} #{i}  {row['wall_ms']/1000:7.1f}s  "
                      f"{'FALLBACK ' if row.get('is_fallback') else ''}"
                      f"got {q.get('duration_ms', 0)/1000:5.1f}s "
                      f"({q.get('duration_ratio', float('nan')):.2f})  "
                      f"seam {q.get('post_energy_delta_db', float('nan')):6.2f} dB"
                      f"{'  ERROR ' + row['error'][:40] if row.get('error') else ''}")
    return rows


def rows_from_cache(path):
    """Reuse the n=141 d2_loop_test.py output as an offline stand-in.

    Not a substitute for the real sweep — those clips were generated with
    whatever duration production asked for, not with a controlled sweep, so
    duration is confounded with mood and with when the clip was made. It is
    enough to exercise the analysis and to see the shape of the relationship
    before spending hours of CPU on the controlled version.
    """
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = []
    for c in data["clips"]:
        if c.get("target_duration_s") is None or c.get("duration_ms") is None:
            continue
        rows.append({
            "duration_seconds": c["target_duration_s"], "mood": c.get("mood"),
            "iteration": 0, "wall_ms": None, "error": None,
            "is_fallback": c.get("source") == "fallback_clips",
            "quality": {
                "duration_ms": c["duration_ms"],
                "duration_ratio": c.get("duration_ratio"),
                "post_energy_delta_db": c.get("post_energy_delta_db"),
                "post_spectral_centroid_delta_hz": c.get("post_spectral_centroid_delta_hz"),
                "lufs": c.get("lufs"),
                "loop_cost": loop_cost(c["duration_ms"], c.get("post_energy_delta_db")),
            },
        })
    return rows, data


def linear_fit(xs, ys):
    """Least squares slope/intercept plus Pearson r. No numpy: this script has
    to run in the same minimal venv as the rest of audio-generation."""
    n = len(xs)
    if n < 3:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    slope = sxy / sxx
    return {"n": n, "slope": slope, "intercept": my - slope * mx,
            "r": sxy / (sxx * syy) ** 0.5}


def report(rows):
    durations = sorted({r["duration_seconds"] for r in rows})
    print("\n" + "=" * 78)
    print("CLIP LENGTH ABLATION")
    print("=" * 78)
    print(f"{'req':>5} {'n':>4} {'delivered p50':>14} {'retention p50':>14} "
          f"{'|seam| p50':>11} {'loops/min':>10} {'loop-cost p50':>14}")

    per_duration = {}
    for d in durations:
        rs = [r for r in rows if r["duration_seconds"] == d
              and r.get("quality") and not r.get("is_fallback")]
        if not rs:
            per_duration[d] = {"n": 0}
            print(f"{d:>4}s {0:>4}   (no generated clips at this duration)")
            continue
        q = [r["quality"] for r in rs]
        delivered = summarise([x["duration_ms"] for x in q])
        retention = summarise([x["duration_ratio"] for x in q])
        seam = summarise([abs(x["post_energy_delta_db"]) for x in q
                          if x.get("post_energy_delta_db") is not None])
        cost = summarise([x["loop_cost"] for x in q if x.get("loop_cost") is not None])
        loops_per_min = 60000.0 / delivered["p50"] if delivered.get("p50") else None
        per_duration[d] = {
            "n": len(rs), "delivered_ms": delivered, "duration_retention": retention,
            "seam_energy_delta_db": seam, "loop_cost": cost,
            "loops_per_minute": round(loops_per_min, 2) if loops_per_min else None,
            "wall_ms": summarise([r.get("wall_ms") for r in rs]),
            "d3_generate_ms": summarise([(r.get("timings") or {}).get("d3_generate_ms")
                                         for r in rs]),
        }
        print(f"{d:>4}s {len(rs):>4} {delivered['p50']/1000:>13.1f}s "
              f"{retention['p50']:>14.3f} {seam.get('p50', float('nan')):>11.2f} "
              f"{loops_per_min:>10.2f} {cost.get('p50', float('nan')):>14.2f}")

    # The question the product answer turns on.
    pts = [(r["duration_seconds"], r["quality"]["duration_ratio"]) for r in rows
           if r.get("quality") and not r.get("is_fallback")
           and r["quality"].get("duration_ratio") is not None]
    ratio_fit = linear_fit([p[0] for p in pts], [p[1] for p in pts]) if pts else None
    abs_pts = [(r["duration_seconds"], r["quality"]["duration_ms"] / 1000.0) for r in rows
               if r.get("quality") and not r.get("is_fallback")]
    abs_fit = linear_fit([p[0] for p in abs_pts], [p[1] for p in abs_pts]) if abs_pts else None

    print("\n" + "-" * 78)
    verdict = "insufficient data"
    if ratio_fit and abs_fit:
        print(f"retention vs requested duration:  slope {ratio_fit['slope']:+.4f} per second, "
              f"r = {ratio_fit['r']:+.3f}  (n={ratio_fit['n']})")
        print(f"delivered  vs requested duration:  slope {abs_fit['slope']:+.3f} s/s, "
              f"r = {abs_fit['r']:+.3f}")
        if ratio_fit["slope"] < -0.01 and ratio_fit["r"] < -0.3:
            verdict = ("retention FALLS with requested length — longer requests are buying audio "
                       "the loop detector then discards, at full generation cost. The shipped "
                       "default is a candidate for change.")
        elif abs(ratio_fit["slope"]) < 0.005:
            verdict = ("retention is roughly flat in requested length — the detector keeps a "
                       "constant fraction, so the choice is a straight latency/loop-frequency "
                       "trade and the loop-cost column decides it.")
        else:
            verdict = "no clean relationship; report the per-duration table and do not fit a line."
        print(f"\nverdict: {verdict}")
    print("=" * 78)

    return {"per_duration": per_duration, "retention_fit": ratio_fit,
            "delivered_fit": abs_fit, "verdict": verdict}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--durations", default="5,10,15,20,28")
    ap.add_argument("--moods", default="calm,focused,tense")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--from-cache", default=None,
                    help="analyse an existing d2_loop_test.py output instead of generating")
    ap.add_argument("--out", default="results/d3-clip-length.json")
    args = ap.parse_args()

    durations = [int(d) for d in args.durations.split(",") if d.strip()]
    moods = [m.strip() for m in args.moods.split(",") if m.strip()]
    started = time.time()
    source = None

    if args.from_cache:
        rows, raw = rows_from_cache(args.from_cache)
        source = args.from_cache
        print(f"[d3_clip_length] OFFLINE MODE — {len(rows)} clips from {source}.\n"
              f"  These were not generated as a controlled sweep: requested duration is "
              f"confounded with mood and with production traffic. Shape only, not a result.\n")
    else:
        body, err = health(args.base_url)
        if err:
            print(f"Cannot reach Feature D at {args.base_url} ({err}).\n"
                  f"Start it with:  uvicorn main:app --port 8000\n"
                  f"Or analyse existing clips offline:  --from-cache results/d2-loop.json",
                  file=sys.stderr)
            return 1
        total = len(durations) * len(moods) * args.repeats
        print(f"[d3_clip_length] backend up. {total} nonce'd generations "
              f"({'+'.join(str(d) for d in durations)}s x {len(moods)} moods x {args.repeats}). "
              f"This is a long CPU run.\n")
        rows = run(args.base_url, durations, moods, args.repeats, args.timeout)

    summary = report(rows)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "elapsed_s": round(time.time() - started, 1),
        "offline_source": source,
        "config": {"durations": durations, "moods": moods, "repeats": args.repeats},
        "summary": summary,
        "rows": rows,
    }, indent=2), encoding="utf-8")
    print(f"\nWrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
