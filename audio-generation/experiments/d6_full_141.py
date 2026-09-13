#!/usr/bin/env python3
"""Items 46 & 51: the exact same experiment d6_crossfade_loop_sweep.py runs
at n=11 (fallback_clips only), now at the full 141-clip Table V population,
now that audio-generation/audio-cache/ has been recovered.

Imports run_clip() directly from the original script -- does not
reimplement any of the loop-detection, crossfade, or seam-scoring logic,
so there is zero risk of drift from the production code path.
"""
import json
import os
import sys

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AUDIO_GEN = os.path.join(REPO, "audio-generation")
sys.path.insert(0, AUDIO_GEN)
sys.path.insert(0, os.path.join(AUDIO_GEN, "experiments"))

import d6_crossfade_loop_sweep as d6

FALLBACK_DIR = os.path.join(AUDIO_GEN, "fallback_clips")
CACHE_DIR = os.path.join(AUDIO_GEN, "audio-cache")

# Same id -> mood join d2_loop_test.py already uses.
d2 = json.load(open(os.path.join(AUDIO_GEN, "results", "d2-loop.json")))
id_to_mood = {c["id"]: c["mood"] for c in d2["clips"] if c["source"] == "audio_cache"}

targets = []  # (mood, path)
for f in sorted(os.listdir(FALLBACK_DIR)):
    if f.endswith(".ogg"):
        targets.append((f[:-4], os.path.join(FALLBACK_DIR, f)))

cache_files = {f[:12]: f for f in os.listdir(CACHE_DIR) if f.endswith(".ogg")}
matched, unmatched = 0, 0
for cid, mood in id_to_mood.items():
    if cid in cache_files:
        targets.append((mood, os.path.join(CACHE_DIR, cache_files[cid])))
        matched += 1
    else:
        unmatched += 1

print(f"targets: {len(targets)} (11 fallback + {matched} audio_cache matched, {unmatched} unmatched)", file=sys.stderr)
assert unmatched == 0, "expected every d2-loop.json audio_cache id to have a recovered file"
assert len(targets) == 141, f"expected 141 total, got {len(targets)}"

results = []
for i, (mood, path) in enumerate(targets):
    print(f"[{i+1}/{len(targets)}] {mood} ({os.path.basename(path)[:16]}...)", file=sys.stderr)
    results.append(d6.run_clip(mood, path))

usable = [r for r in results if "skipped" not in r]
print(f"\nusable: {len(usable)} / {len(results)}", file=sys.stderr)

# ---- Aggregate Experiment A: crossfade width vs seam, n=141 scale ----
widths_summary = {}
for w in d6.SWEEP_WIDTHS_MS:
    energies = [abs(r["crossfade_sweep"][str(w)]["energy_delta_db"]) for r in usable
                if r["crossfade_sweep"][str(w)] is not None]
    centroids = [r["crossfade_sweep"][str(w)]["spectral_centroid_delta_hz"] for r in usable
                 if r["crossfade_sweep"][str(w)] is not None
                 and r["crossfade_sweep"][str(w)]["spectral_centroid_delta_hz"] is not None]
    widths_summary[w] = {
        "n": len(energies),
        "energy_delta_db_median": float(np.median(energies)) if energies else None,
        "energy_delta_db_p95": float(np.percentile(energies, 95)) if energies else None,
        "spectral_centroid_delta_hz_median": float(np.median(centroids)) if centroids else None,
    }

# ---- Aggregate Experiment B: seam-minimising selection, n=141 scale ----
n_changed = sum(1 for r in usable if r["seam_minimising"]["changed_point"])
improvements = [r["seam_minimising"]["score_improvement"] for r in usable
                if r["seam_minimising"]["score_improvement"] is not None]
baseline_energies = [abs(r["seam_minimising"]["baseline_seam"]["energy_delta_db"]) for r in usable
                     if r["seam_minimising"]["baseline_seam"] is not None]
chosen_energies = [abs(r["seam_minimising"]["chosen_seam"]["energy_delta_db"]) for r in usable
                   if r["seam_minimising"]["chosen_seam"] is not None]

summary = {
    "n_clips": len(results),
    "n_usable": len(usable),
    "skipped": [r["mood"] for r in results if "skipped" in r],
    "experiment_a_crossfade_sweep": widths_summary,
    "experiment_b_seam_minimising": {
        "n_changed_point": n_changed,
        "n_usable": len(usable),
        "changed_fraction": n_changed / len(usable) if usable else None,
        "score_improvement_median": float(np.median(improvements)) if improvements else None,
        "baseline_energy_db_median": float(np.median(baseline_energies)) if baseline_energies else None,
        "baseline_energy_db_p95": float(np.percentile(baseline_energies, 95)) if baseline_energies else None,
        "chosen_energy_db_median": float(np.median(chosen_energies)) if chosen_energies else None,
        "chosen_energy_db_p95": float(np.percentile(chosen_energies, 95)) if chosen_energies else None,
    },
    "clips": results,
    "caveat": "n=141: full Table V population, recovered audio-cache/ + fallback_clips/.",
}

out_path = os.path.join(AUDIO_GEN, "results", "d6-crossfade-loop-sweep-n141.json")
json.dump(summary, open(out_path, "w"), indent=2)
print(json.dumps({k: v for k, v in summary.items() if k != "clips"}, indent=2))
print(f"\nwrote {out_path}", file=sys.stderr)
