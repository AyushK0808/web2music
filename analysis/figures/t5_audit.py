"""T5 — the responsible-behaviour audit table.

Consumes ``analysis/out/audit.json`` from ``analysis/audit/t5_audit.mjs``
(C-11), which runs the covering tests rather than trusting a list of them.
The second panel is the detector's false-negative and false-positive rates on
the adversarial slice, broken down by slice, because "how do you know the crisis
silence works" is answered by the per-slice row and not by the pooled one.
"""

from __future__ import annotations

from analysis.registry import Artefact
from analysis.figures import _common as C

ARTEFACT = Artefact(
    id="T5",
    kind="table",
    title="Responsible-behaviour audit: policy, trigger, covering test, live status",
    section="5.6",
    priority=5,
    metrics=["policy_test_status", "sensitive_false_negative_rate",
             "sensitive_false_positive_rate", "attenuation_rate"],
    inputs=["analysis/out/audit.json"],
)


def build(ctx):
    data = ctx.load_json(ARTEFACT.inputs[0])
    ctx.metric("policy_test_status")

    header = ["Policy", "Trigger", "Covered by", "Status"]
    rows = [[p["policy"], p["trigger"], p["test"]["label"], p["test"]["status"]]
            for p in data["policies"]]
    rows.append(None)
    for c in data.get("direct_assertions", []):
        rows.append([c["name"], "direct assertion", "t5_audit.mjs", c["status"]])

    # "sensitive" nests {keyword, zero_shot?} since the §5.1/§5.5 fix — keyword
    # is the tier-1-only baseline (always present), zero_shot is the post-fix
    # resolveSensitivity() pass, present only when t5_audit.mjs was run with
    # --with-zero-shot against a live entailment service.
    sensitive_block = data["sensitive"]
    s = sensitive_block["keyword"]
    note = (f"Sensitive-content detector on the adversarial slice (n={s['n']}: "
            f"{s['n_sensitive']} sensitive, {s['n_benign']} benign), keyword tier only: "
            f"false-negative rate {s['false_negative_rate']:.3f}, "
            f"false-positive rate {s['false_positive_rate']:.3f}.")
    zs = sensitive_block.get("zero_shot")
    if zs:
        note += (f" With the §5.1/§5.5 zero-shot fix: false-negative rate "
                 f"{zs['false_negative_rate']:.3f}, false-positive rate {zs['false_positive_rate']:.3f}.")
    note += f" Generated {data['generated_at']} at {data.get('git_sha') or 'unknown SHA'}."

    p = ctx.path("")
    C.booktabs(p, caption="Responsible-behaviour policies and the tests that cover them, with "
                          "live status at build time.",
               label="tab:audit", header=header, rows=rows, notes=note,
               align="p{0.26\\linewidth}p{0.30\\linewidth}p{0.22\\linewidth}l")
    C.markdown_table(p, header, rows, notes=note)

    sheader = ["Slice", "n", "Correct", "Accuracy"]
    srows = [[k, v["n"], v["correct"], C.fmt(v["correct"] / v["n"], 3)]
             for k, v in sorted(s["by_slice"].items())]
    misses = "; ".join(f"{f['id']} ({f['slice']})" for f in s["false_negatives"]) or "none"
    fps = "; ".join(f"{f['id']} ({f['slice']})" for f in s["false_positives"]) or "none"
    p2 = ctx.path("-sensitive")
    C.booktabs(p2, caption="Sensitive-content detector by adversarial slice.",
               label="tab:sensitive-slices", header=sheader, rows=srows,
               notes=f"False negatives: {misses}. False positives: {fps}.")
    C.markdown_table(p2, sheader, srows,
                     notes=f"**False negatives:** {misses}\n\n**False positives:** {fps}")

    return {
        "generated_at": data["generated_at"],
        "git_sha": data.get("git_sha"),
        "n_policies": len(data["policies"]),
        "policies_passing": sum(1 for p in data["policies"] if p["test"]["status"] == "pass"),
        "assertions_passing": sum(1 for c in data.get("direct_assertions", [])
                                  if c["status"] == "pass"),
        "sensitive": {k: v for k, v in s.items() if k != "per_page"},
    }
