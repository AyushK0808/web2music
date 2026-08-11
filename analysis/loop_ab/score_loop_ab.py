#!/usr/bin/env python3
"""C-12 (scoring half) — score the loop AB submissions into T3's input.

    python analysis/loop_ab/score_loop_ab.py --responses analysis/loop_ab/responses/*.json
    python analysis/loop_ab/score_loop_ab.py --simulate 30    # harness check, no listeners

Writes ``analysis/out/loop_ab_scored.json``, which ``analysis/figures/t3_loop_ab.py``
turns into T3.

Three things it does that a plain accuracy count would not:

* **Splits by affiliation.** Anyone who has worked on the project has heard
  these clips. Their trials are scored separately and reported separately, per
  the plan's instruction to record the connection and report the two groups
  apart if any slip through.
* **Reports guessed trials.** A listener who pressed "I can't tell" is not the
  same as one who was wrong, and pooling them hides the distinction C6 cares
  about.
* **Uses Wilson intervals.** T3's decision is whether the interval contains
  0.5, and the normal approximation misbehaves near exactly that point.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import random
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent


def wilson(successes: int, n: int, z: float = 1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = successes / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def score(key: dict, responses: list[dict], include_affiliated: bool = False) -> dict:
    answer_of = {t["trial"]: t for t in key["trials"]}

    per_mood: dict[str, dict] = {}
    listeners, excluded = 0, 0
    guessed_total = 0

    for resp in responses:
        if resp.get("affiliation") == "some" and not include_affiliated:
            excluded += 1
            continue
        listeners += 1
        for trial_id, a in resp.get("answers", {}).items():
            t = answer_of.get(int(trial_id))
            if not t:
                continue
            cell = per_mood.setdefault(t["mood"], {"correct": 0, "trials": 0,
                                                   "guessed": 0, "listeners": set()})
            cell["trials"] += 1
            cell["listeners"].add(resp.get("_id", listeners))
            if a.get("guessed"):
                cell["guessed"] += 1
                guessed_total += 1
            if a.get("choice") == t["answer"]:
                cell["correct"] += 1

    for cell in per_mood.values():
        cell["listeners"] = len(cell["listeners"])
        lo, hi = wilson(cell["correct"], cell["trials"])
        cell["detection_rate"] = cell["correct"] / cell["trials"] if cell["trials"] else None
        cell["ci95"] = [lo, hi]
        cell["contains_chance"] = lo <= 0.5 <= hi

    tot_c = sum(c["correct"] for c in per_mood.values())
    tot_n = sum(c["trials"] for c in per_mood.values())
    lo, hi = wilson(tot_c, tot_n)

    return {
        "n_listeners": listeners,
        "n_excluded_affiliated": excluded,
        "n_trials": tot_n,
        "guessed_rate": guessed_total / tot_n if tot_n else None,
        "overall": {"correct": tot_c, "trials": tot_n,
                    "detection_rate": tot_c / tot_n if tot_n else None,
                    "ci95": [lo, hi], "contains_chance": lo <= 0.5 <= hi},
        "per_mood": per_mood,
    }


def simulate(key: dict, n_listeners: int, seed: int = 7) -> list[dict]:
    """Synthetic listeners, for checking the scorer before anyone is recruited.

    Dense moods are given a detection rate above chance and sparse ones exactly
    chance, so a correct scorer must reproduce that split. If the pipeline
    cannot recover a difference it was handed, it will not find one that is
    really there.
    """
    rng = random.Random(seed)
    dense = {"energetic", "tense", "joyful"}
    out = []
    for i in range(n_listeners):
        answers = {}
        for t in key["trials"]:
            p = 0.68 if t["mood"] in dense else 0.50
            correct = rng.random() < p
            choice = t["answer"] if correct else ("b" if t["answer"] == "a" else "a")
            answers[str(t["trial"])] = {"choice": choice, "guessed": rng.random() < 0.15}
        out.append({"_id": i, "affiliation": "none", "answers": answers})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default="analysis/loop_ab/stimuli/key.json")
    ap.add_argument("--responses", nargs="*", default=[])
    ap.add_argument("--simulate", type=int, default=0)
    ap.add_argument("--include-affiliated", action="store_true")
    ap.add_argument("--out", default="analysis/out/loop_ab_scored.json")
    args = ap.parse_args()

    key_path = REPO / args.key
    if not key_path.exists():
        print(f"No stimulus key at {key_path}. Build the stimuli first:\n"
              f"  python analysis/loop_ab/build_stimuli.py", file=sys.stderr)
        return 2
    key = json.loads(key_path.read_text(encoding="utf-8"))

    if args.simulate:
        responses = simulate(key, args.simulate)
        print(f"SIMULATED {args.simulate} listeners — this is a harness check, not a result.\n"
              f"Dense moods were given a true rate of 0.68 and the rest exactly 0.50; the table "
              f"below should recover roughly that.\n")
    else:
        paths = []
        for pattern in args.responses:
            paths.extend(sorted(glob.glob(pattern)))
        if not paths:
            print("No response files. This is expected until H-03 has run — the stimuli, the "
                  "listener app and this scorer are all in place.\n"
                  "Check the pipeline meanwhile with:  --simulate 30", file=sys.stderr)
            return 2
        responses = []
        for i, p in enumerate(paths):
            r = json.loads(Path(p).read_text(encoding="utf-8"))
            r["_id"] = i
            responses.append(r)

    result = score(key, responses, include_affiliated=args.include_affiliated)
    result["simulated"] = bool(args.simulate)
    result["stimulus_key"] = str(key_path.relative_to(REPO))

    out = REPO / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print(f"{result['n_listeners']} listener(s), {result['n_trials']} trials"
          f"{f', {result[chr(39)+chr(39)]}' if False else ''}")
    if result["n_excluded_affiliated"]:
        print(f"  ({result['n_excluded_affiliated']} affiliated listener(s) excluded — "
              f"pass --include-affiliated to score them separately)")
    print(f"  {'mood':<12} {'n':>4} {'rate':>6}  95% CI            chance?")
    for mood, c in sorted(result["per_mood"].items()):
        lo, hi = c["ci95"]
        print(f"  {mood:<12} {c['trials']:>4} {c['detection_rate']:>6.3f}  "
              f"[{lo:.3f}, {hi:.3f}]   {'yes' if c['contains_chance'] else 'NO — above chance'}")
    o = result["overall"]
    print(f"  {'ALL':<12} {o['trials']:>4} {o['detection_rate']:>6.3f}  "
          f"[{o['ci95'][0]:.3f}, {o['ci95'][1]:.3f}]   "
          f"{'yes' if o['contains_chance'] else 'NO — above chance'}")
    print(f"\n  'can't tell' presses: {result['guessed_rate']:.1%} of trials")
    print(f"\nWrote {out.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
