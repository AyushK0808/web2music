# Web2Music paper — supplementary working notes

Companion to `main.tex`. Updated 2026-08-12 against repository commit `a492ec5`.

The paper itself carries **no draft markup**. Every hole, every preliminary
number and every citation that still needs checking is recorded here instead.
Work through Section 1 first; nothing else can be finalised until the metadata
and the human-subjects track are moving.

---

## 0. Provenance: which numbers in the paper are what

This is the most important table in this document. The paper states its caveats
in prose, but the mapping from claim to producing script lives here.

### Measured — a named script produced these from real input

| Paper location | Claim | n | Source file |
|---|---|---|---|
| Table I | Extraction cost, per stage | 105 sites | `data-extraction/benchmark/extraction-cost-results-fixed.json` |
| Table II, III | Generation latency by class and stage | 144 requests | `audio-generation/results/d1-latency-full.json` |
| Fig. 4, 5, 6 | Timeline, duration/RTF, concurrency | same run | `analysis/build_all.py` → `analysis/out/f1,f2,f3` |
| Table V, Fig. 7 | Seam, loudness, duration retention | 141 clips | `audio-generation/results/d2-loop.json` |
| §V-D | Token/byte/USD cost model | analytic + 18-page corpus | `analysis/out/cost.json` |
| Table VI, §V-G | Restraint audit, FN 0.455 / FP 0.333 | 20-page slice | `analysis/out/audit.json` |
| Table VII | Retrieval coverage of the 1925-cell space | analytic | `analysis/out/baselines.json` |
| §V-A | Corpus composition, 260 pages, 7 slices | 260 pages | `analysis/corpus/s2_corpus.json` |

### Preliminary — in the paper, but flagged in the text as not a result

| Paper location | What it actually is | Must be replaced by |
|---|---|---|
| Table IV (tier ablation) | 18-page development subset, **one annotator**, no agreement coefficient, no human ceiling | §3 + §4.1 below |
| §V-D escalation rate (0.222) | Same 18-page subset; the *unit* costs are model properties and do survive, the *rate* does not | §3 |

### Excluded — built, but kept out of the paper entirely

| Artefact | Why it is not in the paper |
|---|---|
| T3, loop AB detection rate | Built from **simulated listeners**. The numbers are what the simulator was told to emit. Zero information about human perception. |
| T4 / F7, comprehension, TLX, fit ratings | Built from a **synthetic** four-condition session. No participant has ever run this study. |
| F8, in-the-wild telemetry | Built from **one synthetic** telemetry export. |
| F4 / F5, confusion matrix and exposure sweep | Blocked by the build driver: the annotated corpus does not exist. |

`analysis/build_all.py` currently reports **7 of 13** artefacts built and 6
blocked. The blocked six are exactly the user study, the deployment, and
everything downstream of corpus annotation.

---

## 1. Metadata — trivial, do first

| # | Item | Where |
|---|---|---|
| 1.1 | **Sixth author's name.** The paper currently reads "Sixth Author". Five names were supplied (Ayush Kumar, Sneha, Vedant, Tvisha, Pari); the sixth block is a placeholder. | author block |
| 1.2 | **Surnames** for Sneha, Vedant, Tvisha and Pari. | author block |
| 1.3 | **Real email addresses.** Five of the six are placeholder `firstname@vitstudent.ac.in` patterns — these are *not* real addresses and must be replaced. Only Ayush Kumar's is real. | author block |
| 1.4 | ORCIDs, if the venue wants them. | author block |
| 1.5 | Confirm SCOPE is the correct school for all six authors, and whether any author sits in a different VIT school. | affiliation lines |
| 1.6 | Funding footnote, or delete `\IEEEoverridecommandlockouts`. | preamble |
| 1.7 | Target venue and its page limit. The draft runs to roughly 10–11 pages of IEEEtran two-column with seven figures and seven tables. If the limit is 6 or 8 pages, see §7 below for the cut order. | — |
| 1.8 | **Anonymisation.** The paper is *not* anonymised. If the venue is double-blind, the author block and the real email deanonymise it immediately. | author block |

---

## 2. Human-subjects work — the long pole

