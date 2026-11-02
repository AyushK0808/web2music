# Web2Music — CICT-2026 Revision Plan

**Status:** planning artefact for the minor revision. Covers every reviewer
comment (R3, R4), the studies to re-run, the code changes they need, the paper
edits and the response letter.
**Decision:** Both reviewers recommend *accept after minor revision*.
**Constraints:**
* **No human listening test** can be run in the revision window. All
  perception claims are narrowed. Objective proxies are added in their place
  (§4, S-D′).
* **Hardware:** one machine with an RTX 5060 (8 GB VRAM) and 24 GB RAM. The
  existing Apple M4 and i7-1255U CPU numbers are kept as further hardware
  tiers.
* **Annotators stay the authors.** Independent annotation is out of scope.
  Instead, the revision adds **more data**: a larger corpus with a held-out
  test split, a larger sensitive set, more clips and more seeds (§5, S-E).
  Author labelling is made blind and is acknowledged as a limitation.

**Rule carried over from the results plan:** no claim in the paper may rest on
a number that no script produces. Every new number below names the script that
emits it.

---

## 0. Status tags

| Tag | Meaning |
|---|---|
| `EXISTS` | Script exists and only needs re-running with new settings. |
| `EXTEND` | Script exists but needs a flag or option added. |
| `NEW` | Script has to be written. |
| `HUMAN` | Depends on people outside the author team (annotators). |
| `TEXT` | Paper edit only. |

---

## 1. Comment → change map

### Reviewer 3

| # | Comment | Response | Work |
|---|---|---|---|
| W1 / R1 | Fit to the page is never evaluated with listeners | **Narrow the claim.** Remove all "music suits the page" wording. Add objective conditioning-fidelity proxies (matched vs shuffled). Release the listening protocol for future work. | S-D′, P-1, P-9 |
| W2 / R2 | "36 ms" is the fallback clip; users mostly hear fallback | Measure generation on the GPU tier. Run a duration sweep. Simulate the share of visits and listening time that hear fallback, cached or fresh audio. Restate the claim as three levels of conditioning. | S-B, S-C, P-1, P-6 |
| W3 / R3 | Labels come from the authors; α below threshold; mood α = 0.195 | **Partly addressed.** Annotators stay the authors, but labelling becomes blind with frozen guidelines. Grow the corpus about 2.3× and add a held-out test split. Report α on the test split. Drop mood as an evaluated target. State author labelling as a limitation. | S-E, P-5, P-7, P-11 |
| W4 | Headline latencies come from stubbed benchmarks | Measure end to end with real embedding, classifier and generator, n ≥ 100 per setting. | S-A, P-6 |
| R4 | Garbled sentences; "bart-large-mini"; dense notation | Rewrite the abstract, Intro, §III-A and §III-B. Fix the model name (Word draft). Simplify notation. | P-1…P-4, P-12 |

### Reviewer 4

| # | Comment | Response | Work |
|---|---|---|---|
| 1 | Independent held-out corpus and annotators; tune thresholds on a separate set | **Held-out corpus and separate tuning: yes.** Use the existing 255 pages as **dev** and ~350 new pages as **test**, never used for tuning. **Independent annotators: no.** Mitigate with blind labelling and say so in the letter. | S-E |
| 2 | Listening study (forced choice, Likert) for fit and gapless loops | Not possible. Verify **gapless** playback objectively and report seam size relative to each clip's own variation. Add fit proxies. Say this plainly in the letter. | S-D′, S-I |
| 3 | Improve and re-measure the sensitive detector, including the on-device entailment model | Use a 3-way hypothesis with "unrelated". Run the on-device back end. Add a black-box test set and a large benign set. | S-F, C-2 |
| 4 | Real end-to-end latency, enough runs for p95, CPU-only case | Same as R3 W4, plus a CPU-only discussion. | S-A, S-B, P-6 |
| 5 | Seeds and intervals for prompt and loop studies; compare at least one other generator | Use fixed seed lists, paired tests and bootstrap CIs. Add AudioLDM2-music (or Stable Audio Open Small) and MusicGen-medium. | S-G, C-4, C-5 |
| 6 | Rewrite the abstract and intro; define terms; release code and data | Text pass plus a Zenodo release. | P-1, P-2, P-12, R-1 |
| 7 | Mathematical modelling, annotation reliability, privacy validation, perception, clarity | Add 4 numbered equations explained in words. Run a network-level privacy audit. Fix URL hashing. | P-3, S-H, C-3 |
| W | Limited comparisons with alternative approaches | Add a generator comparison. The cascade already has 7 baselines; point to them explicitly. | S-G, P-8 |

---

## 2. Work package overview

