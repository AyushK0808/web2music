#!/usr/bin/env python3
"""C-16 — the analysis pipeline, written and checked before any data exists.

    python analysis/s4/simulate_and_check.py               # simulate, fit, verify, build figures
    python analysis/s4/simulate_and_check.py --n 56 --seed 3

The plan specifies the models precisely, which means they can be written and
tested now — and doing so is what makes the pre-registration credible rather
than a promise. Discovering on real data that a model does not converge is a
bad week; discovering it here costs an afternoon.

This script:

1. **Simulates** an S4 dataset under a *known* effect, using the real
   assignment logic from ``assignment.mjs`` via ``export_s4.mjs`` rather than a
   convenient parallel implementation — so the simulation exercises the same
   Latin square, the same shuffled draws and the same page structure the study
   will produce.
2. **Fits** the confirmatory models and checks that each recovers the effect it
   was handed. A pipeline that cannot recover an effect it was given will not
   find one that is really there.
3. **Runs the whole thing through to F7 and T4**, so "raw export → figure" is
   known to work end to end.

The R scripts in ``models.R`` are the ones the pre-registration names and are
what the paper will report; this is the same specification in Python so it can
be *executed* here, and the two are cross-checked on the same simulated data
whenever R is available (``--with-r``).
"""

from __future__ import annotations

import argparse
import json
import math
import random
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

CONDITIONS = ["SILENCE", "PLAYLIST", "SHUFFLED", "ADAPTIVE"]

# ── The effects the simulation plants, in the units of the measures ────────
# Chosen to match the plan's own power analysis (dz = 0.4 on the primary
# contrast) so that a run of this script is also a check that N = 56 is enough.
TRUE_EFFECTS = {
    "fit_adaptive_over_shuffled": 0.8,   # Likert points
    "fit_adaptive_over_playlist": 1.2,
    "comprehension_adaptive_vs_silence": 0.0,   # H3 is an equivalence claim
    "tlx_adaptive_under_playlist": -6.0,        # TLX points
}


def simulate(n_participants: int, seed: int, pages_per_block: int = 8) -> dict:
    rng = random.Random(seed)
    nprng = np.random.default_rng(seed)

    pages = [{"id": f"page-{i}", "url": f"https://example.com/{i}",
              "trueMood": ["calm", "focused", "tense", "joyful", "sad", "dark",
                           "curious", "neutral"][i % 8]}
             for i in range(pages_per_block)]

    # Session structure comes from the real assignment code.
    sessions = json.loads(subprocess.run(
        ["node", str(REPO / "analysis/s4/build_sessions.mjs"),
         "--n", str(n_participants), "--pages", json.dumps(pages)],
        capture_output=True, text=True, check=True, cwd=REPO).stdout)

    # Random intercepts: participants differ in how generous they are, pages
    # differ in how easy they are to score music for. Both are in the model, so
    # both must be in the simulation — otherwise the model is being tested on
    # data simpler than the data it will meet.
    p_intercept = {s["participantId"]: nprng.normal(0, 0.7) for s in sessions}
    pg_intercept = {p["id"]: nprng.normal(0, 0.5) for p in pages}
    p_comp = {s["participantId"]: nprng.normal(0, 0.5) for s in sessions}

    fit_base = {"SILENCE": None, "PLAYLIST": 3.4, "SHUFFLED": 3.8,
                "ADAPTIVE": 3.8 + TRUE_EFFECTS["fit_adaptive_over_shuffled"]}
    fit_base["PLAYLIST"] = fit_base["ADAPTIVE"] - TRUE_EFFECTS["fit_adaptive_over_playlist"]
    tlx_base = {"SILENCE": 42.0, "PLAYLIST": 48.0, "SHUFFLED": 47.0,
                "ADAPTIVE": 48.0 + TRUE_EFFECTS["tlx_adaptive_under_playlist"]}

    responses, blocks = [], []
    for s in sessions:
        pid = s["participantId"]
        for b in s["blocks"]:
            cond = b["condition"]
            for t in b["trials"]:
                # SILENCE has no music, so a fit rating for it is undefined —
                # not zero, not neutral. Recording it as null rather than as a
                # number keeps the H1/H2 contrasts from silently including a
                # condition they do not apply to.
                fit = None
                liking = None
                if cond != "SILENCE":
                    mu = fit_base[cond] + p_intercept[pid] + pg_intercept[t["pageId"]]
                    fit = int(np.clip(round(nprng.normal(mu, 1.1)), 1, 7))
                    liking = int(np.clip(round(nprng.normal(mu - 0.2, 1.2)), 1, 7))
                comp_mu = (2.6 + p_comp[pid]
                           + TRUE_EFFECTS["comprehension_adaptive_vs_silence"]
                           * (1 if cond == "ADAPTIVE" else 0))
                comprehension = int(np.clip(round(nprng.normal(comp_mu, 0.9)), 0, 4))
                responses.append({
                    "participant": pid, "condition": cond, "page": t["pageId"],
                    "block": b["blockIndex"], "fit": fit, "liking": liking,
                    "comprehension": comprehension,
                    "played_mood": t.get("playedMood"), "true_mood": t["trueMood"],
                    "shuffle_distance": t.get("shuffleDistance"),
                })
            blocks.append({
                "participant": pid, "condition": cond, "block": b["blockIndex"],
                "tlx": float(np.clip(nprng.normal(tlx_base[cond] + p_intercept[pid] * 3, 9), 0, 100)),
                "distraction": float(np.clip(nprng.normal(
                    3.6 if cond in ("PLAYLIST", "SHUFFLED") else 2.9, 1.0), 1, 7)),
                "turnoff_presses": int(nprng.poisson(
                    1.4 if cond in ("PLAYLIST", "SHUFFLED") else 0.6)),
            })

    return {"simulated": True, "seed": seed, "n_participants": n_participants,
            "true_effects": TRUE_EFFECTS, "responses": responses, "blocks": blocks,
            "sessions": [{"participantId": s["participantId"],
                          "conditionOrder": s["conditionOrder"],
                          "diagnostics": s["diagnostics"]} for s in sessions]}