| # | Item | Blocks |
|---|---|---|
| 2.1 | **Institutional ethics / IRB submission.** Longest latency item in the whole project. Start before anything else here. | everything in §2 |
| 2.2 | Pre-registration (OSF or AsPredicted) of the confirmatory family. Needs pilot effect sizes, so it is downstream of 2.6. | study validity |
| 2.3 | **Run S4.** N=56, within-subjects, four conditions (SILENCE / PLAYLIST / SHUFFLED / ADAPTIVE), Latin-square counterbalanced. SHUFFLED is non-negotiable: it is the only condition that makes the paper's central perceptual claim falsifiable. | the untested claim in §VI |
| 2.4 | **Run the loop AB test** with ~30 real listeners. Harness, 22 seeded stimulus pairs and scoring script all exist and are validated. | the open question in §V-F |
| 2.5 | **Run S5**, the in-the-wild deployment: 12–15 participants, 2 weeks, own browsing, telemetry export plus a daily one-question diary. | cache-hit-rate regime in §V-D |
| 2.6 | Pilot S4 with n=6 before committing to 56 sessions. | 2.3 |
| 2.7 | Human-ceiling baseline: a musically literate person picks a track for each of 20 pages. Cheap, and bounds the gap. | §V-I |

**Do not run any study on participants until item 6.1 is fixed.** The paper
states this in §VII and it is a real gate, not a formality.

---

## 3. Corpus and annotation

| # | Item |
|---|---|
| 3.1 | **Annotate the 260-page corpus.** Three independent annotators; per page: content category (13-way), mood (11-way), sensitive (binary). The annotation tool is `analysis/annotate/`. |
| 3.2 | **Krippendorff's α** per label set with bootstrap CI. Treat α ≥ .667 as the minimum for drawing conclusions, ≥ .80 as good. `analysis/krippendorff.py` is written and has never been run on real data. |
| 3.3 | **Human ceiling** (leave-one-out annotator accuracy). The paper commits in §VII to never printing a classifier accuracy without this beside it — honour that. |
| 3.4 | Decide whether 260 pages suffices. The original plan specified 600 (~45 per category). 260 gives ~20 per category and a 12-page sensitive slice, which is thin for per-category F1. Either capture the remaining pages or restate and justify the target. |
| 3.5 | Ensure annotators see the preference framing — *"which of these 11 moods would you least object to hearing while reading this page"* — not "what mood is this page". The paper's construct-validity argument in §VII depends on it. |

---

## 4. Experiments to run or re-run

| # | Item | Fixes what |
|---|---|---|
| 4.1 | **Rebuild the tier ablation** against the annotated corpus. Table IV is currently 18 pages and one annotator. | §V-E, Table IV |
| 4.2 | **Run the A7 threshold sweep** (`minScore` × `minMargin`) to produce the accuracy-vs-exposure curve. This is the primary quantitative evidence for claim C2 and it does not exist in any form. It is the most valuable single missing artefact in the paper. | §V-E, gap G3 |
| 4.3 | **End-to-end in-browser latency run** (`ui/e2e/latency.e2e.mjs`). Fig. 4 currently has no client-side segments, so navigation-to-audible is asserted server-side only. | Fig. 4 |
| 4.4 | **Cold-cache re-run.** No cache-miss column exists, and the concurrency sweep (Fig. 6) is 100% cache hits — it measures the request path, not generator batching, and the caption says so. | Table II, Fig. 6 |
| 4.5 | **GPU configuration.** Every latency number is one CPU laptop. | §V-C, §VII |
| 4.6 | **Extraction re-run with the real MiniLM backend.** The published run stubs the embedding, so Table I's total is "everything except the embedding". | Table I |
| 4.7 | Widen the generation sample beyond n=3. | Table II, III |
| 4.8 | Expand the adversarial sensitive slice well past n=20 — at that size one page moves the false-negative rate by 9 points. Rebalance across euphemism, non-English and outside-vocabulary cases. | §V-G |
| 4.9 | Recompute cost against the real corpus, and re-check the tier-2 provider's published pricing before submission; the USD figure moves linearly with it. | §V-D |

