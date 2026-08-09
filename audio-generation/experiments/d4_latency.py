#!/usr/bin/env python3
"""
d4_latency.py — §6 systems eval: how long does Feature D actually take, and
where does the time go?

This drives a *running* Feature D over HTTP rather than importing the stages
in-process, for the same reason benchmark/extractionCost.js drives a real
Chrome instead of jsdom: the numbers that matter are the ones a caller
experiences, and they include FastAPI, the asyncio.to_thread hops, D3's batch
worker, the Postgres round trip and the static-file handoff — none of which
exist if you call process_audio() directly in a loop.

    # Terminal 1
    uvicorn main:app --port 8000
    # Terminal 2
    python experiments/d4_latency.py --sections fallback,warm
    python experiments/d4_latency.py                       # everything (slow!)
    python experiments/d4_latency.py --repeats 5 --out results/latency.json

── The four numbers this produces, and what each one is for ────────────────

  fallback     GET /fallback/{mood}. This is *time to first audible sound*,
               because the extension starts the fallback clip immediately and
               crossfades to the generated one later (featureDClient.js's
               requestTrack). If the paper claims the system is responsive,
               this is the number that claim rests on — not `cold`.

  warm         POST /generate that hits the D5 cache. This is the steady-state
               cost once a user has browsed for a while and the pre-warm grid
               has filled in, i.e. the modal case in a real session.

  cold         POST /generate with a nonce, forcing a cache miss and a real
               MusicGen run. The worst case, and the one that decides whether
               the fallback-then-swap design is load-bearing or merely nice.

  duration     cold latency as a function of duration_seconds. MusicGen is
               autoregressive at ~50 tokens/sec of audio, so this should come
               out close to linear; a fit that *isn't* linear means something
               other than generation dominates, and the stage breakdown says
               what.

  concurrency  k simultaneous cold requests. D3 coalesces concurrent calls
               into shared MusicGen batches (MAX_BATCH_SIZE=4), so the
               interesting quantity is not the mean but the ratio
               (k concurrent wall time) / (k sequential wall time) — how much
               of the batching win survives at the API boundary.

Every measurement records both the client's wall clock and the server's own
`timings` dict (d1_validate_ms, d5_cache_check_ms, d2_prompt_ms,
d3_generate_ms, d4_process_ms, d5_save_ms), so "wall clock minus the sum of
the stages" is reported as `unaccounted_ms`. That gap is queueing plus
transport, and watching it grow is how you catch the batch worker starving
real traffic behind the pre-warm grid.

Percentiles, not means: a mean over a bimodal cache-hit/miss distribution is a
number that describes nothing that ever happened.

NOTE ON COST: `cold`, `duration` and `concurrency` each trigger real MusicGen
generations (~15-95 s per clip on CPU). A full default run is on the order of
an hour on CPU. `--sections fallback,warm` finishes in seconds and is what to
run while iterating.
"""

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

# Windows consoles default to cp1252, which cannot encode the box-drawing and
# section characters used in the help text and the summary table -- printing
# either one dies with a UnicodeEncodeError before a single measurement is
# reported. main.py reconfigures stdout for a different reason (block
# buffering); this is the same escape hatch for the encoding half.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# stdlib-only on purpose: this script has to run in whatever environment the
# server happens to be in, including a bare venv where `requests` was never
# installed. urllib adds ~1 ms of overhead, which is noise against a 15 s
# generation and is at least *consistent* noise against a 20 ms fallback.

# All 11 moods B can emit (models.py's validate_mood). Sorted the same way as
# prewarm.py's grid so a warm run and a pre-warm run are comparable.
ALL_MOODS = [
    "calm", "energetic", "focused", "joyful", "sad",
    "dark", "nostalgic", "curious", "tense", "uplifting", "neutral",
]

# One representative profile per mood. bpm values sit inside the three cache
# buckets d5_cache.make_cache_key uses (low <76, mid <101, high >=101) so a
# warm run can actually hit what a pre-warm run wrote.
MOOD_PROFILES = {
    "calm":       {"bpm": 60,  "style": "ambient",    "energy": 0.2, "key": "C major"},
    "energetic":  {"bpm": 120, "style": "electronic", "energy": 0.9, "key": "E major"},
    "focused":    {"bpm": 90,  "style": "ambient",    "energy": 0.4, "key": "D minor"},
    "joyful":     {"bpm": 120, "style": "acoustic",   "energy": 0.8, "key": "G major"},
    "sad":        {"bpm": 60,  "style": "acoustic",   "energy": 0.2, "key": "A minor"},
    "dark":       {"bpm": 60,  "style": "ambient",    "energy": 0.3, "key": "C minor"},
    "nostalgic":  {"bpm": 90,  "style": "acoustic",   "energy": 0.4, "key": "F major"},
    "curious":    {"bpm": 90,  "style": "electronic", "energy": 0.5, "key": "A major"},
    "tense":      {"bpm": 120, "style": "ambient",    "energy": 0.7, "key": "B minor"},
    "uplifting":  {"bpm": 120, "style": "acoustic",   "energy": 0.8, "key": "D major"},
    "neutral":    {"bpm": 90,  "style": "ambient",    "energy": 0.5, "key": "C major"},
}