# ── The models ────────────────────────────────────────────────────────────

def lmm(df: pd.DataFrame, outcome: str, ref: str = "SHUFFLED"):
    """Linear mixed model with a random intercept for participant.

    statsmodels' MixedLM supports one grouping factor, so page enters as a
    fixed effect rather than a second random intercept. That is a deliberate
    downgrade from the pre-registered `(1|participant) + (1|page)` and it is
    the reason models.R, not this file, is what the paper reports: this is a
    *check that the design is recoverable*, not the analysis.
    """
    import statsmodels.formula.api as smf

    d = df.dropna(subset=[outcome]).copy()
    # Only the levels actually observed. `fit` is undefined under SILENCE, so
    # after dropna that level has zero rows — leaving it in the categorical
    # produces an all-zero design column and the fit dies with a singular
    # matrix. The real study will hit this the first time it analyses fit.
    observed = [c for c in d["condition"].unique()]
    if ref not in observed:
        raise ValueError(f"reference level {ref!r} has no rows for outcome {outcome!r}")
    d["condition"] = pd.Categorical(
        [str(c) for c in d["condition"]],
        categories=[ref] + [str(c) for c in observed if str(c) != ref])
    formula = f"{outcome} ~ C(condition)"
    if "page" in d.columns and d["page"].notna().any() and d["page"].nunique() > 1:
        formula += " + C(page)"

    # `groups` must be integer codes. Passed the participant id column
    # directly, pandas 3.0 hands statsmodels an Arrow-backed string array and
    # MixedLM fails with "Singular matrix" from inside the optimiser — an error
    # that says nothing about its cause and looks like a badly specified model.
    # Factorising first makes every optimiser converge on identical estimates.
    groups = pd.factorize(d["participant"].astype(str))[0]
    return smf.mixedlm(formula, d, groups=groups).fit(reml=True)


def contrast(fit, condition: str, ref: str):
    key = next((k for k in fit.params.index if f"T.{condition}" in k), None)
    if key is None:
        return None
    return {"estimate": float(fit.params[key]), "se": float(fit.bse[key]),
            "z": float(fit.tvalues[key]), "p": float(fit.pvalues[key]),
            "ci95": [float(fit.conf_int().loc[key, 0]), float(fit.conf_int().loc[key, 1])],
            "contrast": f"{condition} - {ref}"}


def tost(diffs, bound: float, alpha: float = 0.05):
    """Two one-sided tests. H3 claims *equivalence*, and a non-significant
    t-test is not evidence of that — this is the test the claim needs."""
    from scipy import stats

    n = len(diffs)
    m, sd = float(np.mean(diffs)), float(np.std(diffs, ddof=1))
    se = sd / math.sqrt(n)
    t_lower = (m - (-bound)) / se
    t_upper = (m - bound) / se
    p_lower = 1 - stats.t.cdf(t_lower, n - 1)
    p_upper = stats.t.cdf(t_upper, n - 1)
    p = max(p_lower, p_upper)
    crit = stats.t.ppf(1 - alpha, n - 1)
    return {"n": n, "mean_difference": m, "sd": sd, "bound": bound,
            "p_tost": float(p), "equivalent": bool(p < alpha),
            "ci90": [m - crit * se, m + crit * se]}


def holm(pvalues: dict, alpha: float = 0.05):
    """Holm–Bonferroni within the confirmatory family."""
    items = sorted(pvalues.items(), key=lambda kv: kv[1])
    m = len(items)
    out, prev = {}, 0.0
    for i, (name, p) in enumerate(items):
        adj = max(prev, min(1.0, (m - i) * p))
        prev = adj
        out[name] = {"p_raw": p, "p_holm": adj, "reject": adj < alpha}
    return out


