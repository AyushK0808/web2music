"""C-03 — Krippendorff's alpha, plus the human ceiling that has to be printed beside it.

    python analysis/krippendorff.py --annotations analysis/out/annotations/*.json
    python analysis/krippendorff.py --self-test

Nominal alpha over N annotators x M units, computed from the coincidence matrix
so that missing values (an annotator who skipped a page) are handled correctly
rather than by dropping the unit. Bootstrap CIs resample **units**, not
individual judgements — the units are the independent things here, and
resampling judgements within a unit would understate the interval.

Alongside alpha it computes the number the plan actually needs for §5.2:
**leave-one-annotator-out accuracy**, i.e. how often one annotator agrees with
the majority of the others. That is the ceiling a classifier is measured
against. Alpha says whether the labels are usable; the ceiling says what score
counts as good, and the plan is explicit that classifier accuracy must never be
reported without it.

Input format — one JSON file per annotator:

    {"annotator": "a3",
     "labels": {"page-id": {"category": "Health", "mood": "calm", "sensitive": false}, ...}}
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import random
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Windows terminals default stdout/stderr to the system codepage (cp1252),
# which can't encode "≈" below — without this, --self-test crashes on its
# first print before any of the math it's checking ever runs.
for _stream in (sys.stdout, sys.stderr):
    if getattr(_stream, "encoding", "").lower() not in ("utf-8", "utf8"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

# The plan's gates (§3 S2).
ALPHA_MIN_USABLE = 0.667
ALPHA_GOOD = 0.80


def nominal_alpha(units: dict[str, list]) -> float | None:
    """Krippendorff's alpha for nominal data.

    units maps unit id -> list of values, one per annotator who labelled it,
    with None for annotators who did not. Units with fewer than two values
    contribute nothing (they cannot disagree) and are excluded, which is the
    standard treatment and not a convenience.
    """
    usable = {u: [v for v in vals if v is not None] for u, vals in units.items()}
    usable = {u: vals for u, vals in usable.items() if len(vals) >= 2}
    if not usable:
        return None

    # Coincidence matrix: each unit contributes its ordered pairs, weighted by
    # 1/(m_u - 1) so units with more annotators do not dominate.
    coincidence: dict[tuple, float] = collections.defaultdict(float)
    n_total = 0.0
    for vals in usable.values():
        m = len(vals)
        n_total += m
        for i, a in enumerate(vals):
            for j, b in enumerate(vals):
                if i != j:
                    coincidence[(a, b)] += 1.0 / (m - 1)

    if n_total < 2:
        return None

    values = sorted({v for vals in usable.values() for v in vals}, key=str)
    n_c = {v: sum(coincidence[(v, w)] for w in values) for v in values}

    # Observed disagreement (nominal: 1 if different, 0 if same).
    d_o = sum(coincidence[(a, b)] for a in values for b in values if a != b)
    # Expected disagreement under independence.
    d_e = sum(n_c[a] * n_c[b] for a in values for b in values if a != b) / (n_total - 1)

    if d_e == 0:
        return 1.0  # every annotator used one value; no disagreement was possible
    return 1.0 - (d_o / d_e)


def leave_one_out_accuracy(units: dict[str, list]) -> dict:
    """The human ceiling: agreement of one annotator with the majority of the rest.

    Ties in the majority among the remaining annotators are counted as a miss,
    which is the conservative direction — it never inflates the ceiling a
    classifier is being compared against.
    """
    hits = total = ties = 0
    for vals in units.values():
        present = [v for v in vals if v is not None]
        if len(present) < 3:
            continue  # a "majority of the others" needs at least two others
        for i, held_out in enumerate(present):
            others = present[:i] + present[i + 1:]
            counts = collections.Counter(others)
            top = max(counts.values())
            winners = [v for v, c in counts.items() if c == top]
            total += 1
            if len(winners) > 1:
                ties += 1
                continue
            if winners[0] == held_out:
                hits += 1
    return {
        "leave_one_out_accuracy": hits / total if total else None,
        "n_comparisons": total,
        "n_ties_counted_as_miss": ties,
    }


def majority_labels(units: dict[str, list]) -> dict:
    """Resolved ground truth: majority label per unit; three-way splits discarded
    and counted, as the plan specifies."""
    resolved, discarded = {}, []
    for u, vals in units.items():
        present = [v for v in vals if v is not None]
        if not present:
            discarded.append(u)
            continue
        counts = collections.Counter(present)
        top = max(counts.values())
        winners = [v for v, c in counts.items() if c == top]
        if len(winners) > 1:
            discarded.append(u)
        else:
            resolved[u] = winners[0]
    return {"labels": resolved, "discarded": discarded,
            "discard_rate": len(discarded) / len(units) if units else 0.0}


def label_distribution(units: dict[str, list]) -> dict:
    """Per unit, the distribution over labels. For mood this is more informative
    than the majority label — 'what mood should this page have' is a preference,
    and a distribution is the honest representation of one."""
    out = {}
    for u, vals in units.items():
        present = [v for v in vals if v is not None]
        if not present:
            continue
        c = collections.Counter(present)
        out[u] = {k: v / len(present) for k, v in c.items()}
    return out


def bootstrap_alpha(units: dict[str, list], resamples: int = 2000, alpha_level: float = 0.05,
                    seed: int = 20260810) -> tuple[float, float]:
    """Percentile bootstrap over units."""
    keys = list(units)
    if len(keys) < 3:
        return (float("nan"), float("nan"))
    rng = random.Random(seed)
    stats = []
    for _ in range(resamples):
        sample = {}
        for i in range(len(keys)):
            k = keys[rng.randrange(len(keys))]
            sample[f"{k}#{i}"] = units[k]
        a = nominal_alpha(sample)
        if a is not None:
            stats.append(a)
    if not stats:
        return (float("nan"), float("nan"))
    stats.sort()
    lo = stats[max(0, int(alpha_level / 2 * len(stats)) - 1)]
    hi = stats[min(len(stats) - 1, int((1 - alpha_level / 2) * len(stats)))]
    return (lo, hi)


def analyse(annotations: list[dict], label_sets=("category", "mood", "sensitive"),
            resamples: int = 2000) -> dict:
    annotators = [a["annotator"] for a in annotations]
    all_ids = sorted({pid for a in annotations for pid in a["labels"]})

    report = {"annotators": annotators, "n_annotators": len(annotators), "n_units": len(all_ids)}
    for label in label_sets:
        units = {
            pid: [a["labels"].get(pid, {}).get(label) for a in annotations]
            for pid in all_ids
        }
        alpha = nominal_alpha(units)
        lo, hi = bootstrap_alpha(units, resamples=resamples)
        coverage = {a["annotator"]: sum(1 for pid in all_ids
                                        if a["labels"].get(pid, {}).get(label) is not None)
                    for a in annotations}
        maj = majority_labels(units)
        report[label] = {
            "alpha": alpha,
            "alpha_ci95": [lo, hi],
            "n_units": len(units),
            "coverage": coverage,
            "gate": ("good" if alpha is not None and alpha >= ALPHA_GOOD
                     else "usable" if alpha is not None and alpha >= ALPHA_MIN_USABLE
                     else "BELOW THRESHOLD"),
            **leave_one_out_accuracy(units),
            "majority_labels": maj["labels"],
            "discarded_units": maj["discarded"],
            "discard_rate": maj["discard_rate"],
        }
        if label == "mood":
            # The mood distribution is the thing worth reporting, not the mode.
            report[label]["distribution"] = label_distribution(units)
    return report


# ── Self-test: three cases whose alpha is known by construction ──────────────
def self_test() -> int:
    ok = True

    def check(name, got, want, tol=0.02):
        nonlocal ok
        good = got is not None and abs(got - want) <= tol
        ok = ok and good
        print(f"  {'ok  ' if good else 'FAIL'} {name}: alpha={got!r} expected≈{want}")

    perfect = {f"u{i}": ["A", "A", "A"] for i in range(10)}
    check("perfect agreement", nominal_alpha(perfect), 1.0)

    # Every annotator disagrees maximally and each label is used equally often:
    # alpha should sit at or below 0 (no better than chance).
    chance = {f"u{i}": ["A", "B", "C"] for i in range(10)}
    a = nominal_alpha(chance)
    good = a is not None and a <= 0.0
    ok = ok and good
    print(f"  {'ok  ' if good else 'FAIL'} systematic disagreement: alpha={a:.3f} expected <= 0")

    # Two cases small enough to compute by hand, so the check does not depend on
    # a remembered figure from a paper. The nominal identity being exercised is
    #     alpha = 1 - (n-1) * sum_{c!=k} o_ck / sum_{c!=k} n_c n_k
    #
    # (i) 2 coders, 4 units: AA, AA, AB, BB.
    #     o_AA=4 o_BB=2 o_AB=o_BA=1, n=8, n_A=5 n_B=3
    #     alpha = 1 - 7*2/30 = 0.5333...
    two_coder = {"u1": ["A", "A"], "u2": ["A", "A"], "u3": ["A", "B"], "u4": ["B", "B"]}
    check("hand case, 2 coders", nominal_alpha(two_coder), 1 - 14 / 30, tol=1e-9)

    # (ii) 3 coders, 3 units: AAA, AAB, BBB — exercises the 1/(m-1) weighting.
    #     o_AA=4 o_BB=3 o_AB=o_BA=1, n=9, n_A=5 n_B=4
    #     alpha = 1 - 8*2/40 = 0.6
    three_coder = {"u1": ["A", "A", "A"], "u2": ["A", "A", "B"], "u3": ["B", "B", "B"]}
    check("hand case, 3 coders (1/(m-1) weighting)", nominal_alpha(three_coder), 0.6, tol=1e-9)

    # (iii) missing values must reduce a unit's weight, not drop the unit, and a
    #       unit with a single value must be excluded entirely rather than
    #       counted as perfect agreement with itself.
    with_missing = dict(three_coder)
    with_missing["u4"] = ["A", None, None]  # single value: contributes nothing
    check("single-value unit excluded", nominal_alpha(with_missing), 0.6, tol=1e-9)

    # Ceiling: with 3 annotators where one is a known contrarian on 2 of 10
    # units, leave-one-out accuracy is computable by hand.
    units = {f"u{i}": ["A", "A", "A"] for i in range(8)}
    units["u8"] = ["A", "A", "B"]
    units["u9"] = ["A", "A", "B"]
    loo = leave_one_out_accuracy(units)
    # 8 units x 3 = 24 hits; 2 units contribute 1 hit each (the two A's agree
    # with each other's majority? no: holding out an A leaves [A,B] -> tie ->
    # miss; holding out B leaves [A,A] -> A != B -> miss). So 24/30.
    want = 24 / 30
    good = abs(loo["leave_one_out_accuracy"] - want) < 1e-9
    ok = ok and good
    print(f"  {'ok  ' if good else 'FAIL'} leave-one-out ceiling: "
          f"{loo['leave_one_out_accuracy']:.4f} expected {want:.4f} "
          f"({loo['n_ties_counted_as_miss']} ties counted as miss)")

    print("\nself-test", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--annotations", nargs="*", default=[],
                    help="annotator JSON files, or globs")
    ap.add_argument("--out", default="analysis/out/alpha.json")
    ap.add_argument("--resamples", type=int, default=2000)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    paths = []
    for pattern in args.annotations:
        paths.extend(sorted(glob.glob(pattern)))
    if not paths:
        print("No annotation files. This is expected until D-02 has run — "
              "the code is ready and self-tested (--self-test).", file=sys.stderr)
        return 2

    annotations = [json.loads(Path(p).read_text(encoding="utf-8")) for p in paths]
    report = analyse(annotations, resamples=args.resamples)

    out = REPO / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"{len(annotations)} annotators, {report['n_units']} units\n")
    for label in ("category", "mood", "sensitive"):
        r = report[label]
        lo, hi = r["alpha_ci95"]
        print(f"  {label:<10} alpha={r['alpha']:.3f}  95% CI [{lo:.3f}, {hi:.3f}]  {r['gate']}")
        print(f"             human ceiling {r['leave_one_out_accuracy']:.3f} "
              f"over {r['n_comparisons']} comparisons; "
              f"{r['discard_rate']:.1%} of units discarded as ties")
    print(f"\nWrote {out}")

    below = [l for l in ("category", "mood", "sensitive")
             if (report[l]["alpha"] or 0) < ALPHA_MIN_USABLE]
    if below:
        print(f"\nWARNING: alpha below {ALPHA_MIN_USABLE} for: {', '.join(below)}. "
              f"The plan's gate says do not draw conclusions from these labels; "
              f"a low mood alpha is itself a §6.4 finding, not a reason to re-annotate "
              f"until it rises.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