STAGE_KEYS = [
    "d1_validate_ms",
    "d5_cache_check_ms",
    "d2_prompt_ms",
    "d3_generate_ms",
    "d4_process_ms",
    "d5_save_ms",
]

DEFAULT_DURATIONS = [5, 10, 15, 20, 28]
SECTIONS = ["fallback", "warm", "cold", "duration", "concurrency"]


# ── HTTP ────────────────────────────────────────────────────────────────────

def _request(url, payload=None, timeout=300):
    """
    One request, returning (wall_ms, parsed_body, error).

    Wall clock is measured around the whole call including reading the body:
    the response is small JSON, and stopping the clock at the headers would
    quietly exclude the part of the server's work that streams last.
    """
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method="POST" if data else "GET",
        headers={"Content-Type": "application/json"} if data else {},
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
        wall_ms = (time.perf_counter() - started) * 1000
        return wall_ms, json.loads(body), None
    except urllib.error.HTTPError as e:
        wall_ms = (time.perf_counter() - started) * 1000
        detail = e.read().decode(errors="replace")[:200]
        return wall_ms, None, f"HTTP {e.code}: {detail}"
    except Exception as e:  # timeout, connection refused, malformed JSON
        wall_ms = (time.perf_counter() - started) * 1000
        return wall_ms, None, f"{type(e).__name__}: {e}"


def build_payload(mood, duration_seconds=28, nonce=None):
    """
    A flat Handoff-2 profile, the same shape featureDClient.js POSTs.

    Sent flat (not wrapped in `profile`) deliberately: that is the documented
    Swagger path, it exercises d1_validate's field-by-field defaulting, and it
    keeps this script independent of Feature B's payload version.
    """
    base = MOOD_PROFILES.get(mood, MOOD_PROFILES["neutral"])
    payload = {"mood": mood, "duration_seconds": duration_seconds, **base}
    if nonce:
        payload["nonce"] = nonce
    return payload


# ── Stats ───────────────────────────────────────────────────────────────────

def percentile(values, p):
    """
    Nearest-rank percentile. No interpolation: with the sample sizes here
    (often 3-10 per cell) an interpolated p95 invents a value between two
    measurements and reads as more precise than the data supports.
    """
    if not values:
        return None
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(round((p / 100.0) * len(ordered) + 0.5)) - 1))
    return ordered[idx]


def summarise(values):
    clean = [v for v in values if v is not None]
    if not clean:
        return {"n": 0}
    return {
        "n": len(clean),
        "min": round(min(clean), 1),
        "p50": round(percentile(clean, 50), 1),
        "p95": round(percentile(clean, 95), 1),
        "max": round(max(clean), 1),
        "mean": round(statistics.fmean(clean), 1),
        # Reported alongside the mean specifically so a bimodal cell is
        # visible as a huge stdev rather than hiding inside a plausible mean.
        "stdev": round(statistics.stdev(clean), 1) if len(clean) > 1 else 0.0,
    }


def summarise_stages(samples):
    """
    Per-stage summary plus the wall-clock time no stage claimed.

    `unaccounted_ms` should always be positive and small: the server's stages
    are measured inside the request, so their sum is by construction a subset
    of the client's wall clock. A large positive value is queueing (D3's batch
    worker holding the request, or the pre-warm grid hogging the pool); a
    *negative* value means the stages overlap or double-count, which is a bug
    in the instrumentation rather than a measurement.
    """
    out = {}
    for key in STAGE_KEYS:
        vals = [s["timings"].get(key) for s in samples if s.get("timings")]
        vals = [v for v in vals if isinstance(v, (int, float))]
        if vals:
            out[key] = summarise(vals)
    unaccounted = []
    for s in samples:
        if not s.get("timings") or s.get("wall_ms") is None:
            continue
        staged = sum(v for k, v in s["timings"].items() if k in STAGE_KEYS and isinstance(v, (int, float)))
        unaccounted.append(s["wall_ms"] - staged)
    if unaccounted:
        out["unaccounted_ms"] = summarise(unaccounted)
    return out


