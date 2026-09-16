# Web2Music — paper_2 (revised draft)

The 9-page draft from `paper/` (state of ~2026-09-06) with both review passes
applied. `paper/` is untouched and has since moved on independently; this
directory is a separate line.

```
main.tex              The paper. IEEEtran conference, 6 IEEE-template author blocks (one placeholder), 20 references.
main.pdf              Compiled with Tectonic 0.15 (XeTeX engine, Times via T1 fontenc): 8 pages;
                      Table I at the top of p.2 (declared inside the Introduction on p.1 so the
                      double-column float lands there), Fig. 1 on p.3.
Makefile              `make` (pdflatex x2), `make figures` (regenerate every figure), `make clean`.
figures/
  build_figures.py    f1, f2, f5, f6, f7 from the raw result files (no numbers typed in).
  build_system.py     Fig. 1 architecture as a numbered data flow (steps 1-9, four bands), with the
                      IndexedDB vector store and the Postgres cache index drawn where they are used.
  system.pdf/png      Fig. 1   f1: Fig. 2 timeline   f2: Fig. 3 duration scaling
  f5.pdf/png          Fig. 4 macro-F1 vs total off-device   f6: Fig. 5 loop quality   f7: Fig. 6 coverage
  cascade/featured/pipeline.*   Mermaid diagrams from the paper/ bundle, not used by main.tex.
  unused/             f3 (concurrency, cut) and the older matplotlib architecture sketch.
diagrams/             Mermaid sources + renderer (patched to read its own directory; needs mermaid10.js, gitignored).
source-tables/        Markdown tables emitted by analysis/build_all.py, as in paper/.
```

## Data provenance (every number in main.tex)

| Section | File |
|---|---|
| Extraction cost (Table III) | `data-extraction/benchmark/extraction-cost-results-fixed.json` |
| Generation latency (Table IV, Figs. 2-3, appendix Table X) | `audio-generation/results/d1-latency-full.json` |
| Client latency (Table V) | `data-extraction/results/e2e-latency-swap-full.json` |
| Tier ablation, A7 sweep (Table VI, Fig. 4) | `mood-classification/results/s2-ablation.json`; re-scored columns from the text of `paper/main.tex` (208-page majority) |
| Signal ablation (§V-D) | `mood-classification/results/s3-signals.json` + `experiments/s3_signal_ablation.js` |
| Loop quality (Table VII, Fig. 5) | `audio-generation/results/d2-loop.json` |
| Crossfade sweep, seam-minimising (appendix Table XI) | `audio-generation/results/d6-crossfade-loop-sweep.json` |
| Prompt ablation (Table VIII) | `audio-generation/results/d1-prompt-ablation-gpu.json` |
| Sensitive-content audit (Table IX) | `analysis/audit/sensitive_slice.json`, `analysis/out/audit.json` |
| Retrieval coverage (Fig. 6) | `analysis/out/baselines.json` (`analysis/baselines/retrieval_baseline.mjs`) |
| Cost model (§V-G) | `analysis/cost/cost_accounting.js` (numbers as in the earlier draft) |

## What changed against the two reviews

Figures: 6 (architecture rebuilt in three zones; timeline gains a timeout strip;
duration-scaling enlarged to two stacked panels with n per cell; F1-vs-disclosure
rebuilt as a scatter with LLM-only twins; loop figure annotated; new coverage
figure). The concurrency figure is cut to one sentence.

Tables: 9 in the main text (closest-systems table restructured to seven
comparison columns and nine systems; agreement gate column; extraction cost
condensed; latency by request class only; client latency without the stub row
and with the window row; tier table with total off-device and re-scored
columns; loop table with the worsened row; **new** prompt-ablation table;
**new** sensitive-detection audit table replacing the abridged policy list) and
3 in the appendix (server stages renumbered D1-D6, crossfade sweep, the 14
policies).

Corrections a reviewer would have caught next: the "139 s to generate a 28 s
clip" claim was wrong — the three completed generations were 10, 15 and 20 s
clips (82, 135, 203 s) and every 28 s cache miss timed out at 300 s; the four
non-English misses are a term-list vocabulary gap, not a language gate; the
10.2 vs 7.5 percent ablation gap is the reading-complexity term; the behaviour
and embedding ablation rows are zero by construction.

Deliberately kept as instructed: the "Sixth Author" placeholder (six authors
total, in the IEEE ordinal-superscript template form), and hardware left as the
Lenovo i7-1255U spec confirmed for the Aug 9-10 runs. The 2026-09-17 pass also
retitled the paper, removed the "tier 1 / 1.5 / 2" naming (now keyword / zero-shot
/ LLM stage), demoted prose run-in heads from bold to italic and dropped bold
from table bodies, shortened Table I, and de-duplicated the results section.

Still open: the GPU model for the prompt-ablation run is not recorded anywhere
in the repo and is stated as such in §V-A; the placeholder author block;
the four `@vitstudent.ac.in` addresses are unverified.
