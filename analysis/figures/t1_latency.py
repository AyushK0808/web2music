"""T1 — Feature D latency by request class and by server stage.

Reads the real ``d4_latency.py`` output. Everything reported here is derived
from the ``cache``/``is_fallback``/``error`` fields of the individual rows
rather than from the section name, because in ``d1-latency-full.json`` the two
disagree: the section labelled ``cold`` contains 33 cache *hits*. Classifying
rows by what they actually were is the difference between a table that reports
a cold-cache column and a table that reports the truth.
"""

from __future__ import annotations

import collections

from analysis.registry import Artefact
from analysis.figures import _common as C

ARTEFACT = Artefact(
    id="T1",
    kind="table",
    title="Feature D latency by request class and server stage",
    section="5.1",
    priority=3,
    metrics=["d_stage_ms", "unaccounted_ms", "cache_hit_rate", "fallback_rate", "request_error_rate"],
    inputs=["audio-generation/results/d1-latency-full.json"],
    notes="CPU cell only. The GPU cell needs C-17 and rented hardware.",
)

STAGES = ["d1_validate_ms", "d5_cache_check_ms", "d2_prompt_ms", "d3_generate_ms",
          "d4_process_ms", "d5_save_ms"]


def classify(row: dict) -> str:
    """What this request actually was, regardless of which section it sat in."""
    if row.get("error"):
        return "timeout"
    if row.get("is_fallback") and row.get("cache") is None:
        return "fallback endpoint"
    if row.get("is_fallback"):
        return "generation → fallback"
    if row.get("cache") == "hit":
        return "cache hit"
    if row.get("cache") == "miss":
        return "cache miss (generated)"
    return "other"


def build(ctx):
    data = ctx.load_json(ARTEFACT.inputs[0])
    ctx.metric("d_stage_ms")  # provenance check

    rows = []
    for section, entries in data["sections"].items():
        for r in entries:
            if r.get("aggregate"):
                continue
            rows.append((section, r))

    # ── Panel A: by request class ────────────────────────────────────────────
    by_class = collections.defaultdict(list)
    for _section, r in rows:
        by_class[classify(r)].append(r)

    order = ["fallback endpoint", "cache hit", "cache miss (generated)",
             "generation → fallback", "timeout", "other"]
    panel_a, stats = [], {}
    for cls in order:
        rs = by_class.get(cls)
        if not rs:
            continue
        walls = [r["wall_ms"] for r in rs if "wall_ms" in r]
        s = C.summary(walls)
        stats[cls] = s
        lo, hi = C.bootstrap_ci(walls) if len(walls) > 2 else (float("nan"), float("nan"))
        panel_a.append([
            cls, s.get("n", 0),
            C.fmt(s.get("p50"), 0), f"[{C.fmt(lo, 0)}, {C.fmt(hi, 0)}]",
            C.fmt(s.get("p95"), 0), C.fmt(s.get("max"), 0),
        ])

    # ── Panel B: server stages, over the requests that reported each ─────────
    stage_rows, stage_stats = [], {}
    for stage in STAGES:
        vals = [r["timings"][stage] for _s, r in rows
                if isinstance(r.get("timings"), dict) and stage in r["timings"]]
        if not vals:
            continue
        s = C.summary(vals)
        stage_stats[stage] = s
        stage_rows.append([
            stage.replace("_ms", ""), s["n"], C.fmt(s["p50"], 0), C.fmt(s["p95"], 0),
            C.fmt(s["max"], 0),
        ])

    # unaccounted = wall clock the server did not explain
    unacc = []
    for _s, r in rows:
        if "wall_ms" not in r or not isinstance(r.get("timings"), dict) or not r["timings"]:
            continue
        unacc.append(r["wall_ms"] - sum(r["timings"].values()))
    u = C.summary(unacc)
    if u.get("n"):
        stage_rows.append(None)
        stage_rows.append(["unaccounted (queue + transport)", u["n"],
                           C.fmt(u["p50"], 0), C.fmt(u["p95"], 0), C.fmt(u["max"], 0)])

    # ── Rates ────────────────────────────────────────────────────────────────
    answered = [r for _s, r in rows if "wall_ms" in r]
    cache_rows = [r for r in answered if r.get("cache") in ("hit", "miss")]
    rates = {
        "cache_hit_rate": (sum(1 for r in cache_rows if r["cache"] == "hit") / len(cache_rows)) if cache_rows else None,
        "fallback_rate": sum(1 for r in answered if r.get("is_fallback")) / len(answered),
        "request_error_rate": sum(1 for _s, r in rows if r.get("error")) / len(rows),
        "n_requests": len(rows),
    }

    # ── Honesty note, derived not asserted ───────────────────────────────────
    cold = [r for r in data["sections"].get("cold", []) if not r.get("aggregate")]
    cold_misses = sum(1 for r in cold if r.get("cache") == "miss")
    notes = []
    if cold and cold_misses == 0:
        notes.append(
            f"The run's 'cold' section produced {len(cold)} cache hits and no misses, so this "
            f"table has no cold-cache column: the pre-warm grid was already populated when it ran. "
            f"A cold-cache measurement requires flushing audio-cache/ before the section."
        )
    if rates["request_error_rate"] > 0:
        notes.append(
            f"{rates['request_error_rate']:.1%} of requests ({sum(1 for _s, r in rows if r.get('error'))} of "
            f"{len(rows)}) hit the client's 300 s timeout and are excluded from the percentiles above; "
            f"they are reported as their own row rather than dropped silently."
        )
    gen = [r for r in answered if r.get("cache") == "miss" and not r.get("is_fallback")]
    if gen:
        notes.append(
            f"Only {len(gen)} of {len(answered)} answered requests actually invoked MusicGen; the "
            f"rest were served from cache or fallback. Generation percentiles rest on that n."
        )
    note_text = " ".join(notes)

    header_a = ["Request class", "n", "p50 (ms)", "95% CI on p50", "p95 (ms)", "max (ms)"]
    p = ctx.path("")
    C.booktabs(p, caption="Feature D latency by request class, CPU configuration. "
                          "Nearest-rank percentiles; CI is a 10k-resample percentile bootstrap.",
               label="tab:latency", header=header_a, rows=panel_a, notes=note_text)
    C.markdown_table(p, header_a, panel_a,
                     notes="**Stages (ms)**\n\n" + _md_stage(stage_rows) + "\n\n" + note_text)

    p2 = ctx.path("-stages")
    C.booktabs(p2, caption="Feature D server-side stage times, pooled across request classes.",
               label="tab:latency-stages",
               header=["Stage", "n", "p50 (ms)", "p95 (ms)", "max (ms)"], rows=stage_rows)

    return {
        "by_class": stats,
        "by_stage": stage_stats,
        "unaccounted": u,
        "rates": rates,
        "cold_section_had_no_misses": bool(cold) and cold_misses == 0,
        "elapsed_s": data.get("elapsed_s"),
    }


def _md_stage(stage_rows) -> str:
    out = ["| Stage | n | p50 | p95 | max |", "|---|---|---|---|---|"]
    for r in stage_rows:
        if r is None:
            continue
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)