def record(wall_ms, body, error, **extra):
    """Normalise one measurement into the row shape every section emits."""
    row = {"wall_ms": round(wall_ms, 1), "error": error, **extra}
    if body:
        row["cache"] = body.get("cache")
        row["is_fallback"] = bool((body.get("metadata") or {}).get("is_fallback"))
        row["timings"] = body.get("timings") or {}
        row["audio_url"] = body.get("audio_url")
    return row


# ── Sections ────────────────────────────────────────────────────────────────

def section_fallback(base_url, moods, repeats, timeout):
    """GET /fallback/{mood} — the time-to-first-audible-sound floor."""
    print(f"\n[fallback] {len(moods)} mood(s) x {repeats} repeat(s) — GET /fallback/{{mood}}")
    rows = []
    for mood in moods:
        for i in range(repeats):
            wall, body, err = _request(f"{base_url}/fallback/{mood}", timeout=timeout)
            rows.append(record(wall, body, err, mood=mood, iteration=i))
            flag = "!" if err else " "
            print(f"  {flag} {mood:<10} {wall:8.1f} ms{'  ' + err if err else ''}")
    return rows


def section_warm(base_url, moods, repeats, duration, timeout):
    """
    POST /generate expecting a D5 cache hit.

    One priming request per mood is issued first and NOT measured: on a cold
    server the first request for a mood may still be generating, and folding
    that into a "warm" number is how a cache-hit latency claim ends up an
    order of magnitude wrong.
    """
    print(f"\n[warm] priming {len(moods)} mood(s), then {repeats} measured repeat(s) each")
    rows = []
    for mood in moods:
        payload = build_payload(mood, duration)
        prime_wall, prime_body, prime_err = _request(f"{base_url}/generate", payload, timeout=timeout)
        primed_cache = (prime_body or {}).get("cache")
        print(f"  ~ {mood:<10} prime {prime_wall/1000:6.1f} s (cache={primed_cache}){'  ' + prime_err if prime_err else ''}")
        for i in range(repeats):
            wall, body, err = _request(f"{base_url}/generate", payload, timeout=timeout)
            row = record(wall, body, err, mood=mood, iteration=i)
            rows.append(row)
            if row.get("cache") != "hit":
                # Loud, because every warm statistic below is invalid if this
                # is happening: it means save_to_cache is failing and the
                # "steady state" being measured is really the cold path.
                print(f"  ! {mood:<10} {wall:8.1f} ms  cache={row.get('cache')} "
                      f"is_fallback={row.get('is_fallback')} — NOT a cache hit")
            else:
                print(f"    {mood:<10} {wall:8.1f} ms  cache=hit")
    return rows


def section_cold(base_url, moods, repeats, duration, timeout):
    """POST /generate with a fresh nonce each time — forced cache miss."""
    print(f"\n[cold] {len(moods)} mood(s) x {repeats} repeat(s) — real generation, expect minutes")
    rows = []
    for mood in moods:
        for i in range(repeats):
            payload = build_payload(mood, duration, nonce=str(uuid.uuid4()))
            wall, body, err = _request(f"{base_url}/generate", payload, timeout=timeout)
            row = record(wall, body, err, mood=mood, iteration=i)
            rows.append(row)
            gen = (row.get("timings") or {}).get("d3_generate_ms")
            print(f"  {'!' if err else ' '} {mood:<10} {wall/1000:7.1f} s"
                  f"{f'  (d3 {gen/1000:.1f} s)' if gen else ''}"
                  f"{'  is_fallback' if row.get('is_fallback') else ''}"
                  f"{'  ' + err if err else ''}")
    return rows


def section_duration(base_url, mood, durations, repeats, timeout):
    """Cold latency vs requested clip length — expect ~linear in duration."""
    print(f"\n[duration] mood={mood}, durations={durations}, {repeats} repeat(s) each")
    rows = []
    for d in durations:
        for i in range(repeats):
            payload = build_payload(mood, d, nonce=str(uuid.uuid4()))
            wall, body, err = _request(f"{base_url}/generate", payload, timeout=timeout)
            row = record(wall, body, err, mood=mood, duration_seconds=d, iteration=i)
            rows.append(row)
            gen = (row.get("timings") or {}).get("d3_generate_ms")
            rtf = (gen / 1000.0) / d if gen else None
            print(f"  {'!' if err else ' '} {d:>3}s -> {wall/1000:7.1f} s wall"
                  f"{f'  d3 {gen/1000:6.1f} s  ({rtf:.2f}x realtime)' if rtf else ''}")
    return rows


