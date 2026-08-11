#!/usr/bin/env python3
"""
d2_loop_test.py — §5.3 / C6: does the loop seam actually disappear?

`d4_process._seam_discontinuity` is computed once per clip, at generation
time, on the PRE-crossfade tail/head jump (main.py returns it in
`metadata.seam_discontinuity`, and `d5_cache_local` persists it to the
`audio_cache` table). It has never been aggregated across a dataset, and it
has never been compared against what the crossfade actually leaves behind —
the plan's own Appendix A says so explicitly. This script closes both gaps:

  1. Discovers every clip we already have on disk: the 11 hand-checked
     fallback clips (`fallback_clips/*.ogg`, one per mood, each with a
     sidecar `.json` carrying its pre-crossfade seam metric) and every
     clip the D5 cache has accumulated from real `/generate` traffic
     (`audio-cache/*.ogg`), joined against the local Postgres `audio_cache`
     table for mood + pre-crossfade seam + duration metadata.

  2. For every clip, decodes the actual exported Ogg/Opus file and measures
     ITS OWN seam — tail vs. head of the file a listener actually receives,
     after crossfading, after export — using the same `_seam_discontinuity`
     function reapplied to the finished artifact. This is the "post" number
     the plan asks for; only "pre" existed before this script.

  3. Also measures integrated loudness (LUFS, should sit near -18 LUFS
     post-normalisation per `process_audio`) and clip-length compliance
     against each row's own target `duration_seconds`.

Usage:
    # from audio-generation/, with the local Postgres cache reachable
    # (docker compose -f ../docker/docker-compose.yml up -d db)
    python experiments/d2_loop_test.py
    python experiments/d2_loop_test.py --out results/d2-loop.json
    python experiments/d2_loop_test.py --no-db   # fallback_clips/ only, no Postgres needed

This is read-only: it never calls `/generate` and never writes to the cache
or the fallback directory. Slow part is decoding ~100+ Ogg/Opus files
through ffmpeg and running librosa's spectral centroid on each; a few
seconds per clip, a couple of minutes for the whole corpus.
"""

import argparse
import io
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pyloudnorm as pyln
from pydub import AudioSegment

# Importing d4_process also points AudioSegment.converter at imageio_ffmpeg's
# bundled ffmpeg binary (or $FFMPEG_BINARY), the same setup process_audio()
# itself relies on -- decoding these files without that would fail on any
# machine that doesn't happen to have ffmpeg on PATH.
from d4_process import _seam_discontinuity, CROSSFADE_MS, MIN_LOOP_SECONDS

FALLBACK_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "fallback_clips")
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "audio-cache")
FALLBACK_TARGET_DURATION_S = 15  # generate_fallbacks.py hardcodes this

# Percussive/dense moods are expected to seam worse than sparse/ambient ones
# (plan §3, S3) -- kept here so the per-mood table can flag the split rather
# than reporting an unlabelled ranking.
DENSE_MOODS = {"energetic", "tense"}
SPARSE_MOODS = {"calm", "sad", "nostalgic"}


# ── Discovery ───────────────────────────────────────────────────────────────

def _load_fallback_rows():
    """The 11 fallback clips: mood, pre-crossfade seam + target duration are
    known exactly (generate_fallbacks.py always requests 15s)."""
    rows = []
    if not os.path.isdir(FALLBACK_DIR):
        return rows
    for name in sorted(os.listdir(FALLBACK_DIR)):
        if not name.endswith(".ogg"):
            continue
        mood = name[:-4]
        path = os.path.join(FALLBACK_DIR, name)
        sidecar_path = os.path.join(FALLBACK_DIR, f"{mood}.json")
        pre = None
        if os.path.exists(sidecar_path):
            with open(sidecar_path, encoding="utf-8") as f:
                sidecar = json.load(f)
            pre = sidecar.get("seam_discontinuity")
        rows.append({
            "source": "fallback_clips",
            "id": mood,
            "mood": mood,
            "path": path,
            "target_duration_s": FALLBACK_TARGET_DURATION_S,
            "pre_seam": pre,
        })
    return rows


