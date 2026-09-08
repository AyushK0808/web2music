"""Item 48: test flooring the loop-search start as a fraction of source
duration, instead of the fixed MIN_LOOP_SECONDS=3.0 constant, against the
same 141 real clips used for items 46/51.

Monkey-patches d6_crossfade_loop_sweep's imported MIN_LOOP_SECONDS per
clip (to duration_seconds * FRACTION, floored at the original 3.0s so very
short clips aren't made worse) and calls the SAME unmodified
production_loop_point()/similarity_curve() functions -- no reimplementation
of the search logic itself, only the threshold it's searching from.
"""
import json, os, sys
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AUDIO_GEN = os.path.join(REPO, "audio-generation")
sys.path.insert(0, AUDIO_GEN)
sys.path.insert(0, os.path.join(AUDIO_GEN, "experiments"))
import d6_crossfade_loop_sweep as d6

FALLBACK_DIR = os.path.join(AUDIO_GEN, "fallback_clips")
CACHE_DIR = os.path.join(AUDIO_GEN, "audio-cache")
ORIGINAL_MIN_LOOP_SECONDS = d6.MIN_LOOP_SECONDS  # 3.0, save before any patching

d2 = json.load(open(os.path.join(AUDIO_GEN, "results", "d2-loop.json")))
id_to_mood = {c["id"]: c["mood"] for c in d2["clips"] if c["source"] == "audio_cache"}
cache_files = {f[:12]: f for f in os.listdir(CACHE_DIR) if f.endswith(".ogg")}

targets = [(f[:-4], os.path.join(FALLBACK_DIR, f)) for f in sorted(os.listdir(FALLBACK_DIR)) if f.endswith(".ogg")]
targets += [(mood, os.path.join(CACHE_DIR, cache_files[cid])) for cid, mood in id_to_mood.items() if cid in cache_files]

FRACTION = 0.5  # candidate loop point must be at least 50% of the clip's own duration in

def retention_for(mood, path, fraction):
    seg, arr = d6.load_clip(path)
    sr = seg.frame_rate
    audio_len_ms = len(seg)
    d6.MIN_LOOP_SECONDS = max(ORIGINAL_MIN_LOOP_SECONDS, (audio_len_ms / 1000.0) * fraction)
    loop_ms, frame, sims = d6.production_loop_point(arr, sr, audio_len_ms)
    d6.MIN_LOOP_SECONDS = ORIGINAL_MIN_LOOP_SECONDS  # restore immediately, don't leak
    return audio_len_ms, loop_ms

rows = []
for mood, path in targets:
    dur_ms, orig_loop = retention_for(mood, path, 0.0)  # fraction=0 -> behaves like original 3.0s-only floor
    _, new_loop = retention_for(mood, path, FRACTION)
    rows.append({
        "mood": mood, "duration_ms": dur_ms,
        "orig_loop_ms": orig_loop, "orig_retention": orig_loop / dur_ms,
        "new_loop_ms": new_loop, "new_retention": new_loop / dur_ms,
    })

orig_ret = [r["orig_retention"] for r in rows]
new_ret = [r["new_retention"] for r in rows]
print(f"n = {len(rows)}")
print(f"ORIGINAL (3.0s fixed floor):      median retention = {np.median(orig_ret):.3f}   p05 = {np.percentile(orig_ret,5):.3f}")
print(f"NEW (max(3.0s, {FRACTION}*duration)):  median retention = {np.median(new_ret):.3f}   p05 = {np.percentile(new_ret,5):.3f}")
print(f"clips where new floor actually moved the loop point: {sum(1 for r in rows if r['new_loop_ms'] != r['orig_loop_ms'])} / {len(rows)}")

json.dump(rows, open(os.path.join(AUDIO_GEN, "results", "item48_retention.json"), "w"), indent=2)
