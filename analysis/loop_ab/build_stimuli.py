#!/usr/bin/env python3
"""C-12 (stimulus half) — build the forced-choice pairs for the loop AB test.

    python analysis/loop_ab/build_stimuli.py --cache audio-generation/audio-cache \
        --out analysis/loop_ab/stimuli --pairs-per-mood 3

Each trial is two length-matched clips:

  **looped**     one loop played through two full cycles (A + A)
  **continuous** an excerpt of the same total length taken from a longer piece,
                 containing no repeat

and the listener is asked which one contained a repeat. Chance is 50%, and C6
wants the confidence interval to *include* 50%.

── The three ways this test gets rigged, and what stops each ────────────────

1. **Length or loudness gives it away.** The two clips are trimmed to the same
   duration to the millisecond and loudness-matched to the same LUFS. Without
   that a listener can score above chance on a cue that has nothing to do with
   seams.
2. **The continuous clip is a different piece of music.** Then the task becomes
   "which of these two sounds more repetitive", which is a different question.
   Both members of a pair come from the *same generated clip* wherever the
   source is long enough: the loop is the detected loop; the continuous excerpt
   is a contiguous stretch of the same audio.
3. **Order is predictable.** Which of the two plays first is drawn per trial
   from a seeded RNG and recorded in the answer key, never in the file names —
   `trial-07-a.ogg` must not be the looped one every time.

── Per-mood balancing ──────────────────────────────────────────────────────
§6.6 predicts dense moods (energetic, tense) seam worse than sparse ones
(calm), and T3 reports per mood. So the sampler takes an equal number of pairs
per mood rather than sampling the cache uniformly, which would over-represent
whatever mood happened to be generated most.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "audio-generation"))

TARGET_LUFS = -18.0


def load_segment(path: Path):
    from pydub import AudioSegment
    return AudioSegment.from_file(path)


def match_loudness(seg, target=TARGET_LUFS):
    """Normalise to a fixed LUFS so loudness cannot be the discriminating cue."""
    import numpy as np
    import pyloudnorm as pyln

    samples = np.array(seg.get_array_of_samples()).astype(np.float32)
    samples /= np.iinfo(seg.array_type).max
    try:
        meter = pyln.Meter(seg.frame_rate)
        loudness = meter.integrated_loudness(samples)
        return seg.apply_gain(target - loudness)
    except Exception:
        return seg


def make_pair(seg, rng, crossfade_ms=50):
    """(looped, continuous) — equal length, from the same source audio.

    The looped member is the clip played twice with the same equal-power
    crossfade the production pipeline applies at the seam, so what a listener
    hears is the shipped artefact rather than a butt-joined approximation.
    """
    n = len(seg)
    if n < 4000:
        return None

    half = n // 2
    loop_src = seg[:half]
    looped = loop_src.append(loop_src, crossfade=crossfade_ms)

    # A contiguous stretch of the same audio, the same length as `looped`.
    want = len(looped)
    if n < want:
        return None
    start = rng.randrange(0, n - want + 1)
    continuous = seg[start:start + want]

    # Trim both to the exact same length: a millisecond difference is a cue.
    m = min(len(looped), len(continuous))
    looped, continuous = looped[:m], continuous[:m]
    return match_loudness(looped), match_loudness(continuous)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default="audio-generation/audio-cache")
    ap.add_argument("--loop-results", default="audio-generation/results/d2-loop.json",
                    help="d2_loop_test.py output, used for the mood of each clip")
    ap.add_argument("--out", default="analysis/loop_ab/stimuli")
    ap.add_argument("--pairs-per-mood", type=int, default=3)
    ap.add_argument("--seed", type=int, default=20260810)
    args = ap.parse_args()

    cache = REPO / args.cache
    if not cache.exists():
        print(f"No audio cache at {cache}. Generate some clips first.", file=sys.stderr)
        return 2

    results_path = REPO / args.loop_results
    mood_of = {}
    if results_path.exists():
        for c in json.loads(results_path.read_text(encoding="utf-8"))["clips"]:
            if c.get("source") == "audio_cache":
                mood_of[c["id"]] = c["mood"]

    files = sorted(cache.glob("*.ogg"))
    if not files:
        print(f"No .ogg clips in {cache}.", file=sys.stderr)
        return 2

    # d2_loop_test.py stores a 12-character prefix of the cache-key hash as the
    # clip id, not the full filename stem. Matching on equality silently yields
    # zero pairs and reads like "the cache is empty".
    by_mood: dict[str, list[Path]] = {}
    unknown = 0
    for f in files:
        mood = mood_of.get(f.stem)
        if mood is None:
            mood = next((m for cid, m in mood_of.items() if f.stem.startswith(cid)), None)
        if mood is None:
            unknown += 1
            continue
        by_mood.setdefault(mood, []).append(f)

    rng = random.Random(args.seed)
    outdir = REPO / args.out
    outdir.mkdir(parents=True, exist_ok=True)

    trials, skipped = [], []
    for mood in sorted(by_mood):
        pool = by_mood[mood][:]
        rng.shuffle(pool)
        made = 0
        for src in pool:
            if made >= args.pairs_per_mood:
                break
            try:
                seg = load_segment(src)
            except Exception as e:
                skipped.append({"file": src.name, "reason": str(e)})
                continue
            pair = make_pair(seg, rng)
            if pair is None:
                skipped.append({"file": src.name, "reason": "too short to split into a pair"})
                continue
            looped, continuous = pair

            idx = len(trials)
            # Order drawn per trial, and stored only in the key.
            looped_is_a = rng.random() < 0.5
            a, b = (looped, continuous) if looped_is_a else (continuous, looped)
            a_path = outdir / f"trial-{idx:03d}-a.ogg"
            b_path = outdir / f"trial-{idx:03d}-b.ogg"
            a.export(a_path, format="ogg", codec="libopus", bitrate="128k")
            b.export(b_path, format="ogg", codec="libopus", bitrate="128k")

            trials.append({
                "trial": idx, "mood": mood, "source_clip": src.stem,
                "a": a_path.name, "b": b_path.name,
                "answer": "a" if looped_is_a else "b",
                "duration_ms": len(a),
                "loop_length_ms": len(seg) // 2,
            })
            made += 1

    key = {
        "generated_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "seed": args.seed, "target_lufs": TARGET_LUFS,
        "n_trials": len(trials), "moods": sorted(by_mood),
        "clips_without_a_known_mood": unknown,
        "skipped": skipped,
        "trials": trials,
    }
    (outdir / "key.json").write_text(json.dumps(key, indent=2), encoding="utf-8")

    # The listener-facing manifest carries no answers. Two files rather than
    # one field, because a single file with the key in it will eventually be
    # served to a participant by accident.
    (outdir / "manifest.json").write_text(json.dumps({
        "n_trials": len(trials),
        "trials": [{"trial": t["trial"], "a": t["a"], "b": t["b"],
                    "duration_ms": t["duration_ms"]} for t in trials],
    }, indent=2), encoding="utf-8")

    per_mood = {}
    for t in trials:
        per_mood[t["mood"]] = per_mood.get(t["mood"], 0) + 1
    print(f"{len(trials)} trial(s) across {len(per_mood)} mood(s) -> {outdir}")
    for m, n in sorted(per_mood.items()):
        print(f"  {m:<12} {n}")
    if unknown:
        print(f"  ({unknown} cached clip(s) had no mood in {args.loop_results} and were skipped)")
    if skipped:
        print(f"  ({len(skipped)} clip(s) unusable — see key.json)")
    print("\nkey.json has the answers. manifest.json is the only file a listener should ever see.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