def _load_cache_rows(limit=None):
    """
    Real generated clips from the D5 local cache, joined against Postgres
    for mood / pre-crossfade seam / target duration. Skips silently (with a
    count reported to stderr) if the DB isn't reachable -- `--no-db` exists
    for exactly that case, so this degrading gracefully rather than raising
    lets the same invocation work whether or not `docker compose up -d db`
    has been run.
    """
    if not os.path.isdir(CACHE_DIR):
        return []
    on_disk = {f[:-4] for f in os.listdir(CACHE_DIR) if f.endswith(".ogg")}
    if not on_disk:
        return []

    try:
        import psycopg2
        import psycopg2.extras
        LOCAL_DB_URL = os.getenv("LOCAL_DB_URL", "postgresql://postgres:postgres@localhost:5432/audio_cache")
        conn = psycopg2.connect(LOCAL_DB_URL, connect_timeout=5)
    except Exception as e:
        print(f"[d2_loop_test] cannot reach Postgres ({e}) -- skipping {len(on_disk)} "
              f"audio-cache clip(s); pass --no-db to silence this.", file=sys.stderr)
        return []

    rows = []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT cache_key, mood, duration_seconds, seam_discontinuity "
                "FROM audio_cache WHERE cache_key = ANY(%s)",
                (list(on_disk),),
            )
            for r in cur.fetchall():
                path = os.path.join(CACHE_DIR, f"{r['cache_key']}.ogg")
                rows.append({
                    "source": "audio_cache",
                    "id": r["cache_key"][:12],
                    "mood": r["mood"],
                    "path": path,
                    "target_duration_s": r["duration_seconds"],
                    "pre_seam": r["seam_discontinuity"],
                })
    finally:
        conn.close()

    missing = len(on_disk) - len(rows)
    if missing > 0:
        print(f"[d2_loop_test] {missing} file(s) in audio-cache/ have no matching DB row "
              f"(stale cache?) -- skipped.", file=sys.stderr)

    if limit:
        rows = rows[:limit]
    return rows


# ── Per-clip measurement ─────────────────────────────────────────────────────

def _segment_to_float_mono(segment: AudioSegment) -> np.ndarray:
    samples = np.array(segment.get_array_of_samples()).astype(np.float64)
    if segment.channels > 1:
        samples = samples.reshape(-1, segment.channels).mean(axis=1)
    return samples / float(np.iinfo(segment.array_type).max)


def analyze_clip(row):
    """
    One clip in, one result row out. Never raises -- a single corrupt/short
    file shouldn't kill a run over 100+ clips; it's recorded with an `error`
    field and excluded from the aggregates instead.
    """
    out = {**{k: row[k] for k in ("source", "id", "mood", "target_duration_s")}}
    try:
        with open(row["path"], "rb") as f:
            audio_bytes = f.read()
        segment = AudioSegment.from_file(io.BytesIO(audio_bytes), format="ogg")

        # The "post" seam: tail vs. head of the file exactly as a listener
        # receives it, after crossfade and export -- what C6 is actually
        # about. Reuses the same window/metric as the pre-crossfade number
        # so the two are directly comparable.
        post = _seam_discontinuity(segment, crossfade_ms=CROSSFADE_MS)
        out["post_energy_delta_db"] = post["energy_delta_db"]
        out["post_spectral_centroid_delta_hz"] = post["spectral_centroid_delta_hz"]

        pre = row.get("pre_seam") or {}
        out["pre_energy_delta_db"] = pre.get("energy_delta_db")
        out["pre_spectral_centroid_delta_hz"] = pre.get("spectral_centroid_delta_hz")

        mono = _segment_to_float_mono(segment)
        meter = pyln.Meter(segment.frame_rate)
        out["lufs"] = round(float(meter.integrated_loudness(mono)), 2)

        out["duration_ms"] = len(segment)
        target_ms = (row.get("target_duration_s") or FALLBACK_TARGET_DURATION_S) * 1000
        # Compliant if the exported clip (necessarily <= target, since loop
        # detection only ever cuts the clip shorter, never extends it, and
        # the crossfade trims CROSSFADE_MS more) is at least the shortest
        # loop the pipeline can legally emit.
        #
        # The floor has to be MIN_LOOP_SECONDS *minus the crossfade*, not a
        # bare 3000. _detect_loop_point_ms clamps its answer to >= 3.0s and
        # _crossfade_loop then shrinks the clip by CROSSFADE_MS, so a clip
        # that lands exactly on the legal floor exports at ~2950ms. Checking
        # it against 3000 marked that clip non-compliant for doing precisely
        # what it was designed to do -- the upper bound on this same line
        # already added CROSSFADE_MS, the lower bound just never subtracted
        # it. This is what the one "failing" clip in the first run was.
        min_legal_ms = MIN_LOOP_SECONDS * 1000 - CROSSFADE_MS
        out["duration_compliant"] = min_legal_ms <= out["duration_ms"] <= target_ms + CROSSFADE_MS
        out["target_duration_ms"] = target_ms
        # The compliance flag above only catches clips outside the legal
        # range at all. It says nothing about *how much* of the requested
        # duration survived, and on a 28s request a legal 3s loop still
        # throws away 89% of the generation. Carry the ratio so the summary
        # can report the distribution instead of a near-vacuous pass rate.
        out["duration_ratio"] = round(out["duration_ms"] / target_ms, 3) if target_ms else None
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return out


