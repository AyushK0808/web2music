"""S-C — how much of the time does a listener actually hear page-level generated audio? (R3 W2)

    python analysis/exposure/simulate_exposure.py \
        --d4 5060=audio-generation/results/d4-duration-5060.json \
        --d4 cpu=audio-generation/results/d4-duration-cpu2.json \
        --d4 m4=audio-generation/results/d4-latency-m4.json \
        --moods analysis/out/corpus_moods.json --out analysis/exposure/exposure.json
    python analysis/exposure/simulate_exposure.py --self-test

The paper's "36 ms" is the mood-level fallback clip. Whether a listener ever
hears page-conditioned audio depends on how long they stay on a page compared
with how long generation takes. This script simulates browsing sessions and
reports, per hardware tier and requested clip length, the share of VISITS and of
LISTENING SECONDS spent at each of three levels of conditioning:

    L1  mood-level fallback clip (11 clips, always available)
    L2  profile-level cache hit: the pre-warm grid, or a clip an earlier visit in
        the session generated for the same cache key
    L3  page-level fresh generation, heard once the worker has finished it

Model (every assumption is a parameter, and the sensitivity sweep varies them)
  * a session is N page visits. Moods follow a first-order Markov chain: stay with
    probability `stickiness`, otherwise draw from the corpus mood frequencies.
  * dwell time on a page is Weibull with shape < 1 (many short visits, a long
    tail), the form reported for web dwell times (Liu, White & Dumais, SIGIR 2010).
    The median is swept; long-form pages get a multiplier, so the result is also
    stratified by page type.
  * the mood is committed after a CONFIDENCE_WINDOW (5 s) of stability, so a visit
    shorter than that produces no audio change at all ("none").
  * one generation worker. A request is cancelled when the next visit needs a
    different cache key, and the work done so far is lost.
  * generation time is DRAWN FROM THE MEASURED DISTRIBUTIONS (d4_latency.py
    `duration` section), per tier and duration; a measured timeout is censored: it
    never completes within any dwell.
  * cache: 99 pre-warm entries (11 moods x 3 bpm buckets x 3 energy tiers). A page's
    key is in the grid with probability `grid_hit` (a parameter: real profiles
    vary more than the grid does); otherwise it is drawn from a Zipf-distributed
    off-grid key space, so repeated keys in a session hit the cache after the first
    generation.

Nothing here is a measurement of listeners. The output says how often generated
audio COULD be heard under stated dwell assumptions, which is the claim the paper
needs, and the dwell model is listed as a limitation.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import sys
from pathlib import Path

CONFIDENCE_WINDOW_S = 5.0
MOODS = ["calm", "focused", "joyful", "energetic", "sad", "dark", "nostalgic",
         "curious", "tense", "uplifting", "neutral"]
WEIBULL_SHAPE = 0.6
LONG_FORM_DWELL_MULTIPLIER = 3.0
LONG_FORM_SHARE = 0.25
CENSORED = float("inf")


# ── inputs ──────────────────────────────────────────────────────────────────

def load_gen_times(d4_specs, gen_json):
    """{tier: {duration_s: [seconds or inf, ...]}} from d4 result files and/or a plain JSON."""
    out: dict = {}
    for spec in d4_specs or []:
        tier, _, path = spec.partition("=")
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        rows = (data.get("sections", {}).get("duration") or data.get("rows") or [])
        for r in rows:
            d = r.get("duration_seconds")
            if d is None:
                continue
            if r.get("error") or r.get("is_fallback"):
                t = CENSORED  # timeouts and fallbacks are censored, not missing
            else:
                ms = (r.get("timings") or {}).get("d3_generate_ms") or r.get("wall_ms")
                if ms is None:
                    continue
                t = ms / 1000.0
            out.setdefault(tier, {}).setdefault(int(d), []).append(t)
    if gen_json:
        for tier, by_d in json.loads(Path(gen_json).read_text(encoding="utf-8")).items():
            for d, vals in by_d.items():
                out.setdefault(tier, {}).setdefault(int(d), []).extend(
                    CENSORED if v is None else float(v) for v in vals)
    return out


def mood_frequencies(path):
    if not path:
        return {m: 1 / len(MOODS) for m in MOODS}
    moods = json.loads(Path(path).read_text(encoding="utf-8"))
    counts = {m: 0 for m in MOODS}
    for m in moods:
        if m in counts:
            counts[m] += 1
    total = sum(counts.values()) or 1
    return {m: c / total for m, c in counts.items()}


# ── model ───────────────────────────────────────────────────────────────────

def weibull_scale(median_s, shape=WEIBULL_SHAPE):
    return median_s / (math.log(2) ** (1 / shape))


class Sim:
    def __init__(self, freqs, gen_samples, *, stickiness, grid_hit, median_dwell_s,
                 visits_per_session=20, off_grid_keys=500, zipf_s=1.0, rng):
        self.freqs, self.gen_samples = freqs, gen_samples
        self.stickiness, self.grid_hit = stickiness, grid_hit
        self.median, self.n_visits = median_dwell_s, visits_per_session
        self.rng = rng
        weights = [1 / (k ** zipf_s) for k in range(1, off_grid_keys + 1)]
        tot = sum(weights)
        self.off_w = [w / tot for w in weights]
        self.off_n = off_grid_keys

    def _mood(self, prev):
        if prev is not None and self.rng.random() < self.stickiness:
            return prev
        r, acc = self.rng.random(), 0.0
        for m, p in self.freqs.items():
            acc += p
            if r <= acc:
                return m
        return MOODS[-1]

    def _key(self, mood):
        if self.rng.random() < self.grid_hit:
            return ("grid", mood, self.rng.randrange(9))      # one of the 9 pre-warmed buckets
        k = self.rng.choices(range(self.off_n), weights=self.off_w)[0]
        return ("off", mood, k)

    def _gen_time(self):
        return self.rng.choice(self.gen_samples)

    def session(self):
        """One session -> list of visit dicts {level, listen_s, dwell_s, long_form}."""
        cache = set()                       # keys generated this session
        cached_grid = True                  # the pre-warm grid is present from the start
        visits, mood, free_at = [], None, 0.0
        t = 0.0
        pending = None                      # in-flight job: dict(key, done_at, visit_idx)
        for i in range(self.n_visits):
            long_form = self.rng.random() < LONG_FORM_SHARE
            med = self.median * (LONG_FORM_DWELL_MULTIPLIER if long_form else 1.0)
            dwell = self.rng.weibullvariate(weibull_scale(med), WEIBULL_SHAPE)
            mood = self._mood(mood)
            key = self._key(mood)
            start, end = t, t + dwell
            v = {"level": "none", "listen_s": 0.0, "dwell_s": dwell, "long_form": long_form,
                 "l1_s": 0.0, "l2_s": 0.0, "l3_s": 0.0}

            # a running job whose key differs from this page's is cancelled
            if pending and pending["key"] != key and pending["done_at"] > start:
                free_at = start
                pending = None

            commit = start + CONFIDENCE_WINDOW_S
            if dwell > CONFIDENCE_WINDOW_S:
                listen = end - commit
                v["listen_s"] = listen
                if key[0] == "grid" and cached_grid or key in cache:
                    v["level"], v["l2_s"] = "L2", listen
                else:
                    # fallback audible at commit; generation starts when the worker is free
                    gstart = max(commit, free_at)
                    if pending and pending["key"] == key:
                        done = pending["done_at"]
                    else:
                        g = self._gen_time()
                        done = gstart + g if g != CENSORED else CENSORED
                        free_at = done if done != CENSORED else end   # a censored job holds the worker until cancelled
                        pending = {"key": key, "done_at": done}
                    if done != CENSORED and done < end:
                        v["level"] = "L3"
                        v["l1_s"], v["l3_s"] = done - commit, end - done
                        cache.add(key)
                        pending = None
                    else:
                        v["level"], v["l1_s"] = "L1", listen
            visits.append(v)
            t = end
        return visits


def aggregate(sessions):
    visits = [v for s in sessions for v in s]
    n = len(visits)
    out = {"n_visits": n}
    for lvl in ("none", "L1", "L2", "L3"):
        out[f"visit_share_{lvl}"] = round(sum(1 for v in visits if v["level"] == lvl) / n, 4)
    total_listen = sum(v["listen_s"] for v in visits) or 1.0
    for lvl, key in (("L1", "l1_s"), ("L2", "l2_s"), ("L3", "l3_s")):
        out[f"listen_share_{lvl}"] = round(sum(v[key] for v in visits) / total_listen, 4)
    out["p_L3_heard_given_committed"] = round(
        sum(1 for v in visits if v["level"] == "L3") / max(1, sum(1 for v in visits if v["level"] != "none")), 4)
    return out


def run_cell(freqs, gen_samples, *, stickiness, grid_hit, median, n_sessions, seed):
    rng = random.Random(seed)
    sim = Sim(freqs, gen_samples, stickiness=stickiness, grid_hit=grid_hit, median_dwell_s=median, rng=rng)
    sessions = [sim.session() for _ in range(n_sessions)]
    out = aggregate(sessions)
    visits = [v for s in sessions for v in s]
    for name, sel in (("long_form", True), ("other", False)):
        sub = [v for v in visits if v["long_form"] is sel]
        if sub:
            out[f"stratum_{name}"] = aggregate([sub])
    return out


# ── CLI ─────────────────────────────────────────────────────────────────────

def _self_test():
    freqs = {m: 1 / len(MOODS) for m in MOODS}
    # instant generation, nothing pre-warmed: every committed visit becomes L3
    r = run_cell(freqs, [0.0], stickiness=0.0, grid_hit=0.0, median=30, n_sessions=300, seed=1)
    committed = 1 - r["visit_share_none"]
    assert abs(r["visit_share_L3"] - committed) < 0.02, r
    # generation that never finishes: no L3 at all
    r = run_cell(freqs, [CENSORED], stickiness=0.0, grid_hit=0.0, median=30, n_sessions=300, seed=1)
    assert r["visit_share_L3"] == 0.0, r
    # fully pre-warmed grid: everything committed is L2
    r = run_cell(freqs, [CENSORED], stickiness=0.0, grid_hit=1.0, median=30, n_sessions=300, seed=1)
    assert r["visit_share_L1"] == 0.0 and r["visit_share_L2"] > 0.3, r
    # shares sum to 1
    r = run_cell(freqs, [20.0], stickiness=0.3, grid_hit=0.5, median=20, n_sessions=300, seed=2)
    assert abs(sum(r[f"visit_share_{k}"] for k in ("none", "L1", "L2", "L3")) - 1) < 1e-3, r
    # slower generation can only reduce L3 exposure
    fast = run_cell(freqs, [5.0], stickiness=0.3, grid_hit=0.0, median=20, n_sessions=500, seed=3)
    slow = run_cell(freqs, [60.0], stickiness=0.3, grid_hit=0.0, median=20, n_sessions=500, seed=3)
    assert slow["visit_share_L3"] <= fast["visit_share_L3"], (fast, slow)
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--d4", action="append", help="tier=path to a d4_latency.py result (duration section); repeatable")
    ap.add_argument("--gen-json", help='plain JSON {"tier": {"10": [seconds, null=censored, ...]}}')
    ap.add_argument("--moods", help="JSON array of mood labels (corpus), for the stationary distribution")
    ap.add_argument("--durations", default="10,15,28")
    ap.add_argument("--medians", default="10,20,30,60,120", help="median dwell seconds to sweep")
    ap.add_argument("--stickiness", type=float, default=0.3)
    ap.add_argument("--grid-hit", type=float, default=0.5, help="share of page profiles whose key is in the 99-entry pre-warm grid")
    ap.add_argument("--sessions", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=20260611)
    ap.add_argument("--primary-median", type=float, default=30.0)
    ap.add_argument("--out", default="analysis/exposure/exposure.json")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return 0

    gen = load_gen_times(args.d4, args.gen_json)
    if not gen:
        print("no generation-time data: pass --d4 tier=path and/or --gen-json", file=sys.stderr)
        return 2
    freqs = mood_frequencies(args.moods)
    durations = [int(d) for d in args.durations.split(",")]
    medians = [float(m) for m in args.medians.split(",")]

    result = {"assumptions": {"confidence_window_s": CONFIDENCE_WINDOW_S, "weibull_shape": WEIBULL_SHAPE,
                              "long_form_dwell_multiplier": LONG_FORM_DWELL_MULTIPLIER,
                              "long_form_share": LONG_FORM_SHARE, "stickiness": args.stickiness,
                              "grid_hit": args.grid_hit, "sessions_per_cell": args.sessions,
                              "seed": args.seed, "primary_median_dwell_s": args.primary_median},
              "gen_time_sources": {t: {str(d): {"n": len(v), "censored": sum(1 for x in v if x == CENSORED),
                                              "median_s": (statistics.median([x for x in v if x != CENSORED])
                                                           if any(x != CENSORED for x in v) else None)}
                                       for d, v in by_d.items()} for t, by_d in gen.items()},
              "cells": []}
    for tier, by_d in gen.items():
        for d in durations:
            samples = by_d.get(d)
            if not samples:
                continue
            for med in medians:
                cell = run_cell(freqs, samples, stickiness=args.stickiness, grid_hit=args.grid_hit,
                                median=med, n_sessions=args.sessions, seed=args.seed)
                result["cells"].append({"tier": tier, "duration_s": d, "median_dwell_s": med, **cell})
            line = next(c for c in result["cells"] if c["tier"] == tier and c["duration_s"] == d
                        and c["median_dwell_s"] == min(medians, key=lambda m: abs(m - args.primary_median)))
            print(f"{tier:>6} {d:>3}s  median dwell {line['median_dwell_s']:>5.0f}s  "
                  f"visits L1/L2/L3/none = {line['visit_share_L1']:.2f}/{line['visit_share_L2']:.2f}/"
                  f"{line['visit_share_L3']:.2f}/{line['visit_share_none']:.2f}   "
                  f"listening L1/L2/L3 = {line['listen_share_L1']:.2f}/{line['listen_share_L2']:.2f}/{line['listen_share_L3']:.2f}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