# ── Main ──────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=56)
    ap.add_argument("--seed", type=int, default=20260810)
    ap.add_argument("--out", default="analysis/out/s4_tidy.json")
    ap.add_argument("--keep", action="store_true",
                    help="leave the simulated tidy file in place instead of removing it")
    args = ap.parse_args()

    print(f"Simulating {args.n} participants under known effects:")
    for k, v in TRUE_EFFECTS.items():
        print(f"  {k:<42} {v:+.2f}")

    data = simulate(args.n, args.seed)
    responses = pd.DataFrame(data["responses"])
    blocks = pd.DataFrame(data["blocks"])

    out = REPO / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"\nWrote simulated tidy data to {out.relative_to(REPO)} "
          f"({len(responses)} responses, {len(blocks)} blocks)")

    print("\nFitting the confirmatory models …")
    checks, pvals = [], {}

    fit_model = lmm(responses, "fit", ref="SHUFFLED")
    h1 = contrast(fit_model, "ADAPTIVE", "SHUFFLED")
    pvals["H1 fit ADAPTIVE > SHUFFLED"] = h1["p"]
    checks.append(("H1  fit ADAPTIVE - SHUFFLED", h1["estimate"],
                   TRUE_EFFECTS["fit_adaptive_over_shuffled"], h1["ci95"]))

    fit_model_pl = lmm(responses, "fit", ref="PLAYLIST")
    h2 = contrast(fit_model_pl, "ADAPTIVE", "PLAYLIST")
    pvals["H2 fit ADAPTIVE > PLAYLIST"] = h2["p"]
    checks.append(("H2  fit ADAPTIVE - PLAYLIST", h2["estimate"],
                   TRUE_EFFECTS["fit_adaptive_over_playlist"], h2["ci95"]))

    # H3 — equivalence on comprehension, per participant.
    per_p = responses.pivot_table(index="participant", columns="condition",
                                  values="comprehension", aggfunc="mean")
    diffs = (per_p["ADAPTIVE"] - per_p["SILENCE"]).dropna().to_numpy()
    h3 = tost(diffs, bound=0.5)
    pvals["H3 comprehension equivalence"] = h3["p_tost"]
    checks.append(("H3  comprehension ADAPTIVE - SILENCE", h3["mean_difference"],
                   TRUE_EFFECTS["comprehension_adaptive_vs_silence"], h3["ci90"]))

    tlx_model = lmm(blocks, "tlx", ref="PLAYLIST")
    h4 = contrast(tlx_model, "ADAPTIVE", "PLAYLIST")
    pvals["H4 tlx ADAPTIVE < PLAYLIST"] = h4["p"]
    checks.append(("H4  TLX ADAPTIVE - PLAYLIST", h4["estimate"],
                   TRUE_EFFECTS["tlx_adaptive_under_playlist"], h4["ci95"]))

    print(f"\n{'hypothesis':<38} {'estimate':>9} {'planted':>9}  interval          recovered?")
    ok = True
    for name, est, truth, ci in checks:
        recovered = ci[0] <= truth <= ci[1]
        ok = ok and recovered
        print(f"{name:<38} {est:>9.3f} {truth:>9.3f}  "
              f"[{ci[0]:6.3f}, {ci[1]:6.3f}]  {'yes' if recovered else 'NO'}")

    corrected = holm(pvals)
    print(f"\nHolm correction within the confirmatory family (alpha = .05):")
    for name, r in corrected.items():
        print(f"  {name:<36} p={r['p_raw']:.2e}  p_holm={r['p_holm']:.2e}  "
              f"{'reject H0' if r['reject'] else 'retain H0'}")
    print(f"\nH3 equivalence (±0.5 questions): "
          f"{'EQUIVALENT' if h3['equivalent'] else 'not shown'} "
          f"(p_TOST = {h3['p_tost']:.4f}, 90% CI "
          f"[{h3['ci90'][0]:+.3f}, {h3['ci90'][1]:+.3f}])")

    # End-to-end: raw export -> figure.
    print("\nBuilding F7 and T4 from the simulated export …")
    r = subprocess.run([sys.executable, str(REPO / "analysis/build_all.py"),
                        "--only", "F7", "T4"],
                       capture_output=True, text=True, cwd=REPO,
                       env={**__import__("os").environ, "PYTHONIOENCODING": "utf-8"})
    built = "2 built" in r.stdout
    print("  " + "\n  ".join(l for l in r.stdout.splitlines()
                             if any(k in l for k in ("F7", "T4", "built"))))
    if not built:
        ok = False
        print(r.stdout[-2000:], r.stderr[-2000:], file=sys.stderr)

    if not args.keep:
        out.unlink(missing_ok=True)
        print(f"\nRemoved {out.relative_to(REPO)} — simulated data must not be left where a "
              f"real analysis would pick it up. Pass --keep if you want it.")

    print(f"\n{'PASSED — the pipeline recovers what it was given and runs end to end.' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