# ── Stats (same conventions as d4_latency.py, kept local & stdlib+numpy only) ─

def percentile(values, p):
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
        "min": round(min(clean), 2),
        "p50": round(percentile(clean, 50), 2),
        "p95": round(percentile(clean, 95), 2),
        "max": round(max(clean), 2),
        "mean": round(statistics.fmean(clean), 2),
        "stdev": round(statistics.stdev(clean), 2) if len(clean) > 1 else 0.0,
    }


def report(rows):
    ok = [r for r in rows if "error" not in r]
    failed = [r for r in rows if "error" in r]

    lines = ["", "=" * 74, "LOOP SEAM / F6 — SUMMARY", "=" * 74,
             f"  {len(ok)} clip(s) analysed, {len(failed)} failed to decode"]
    for r in failed[:10]:
        lines.append(f"    ! {r['source']}/{r['id']}: {r['error']}")

    lines.append("")
    lines.append("── seam discontinuity: pre-crossfade (what a naive cut would sound like) ──")
    pre_e = summarise([r.get("pre_energy_delta_db") for r in ok if r.get("pre_energy_delta_db") is not None])
    pre_c = summarise([r.get("pre_spectral_centroid_delta_hz") for r in ok if r.get("pre_spectral_centroid_delta_hz") is not None])
    if pre_e.get("n"):
        lines.append(f"  energy_delta_db     p50 {pre_e['p50']:>7.2f} dB   p95 {pre_e['p95']:>7.2f} dB   (n={pre_e['n']})")
    if pre_c.get("n"):
        lines.append(f"  centroid_delta_hz   p50 {pre_c['p50']:>7.1f} Hz   p95 {pre_c['p95']:>7.1f} Hz   (n={pre_c['n']})")
    if not pre_e.get("n") and not pre_c.get("n"):
        lines.append("  (no pre-crossfade data joined -- run with Postgres reachable, or check fallback_clips/*.json)")

    lines.append("")
    lines.append("── seam discontinuity: post-crossfade (what the loop actually sounds like) ──")
    post_e = summarise([r["post_energy_delta_db"] for r in ok if r.get("post_energy_delta_db") is not None])
    post_c = summarise([r["post_spectral_centroid_delta_hz"] for r in ok if r.get("post_spectral_centroid_delta_hz") is not None])
    if post_e.get("n"):
        lines.append(f"  energy_delta_db     p50 {post_e['p50']:>7.2f} dB   p95 {post_e['p95']:>7.2f} dB   (n={post_e['n']})")
    if post_c.get("n"):
        lines.append(f"  centroid_delta_hz   p50 {post_c['p50']:>7.1f} Hz   p95 {post_c['p95']:>7.1f} Hz   (n={post_c['n']})")

    if pre_e.get("n") and post_e.get("n"):
        lines.append(f"  crossfade improvement (median): {pre_e['p50'] - post_e['p50']:+.2f} dB energy jump removed")

    lines.append("")
    lines.append("── by mood (post-crossfade energy_delta_db, dense vs sparse) ──")
    by_mood = {}
    for r in ok:
        if r.get("post_energy_delta_db") is not None:
            by_mood.setdefault(r["mood"], []).append(r["post_energy_delta_db"])
    for mood in sorted(by_mood, key=lambda m: statistics.fmean([abs(v) for v in by_mood[m]]), reverse=True):
        vals = by_mood[mood]
        tag = " (dense)" if mood in DENSE_MOODS else " (sparse)" if mood in SPARSE_MOODS else ""
        lines.append(f"  {mood:<12} mean |Δ| {statistics.fmean([abs(v) for v in vals]):>6.2f} dB   (n={len(vals)}){tag}")

    lines.append("")
    lines.append("── loudness (target: -18 LUFS, per process_audio's normalisation target) ──")
    lufs = summarise([r["lufs"] for r in ok if r.get("lufs") is not None])
    if lufs.get("n"):
        lines.append(f"  LUFS   p50 {lufs['p50']:>7.2f}   min {lufs['min']:>7.2f}   max {lufs['max']:>7.2f}   (n={lufs['n']})")

    lines.append("")
    lines.append("── clip-length compliance ──")
    compliant = [r for r in ok if r.get("duration_compliant") is True]
    noncompliant = [r for r in ok if r.get("duration_compliant") is False]
    total = len(compliant) + len(noncompliant)
    if total:
        floor_ms = MIN_LOOP_SECONDS * 1000 - CROSSFADE_MS
        lines.append(f"  {len(compliant)}/{total} clips ({100 * len(compliant) / total:.1f}%) within [{floor_ms:.0f}ms, target+{CROSSFADE_MS}ms]")
        for r in noncompliant[:10]:
            lines.append(f"    ! {r['source']}/{r['id']} ({r['mood']}): {r['duration_ms']}ms vs target {r['target_duration_ms']}ms")

        # The pass rate above is close to vacuous on its own: the legal range
        # spans 3s..28s, so a clip that keeps 11% of the requested duration
        # "passes" identically to one that keeps 96%. How much of the request
        # actually survives loop detection is the number worth reading, and
        # it is the one that says whether looping is delivering the clip
        # length the profile asked for. Reported as a distribution, not a
        # mean -- the spread is the finding.
        ratios = sorted(r["duration_ratio"] for r in ok if r.get("duration_ratio") is not None)
        if ratios:
            def _pct(p):
                return ratios[min(len(ratios) - 1, int(p * len(ratios)))]
            lines.append(
                f"  duration retained vs. target: p50 {_pct(0.5):.3f}  p10 {_pct(0.1):.3f}  "
                f"p90 {_pct(0.9):.3f}  min {ratios[0]:.3f}  max {ratios[-1]:.3f}  (n={len(ratios)})"
            )
            for thr in (0.20, 0.50):
                n_under = sum(1 for x in ratios if x < thr)
                lines.append(f"    {n_under}/{len(ratios)} clips ({100 * n_under / len(ratios):.1f}%) retain under {thr:.0%} of the requested duration")

    lines.append("")
    lines.append("── dataset composition ──")
    by_source = {}
    for r in ok:
        by_source[r["source"]] = by_source.get(r["source"], 0) + 1
    for source, n in by_source.items():
        lines.append(f"  {source:<16} {n}")
    lines.append(f"  {'total':<16} {len(ok)}"
                  + ("  (target for the paper's F6 is >=200 -- see plan §3 S3)" if len(ok) < 200 else ""))

    lines.append("=" * 74)
    return "\n".join(lines)


