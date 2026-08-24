#!/usr/bin/env python3
"""
d6_crossfade_loop_sweep.py -- SUPPLEMENTARY.md 4.11 / 4.12: the two hypotheses
main.tex's Loop quality discussion names as untested ("a longer or
content-adaptive window, or selecting the loop point to minimise measured seam
rather than to maximise chroma self-similarity") and leaves unquantified.

Data availability, honestly stated up front: `process_audio` only persists
the delivered clip, not the raw pre-loop-cut audio it cut from (this is C-09,
the same gap `_retain_pretrim` exists to eventually close). None of the 141
clips behind Table V / Fig. 6 have their pre-cut audio on disk, so this script
cannot re-run the sweep against that exact population. What IS on disk is the
11 real, hand-checked `fallback_clips/*.ogg` files -- genuine MusicGen output,
already loop-cut and crossfaded once at the production default (50 ms). This
script treats each of those 11 clips as a fresh input track: runs the
production loop detector on it to find a *new* internal loop point (using
the same chroma self-similarity + bar-snap code `d4_process.py` ships), then
sweeps crossfade width and an alternative seam-minimising selection rule at
that new cut. Every number below is a real measurement over n=11 real audio
files, run through the unmodified production seam metric -- just a smaller
and secondary sample to the 141-clip Table V population, not a replacement
for it.

Two experiments:

  A. Crossfade-window sweep. Hold the loop point fixed (production detector's
     own choice), vary crossfade_ms in {50, 100, 250, 500}, measure post-
     crossfade seam via the unmodified `_seam_discontinuity`.

  B. Seam-minimising loop-point selection. At the production crossfade width
     (50 ms), compare the production loop point (argmax chroma similarity,
     snapped to the nearest bar) against an alternative that searches the
     same similarity curve's local maxima plus bar-snapped candidates and
     picks whichever minimises the *measured* post-crossfade seam directly,
     rather than trusting chroma similarity as a proxy for it.

Usage:
    python experiments/d6_crossfade_loop_sweep.py
    python experiments/d6_crossfade_loop_sweep.py --out results/d6-crossfade-loop-sweep.json
"""

import argparse
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import librosa
import numpy as np
from pydub import AudioSegment

from d4_process import (
    _seam_discontinuity,
    _crossfade_loop,
    _vectorized_chroma_similarity,
    _bar_boundaries_ms,
    CROSSFADE_MS,
    MIN_LOOP_SECONDS,
    HOP_LENGTH,
    CHROMA_WINDOW,
    BEATS_PER_BAR,
)

FALLBACK_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "fallback_clips")
SWEEP_WIDTHS_MS = [50, 100, 250, 500]
LOCAL_MAX_ORDER = 5  # frames on each side a point must beat to count as a local peak


def load_clip(path):
    seg = AudioSegment.from_file(path)
    if seg.channels > 1:
        seg = seg.set_channels(1)
    arr = np.array(seg.get_array_of_samples()).astype(np.float32)
    arr /= np.iinfo(seg.array_type).max
    return seg, arr


def similarity_curve(audio_array, sr):
    chroma = librosa.feature.chroma_cqt(y=audio_array, sr=sr, hop_length=HOP_LENGTH)
    n_frames = chroma.shape[1]
    if n_frames <= CHROMA_WINDOW:
        # Mirrors d4_process._detect_loop_point_ms's own too-short-for-search
        # guard. Returning an all-masked curve routes this through
        # production_loop_point's existing isfinite check below instead of
        # needing a second short-circuit path here.
        return np.full(n_frames, -np.inf), n_frames
    sims = _vectorized_chroma_similarity(chroma, CHROMA_WINDOW)
    min_loop_frames = librosa.time_to_frames(MIN_LOOP_SECONDS, sr=sr, hop_length=HOP_LENGTH)
    if min_loop_frames < n_frames:
        sims[:min_loop_frames] = -np.inf
    else:
        # Track shorter than MIN_LOOP_SECONDS entirely -- same short-circuit
        # as d4_process._detect_loop_point_ms's own else branch.
        sims[:] = -np.inf
    return sims, n_frames


