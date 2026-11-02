#!/usr/bin/env python3
"""
d6_loop_seeds.py -- S-G loop study at fresh-clip scale (R4 #5).

    # Terminal 1 (the generator under test; record W2M_COMPILE / W2M_MODEL)
    uvicorn main:app --port 8000
    # Terminal 2
    python experiments/d6_loop_seeds.py --seeds 20 --duration 15 --out results/d6-loop-seeds-5060.json
    python experiments/d6_loop_seeds.py --dry-run      # list the (mood, seed) grid only

11 moods x N fixed seeds. Every clip is generated through the running Feature D
(unique nonce, so the cache never answers), downloaded, and handed to
`d6_crossfade_loop_sweep.run_clip` -- the same function that produced the n=141
numbers, so nothing about the seam logic is reimplemented here.

Reported per rule (chroma = the original argmax-chroma cut, seam = the measured
seam selector now shipped as the default, C-1):
  * p50 |dE| with a 10k-sample bootstrap CI
  * share of seams above 1 dB with a bootstrap CI
  * McNemar's exact test on the paired "above 1 dB" flags
  * Wilcoxon signed-rank on the paired |dE| values
Seams are paired by clip, so the comparison is within-clip by construction.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from experiments._dcommon import (  # noqa: E402
    MOOD_PROFILES, bootstrap_ci, fetch_audio, hardware_manifest, health, mcnemar_exact,
    paired_wilcoxon, payload_for, request, seeds,
)

DEFAULT_BASE = os.getenv("D_BASE_URL", "http://127.0.0.1:8000")
SEAM_THRESHOLD_DB = 1.0


def generate_clips(base_url, moods, seed_list, duration, timeout, clip_dir):
    rows = []
    for mood in moods:
        for i, seed in enumerate(seed_list):
            nonce = f"loop-{mood}-{i}-{seed}"
            payload = payload_for(mood, duration_seconds=duration, nonce=nonce, seed_override=seed)
            wall_ms, body, err = request(f"{base_url}/generate", payload, timeout=timeout)
            row = {"mood": mood, "seed_index": i, "seed": seed, "wall_ms": round(wall_ms, 1), "error": err}
            meta = (body or {}).get("metadata") or {}
            row["is_fallback"] = bool(meta.get("is_fallback"))
            if body and body.get("audio_url") and not row["is_fallback"]:
                audio, aerr = fetch_audio(body["audio_url"])
                if audio:
                    path = clip_dir / f"{mood}-{i:02d}.ogg"
                    path.write_bytes(audio)
                    row["path"] = str(path)
                else:
                    row["error"] = aerr
            rows.append(row)
            print(f"  {mood:<10} seed#{i:02d} {wall_ms / 1000:6.1f}s "
                  f"{'FALLBACK ' if row['is_fallback'] else ''}{row.get('error') or ''}")
    return rows


def analyse(rows):
    import d6_crossfade_loop_sweep as d6

    per_clip = []
    for r in rows:
        if "path" not in r:
            continue
        res = d6.run_clip(r["mood"], r["path"])
        if "skipped" in res:
            continue
        sm = res["seam_minimising"]
        if not sm["baseline_seam"] or not sm["chosen_seam"]:
            continue
        per_clip.append({
            "mood": r["mood"], "seed": r["seed"],
            "chroma_dE": abs(sm["baseline_seam"]["energy_delta_db"]),
            "seam_dE": abs(sm["chosen_seam"]["energy_delta_db"]),
            "chroma_dc": sm["baseline_seam"].get("spectral_centroid_delta_hz"),
            "seam_dc": sm["chosen_seam"].get("spectral_centroid_delta_hz"),
            "changed_point": sm["changed_point"],
        })

    chroma = [c["chroma_dE"] for c in per_clip]
    seam = [c["seam_dE"] for c in per_clip]
    above_c = [v > SEAM_THRESHOLD_DB for v in chroma]
    above_s = [v > SEAM_THRESHOLD_DB for v in seam]

    def ci(values, stat=statistics.median):
        return dict(zip(("point", "lo", "hi"), bootstrap_ci(values, stat=stat)))

    summary = {
        "n_clips": len(per_clip),
        "chroma_p50_dE": ci(chroma),
        "seam_p50_dE": ci(seam),
        "chroma_share_above_1dB": ci([float(f) for f in above_c], statistics.fmean),
        "seam_share_above_1dB": ci([float(f) for f in above_s], statistics.fmean),
        "mcnemar_above_1dB": mcnemar_exact(above_c, above_s),
        "wilcoxon_dE": paired_wilcoxon(chroma, seam),
        "changed_point_fraction": (sum(1 for c in per_clip if c["changed_point"]) / len(per_clip))
        if per_clip else None,
    }
    return per_clip, summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--moods", default=",".join(MOOD_PROFILES))
    ap.add_argument("--seeds", type=int, default=20, help="fixed seeds per mood (11 x 20 = 220 clips)")
    ap.add_argument("--duration", type=int, default=15)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="results/d6-loop-seeds.json")
    args = ap.parse_args()

    moods = [m.strip() for m in args.moods.split(",") if m.strip()]
    seed_list = seeds(args.seeds)
    if args.dry_run:
        print(f"{len(moods)} moods x {len(seed_list)} seeds = {len(moods) * len(seed_list)} clips")
        print("seeds:", seed_list)
        return 0

    _body, err = health(args.base_url)
    if err:
        print(f"Cannot reach Feature D at {args.base_url} ({err})", file=sys.stderr)
        return 1

    started = time.time()
    with tempfile.TemporaryDirectory(prefix="w2m-loop-") as td:
        rows = generate_clips(args.base_url, moods, seed_list, args.duration, args.timeout, Path(td))
        per_clip, summary = analyse(rows)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "elapsed_s": round(time.time() - started, 1),
        "manifest": hardware_manifest(args.base_url),
        "seeds": seed_list,
        "config": {"moods": moods, "duration_seconds": args.duration, "threshold_db": SEAM_THRESHOLD_DB},
        "summary": summary,
        "generation_rows": [{k: v for k, v in r.items() if k != "path"} for r in rows],
        "clips": per_clip,
    }, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"\nWrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
