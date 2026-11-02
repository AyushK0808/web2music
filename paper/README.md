# Web2Music — paper

*Web2Music: Page-Conditioned Music Generation with a Disclosure-Aware
Classifier Cascade.* IEEEtran conference, 7 authors, 28 references.

```
main.tex            The paper.
main.pdf            Built from main.tex.
SUPPLEMENTARY.md    Provenance notes from the earlier, longer draft.
Makefile            `make` to build, `make clean`.
figures/            Figures used by main.tex, plus those of the earlier draft.
diagrams/           Mermaid sources for the earlier draft's architecture diagrams.
source-tables/      Markdown tables emitted by analysis/build_all.py.
```

## Sections

Introduction · Related Work · Research Gaps and Problem Statement ·
System Architecture · Results and Discussion · Conclusion ·
Limitations and Future Work · References

## Building

```
make          # pdflatex x2 -> main.pdf
make clean
```

## Figures

| Fig. | File | Source |
|---|---|---|
| 1 | `figures/architecture.png` | Architecture diagram (raster) |
| 2 | `figures/frontier.pdf` | `analysis/figures/f10_disclosure_frontier.py` ← `mood-classification/results/s2-ablation-a6-full.json` |
| 3 | `figures/coldgen.pdf` | `analysis/figures/f11_cold_generation.py` ← `audio-generation/results/d1-latency-full.json`, `d4-cold-rerun.json` |
| 4 | `figures/seamcdf.pdf` | `analysis/figures/f12_seam_cdf.py` ← `audio-generation/results/d6-crossfade-loop-sweep-n141.json` |

Regenerate Figs. 2–4 from the repo root (they need matplotlib):

```
python -m analysis.figures.f10_disclosure_frontier
python -m analysis.figures.f11_cold_generation
python -m analysis.figures.f12_seam_cdf
```

Fig. 2's local-gate frontier is replayed from the stored per-page tier outputs
with the same decision order as `simulateCascade` in
`mood-classification/experiments/s2_tier_ablation.js`; it reproduces A6b
(.689 macro-F1, .467 off-device), the 0.30 gate (.675, .290) and the open gate
(.594, 0).

## Revision placeholders

During the CICT-2026 revision, `main.tex` contains `	bd{study: value}` (bold red) wherever a number is owed by a study
that has not been run yet; the text names the study (S-A…S-I) and the value. `python analysis/numbers_diff.py` fails while any
remain, and also fails for any number printed in the paper that is not registered in `paper/numbers.json` against a result file.
See `RUN_COMMANDS.md` for how each placeholder is produced. A PDF built with placeholders in it is not committed.