def local_maxima(sims, order=LOCAL_MAX_ORDER):
    """Frame indices that are local peaks in the similarity curve (finite,
    beat every neighbour within `order` frames on both sides). Cheap
    substitute for scipy.signal.argrelmax so this script has no extra deps
    beyond what d4_process.py already needs."""
    finite = np.isfinite(sims)
    n = len(sims)
    peaks = []
    for i in range(n):
        if not finite[i]:
            continue
        lo, hi = max(0, i - order), min(n, i + order + 1)
        window = sims[lo:hi]
        if sims[i] == np.max(window) and np.sum(window == sims[i]) == 1:
            peaks.append(i)
    return peaks


def production_loop_point(audio_array, sr, audio_len_ms):
    """Exactly d4_process._detect_loop_point_ms's own logic, inlined so we
    can also surface the candidate list instead of only the final answer."""
    sims, n_frames = similarity_curve(audio_array, sr)
    if not np.isfinite(sims).any():
        return audio_len_ms, None, sims

    best_frame = int(np.argmax(sims))
    best_time_ms = librosa.frames_to_time(best_frame, sr=sr, hop_length=HOP_LENGTH) * 1000

    tempo, beat_frames = librosa.beat.beat_track(y=audio_array, sr=sr, hop_length=HOP_LENGTH)
    beat_times_ms = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH) * 1000
    bar_times_ms = _bar_boundaries_ms(beat_times_ms, BEATS_PER_BAR)
    candidates = bar_times_ms if len(bar_times_ms) > 0 else beat_times_ms
    candidates = candidates[candidates >= MIN_LOOP_SECONDS * 1000]

    if len(candidates) > 0:
        loop_point_ms = float(candidates[int(np.argmin(np.abs(candidates - best_time_ms)))])
    else:
        loop_point_ms = best_time_ms

    return int(loop_point_ms), best_frame, sims


def seam_at(seg, loop_point_ms, crossfade_ms):
    """Cut at loop_point_ms, crossfade at crossfade_ms, measure post-crossfade
    seam. Mirrors process_audio's own pre_crossfade_clip -> _crossfade_loop
    -> _seam_discontinuity chain exactly."""
    pre = seg[:loop_point_ms]
    if len(pre) <= crossfade_ms * 2:
        return None
    looped = _crossfade_loop(pre, crossfade_ms=crossfade_ms)
    return _seam_discontinuity(looped, crossfade_ms=crossfade_ms)


def seam_score(metric):
    """Single scalar to rank candidates by: |energy delta| dominates (it's
    what dB-scale audibility tracks), spectral centroid delta is a tiebreaker
    on a normalised sub-scale so it can't swamp the energy term."""
    if metric is None or metric.get("energy_delta_db") is None:
        return float("inf")
    e = abs(metric["energy_delta_db"])
    c = metric.get("spectral_centroid_delta_hz")
    return e + (abs(c) / 5000.0 if c is not None else 0.0)