### Ablations not yet run — a reviewer will ask

| # | Item | Effort |
|---|---|---|
| 4.10 | **Signal ablation**: re-run classification with each Feature A signal removed in turn (text-only, −colour, −behaviour, −embedding). The paper claims a four-signal descriptor; nothing currently demonstrates that colour and behaviour earn their place. `runB1`/`runB2` already accept partial descriptors. | low |
| 4.11 | **Crossfade-window sweep**: 50 / 100 / 250 / 500 ms against the seam metric. Turns the bare negative result in §V-F into a characterised one. One-line change plus one re-run. | low |
| 4.12 | **Loop-point selection that minimises measured seam** rather than maximising chroma self-similarity. | medium |
| 4.13 | **Prompt ablation**: engineered prompt vs the service's fallback prompt vs a bare mood word. `d1_prompt_ablation.py` is an empty stub. | medium |
| 4.14 | **Clip-length study**: 5/10/15/20/28 s against loop quality and latency. Only the 28 s cell currently has real n. | medium |

---

## 5. Defects this evaluation surfaced — fix before deployment

| # | Item | Severity |
|---|---|---|
| 5.1 | **Sensitive-content detector: FN 0.455, FP 0.333.** A keyword list is not a detector. Misses addiction, miscarriage and terminal illness (outside the term list), euphemism, and all non-English. Wrongly silences grief-counselling degree programmes, a psychology textbook, and an engineering article containing "trauma". The entailment tier is already loaded and can score a sensitivity hypothesis at near-zero marginal cost. **Blocks all participant-facing work.** | high, ethical |
| 5.2 | **2-second cache check.** `d5_cache_check` p50 is 2082 ms against local PostgreSQL and dominates every cache-hit response. Almost certainly connection establishment or event-loop blocking rather than query time. Largest addressable inefficiency in the system. | high |
| 5.3 | **8.3% of requests hit the 300 s client timeout** on CPU. Either the timeout, the CPU deployment story, or both need revisiting. | medium |
| 5.4 | **50% duration loss.** Delivered clips retain a median 50.3% of requested duration. Doubles the effective cost per second of delivered audio and doubles seam exposure. | medium |
| 5.5 | **Language gate causes two separate failures**: non-English pages skip tier 1 by construction *and* evade the sensitive detector. Same root cause, two consequences. | medium |
| 5.6 | One clip in an earlier run fell back to the minimum loop length (2958 ms against a 28000 ms target). Check whether that profile genuinely has no self-similar region or whether the loop detector has a bug. | low |

---

## 6. Citations to verify

The bibliography has 41 entries. Most are standard and safe. These need a
check against the actual source before submission — the team's own resource
list supplied a link or a DOI but not full metadata, and the entries were
completed from the identifier:

| Key | Issue |
|---|---|
| `affectmachine` | arXiv:2506.08200 — **author list missing entirely.** Fill from the arXiv page. |
| `multimodalmood` | "Multi-modal Song Mood Detection with Deep Learning" — authors and venue unverified; the entry currently guesses CSMC 2020. Verify or replace. |
| `dominantcolour` | Only an IEEE Xplore document number (9869653) was supplied. **Title and authors are not verified** — the current entry is a descriptive placeholder title. Must be corrected. |
| `cursorcikm` | DOI 10.1145/2661829.2661909 (CIKM 2014). Title and author list inferred; verify. |
| `boilerplate` | The team's resource list gave DOI 10.1145/1741906.1741954, which is a *different* WSDM 2010 paper from the Kohlschütter one cited. Check which paper the implementation actually follows and cite that one. |
| `arapakis` | Verify against DOI 10.1145/2911451.2911505. |
| `stableaudio` | Verify venue (ICML 2024) and author list. |
| `nliprompts` | Verify venue — COLING 2022 vs an alternative. |
| `ebu128` | Confirm the current revision year of EBU R 128. |

Optional additions if reviewers push on specific points: a citation for
Transformers.js / ONNX Runtime if the venue expects tool citations; NASA-TLX
(Hart & Staveland 1988) and an equivalence-testing reference (Lakens 2017) once
the user study runs and §VIII's analysis plan moves into the results.

