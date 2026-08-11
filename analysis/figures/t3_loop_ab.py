"""T3 — loop AB detection rate per mood, with CIs against the 50% chance line.

C6 wants the interval to *contain* 0.5, which is an unusual thing to want and
changes how the table must be read: a rate near chance is the claim succeeding,
not the experiment failing. The interval is Wilson rather than normal-
approximation, because with ~30 listeners × 20 pairs the per-mood cells are
small and a normal interval near p = 0.5 is wider than it needs to be at the
exact place the decision is made.

Consumes the scored output of ``analysis/loop_ab/score_loop_ab.py`` (C-12).
"""

from __future__ import annotations

from analysis.registry import Artefact
from analysis.figures import _common as C

ARTEFACT = Artefact(
    id="T3",
    kind="table",
    title="Loop AB-test detection rate per mood",
    section="5.3",
    priority=7,
    metrics=["loop_detection_rate", "seam_energy_delta_db"],
    inputs=["analysis/out/loop_ab_scored.json"],
)


def build(ctx):
    data = ctx.load_json(ARTEFACT.inputs[0])
    ctx.metric("loop_detection_rate")

    header = ["Mood", "Listeners", "Trials", "Detection rate", "95% CI (Wilson)", "Contains 0.5?"]
    rows, per_mood = [], {}
    for mood, cell in sorted(data["per_mood"].items()):
        hits, n = cell["correct"], cell["trials"]
        lo, hi = C.wilson_ci(hits, n)
        contains = lo <= 0.5 <= hi
        per_mood[mood] = {"correct": hits, "trials": n, "rate": hits / n if n else None,
                          "ci": [lo, hi], "contains_chance": contains}
        rows.append([mood, cell.get("listeners", "—"), n, C.fmt(hits / n if n else None, 3),
                     f"[{C.fmt(lo, 3)}, {C.fmt(hi, 3)}]", "yes" if contains else "no"])

    tot_h = sum(c["correct"] for c in data["per_mood"].values())
    tot_n = sum(c["trials"] for c in data["per_mood"].values())
    lo, hi = C.wilson_ci(tot_h, tot_n)
    rows.append(None)
    rows.append(["All moods", data.get("n_listeners", "—"), tot_n, C.fmt(tot_h / tot_n, 3),
                 f"[{C.fmt(lo, 3)}, {C.fmt(hi, 3)}]", "yes" if lo <= 0.5 <= hi else "no"])

    note = ("C6 predicts intervals that contain 0.5. A rate significantly above chance in the "
            "dense moods and at chance in the sparse ones is itself the §6.6 finding, and is "
            "reported as such rather than pooled away.")
    # score_loop_ab.py --simulate produces a file of the same shape as a real
    # one. Without this the table is indistinguishable from a finished study,
    # which is precisely the confusion that would survive into a draft.
    if data.get("simulated"):
        note = ("BUILT FROM SIMULATED LISTENERS — a harness check, not a result. The rates below "
                "are the ones the simulator was told to produce. Rebuild after H-03. " + note)
    p = ctx.path("")
    C.booktabs(p, caption="Forced-choice loop detection per mood. Chance is 0.500.",
               label="tab:loop-ab", header=header, rows=rows, notes=note)
    C.markdown_table(p, header, rows, notes=note)

    return {"simulated": bool(data.get("simulated")),
            "per_mood": per_mood, "overall": {"correct": tot_h, "trials": tot_n,
                                              "rate": tot_h / tot_n if tot_n else None,
                                              "ci": [lo, hi]},
            "n_listeners": data.get("n_listeners")}
