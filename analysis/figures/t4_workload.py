"""T4 — comprehension, TLX and distraction by condition, with effect sizes.

The comprehension row is an *equivalence* claim (H3, TOST against ±0.5
questions), not a null-hypothesis one, so this table prints the equivalence
bounds and the 90% CI that TOST is read off, rather than a p-value that would
invite "no significant difference" to be read as "no difference".
"""

from __future__ import annotations

import collections
import statistics

from analysis.registry import Artefact
from analysis.figures import _common as C

ARTEFACT = Artefact(
    id="T4",
    kind="table",
    title="Comprehension, workload and distraction by condition",
    section="5.5",
    priority=6,
    metrics=["comprehension", "tlx", "distraction", "skip_rate"],
    inputs=["analysis/out/s4_tidy.json"],
)

ORDER = ["SILENCE", "PLAYLIST", "SHUFFLED", "ADAPTIVE"]
TOST_BOUND = 0.5  # questions, from the plan's §5 statistical analysis plan


def _paired(per_pt, a, b):
    pairs = [(v[a], v[b]) for v in per_pt.values() if a in v and b in v]
    if len(pairs) < 2:
        return None
    diffs = [x - y for x, y in pairs]
    m = statistics.fmean(diffs)
    sd = statistics.stdev(diffs)
    se = sd / len(diffs) ** 0.5
    return {"n": len(diffs), "mean_diff": m, "sd": sd, "dz": m / sd if sd else None,
            "ci90": (m - 1.645 * se, m + 1.645 * se)}


def build(ctx):
    data = ctx.load_json(ARTEFACT.inputs[0])
    ctx.metric("comprehension")
    responses, blocks = data["responses"], data.get("blocks", [])

    conditions = [c for c in ORDER if any(r["condition"] == c for r in responses)]

    def collect(recs, key, cond):
        return [r[key] for r in recs if r["condition"] == cond and r.get(key) is not None]

    def per_participant(recs, key):
        out = collections.defaultdict(dict)
        agg = collections.defaultdict(lambda: collections.defaultdict(list))
        for r in recs:
            if r.get(key) is not None:
                agg[r["participant"]][r["condition"]].append(r[key])
        for pid, conds in agg.items():
            for c, vs in conds.items():
                out[pid][c] = statistics.fmean(vs)
        return out

    measures = [
        ("Comprehension (0–4)", responses, "comprehension", 2),
        ("Raw TLX (0–100)", blocks, "tlx", 1),
        ("Distraction (1–7)", blocks, "distraction", 2),
        ("'Turn it off' presses", blocks, "turnoff_presses", 2),
    ]

    header = ["Measure"] + conditions + ["ADAPTIVE − SILENCE", "ADAPTIVE − PLAYLIST"]
    rows, values = [], {}
    for label, recs, key, places in measures:
        if not recs or not any(r.get(key) is not None for r in recs):
            continue
        pp = per_participant(recs, key)
        cells = []
        for c in conditions:
            vals = collect(recs, key, c)
            cells.append(f"{statistics.fmean(vals):.{places}f} ({statistics.stdev(vals):.{places}f})"
                         if len(vals) > 1 else C.fmt(vals[0] if vals else None, places))
        d_sil = _paired(pp, "ADAPTIVE", "SILENCE")
        d_pl = _paired(pp, "ADAPTIVE", "PLAYLIST")
        rows.append([label] + cells + [_fmt_contrast(d_sil, places), _fmt_contrast(d_pl, places)])
        values[key] = {"by_condition": {c: C.summary(collect(recs, key, c)) for c in conditions},
                       "adaptive_minus_silence": d_sil, "adaptive_minus_playlist": d_pl}

    # H3: equivalence, read off the 90% CI against ±0.5 questions.
    equiv = None
    comp = values.get("comprehension", {}).get("adaptive_minus_silence")
    if comp:
        lo, hi = comp["ci90"]
        equiv = {"bound": TOST_BOUND, "ci90": [lo, hi],
                 "equivalent": -TOST_BOUND < lo and hi < TOST_BOUND}
        rows.append(None)
        rows.append([f"H3 equivalence (±{TOST_BOUND} questions)"] + [""] * len(conditions) +
                    [f"90% CI [{lo:.2f}, {hi:.2f}] → "
                     f"{'equivalent' if equiv['equivalent'] else 'not equivalent'}", ""])

    note = ("Cells are mean (SD). Contrasts are paired mean differences with dz; the confirmatory "
            "tests are the mixed models in analysis/s4/models.R, Holm-corrected within the "
            "confirmatory family. Comprehension is an equivalence claim, not a null result.")
    p = ctx.path("")
    C.booktabs(p, caption="Task performance and workload by condition.", label="tab:workload",
               header=header, rows=rows, notes=note)
    C.markdown_table(p, header, rows, notes=note)
    return {"conditions": conditions, "measures": values, "h3_equivalence": equiv}


def _fmt_contrast(d, places):
    if not d:
        return "—"
    dz = f", dz={d['dz']:.2f}" if d.get("dz") is not None else ""
    return f"{d['mean_diff']:+.{places}f}{dz}"