| WP | Content | Depends on | Effort |
|---|---|---|---|
| WP0 | Environment and freeze | — | 1 day |
| WP1 | Code changes (C-1…C-8) | WP0 | 3–4 days |
| WP2 | Studies (S-A…S-I) | WP1 | ~2 weeks, mostly overnight GPU runs |
| WP3 | Corpus expansion and author annotation (S-E) | freeze tag | ~2 weeks elapsed (critical path: about 350 pages × 3 authors) |
| WP4 | Paper edits (P-1…P-12) | WP2, WP3 | 1 week |
| WP5 | Release (R-1) | WP4 | 1 day |
| WP6 | Response letter | WP4 | 1 day |

---

## 3. WP0 — Environment and freeze

| ID | Task | Detail |
|---|---|---|
| E-1 | Install PyTorch for Blackwell | The RTX 5060 is `sm_120` and needs **torch ≥ 2.7, cu128** wheels. Check that `torch.cuda.get_device_capability() == (12, 0)`. |
| E-2 | Pick a runtime for the generation service | Use WSL2 (or [docker/feature-d.gpu.Dockerfile](docker/feature-d.gpu.Dockerfile)). Native Windows usually can't run `torch.compile`/Triton, and Essentia (S-D′) has no Windows wheels. |
| E-3 | Guard `torch.compile` | [d3_generate.py:32](audio-generation/d3_generate.py#L32) compiles whenever CUDA is present. Put it behind an env flag (`W2M_COMPILE`). Use one setting for every timing run and record it. |
| E-4 | Hardware manifest | Write GPU SKU, driver, CUDA, torch, precision (fp16 on CUDA, fp32 on MPS/CPU), power mode, and laptop vs desktop into every result JSON header. |
| E-5 | Timing hygiene | Plugged in, performance power plan, nothing else on the GPU, warm-up discarded. Don't run CLAP or Essentia while timing. |
| E-6 | **Freeze tag** `revision-freeze` | Tag the pipeline after C-1…C-3 land and before the held-out corpus is collected. All test-set numbers come from this tag. |

---

## 4. WP1 — Code changes

| ID | Change | Where | Why |
|---|---|---|---|
| C-1 | Make A6b (local zero-shot middle stage) and the measured-seam selector the **defaults** | `feature_b` config; `d4_process.py` | The paper's headline numbers describe these settings. The evaluated system and the shipped system must be the same. (Already listed as future work item 1.) |
| C-2 | Add a third "unrelated / everyday content" hypothesis to the sensitivity check and parse it 3-way | [b1_zeroShotCategory.js:346](mood-classification/feature_b/b1_zeroShotCategory.js#L346), `parseSensitivityResult` | Fixes the over-triggering found in the restraint study. Recalibrate `DEFAULT_SENSITIVITY_MIN_SCORE/MARGIN` on the **white-box dev slice only**. |
| C-3 | Replace plain SHA-256 URL hashes with an HMAC keyed by a random per-install secret | [telemetry.js:18](ui/src/telemetry.js#L18) | Plain hashes of URLs can be reversed with a dictionary attack (R4 privacy validation). |
| C-4 | Generator back-end switch (`W2M_MODEL`): `musicgen-small` (default), `musicgen-medium`, `audioldm2-music` (diffusers), optionally `stable-audio-open-small` | [d3_generate.py:23-30](audio-generation/d3_generate.py#L23-L30) | R4 #5. AudioLDM2 is a different model family (latent diffusion) and runs through diffusers in fp16 within 8 GB. MusicGen-medium shows the effect of scale. |
| C-5 | Fixed seed lists in the prompt and loop experiments, sent via `seed_override` | [d1_prompt_ablation.py](audio-generation/experiments/d1_prompt_ablation.py), [d6_full_141.py](audio-generation/experiments/d6_full_141.py) | R4 #5. Seeds go into the result JSON and the paper. |
| C-6 | Real-pipeline mode for the end-to-end harness: `--real-classify` (sets `stubLlm: false`), `--d-url` (real Feature D instead of the stub), and logging of the swap time (navigation → generated audio) | [latency.e2e.mjs:406](ui/e2e/latency.e2e.mjs#L406), [harnessServer.mjs:149](ui/e2e/harnessServer.mjs#L149) | R3 W4, R4 #4. |
| C-7 | Network audit harness: record every request from the service worker, offscreen document and content scripts over CDP, then classify request bodies as "contains page text" or "profile only" | `NEW` `ui/e2e/networkAudit.e2e.mjs` | S-H. |
| C-8 | Output recorder: capture the offscreen player's output over N loop cycles | `NEW` `ui/e2e/gapless.e2e.mjs` | S-I. |
| C-9 | Annotation export allowlist (`id, url, title, text` only), plus a test that fails if any prediction, tier or `true_category` field reaches the tool | `NEW` `analysis/annotate/export_for_annotation.mjs` + test | L-1. |
| C-10 | LLM response cache keyed by (model, prompt hash, page hash). Replays and ablations read from the cache. Raw responses go into the release. | `feature_b` LLM call sites, replay harness | L-5. |

---

## 5. WP2 — Studies

Each study lists its design, sample size, output file and where it lands in
the paper. "Overnight" means one unattended GPU run.

### S-A. Real end-to-end latency `EXTEND`
* **Setups:** {A6 fully local, A6b} × {5060 generation, CPU-only generation} × {cold cache, warm cache}.
* **Load:** 11 fixtures × 10 repeats = **110 loads per setup**, plus 30 live sites × 3 from [liveSites.js](ui/e2e/liveSites.js).
* **Report:** p50 and p95 (nearest rank, 10k bootstrap CI) for:
  * navigation → first extraction
  * navigation → mood commit
  * commit → fallback audible
  * **navigation → generated audio audible**
* **Embedding cost:** re-run [extractionCost.js](data-extraction/benchmark/extractionCost.js) with `--real-embedding` on the 105 sites. This replaces "86 ms excluding embedding".
* **Output:** `data-extraction/results/e2e-latency-real-*.json`, `extraction-cost-real-embedding.json`.
* **Lands in:** latency table, abstract, §IV descriptor cost.

### S-B. Generation latency by duration and hardware `EXISTS`
* Run `d4_latency.py --sections duration` on the 5060 for 8, 10, 15, 20 and 28 s clips. Use n ≥ 30 per duration, spread over all 11 moods. Then run `--sections concurrency` (1, 2, 4, 8).
* Repeat the duration sweep CPU-only on the same machine with n ≥ 10 at 10 and 15 s. Treat timeouts as **censored**, not missing, and report them as "> 300 s, k of n".
* Run `d3_clip_length.py` on the 5060 to show the trade-off between requested duration, loop period and seam quality. Delivered loops keep about 50% of the request, so a 15 s request may be enough.
* **Output:** `audio-generation/results/d4-duration-5060.json`, `d4-duration-cpu2.json`, `d3-clip-length-5060.json`.
* **Lands in:** latency table, cold-generation figure, §IV-latency text.

### S-C. Generated-audio exposure `NEW`
This answers R3's second point directly.
* **Script:** `analysis/exposure/simulate_exposure.py`.
* **Model:**
  * Sessions of page visits.
  * Mood transitions follow a Markov chain fitted to corpus mood labels.
  * Dwell times follow a Weibull distribution. Use parameters from published dwell-time studies (e.g. Liu, White & Dumais, SIGIR 2010), with a sensitivity sweep over the median.
  * Generation time is drawn from the measured S-B distributions for each hardware tier and duration.
  * One worker. The 5 s confidence window applies. Generation is cancelled on a mood change. The pre-warm grid has 99 entries, and the cache fills as the session runs.
* **Three levels of conditioning:**
  * L1 mood-level fallback (11 clips)
  * L2 profile-level cache hit (pre-warm grid or an earlier generation in the same bucket)
  * L3 page-level fresh generation
* **Report:**
  * share of **visits** and of **listening seconds** at each level, per {CPU, M4, 5060} × {10, 15, 28 s}
  * a curve of P(L3 heard) against median dwell time
  * a result stratified by page category (long-form reading against everything else)
* **Lands in:** a new results subsection and figure, the abstract (one sentence), and the restated claim (P-1).

### S-D′. Conditioning-fidelity proxies (replaces the listening study) `NEW`
* **Script:** `analysis/proxies/score_fit.py`.
* **Stimuli:**
  * All non-sensitive dev and test pages (~500) × 3 seeds, generated on the 5060.
  * **Shuffled control:** a clip from a page ≥ 2 steps away in valence–arousal space, using the same rule as [assignment.mjs](analysis/s4/assignment.mjs).
  * **Fixed-prompt control:** one page-agnostic prompt.
  * About 1,500 matched clips. Shuffled controls reuse other pages' clips, so they cost no extra generation. At 15 s per request this is about two overnight runs.
* **Proxies:**
  1. **Valence/arousal agreement:** Essentia valence/arousal regressors (DEAM / emoMusic heads on MusiCNN embeddings). Report the Spearman correlation between the profile's target valence/arousal and the predicted values, and the paired distance for matched vs shuffled.
  2. **Mood tags:** the Essentia MTG-Jamendo mood/theme tagger. Report top-k agreement with the intended mood.
  3. **CLAP retrieval:** the LAION-CLAP music checkpoint. Rank a page's own clip among 10 candidates using the page's title and lead text (chance = 10% top-1). Also report paired page-text↔audio similarity, matched vs shuffled.
  4. **Quality:** Audiobox Aesthetics scores per clip, and FAD against a fixed reference set (name the embedding model). Compare generated clips, fallback clips and the generators from S-G.
* **Statistics:** paired Wilcoxon on matched − shuffled, bootstrap CIs, and a mixed model with random effects for page and seed.
* **Wording rule:** call these "conditioning fidelity", never "perceived fit".
* **Caveats to state:**
  * CLAP's training domain is music captions, not web pages.
  * Prompt-vs-audio CLAP only measures whether the generator follows the prompt. That's why page-text-vs-audio is the main measure.
* **Lands in:** a new results subsection and table.

### S-E. Corpus expansion and held-out test set (author-labelled)
Annotators stay the three authors. The gain comes from more data, a clean
dev/test split and less biased labelling.

**More data**
* **Test set:** ~350 new pages captured with [capture_corpus.mjs](analysis/corpus/capture_corpus.mjs) **after** the `revision-freeze` tag. The total becomes ~600 pages, the original target in [RESULTS_AND_DISCUSSION_PLAN.md](RESULTS_AND_DISCUSSION_PLAN.md).
* **Stratification:** at least 20 pages per category (13 categories, so at least 260), plus the adversarial slices (vocabulary mismatch, non-English, mixed-genre, near-miss, bypass) in the original proportions.
* **Sources:** cap Wikipedia at ≤ 25% (see [_nonwiki.jsonl](analysis/corpus/_nonwiki.jsonl)). Draw the rest from news, blogs, forums, docs, shops, recipes and government sites. **No URLs suggested by an LLM** (L-3): every URL records its `source` and `query`. Choose URLs **before** running any classifier on them, then freeze the URL list in `urls-test.jsonl` with a commit hash.
* **Contamination slice (L-6):** record a publication date per page. At least 80 pages must be published after the LLM's knowledge cutoff.
* **Sensitive pages:** the test set includes ~50 real crisis and support pages, which double as the S-F black-box set.
* **Dev set:** the existing 255 pages, unchanged. All tuning happens here.

**Making author labelling less biased**
* **Blind labelling:** in [annotate/index.html](analysis/annotate/index.html), hide the "collected-for" category, the cascade predictions and other authors' labels. Shuffle page order per annotator.
* **Frozen guidelines:** write and commit the guidelines **before** labelling the test set. Include one-line definitions per category and tie-break rules for mixed pages. Run a 20-page calibration round on dev pages, discuss, update the guidelines, then freeze them.
* **Labels:** category and binary sensitivity only. **No mood labels.**
* **Gold label:** the majority of three. Ties go to an adjudication pass, and that count is reported. The "collected-for" label serves only as a check (report the agreement rate, as now).

**Analysis**
* **Tuning:** adapt [item44_threshold_sweep.mjs](analysis/item44_threshold_sweep.mjs) to choose gate thresholds on dev, then score A1–A6b **once** on test. State which thresholds were fixed before any corpus existed (0.5 keyword, 0.45/0.10 zero-shot).
* **Report:**
  * α for category and sensitivity on test, with bootstrap CIs, next to the dev α (did the guidelines raise it above 0.667?)
  * macro-F1 with bootstrap CIs on test (expect about ±0.05 at n ≈ 350)
  * paired differences between configurations
  * per-category F1 for categories with ≥ 20 pages
  * accuracy split by deciding stage (L-8), and macro-F1 on the post-cutoff subset (L-6)
  * the frontier figure redrawn with dev-chosen gates evaluated on test
* **Lands in:** cascade table, frontier figure, annotation subsection.

**Effort:** about 350 pages × 3 authors at roughly 1 minute each comes to about 6 hours per person. Spread it over a week.

### More data for the other studies
| Study | Before | After |
|---|---|---|
| S-A live sites (descriptor cost) | 105 | ~200 (extend [top-sites.txt](data-extraction/benchmark/top-sites.txt)) |
| S-A end-to-end loads per setup | 55 | 110 fixture + 90 live |
| S-B cold generations | 140 (M4) | ≥ 150 on the 5060 + ≥ 20 CPU |
| S-D′ pages for fidelity proxies | — | all ~500 non-sensitive pages from dev + test, × 3 seeds |
| S-F sensitive / benign | 29 / 18 | 29 white-box + ~50 black-box / ~500 benign |
| S-G loop study clips | 113 | 220 (11 moods × 20 seeds) |
| S-G prompt ablation | 15 per prompt | 55 per prompt (11 moods × 5 seeds) |

### S-F. Sensitive detector re-measurement `EXTEND`
* **Detectors:**
  * term lists only
  * term lists + entailment, hosted, 2-way (existing)
  * **term lists + entailment, on-device `nli-deberta-v3-xsmall`, 3-way (C-2)**
  * optional upper bound: `deberta-v3-base` NLI on the GPU
* **Sets:**
  * the existing white-box slice of 47 pages, used **only** to choose the threshold
  * a **black-box** set of ~50 real crisis or support pages from the S-E test capture. Choose them by searching for real support resources, not by using the term lists.
  * a **benign** set made of all ~500 non-sensitive dev and test pages, plus near-miss pages
* **Run:** [t5_audit.mjs](analysis/audit/t5_audit.mjs) `--with-zero-shot` against the local back end.
* **Report:** recall and false-positive rate with Wilson CIs, non-English recall, on-device latency, and confirmation that the on-device run discloses nothing (from S-H).
* **Lands in:** sensitive-detection table and restraint subsection.

### S-G. Seeds, intervals and generator comparison `EXTEND`
* **Prompt ablation:** prompts P1–P3 × 11 moods × 5 fixed seeds = 165 clips. Compare paired by (mood, seed): Wilcoxon signed-rank and bootstrap CIs on differences in |ΔE|, |Δc| and retention. Add CLAP prompt adherence.
* **Loop study:** 11 moods × 20 seeds = 220 fresh clips on the 5060. Compare chroma vs measured-seam cut points: bootstrap CIs on p50 |ΔE| and on the share above 1 dB, and McNemar's test for the paired proportions.
* **Generators:** MusicGen-small, MusicGen-medium, and AudioLDM2-music (or Stable Audio Open Small) × 11 moods × 5 seeds. Report real-time factor on the 5060, seam metrics after loop synthesis, retention, CLAP adherence and Audiobox Aesthetics.
* **Output:** `audio-generation/results/d1-prompt-seeds.json`, `d6-loop-seeds-5060.json`, `d7-generators.json`.
* **Lands in:** prompt table (with CIs), seam table (with CIs), a new generator comparison table.

### S-H. Network-level privacy audit `NEW` (C-7)
* Run the built extension over the test corpus in A6 and A6b.
* **Assertions:**
  1. In A6, no request body contains page text.
  2. In A6b, page text leaves only on escalated pages. The observed rate must match the replayed off-device rate.
  3. No telemetry leaves unless the user exports it.
  4. Requests to the generation service carry the music profile (category, mood, tempo) and nothing else.
* **Report:** bytes per page by destination.
* State in the paper that the generation service sees the category and mood. Note that with a local GPU (S-B), A6 becomes fully on-device end to end.
* **Lands in:** restraint and privacy subsection, plus one table row.

### S-I. Gapless verification and relative seam size `NEW` (C-8)
* **Gapless:** record the output over ≥ 10 loop cycles for 30 clips. Check for zero inserted silence or sample gaps at loop boundaries, and confirm that the Opus files carry no repeat padding.
* **Relative seam:** for each clip, find the percentile of the seam's |ΔE| and |Δc| within the distribution of frame-to-frame changes elsewhere in the same clip. Report the share of seams that fall within the clip's own 95th percentile. Script: `NEW` `analysis/proxies/seam_relative.py`.
* **Wording rule:** "gapless" is shown. "Seamless" or "inaudible" is **not** claimed.
* **Lands in:** loop-quality subsection.

### GPU budget (RTX 5060)

| Night | Runs |
|---|---|
| 1 | S-B duration + concurrency sweep (GPU), then the S-G loop study (220 clips) |
| 2 | S-G prompt ablation and generator comparison |
| 3–4 | S-D′ generation (~1,500 clips; needs the S-E test capture first) |
| 5 | CLAP, Essentia and Audiobox scoring |
| Day/CPU | S-B CPU-only, S-A, S-F, S-H, S-I (browser- or CPU-bound) |

---

## 5a. LLM-bias controls

**Principle:** an LLM may be **evaluated**, never **used to evaluate**. The
cascade's third stage is an LLM (gpt-oss-20b on Groq). If an LLM influences
which pages are chosen, how they're labelled, or how outputs are judged, the
evaluation favours the LLM stage and every configuration that uses it (A3, A4,
A5, A6b).

| ID | Where bias could enter | Control | Check |
|---|---|---|---|
| L-1 | **Gold labels** | Humans only. No LLM pre-labels, suggestions, autocomplete or tie-breaking. Ties are adjudicated by the authors. | The annotation tool already shows no predictions or `true_category` and shuffles per annotator ([index.html:224-283](analysis/annotate/index.html#L224-L283)). Add an **export allowlist** (C-9) so the file fed to the tool contains only `id, url, title, text`. A test fails if any other field appears. |
| L-2 | **Guidelines and category definitions** | Written by the authors. Example pages come from the dev set, not from an LLM. | Commit the guidelines with author attribution before test labelling. |
| L-3 | **URL selection** | No URLs suggested by an LLM, and that includes Claude. Allowed sources: fixed search-engine query templates per category (the query is logged), Tranco / top-sites lists, Curlie directory pages, Wikipedia random (capped at 25%), and news RSS. Every URL records `source` and `query` in `urls-test.jsonl`. | Every test URL has a non-empty `source`. Report the source mix in the paper. |
| L-4 | **Sensitive pages** | The black-box set is **real** crisis and support pages found through search and helpline directories, not written text. The existing 47-page white-box slice is "hand-written" ([sensitive_slice.json](analysis/audit/sensitive_slice.json)), but whether an LLM helped write it isn't recorded. Its authors should confirm. If unknown, use it only to choose thresholds and draw every detector claim from the black-box set. | Record provenance per page. |
| L-5 | **LLM stage drifting toward the test set** | Freeze the model ID, prompt, temperature (0) and timeout at `revision-freeze`. No prompt edits after anyone has looked at test pages. Cache raw LLM responses (C-10) so every replay and ablation reuses the same answers instead of querying again. | The freeze tag contains `llmConfig.js` and the prompts. Run the LLM stage again on 50 test pages and report agreement, because temperature 0 on a hosted API isn't guaranteed to be deterministic. |
| L-6 | **Training-data contamination** | Test pages may already be in the LLM's or the NLI models' training data. Record a publication date per page. Include **≥ 80 pages published after gpt-oss-20b's documented knowledge cutoff** (recent news, new posts and docs). | Report macro-F1 on the post-cutoff subset next to the rest. A large gap means contamination. |
| L-7 | **Judging outputs** | No LLM or audio-language model judges fit, quality or seams. S-D′ uses only non-generative scorers (CLAP embeddings, Essentia regressors and taggers, Audiobox Aesthetics), and S-I uses signal measurements. | State this in the paper's method text. |
| L-8 | **Hiding where accuracy comes from** | For every configuration on test, report accuracy **split by which stage made the decision** (keyword, local zero-shot, LLM). This shows how much of each score comes from the LLM. | A new column or breakdown in the cascade table. |
| L-9 | **Writing assistance** | LLM help (including this plan) is limited to planning and language editing. Every number comes from a script through [build_all.py](analysis/build_all.py). Before submission, diff the numbers in the paper against `analysis/metrics.json`. Disclose AI-assisted editing in the acknowledgments, as IEEE policy requires. | A numbers-diff script passes. Acknowledgment added. |

---

## 6. WP4 — Paper edits

Line numbers refer to [paper/main.tex](paper/main.tex) at `324fbb9`. **First
decide which copy is the master:** `main.tex` or the revised Word draft.
"bart-large-mini" is not in `main.tex`, so the Word draft has diverged.

| ID | Section | Change |
|---|---|---|
| P-1 | Abstract (87–111) | Rewrite in plain language. Make these changes: <br>• "generates music relevant to the page" → "generates music conditioned on the page". <br>• Describe the 36 ms as the **mood-level fallback**. <br>• Add one sentence on how often generated audio is heard (S-C). <br>• Replace 86 ms with the real-embedding cost. <br>• Give the held-out macro-F1. <br>• Add a GPU generation time. |
| P-2 | Introduction (125–156) | Rewrite the three problems and the contributions as a short numbered list. Define the three levels of conditioning (L1–L3). Remove the long run-on sentences. |
| P-3 | §III, equations | Add four numbered equations, each with one sentence in plain words: <br>(1) the zero-shot gate rule (score ≥ τ, margin ≥ δ) <br>(2) expected disclosure D = Σ P(page reaches an off-device stage) <br>(3) seam cost J = \|ΔE\| + λ\|Δc\| <br>(4) exposure P(L3 heard) = P(T_gen + W < dwell) <br>Remove dense inline notation elsewhere (R3 asks for less notation; this satisfies R4 too). |
| P-4 | §III-A (268–276), §III-B (278–308) | Rewrite the garbled sentences (e.g. 279–281, 282–287, 296–298). Fix the model name to `bart-large-mnli` everywhere. Describe C-1 defaults and C-2's 3-way check. |
| P-5 | §III-C/D | Generator back ends (C-4). HMAC hashing (C-3). An explicit list of what leaves the device in each setting. |
| P-6 | Eval design and latency (367–383, 443–460, 498–533) | Add a hardware table with three tiers and precision. Add GPU and real-end-to-end rows with n ≥ 100 and p95 CIs. Report timeouts as censored. Add a CPU-only discussion: generated audio rarely reaches the listener, so on CPU the system behaves as a mood-level player. |
| P-7 | Annotation (412–422) and classification (463–496) | Describe the blind labelling protocol and frozen guidelines. Report dev and test α and test-set results. Mood becomes "a stylistic mapping, not evaluated". Remove the "scored on the corpus they are chosen from" caveat, since gates are now chosen on dev. |
| P-8 | New subsections | Generated-audio exposure (S-C), conditioning fidelity (S-D′), generator comparison (S-G). Point out that the cascade table already contains 7 baselines. |
| P-9 | Loop quality (553–581) and prompt ablation (583–615) | Add seeds, CIs and tests. Gapless verification and relative seam size (S-I). No listener language anywhere. |
| P-10 | Restraint (617–656) | New detector table (S-F) and network audit (S-H). |
| P-11 | Conclusion (659–672) and limitations (675–697) | Remove "suitable for the context". Limitations: no perceptual evaluation (protocol and instruments released), proxy-model bias, CLAP domain mismatch, dwell model assumptions, **annotators are the authors** (blinded, but not independent). |
| P-12 | Whole paper | Plain-English pass. Define macro-F1, NLI, off-device rate, real-time factor (RTF), LUFS and Krippendorff's α on first use. Consistent units. Move overflow to [SUPPLEMENTARY.md](paper/SUPPLEMENTARY.md) to stay within the page limit. Rebuild figures with [build_all.py](analysis/build_all.py). |

### Claims ledger (before → after)

| Before | After |
|---|---|
| Music relevant / suitable to the page | Music **conditioned on** the page. Conditioning fidelity is measured by proxies. Perceived fit is untested. |
| Audible 36 ms after mood commitment | Mood-level fallback audible in X ms. Page-level generated audio reaches the listener on Y% of visits on a consumer GPU and Z% on CPU (S-C). |
| 86 ms per page (excluding embedding) | N ms per page including embedding (S-A). |
| Cascade matches keyword→LLM F1 (0.689) with 38% less disclosure | The same comparison on a **~350-page held-out test set** (blind author labels), with gates chosen on the 255-page dev set. |
| Loops are gapless; seams reduced | Gapless verified from recorded output. Seam size relative to the clip's own variation. No audibility claim. |
| Sensitive pages produce silence | Recall and false-positive rate of the on-device 3-way detector on a black-box set, with CIs. |

---

## 7. WP5 — Release (R-1)

* Tag the repo `cict2026-camera-ready` and archive it on Zenodo for a DOI.
* **Data:**
  * corpus URLs, labels and annotation guidelines
  * result JSONs and generated clips
  * no page text, for copyright
* Generated clips follow the generator weights' licence (MusicGen weights are CC-BY-NC 4.0). State this.
* Release the listening-study protocol ([PREREGISTRATION.md](analysis/PREREGISTRATION.md), [loop_ab](analysis/loop_ab/), [session.html](analysis/s4/session.html)) as ready-to-run future work.

---

## 8. WP6 — Response letter

One row per comment, in the §1 order: comment → what changed → where (section,
table, figure). The draft paragraph on the listening study:

> We were unable to run a human listening study within the revision period.
> Rather than leave the claim unsupported, we (i) removed all claims that the
> music is perceived as fitting the page, (ii) added objective tests of
> conditioning fidelity — audio valence/arousal regressors, mood tagging and
> CLAP retrieval, each comparing page-matched against shuffled-mood clips over
> N pages × 3 seeds — and (iii) separated *gapless* playback, which we now
> verify from recorded output, from *perceptual* seamlessness, which we report
> as seam discontinuity relative to each clip's own variation. The listening
> protocol and instruments are released for follow-up work.

The draft paragraph on annotation:

> We were not able to recruit independent annotators. To address the
> underlying concern, we (i) more than doubled the labelled corpus, adding a
> ~350-page held-out test set captured after the system was frozen and never
> used for tuning; (ii) chose all cascade thresholds on the original 255-page
> set only; (iii) made labelling blind to the collection category, to system
> outputs and to the other annotators, under guidelines frozen before the test
> set was labelled; (iv) kept LLMs out of page selection, labelling and
> judging, froze the LLM stage before the test set was seen, and report
> results on pages published after the LLM's knowledge cutoff; and (v)
> removed every claim that depends on mood labels.
> We report agreement on the test set and list author annotation as a
> limitation.

---

## 9. Schedule

| Week | Engineering | People | Writing |
|---|---|---|---|
| 1 | WP0. C-1…C-6. Tag `revision-freeze`. Night 1. | Write guidelines. Build and freeze the ~350-URL test list, including ~50 real crisis/support pages. Add blind mode to the annotation tool. | P-2, P-4, P-12 English pass on the text that doesn't change |
| 2 | C-7, C-8. Night 2. Capture the test corpus. S-A, S-F, S-H, S-I. S-C script. | Calibration round on dev, then freeze guidelines. Start labelling the test set (~70 pages per day per author). | P-3 equations, P-5 |
| 3 | Nights 3–5 (S-D′). S-E analysis. Rebuild figures. | Finish test labelling. Adjudicate ties. | P-6…P-10 |
| 4 | Fixes and reruns. | — | P-1, P-11, page budget, response letter, release |

**Critical path:** test corpus capture and labelling (S-E) → held-out
results and S-D′ generation → cascade claims in the abstract. Freeze the URL
list in week 1.

---

## 10. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Labelling 350 pages takes longer than planned | Label the stratified minimum first (20 per category = 260 pages). Leave the rest unlabelled and use it only in label-free studies (S-A, S-D′). Don't use an LLM to pre-label: the LLM is the cascade's third stage, so its labels would bias the evaluation. |
| Test α stays below 0.667 | Report it as is. Present category results as tentative, as now. Add per-category α to show which categories are ambiguous. |
| Blackwell / torch setup fails | Use the Docker GPU image. If that fails, keep the M4 tier as the "GPU-class" result and say so. |
| Proxies show no matched > shuffled difference | Report it as a negative result. It supports the narrowed claim and shapes the limitations section. Don't search for a proxy that works. |
| P(L3 heard) is low even on the 5060 | Restate the system as mood-level audio with page-level refinement on longer visits. Recommend shorter clips (S-B) and say which page types benefit. |
| The 3-way sensitivity check still over-triggers | Keep it optional (as now). Report the trade-off between recall and false-positive rate, and don't claim the restraint property beyond what was measured. |
| Over the page limit | Move the CPU-only details, the full gate sweep and the per-mood tables to the supplementary material. |

---

## 11. Checklist

Legend: `[x]` written and committed on `revision-wp1`; `[ ]` waits on a run, on people, or on the final numbers.
Every command is in [RUN_COMMANDS.md](RUN_COMMANDS.md). Nothing below marked `[x]` has been *run* on the RTX 5060; it is implemented, self-tested where it could be, and has a command.

- [x] E-1 [check_gpu.py](audio-generation/check_gpu.py), CUDA 12.8 Docker image · E-3 `W2M_COMPILE` · E-4 hardware manifest in result headers · E-5 `W2M_PREWARM=0`, [timing hygiene](RUN_COMMANDS.md) · [ ] E-2 pick WSL2/Docker on your machine · [ ] E-6 `git tag revision-freeze`
- [x] C-1 defaults (seam selector in `d4_process.py`, on-device zero-shot in the extension) · C-2 3-way sensitivity · C-3 HMAC · C-4 `W2M_MODEL` · C-5 fixed seeds · C-6 real end-to-end flags · C-7 network audit · C-8 gapless render · C-9 export allowlist + test · C-10 LLM cache
- [ ] Test URL list frozen (~350, incl. ~50 crisis/support, ≥ 80 post-cutoff), each URL with `source`/`query` ([validator](analysis/corpus/check_urls_test.mjs) written) · [ ] guidelines written and frozen ([skeleton](analysis/annotate/GUIDELINES.md)) · [x] blind export for the annotation tool (the tool shows no collection category or prediction)
- [ ] LLM-bias controls: [x] L-1 export allowlist test passes · [ ] L-5 LLM config in the freeze tag, cache recorded, 50-page agreement check · [ ] L-4 white-box slice provenance confirmed · [x] L-9 numbers-diff written · [ ] numbers-diff passes (waits on the numbers) · [x] AI-assistance acknowledgment added
- [ ] Studies run: S-A · S-B · S-C · S-D′ · S-E · S-F · S-G · S-H · S-I — [x] script/command exists for each (S-A: `latency.e2e.mjs` flags, `extractionCost.js`, `make_top_sites.mjs`; S-B: `d4_latency.py`, `d3_clip_length.py`; S-C: `simulate_exposure.py`; S-D′: `build_profiles.mjs`, `generate_fit_clips.py`, `score_fit.py`; S-E: `majority_gold.py`, `s_e_dev_test.mjs`; S-F: `s_f_detector_study.mjs`; S-G: `d1_prompt_ablation.py`, `d6_loop_seeds.py`, `d7_generators.py`; S-H: `networkAudit.e2e.mjs`; S-I: `gapless.e2e.mjs`, `seam_relative.py`)
- [x] P-1…P-12 drafted in `paper/main.tex`, with a red `	bd{study: value}` wherever a number is still owed · [x] claims ledger applied (the 50 ms vs 250 ms crossfade discrepancy is corrected in the text) · [x] "bart-large-mini" is not in `main.tex` (it was only in the Word draft; fix it there if the Word file is still used) · [ ] every `	bd` replaced · [ ] page budget (9 pages with placeholders; was 7) · [ ] Word draft synced
- [ ] Figures and tables rebuilt from scripts; every number traceable
- [x] R-1 [release checklist](RELEASE.md) written · [ ] release with DOI
- [x] Response letter [draft](RESPONSE_LETTER.md) · [ ] ⟦cells⟧ filled
