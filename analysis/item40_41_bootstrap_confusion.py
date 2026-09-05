"""Items 40 & 41: bootstrap CIs on T2 (accuracy/macro-F1 per config) and
per-class support + confusion matrix for the 13-way category task.

Replays the production cascade over the stored per-page tier outputs in
mood-classification/results/s2-ablation.json -- the same file T2/F4/F5 in
the paper are built from -- using the identical mirror of simulateCascade()
that analysis/figures/f4_confusion.py already uses, so these numbers are
consistent with the built T2/F4 tables rather than a re-derivation that
could quietly disagree with them.
"""
import json, random
from pathlib import Path

random.seed(20260904)

REPO = Path("/home/claude/web2music")
data = json.loads((REPO / "mood-classification/results/s2-ablation.json").read_text())
pages = data["per_page"]
N = len(pages)
print(f"n pages = {N}")

PROD_MIN_SCORE, PROD_MIN_MARGIN = 0.45, 0.10

def cascade(r, min_score=PROD_MIN_SCORE, min_margin=PROD_MIN_MARGIN, zero_shot=True, allow_llm=True):
    if r.get("isSensitive"):
        return (r["keyword"].get("primary") or "Entertainment", "skipped-sensitive")
    if r["keyword"].get("primary") and not r.get("langSkipsKeyword"):
        return (r["keyword"]["primary"], "keyword")
    zs = r.get("zeroShot")
    if zero_shot and zs and zs["score"] >= min_score and zs["margin"] >= min_margin:
        return (zs["category"], "zero-shot")
    if allow_llm and r.get("llm"):
        return (r["llm"], "llm")
    return ("Entertainment", "default")

def tier_alone(r, tier):
    if tier == "keyword":
        return (r["keyword"]["primary"], "keyword") if r["keyword"]["primary"] else (None, "none")
    if tier == "zero-shot":
        zs = r.get("zeroShot")
        return (zs["category"], "zero-shot") if zs else (None, "none")
    if tier == "llm":
        return (r["llm"], "llm") if r.get("llm") else (None, "none")

CONFIGS = {
    "A1 keyword-only": lambda r: tier_alone(r, "keyword"),
    "A2 zero-shot-only (ungated)": lambda r: tier_alone(r, "zero-shot"),
    "A3 LLM-only": lambda r: tier_alone(r, "llm"),
    "A4 keyword->LLM": lambda r: cascade(r, zero_shot=False),
    "A5 keyword->zero-shot->LLM": lambda r: cascade(r, zero_shot=True),
}

CATEGORIES = sorted({p["true_category"] for p in pages if p.get("true_category")})

def macro_f1(preds):
    per = {c: [0,0,0] for c in CATEGORIES}  # tp fp fn
    for t, p in preds:
        if p == t:
            if t in per: per[t][0] += 1
        else:
            if t in per: per[t][2] += 1
            if p in per: per[p][1] += 1
    f1s = []
    for c in CATEGORIES:
        tp, fp, fn = per[c]
        if tp+fp+fn == 0: continue
        prec = tp/(tp+fp) if tp+fp else 0
        rec = tp/(tp+fn) if tp+fn else 0
        f1s.append(2*prec*rec/(prec+rec) if prec+rec else 0)
    return sum(f1s)/len(f1s) if f1s else 0.0

def accuracy(preds):
    return sum(1 for t,p in preds if p == t) / len(preds)

def bootstrap_ci(pages_subset, decide, n_boot=2000, alpha=0.05):
    idx = list(range(len(pages_subset)))
    accs, f1s = [], []
    for _ in range(n_boot):
        sample_idx = [random.choice(idx) for _ in idx]
        preds = [(pages_subset[i]["true_category"], decide(pages_subset[i])[0]) for i in sample_idx]
        accs.append(accuracy(preds))
        f1s.append(macro_f1(preds))
    accs.sort(); f1s.sort()
    lo_i, hi_i = int(n_boot*alpha/2), int(n_boot*(1-alpha/2))
    return (accs[lo_i], accs[hi_i]), (f1s[lo_i], f1s[hi_i])

print("\n=== Item 40: bootstrap 95% CIs (2000 resamples, page-level) ===")
results_40 = {}
for name, decide in CONFIGS.items():
    preds = [(p["true_category"], decide(p)[0]) for p in pages]
    acc = accuracy(preds); f1 = macro_f1(preds)
    (acc_lo, acc_hi), (f1_lo, f1_hi) = bootstrap_ci(pages, decide)
    results_40[name] = dict(accuracy=round(acc,3), acc_ci=[round(acc_lo,3), round(acc_hi,3)],
                             macro_f1=round(f1,3), f1_ci=[round(f1_lo,3), round(f1_hi,3)])
    print(f"{name:32s} acc={acc:.3f} [{acc_lo:.3f},{acc_hi:.3f}]   "
          f"macroF1={f1:.3f} [{f1_lo:.3f},{f1_hi:.3f}]")

# A4 vs A5 paired bootstrap on the delta (same resample indices for both configs)
print("\n=== A4 vs A5 paired-bootstrap delta (macro-F1) ===")
idx = list(range(N))
deltas = []
for _ in range(2000):
    sample_idx = [random.choice(idx) for _ in idx]
    preds_a4 = [(pages[i]["true_category"], CONFIGS["A4 keyword->LLM"](pages[i])[0]) for i in sample_idx]
    preds_a5 = [(pages[i]["true_category"], CONFIGS["A5 keyword->zero-shot->LLM"](pages[i])[0]) for i in sample_idx]
    deltas.append(macro_f1(preds_a5) - macro_f1(preds_a4))
deltas.sort()
lo, hi = deltas[int(0.025*2000)], deltas[int(0.975*2000)]
point = macro_f1([(p["true_category"], CONFIGS["A5 keyword->zero-shot->LLM"](p)[0]) for p in pages]) - \
        macro_f1([(p["true_category"], CONFIGS["A4 keyword->LLM"](p)[0]) for p in pages])
print(f"A5 - A4 macro-F1 delta = {point:.4f}  95% CI [{lo:.4f}, {hi:.4f}]  "
      f"{'(CI excludes 0 -- significant)' if lo>0 or hi<0 else '(CI includes 0)'}")

json.dump(results_40, open("/home/claude/w2m_work/item40_bootstrap_ci.json","w"), indent=2)

print("\n=== Item 41: per-class support + confusion, A5 cascade ===")
preds_a5 = [(p["true_category"], cascade(p)[0]) for p in pages if p.get("true_category")]
n_no_truth = sum(1 for p in pages if not p.get("true_category"))
print(f"  ({n_no_truth} of {N} pages have no true_category and are excluded from support/confusion)")
support = {c: 0 for c in CATEGORIES}
for t, _ in preds_a5:
    support[t] += 1
for c in sorted(support, key=lambda c: support[c]):
    flag = "  <-- near-empty (n<10)" if support[c] < 10 else ""
    print(f"  {c:14s} n={support[c]:3d}{flag}")
json.dump({"support": support, "n_classes": len(CATEGORIES), "n_pages": N},
          open("/home/claude/w2m_work/item41_support.json","w"), indent=2)
