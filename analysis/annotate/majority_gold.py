"""S-E — gold labels from three blind author annotators.

    python analysis/annotate/majority_gold.py --annotations analysis/out/annotations/test/*.json \
        --out analysis/out/gold-test.json
    python analysis/annotate/majority_gold.py --self-test

Gold = the strict majority of the annotators who labelled a page, separately for
`category` and for `sensitive`. A page with no strict majority (a three-way
split, or a 1-1 split when one annotator skipped) is a TIE: it is written to
`ties` and given no gold label until the authors adjudicate it in a discussion
pass, recorded by passing `--adjudicated adjudicated.json` ({page-id: {category,
sensitive}}). The number of ties and the number adjudicated are reported, because
the paper has to say how many labels were decided by discussion rather than vote.

No LLM touches this file at any step (L-1): it reads only the annotators' own
exports (the shape analysis/krippendorff.py reads) and an optional file of the
authors' adjudications.
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import sys
from pathlib import Path


def majority(values):
    """(winner, n_votes, tie) for a list of labels; skipped/None values are ignored."""
    votes = [v for v in values if v is not None]
    if not votes:
        return None, 0, True
    counts = collections.Counter(votes).most_common()
    top = counts[0][1]
    leaders = [v for v, c in counts if c == top]
    if len(leaders) > 1 or top * 2 <= len(votes):
        return None, len(votes), True
    return leaders[0], len(votes), False


def build_gold(annotations, adjudicated=None):
    """annotations: list of {"annotator", "labels": {page-id: {category, sensitive, skipped?}}}"""
    adjudicated = adjudicated or {}
    ids = sorted({pid for a in annotations for pid in a["labels"]})
    gold, ties = {}, []
    for pid in ids:
        per = [a["labels"].get(pid) for a in annotations]
        per = [l for l in per if l and not l.get("skipped")]
        cat, n_cat, tie_cat = majority([l.get("category") for l in per])
        sens, n_sens, tie_sens = majority([l.get("sensitive") for l in per])
        entry = {"category": cat, "sensitive": sens, "n_annotators": max(n_cat, n_sens),
                 "adjudicated": False}
        if tie_cat or tie_sens:
            ties.append({"id": pid, "category_tie": tie_cat, "sensitive_tie": tie_sens,
                         "votes": [{"category": l.get("category"), "sensitive": l.get("sensitive")} for l in per]})
            adj = adjudicated.get(pid)
            if adj:
                if tie_cat and adj.get("category") is not None:
                    entry["category"] = adj["category"]
                if tie_sens and adj.get("sensitive") is not None:
                    entry["sensitive"] = adj["sensitive"]
                entry["adjudicated"] = True
        gold[pid] = entry
    return gold, ties


def _self_test():
    ann = [
        {"annotator": "a", "labels": {"p1": {"category": "News", "sensitive": False},
                                       "p2": {"category": "Health", "sensitive": True},
                                       "p3": {"category": "Legal", "sensitive": False}}},
        {"annotator": "b", "labels": {"p1": {"category": "News", "sensitive": False},
                                       "p2": {"category": "Health", "sensitive": True},
                                       "p3": {"category": "News", "sensitive": False}}},
        {"annotator": "c", "labels": {"p1": {"category": "Blog", "sensitive": False},
                                       "p2": {"category": "Health", "sensitive": False},
                                       "p3": {"category": "Shopping", "sensitive": False}}},
    ]
    gold, ties = build_gold(ann)
    assert gold["p1"]["category"] == "News" and gold["p1"]["sensitive"] is False
    assert gold["p2"]["category"] == "Health" and gold["p2"]["sensitive"] is True
    assert gold["p3"]["category"] is None and [t["id"] for t in ties] == ["p3"], "3-way split is a tie"
    gold2, ties2 = build_gold(ann, {"p3": {"category": "News"}})
    assert gold2["p3"]["category"] == "News" and gold2["p3"]["adjudicated"] is True and len(ties2) == 1
    skip = [{"annotator": "a", "labels": {"p": {"category": "X", "sensitive": False}}},
            {"annotator": "b", "labels": {"p": {"category": "Y", "sensitive": False}}},
            {"annotator": "c", "labels": {"p": {"skipped": True}}}]
    _, t = build_gold(skip)
    assert t and t[0]["category_tie"], "1-1 with one skip is a tie, not a majority"
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--annotations", nargs="*", default=[])
    ap.add_argument("--adjudicated", default=None)
    ap.add_argument("--out", default="analysis/out/gold.json")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return 0

    files = [f for pat in args.annotations for f in glob.glob(pat)]
    if len(files) < 2:
        print("need at least two annotation files", file=sys.stderr)
        return 2
    annotations = [json.loads(Path(f).read_text(encoding="utf-8")) for f in files]
    adj = json.loads(Path(args.adjudicated).read_text(encoding="utf-8")) if args.adjudicated else None
    gold, ties = build_gold(annotations, adj)
    unresolved = [t["id"] for t in ties if not gold[t["id"]]["adjudicated"]]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "annotators": [a.get("annotator") for a in annotations],
        "n_pages": len(gold),
        "n_ties": len(ties),
        "n_adjudicated": sum(1 for g in gold.values() if g["adjudicated"]),
        "unresolved_ties": unresolved,
        "gold": gold,
        "ties": ties,
    }, indent=2), encoding="utf-8")
    print(f"{len(gold)} pages, {len(ties)} ties, {len(unresolved)} still unresolved -> {out}")
    return 1 if unresolved else 0


if __name__ == "__main__":
    raise SystemExit(main())