---

## 7. Figures and tables — current state

**In the paper.** Seven figures, seven tables.

| # | Content | Backed by | File |
|---|---|---|---|
| Fig. 1 | Process topology, three handoffs | architecture | `figures/pipeline.pdf` |
| Fig. 2 | Three-tier cascade | architecture | `figures/cascade.pdf` |
| Fig. 3 | Feature D and loop synthesis | architecture | `figures/featured.pdf` |
| Fig. 4 | Timeline, nav → first sound → swap | real, server-side only | `figures/f1.pdf` |
| Fig. 5 | Generation latency vs duration + RTF | real, 3 of 5 cells | `figures/f2.pdf` |
| Fig. 6 | Speedup vs concurrency | real, all cache hits | `figures/f3.pdf` |
| Fig. 7 | Seam pre/post crossfade + duration retention | real, n=141 | `figures/f6.pdf` |
| Table I | Extraction cost | 105 sites | — |
| Table II | Latency by request class | 144 requests | — |
| Table III | Server stage times | same | — |
| Table IV | Tier ablation | **18 pages, preliminary** | — |
| Table V | Loop quality | 141 clips | — |
| Table VI | Restraint audit | 14 policies + 20-page slice | — |
| Table VII | Retrieval coverage | analytic | — |

**Cut order if the page limit bites:** Fig. 6 first (it is engineering detail
and its caption already disclaims what it measures), then Fig. 5, then Table
III. Do not cut Fig. 2 or Table VII — they carry gaps G3 and G2 respectively.

**Waiting to be added** once their studies run: confusion matrix, the
accuracy-vs-exposure sweep, fit ratings by condition, the workload table, the
loop-AB detection table, and the in-the-wild figure.

### Regenerating

Matplotlib figures, from the repo root:

```
python analysis/build_all.py
```

Mermaid architecture diagrams, from `paper/diagrams/`:

```
node render_mermaid.mjs ../figures
```

This renders each `.mmd` to a **vector PDF** (via the repo's existing
Playwright Chromium printing to PDF) plus a 3× PNG preview. It needs
`mermaid10.js` in the same directory — a mermaid 10.x UMD bundle, downloadable
from any CDN mirror; it is not committed because of its size.

Two things to know if you edit the diagrams. Font sizes must be set through
mermaid's own config, never through post-hoc CSS: mermaid measures label boxes
at render time, so enlarging text afterwards silently clips cluster titles.
And a `subgraph` whose nodes have edges crossing the cluster boundary will
have its internal `direction` ignored, which is why the topology diagram uses
a dashed node border rather than a cluster to mark the network boundary.

---

## 8. Writing tasks left

- **§V-E will need rewriting from scratch**, not patching, once the corpus is
  annotated and the sweep is run. The current narrative — that the full cascade
  is *less* accurate than the design it replaced — may reverse entirely at a
  real sample size.
- **§VI's closing paragraph** states the perceptual claim is untested. When S4
  lands, that paragraph and the corresponding limitation in §VII both change.
- **§VIII's first item** becomes results rather than future scope once the
  studies run; the analysis plan currently sitting there moves into §V.
- The paper currently leads with a systems framing, which suits an IEEE venue.
  If it is later retargeted at an interaction venue, the introduction and the
  contributions list need reordering to lead with the conditioning claim rather
  than the latency and disclosure results.
- Consider whether §III's five-gap structure is too long for the page budget;
  G1 and G5 could compress into a single paragraph if space is tight.

---

## 9. Housekeeping

- **`main.tex` has not been compiled.** No LaTeX toolchain was available in the
  authoring environment. It has been validated structurally — environments
  balanced, no undefined references or citations, all seven `\includegraphics`
  targets present — but expect to fix something on the first real build.
- `make` builds it; `make clean` removes the artefacts.
- `audio-generation/research_log.md` should gain a dated entry for every run in
  §4: command line, git SHA, hardware, output path.
- The figure style change made for this draft (`analysis/figures/_common.py`:
  base font 8 → 9.5 pt, savefig DPI 300 → 400) is committed to the repo, so
  regenerating reproduces the figures as they appear in the paper.