def section_concurrency(base_url, mood, levels, duration, timeout):
    """
    k simultaneous cold requests vs the same k run back to back.

    The sequential baseline is measured in the same run, not taken from the
    `cold` section, so both halves see the same machine state — a comparison
    against numbers collected an hour earlier on a hotter box says nothing.
    """
    print(f"\n[concurrency] mood={mood}, levels={levels}")
    rows = []
    for k in levels:
        payloads = [build_payload(mood, duration, nonce=str(uuid.uuid4())) for _ in range(k)]

        started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=k) as pool:
            results = list(pool.map(
                lambda p: _request(f"{base_url}/generate", p, timeout=timeout), payloads
            ))
        concurrent_wall_ms = (time.perf_counter() - started) * 1000

        for i, (wall, body, err) in enumerate(results):
            rows.append(record(wall, body, err, mood=mood, level=k, mode="concurrent", iteration=i))

        seq_payloads = [build_payload(mood, duration, nonce=str(uuid.uuid4())) for _ in range(k)]
        started = time.perf_counter()
        for i, p in enumerate(seq_payloads):
            wall, body, err = _request(f"{base_url}/generate", p, timeout=timeout)
            rows.append(record(wall, body, err, mood=mood, level=k, mode="sequential", iteration=i))
        sequential_wall_ms = (time.perf_counter() - started) * 1000

        speedup = sequential_wall_ms / concurrent_wall_ms if concurrent_wall_ms else 0
        print(f"    k={k:<2} concurrent {concurrent_wall_ms/1000:7.1f} s   "
              f"sequential {sequential_wall_ms/1000:7.1f} s   speedup {speedup:.2f}x")
        rows.append({
            "aggregate": True, "level": k,
            "concurrent_wall_ms": round(concurrent_wall_ms, 1),
            "sequential_wall_ms": round(sequential_wall_ms, 1),
            "speedup": round(speedup, 3),
        })
    return rows


# ── Reporting ───────────────────────────────────────────────────────────────

def report(results):
    lines = ["", "=" * 74, "FEATURE D LATENCY — SUMMARY", "=" * 74]

    for name in SECTIONS:
        rows = results["sections"].get(name)
        if not rows:
            continue
        measured = [r for r in rows if not r.get("aggregate")]
        ok = [r for r in measured if not r.get("error")]
        failed = len(measured) - len(ok)

        lines.append("")
        lines.append(f"── {name} ── {len(ok)} ok, {failed} failed")
        wall = summarise([r["wall_ms"] for r in ok])
        if wall.get("n"):
            lines.append(f"   wall  p50 {wall['p50']:>9.1f} ms   p95 {wall['p95']:>9.1f} ms   "
                         f"max {wall['max']:>9.1f} ms   (n={wall['n']})")

        stages = summarise_stages(ok)
        for key, s in stages.items():
            lines.append(f"     {key:<20} p50 {s['p50']:>9.1f} ms   p95 {s['p95']:>9.1f} ms")

        if name == "duration":
            lines.append("   by duration:")
            for d in sorted({r.get("duration_seconds") for r in ok if r.get("duration_seconds")}):
                cell = [r for r in ok if r.get("duration_seconds") == d]
                gens = [(r.get("timings") or {}).get("d3_generate_ms") for r in cell]
                gens = [g for g in gens if g]
                w = summarise([r["wall_ms"] for r in cell])
                rtf = (statistics.fmean(gens) / 1000.0) / d if gens else 0
                lines.append(f"     {d:>3}s   wall p50 {w['p50']:>9.1f} ms   "
                             f"d3 mean {statistics.fmean(gens)/1000 if gens else 0:6.1f} s   {rtf:5.2f}x realtime")

        if name == "concurrency":
            lines.append("   batching:")
            for agg in [r for r in rows if r.get("aggregate")]:
                lines.append(f"     k={agg['level']:<2} speedup {agg['speedup']:.2f}x  "
                             f"(concurrent {agg['concurrent_wall_ms']/1000:.1f} s vs "
                             f"sequential {agg['sequential_wall_ms']/1000:.1f} s)")

        if name in ("warm", "cold"):
            by_mood = {}
            for r in ok:
                by_mood.setdefault(r["mood"], []).append(r["wall_ms"])
            lines.append("   by mood (p50):")
            for mood in sorted(by_mood, key=lambda m: percentile(by_mood[m], 50), reverse=True):
                lines.append(f"     {mood:<12} {percentile(by_mood[mood], 50):>9.1f} ms")

        if name == "warm":
            misses = [r for r in ok if r.get("cache") != "hit"]
            if misses:
                lines.append(f"   ⚠  {len(misses)}/{len(ok)} 'warm' requests did NOT hit the cache — "
                             f"these numbers are not steady-state. Check save_to_cache in the server log.")

    # The headline claim of the paper's latency subsection, assembled from
    # whichever sections were actually run.
    fb = summarise([r["wall_ms"] for r in results["sections"].get("fallback", []) if not r.get("error")])
    warm = summarise([r["wall_ms"] for r in results["sections"].get("warm", []) if not r.get("error")])
    cold = summarise([r["wall_ms"] for r in results["sections"].get("cold", []) if not r.get("error")])
    if fb.get("n") or warm.get("n") or cold.get("n"):
        lines += ["", "── perceived time-to-audio ──"]
        if fb.get("n"):
            lines.append(f"   first sound (fallback)      p50 {fb['p50']:>9.1f} ms   p95 {fb['p95']:>9.1f} ms")
        if warm.get("n"):
            lines.append(f"   generated clip, cache hit   p50 {warm['p50']:>9.1f} ms   p95 {warm['p95']:>9.1f} ms")
        if cold.get("n"):
            lines.append(f"   generated clip, cache miss  p50 {cold['p50']/1000:>9.1f} s    p95 {cold['p95']/1000:>9.1f} s")

    lines.append("=" * 74)
    return "\n".join(lines)


