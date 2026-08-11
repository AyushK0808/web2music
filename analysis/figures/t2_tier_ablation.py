"""T2 — accuracy per tier configuration A1–A6, with escalation and exposure.

The table C3 is argued from. Two columns carry most of the weight and neither is
accuracy: **exposure rate** (share of pages whose text left the device) and
**escalation** (where the decision was actually taken). The human ceiling from
D-02 is printed as its own row, because an accuracy figure without the ceiling
next to it invites the reader to compare the classifier to perfection instead of
to a person.
"""

from __future__ import annotations

import json

from analysis.registry import Artefact, REPO
from analysis.figures import _common as C
from analysis.figures._s2 import s2_results_path, smoke_warning

ARTEFACT = Artefact(
    id="T2",
    kind="table",
    title="Classification accuracy per tier configuration, with escalation and exposure",
    section="5.2",
    priority=2,
    metrics=["macro_f1_category", "escalation_rate", "exposure_rate", "abstention_rate",
             "human_ceiling"],
    inputs=[s2_results_path()],
)

CEILING = "analysis/out/alpha.json"  # written by analysis/krippendorff.py after D-02


def build(ctx):
    path = ARTEFACT.inputs[0]
    data = ctx.load_json(path)
    ctx.metric("macro_f1_category")

    configs = data["configs"]
    n = configs[0]["n"] if configs else 0

    header = ["Configuration", "n", "Accuracy", "Macro-F1", "Escalation (keyword / ZS / LLM / other)",
              "Exposure", "ZS proxy"]
    rows = []
    for c in configs:
        esc = c.get("escalation", {})
        kw, zs, llm = esc.get("keyword", 0), esc.get("zero-shot", 0), esc.get("llm", 0)
        other = sum(v for k, v in esc.items() if k not in ("keyword", "zero-shot", "llm"))
        rows.append([
            c["name"], c["n"], C.fmt(c.get("accuracy"), 3), C.fmt(c.get("macro_f1"), 3),
            f"{kw} / {zs} / {llm} / {other}",
            C.fmt(c.get("exposure_rate"), 3), C.fmt(c.get("zero_shot_proxy_rate"), 3),
        ])

    # Human ceiling row, when D-02 has produced one.
    ceiling = None
    cp = REPO / CEILING
    if cp.exists():
        alpha = json.loads(cp.read_text(encoding="utf-8"))
        ceiling = alpha.get("category", {}).get("leave_one_out_accuracy")
        if ceiling is not None:
            rows.append(None)
            rows.append(["Human ceiling (leave-one-annotator-out)", alpha["category"].get("n_units", "—"),
                         C.fmt(ceiling, 3), "—", "—", "0.000", "0.000"])

    # The A4 → A5 trade, which is the sentence §6.3 is built on.
    by_name = {c["name"]: c for c in configs}
    a4 = next((c for k, c in by_name.items() if k.startswith("A4")), None)
    a5 = next((c for k, c in by_name.items() if k.startswith("A5")), None)
    trade = None
    if a4 and a5 and a4.get("macro_f1") is not None and a5.get("macro_f1") is not None:
        trade = {
            "macro_f1_delta": round(a5["macro_f1"] - a4["macro_f1"], 4),
            "exposure_delta": round((a5.get("exposure_rate") or 0) - (a4.get("exposure_rate") or 0), 4),
        }

    warn = smoke_warning(path, n)
    p = ctx.path("")
    C.booktabs(p, caption="Tier configurations over the frozen S2 corpus. Escalation counts are "
                          "pages decided at each tier; exposure is the share whose text left the device.",
               label="tab:tiers", header=header, rows=rows, notes=warn)
    C.markdown_table(p, header, rows, notes=warn)

    return {
        "source": path,
        "smoke": bool(warn),
        "n": n,
        "configs": configs,
        "a4_to_a5_trade": trade,
        "human_ceiling": ceiling,
    }
