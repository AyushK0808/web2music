#!/usr/bin/env python3
"""
d7_generators.py -- S-G generator comparison (R4 #5, C-4).

The generator is a process-level setting (W2M_MODEL), so this script measures
ONE back end per invocation and a second mode merges the per-generator files:

    # for each of: musicgen-small musicgen-medium audioldm2-music
    W2M_MODEL=musicgen-medium uvicorn main:app --port 8000
    python experiments/d7_generators.py run --seeds 5 --duration 15 \
        --clips-dir results/d7-clips --out results/d7-musicgen-medium.json

    python experiments/d7_generators.py merge results/d7-musicgen-small.json \
        results/d7-musicgen-medium.json results/d7-audioldm2-music.json \
        --out results/d7-generators.json

Per clip: wall time, real-time factor (generation seconds per second of
requested audio), delivered duration and its ratio to the request, and the seam
after loop synthesis. Clips are kept as .ogg under --clips-dir/<generator>/ so
analysis/proxies/score_fit.py can add CLAP adherence and Audiobox Aesthetics
without regenerating anything. Same 11 moods x same fixed seeds for every
generator, so the comparison is paired by (mood, seed).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from experiments._dcommon import (  # noqa: E402
    MOOD_PROFILES, analyse_clip, bootstrap_ci, fetch_audio, hardware_manifest, health,
    payload_for, request, seeds, summarise,
)

DEFAULT_BASE = os.getenv("D_BASE_URL", "http://127.0.0.1:8000")


def run(args) -> int:
    body, err = health(args.base_url)
    if err:
        print(f"Cannot reach Feature D at {args.base_url} ({err})", file=sys.stderr)
        return 1
    generator = ((body or {}).get("generator") or {}).get("model", "unknown")
    moods = list(MOOD_PROFILES) if args.moods == "all" else [m.strip() for m in args.moods.split(",")]
    seed_list = seeds(args.seeds)
    clip_dir = Path(args.clips_dir) / generator
    clip_dir.mkdir(parents=True, exist_ok=True)
    print(f"[d7] generator={generator}  {len(moods)} moods x {len(seed_list)} seeds at {args.duration}s")

    rows, started = [], time.time()
    for mood in moods:
        for i, seed in enumerate(seed_list):
            nonce = f"gen-{generator}-{mood}-{i}-{seed}"
            payload = payload_for(mood, duration_seconds=args.duration, nonce=nonce, seed_override=seed)
            wall_ms, resp, rerr = request(f"{args.base_url}/generate", payload, timeout=args.timeout)
            row = {"generator": generator, "mood": mood, "seed_index": i, "seed": seed,
                   "wall_ms": round(wall_ms, 1), "error": rerr,
                   "rtf": round(wall_ms / 1000 / args.duration, 3)}
            meta = (resp or {}).get("metadata") or {}
            row["is_fallback"] = bool(meta.get("is_fallback"))
            row["d3_generate_ms"] = ((resp or {}).get("timings") or {}).get("d3_generate_ms")
            if resp and resp.get("audio_url") and not row["is_fallback"]:
                audio, aerr = fetch_audio(resp["audio_url"])
                if audio:
                    path = clip_dir / f"{mood}-{i:02d}.ogg"
                    path.write_bytes(audio)
                    row["clip"] = str(path)
                    try:
                        row["quality"] = analyse_clip(audio)
                    except Exception as e:
                        row["quality_error"] = f"{type(e).__name__}: {e}"
                else:
                    row["error"] = aerr
            rows.append(row)
            q = row.get("quality") or {}
            print(f"  {mood:<10} #{i} {wall_ms / 1000:6.1f}s rtf {row['rtf']:5.2f} "
                  f"seam {q.get('post_energy_delta_db', float('nan')):6.2f} dB "
                  f"{'FALLBACK ' if row['is_fallback'] else ''}{rerr or ''}")

    generated = [r for r in rows if r.get("quality")]
    summary = {
        "generator": generator,
        "n_requests": len(rows),
        "n_generated": len(generated),
        "rtf": summarise([r["rtf"] for r in rows if not r["error"]]),
        "d3_generate_ms": summarise([r["d3_generate_ms"] for r in rows]),
        "seam_energy_delta_db": summarise([abs(r["quality"]["post_energy_delta_db"]) for r in generated]),
        "duration_retention": summarise([r["quality"]["duration_ms"] / (args.duration * 1000) for r in generated]),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "elapsed_s": round(time.time() - started, 1),
        "manifest": hardware_manifest(args.base_url),
        "seeds": seed_list,
        "config": {"moods": moods, "duration_seconds": args.duration},
        "summary": summary,
        "rows": rows,
    }, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"\nWrote {out}")
    return 0


def merge(args) -> int:
    parts = [json.loads(Path(p).read_text(encoding="utf-8")) for p in args.inputs]
    merged = {"generators": {}, "paired": {}}
    by_gen = {}
    for part in parts:
        g = part["summary"]["generator"]
        merged["generators"][g] = {"summary": part["summary"], "manifest": part.get("manifest")}
        by_gen[g] = {(r["mood"], r["seed"]): r for r in part["rows"] if r.get("quality")}
    names = list(by_gen)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            keys = sorted(set(by_gen[a]) & set(by_gen[b]))
            diffs = [abs(by_gen[a][k]["quality"]["post_energy_delta_db"])
                     - abs(by_gen[b][k]["quality"]["post_energy_delta_db"]) for k in keys]
            point, lo, hi = bootstrap_ci(diffs)
            merged["paired"][f"{a}_vs_{b}"] = {"n_pairs": len(keys), "median_seam_diff_db": point,
                                              "ci": [lo, hi]}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    print(f"Wrote {out}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--base-url", default=DEFAULT_BASE)
    r.add_argument("--moods", default="all")
    r.add_argument("--seeds", type=int, default=5)
    r.add_argument("--duration", type=int, default=15)
    r.add_argument("--timeout", type=int, default=1200)
    r.add_argument("--clips-dir", default="results/d7-clips")
    r.add_argument("--out", required=True)
    m = sub.add_parser("merge")
    m.add_argument("inputs", nargs="+")
    m.add_argument("--out", default="results/d7-generators.json")
    args = ap.parse_args()
    return run(args) if args.cmd == "run" else merge(args)


if __name__ == "__main__":
    raise SystemExit(main())