# ── Entry point ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default=os.getenv("FEATURE_D_URL", "http://127.0.0.1:8000"))
    ap.add_argument("--sections", default="fallback,warm",
                    help=f"comma-separated subset of {SECTIONS}, or 'all'. "
                         f"Default is the two fast ones; 'all' runs real generations.")
    ap.add_argument("--moods", default=",".join(ALL_MOODS))
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--duration", type=int, default=28, help="duration_seconds for every section except --sections duration")
    ap.add_argument("--durations", default=",".join(str(d) for d in DEFAULT_DURATIONS))
    ap.add_argument("--concurrency-levels", default="1,2,4,8")
    ap.add_argument("--timeout", type=int, default=300, help="per-request timeout, seconds")
    ap.add_argument("--out", default=None, help="write the full result JSON here")
    args = ap.parse_args()

    base_url = args.base_url.rstrip("/")
    sections = SECTIONS if args.sections == "all" else [s.strip() for s in args.sections.split(",") if s.strip()]
    unknown = [s for s in sections if s not in SECTIONS]
    if unknown:
        ap.error(f"unknown section(s) {unknown}; valid: {SECTIONS}")

    moods = [m.strip() for m in args.moods.split(",") if m.strip()]
    durations = [int(d) for d in args.durations.split(",") if d.strip()]
    levels = [int(k) for k in args.concurrency_levels.split(",") if k.strip()]

    # Fail fast and legibly rather than producing a table of connection errors.
    _, health, err = _request(f"{base_url}/fallback/{moods[0]}", timeout=15)
    if err and "HTTP 503" not in err:
        print(f"Cannot reach Feature D at {base_url} ({err}).\n"
              f"Start it with:  uvicorn main:app --port 8000", file=sys.stderr)
        return 1
    if err:
        print(f"WARNING: /fallback returned 503 — fallback_clips/ is empty, so the "
              f"'fallback' section will measure only the error path. "
              f"Run generate_fallbacks.py first.", file=sys.stderr)

    results = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "base_url": base_url,
        "config": {
            "sections": sections, "moods": moods, "repeats": args.repeats,
            "duration": args.duration, "durations": durations,
            "concurrency_levels": levels,
        },
        "sections": {},
    }

    started = time.perf_counter()
    if "fallback" in sections:
        results["sections"]["fallback"] = section_fallback(base_url, moods, args.repeats, args.timeout)
    if "warm" in sections:
        results["sections"]["warm"] = section_warm(base_url, moods, args.repeats, args.duration, args.timeout)
    if "cold" in sections:
        results["sections"]["cold"] = section_cold(base_url, moods, args.repeats, args.duration, args.timeout)
    if "duration" in sections:
        results["sections"]["duration"] = section_duration(base_url, moods[0], durations, args.repeats, args.timeout)
    if "concurrency" in sections:
        results["sections"]["concurrency"] = section_concurrency(base_url, moods[0], levels, args.duration, args.timeout)
    results["elapsed_s"] = round(time.perf_counter() - started, 1)

    summary = report(results)
    print(summary)

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(f"\nWrote {args.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