def run_clip(mood, path):
    seg, arr = load_clip(path)
    sr = seg.frame_rate
    audio_len_ms = len(seg)

    base_loop_ms, base_frame, sims = production_loop_point(arr, sr, audio_len_ms)
    if base_frame is None or audio_len_ms - base_loop_ms < 2 * max(SWEEP_WIDTHS_MS):
        return {"mood": mood, "skipped": "clip too short for the full sweep", "duration_ms": audio_len_ms}

    # ---- Experiment A: crossfade-window sweep at the fixed production loop point ----
    sweep = {}
    for w in SWEEP_WIDTHS_MS:
        sweep[w] = seam_at(seg, base_loop_ms, w)

    # ---- Experiment B: seam-minimising loop-point selection, at 50 ms ----
    peaks = local_maxima(sims)
    tempo, beat_frames = librosa.beat.beat_track(y=arr, sr=sr, hop_length=HOP_LENGTH)
    beat_times_ms = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH) * 1000
    bar_times_ms = _bar_boundaries_ms(beat_times_ms, BEATS_PER_BAR)
    bar_candidates_ms = [float(t) for t in bar_times_ms if t >= MIN_LOOP_SECONDS * 1000]

    candidate_ms = set()
    for f in peaks:
        t = librosa.frames_to_time(f, sr=sr, hop_length=HOP_LENGTH) * 1000
        if t >= MIN_LOOP_SECONDS * 1000:
            candidate_ms.add(int(t))
    for t in bar_candidates_ms:
        candidate_ms.add(int(t))
    candidate_ms.add(base_loop_ms)
    # Only keep candidates that leave room for the crossfade.
    candidate_ms = sorted(c for c in candidate_ms if audio_len_ms - c >= 2 * CROSSFADE_MS)

    scored = []
    for c in candidate_ms:
        m = seam_at(seg, c, CROSSFADE_MS)
        scored.append((c, m, seam_score(m)))

    if scored:
        best_ms, best_metric, best_score = min(scored, key=lambda x: x[2])
    else:
        best_ms, best_metric, best_score = base_loop_ms, sweep[CROSSFADE_MS], seam_score(sweep[CROSSFADE_MS])

    baseline_metric = sweep[CROSSFADE_MS]
    baseline_score = seam_score(baseline_metric)

    return {
        "mood": mood,
        "duration_ms": audio_len_ms,
        "production_loop_point_ms": base_loop_ms,
        "n_similarity_peaks": len(peaks),
        "n_bar_candidates": len(bar_candidates_ms),
        "n_candidates_evaluated": len(candidate_ms),
        "crossfade_sweep": {str(w): sweep[w] for w in SWEEP_WIDTHS_MS},
        "seam_minimising": {
            "baseline_loop_point_ms": base_loop_ms,
            "baseline_seam": baseline_metric,
            "baseline_score": round(baseline_score, 4) if np.isfinite(baseline_score) else None,
            "chosen_loop_point_ms": best_ms,
            "chosen_seam": best_metric,
            "chosen_score": round(best_score, 4) if np.isfinite(best_score) else None,
            "changed_point": best_ms != base_loop_ms,
            "score_improvement": round(baseline_score - best_score, 4)
            if np.isfinite(baseline_score) and np.isfinite(best_score) else None,
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="results/d6-crossfade-loop-sweep.json")
    args = ap.parse_args()

    moods = sorted(f[:-4] for f in os.listdir(FALLBACK_DIR) if f.endswith(".ogg"))
    results = []
    for mood in moods:
        print(f"[D6] {mood}...", file=sys.stderr)
        results.append(run_clip(mood, os.path.join(FALLBACK_DIR, f"{mood}.ogg")))

    usable = [r for r in results if "skipped" not in r]

    # ---- Aggregate Experiment A: crossfade width vs seam ----
    widths_summary = {}
    for w in SWEEP_WIDTHS_MS:
        energies = [abs(r["crossfade_sweep"][str(w)]["energy_delta_db"]) for r in usable
                    if r["crossfade_sweep"][str(w)] is not None]
        centroids = [r["crossfade_sweep"][str(w)]["spectral_centroid_delta_hz"] for r in usable
                     if r["crossfade_sweep"][str(w)] is not None
                     and r["crossfade_sweep"][str(w)]["spectral_centroid_delta_hz"] is not None]
        widths_summary[w] = {
            "n": len(energies),
            "energy_delta_db_median": float(np.median(energies)) if energies else None,
            "energy_delta_db_mean": float(np.mean(energies)) if energies else None,
            "spectral_centroid_delta_hz_median": float(np.median(centroids)) if centroids else None,
        }

    # ---- Aggregate Experiment B: seam-minimising selection ----
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
            "chosen_energy_db_median": float(np.median(chosen_energies)) if chosen_energies else None,
        },
        "clips": results,
        "caveat": (
            "n=11: the repo's persisted fallback clips, re-cut at a fresh internal "
            "loop point by this script's own call into the production detector. "
            "NOT a re-run over the 141-clip Table V population -- raw pre-loop "
            "audio for that run is not retained on disk (see d4_process.py's "
            "RETAIN_PRETRIM_EVERY / C-09 note)."
        ),
    }

    out_path = os.path.join(os.path.dirname(__file__), "..", args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print(json.dumps({k: v for k, v in summary.items() if k != "clips"}, indent=2))
    print(f"\n[D6] wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