# ── Entry point ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-db", action="store_true", help="skip audio-cache/ (fallback_clips/ only, no Postgres needed)")
    ap.add_argument("--limit-cache", type=int, default=None, help="cap how many audio-cache/ clips to analyse")
    ap.add_argument("--out", default=None, help="write the full result JSON here")
    args = ap.parse_args()

    rows = _load_fallback_rows()
    print(f"[d2_loop_test] {len(rows)} fallback clip(s) found in {FALLBACK_DIR}")
    if not args.no_db:
        cache_rows = _load_cache_rows(limit=args.limit_cache)
        print(f"[d2_loop_test] {len(cache_rows)} audio-cache clip(s) joined against Postgres")
        rows += cache_rows

    if not rows:
        print("No clips found. Run generate_fallbacks.py, or warm the audio-cache "
              "(prewarm.py / a few /generate calls), first.", file=sys.stderr)
        return 1

    results = []
    for i, row in enumerate(rows):
        result = analyze_clip(row)
        results.append(result)
        flag = "!" if "error" in result else " "
        print(f"  {flag} [{i + 1}/{len(rows)}] {row['source']:<14} {row['mood']:<12} {row['id']}")

    summary = report(results)
    print(summary)

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"clips": results}, f, indent=2)
        print(f"\nWrote {args.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
