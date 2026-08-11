# Web2Music — Results & Discussion Planning Document

**Status:** planning artefact, not a draft of the paper. Every number below is a
placeholder shaped like the number we intend to report.
**Target venues:** IUI (primary), ACM Multimedia, CHI. ISMIR/DAFx as fallback if
the loop-generation contribution outgrows the interaction contribution.
**Scope:** §5 Results and §6 Discussion only. System description (§3) and
implementation (§4) are assumed written.
**Last updated:** 2026-08-10.

---

## 0. How to use this document

Each subsection carries a status tag:

| Tag | Meaning |
|---|---|
| `READY` | The instrument exists and has been run; only analysis remains. |
| `INSTRUMENTED` | The instrument exists in the repo but has never produced a dataset. |
| `TO BUILD` | No instrument exists. Someone has to write it. |
| `BLOCKED` | Depends on something outside the repo (ethics approval, participants). |

The rule this document enforces: **no claim in §6 may rest on a number that no
script in §5 produces.** Section 4 (Metrics dictionary) exists specifically so
that every figure can be traced to the file that emits it. If a metric has no
provenance row, it does not go in the paper.

---

## 1. Claim structure

The paper argues six things. Everything in Results exists to support one of
them; everything in Discussion exists to interpret one of them. Each claim
lists the result that would **falsify** it — if we cannot state that, we are
not running an experiment, we are running a demo.

### C1 — Web-context conditioning produces music that fits the page

> Music generated from page content, behaviour and colour is judged more
> appropriate to the page than music from ablated or page-agnostic baselines.

* **Evidence:** S4 (controlled study), fit ratings per page; S3 (listening test)
  on the generation side.
* **Baselines:** page-agnostic fixed prompt; shuffled-mood (same generator,
  wrong page); fixed lo-fi playlist; human-chosen track (ceiling).
* **Falsified if:** fit ratings for the real system are statistically
  indistinguishable from shuffled-mood. That would mean the conditioning
  contributes nothing and only the generator matters — which is the single
  most dangerous outcome for this paper, and the reason shuffled-mood is a
  mandatory condition rather than a nice-to-have.
* **Lands in:** §5.4, §6.1.

### C2 — The system is fast enough to live inside the browsing loop

> First audio arrives fast enough not to be perceived as a delay, and the
> pipeline's own compute is a small fraction of the wall-clock time.

* **Evidence:** S1 (systems benchmark) — `d4_latency.py` + `latency.e2e.mjs`.
* **Falsified if:** p95 time-to-first-sound exceeds a few hundred ms, or the
  fallback-then-swap design turns out not to hide generation latency (i.e.
  users notice the swap).
* **Lands in:** §5.1, §6.2.
* **Honesty requirement:** the wall-clock number is dominated by the
  deliberate 5 s confidence window (`confidenceWindowMs`, `feature_b/index.js`).
  We report both wall-clock and compute-only, and we say plainly that the
  former is a design parameter, not a limitation of the implementation.
  `latency.e2e.mjs` emits both and cross-checks the constant.

### C3 — A tiered classifier gets near-LLM accuracy at a fraction of the cost and exposure

> The keyword → zero-shot NLI → LLM cascade matches LLM-only accuracy within a
> small margin while sending a minority of pages off the device.

* **Evidence:** S2 (classification accuracy), tier ablation.
* **Key quantities:** macro-F1 per tier configuration; **escalation rate**
  (fraction of pages reaching each tier); **exposure rate** (fraction of pages
  whose text leaves the machine); per-tier latency.
* **Falsified if:** the cascade's macro-F1 is more than ~5 points below
  LLM-only, or the zero-shot tier's abstention rate is so high (it declines
  below `minScore` 0.45 / `minMargin` 0.10) that escalation to the LLM is not
  meaningfully reduced.
* **Lands in:** §5.2, §6.3.

### C4 — Adaptive ambient music does not harm task performance, and reduces perceived effort

> Compared with silence and with a fixed playlist, the adaptive condition does
> not degrade reading comprehension or task completion, and lowers subjective
> workload / distraction.

* **Evidence:** S4.
* **Falsified if:** comprehension drops significantly relative to silence.
  A null on workload is publishable; a performance regression is not, and we
  would report it as a negative result and reframe the paper around C1/C3.
* **Lands in:** §5.5, §6.4.

### C5 — The system behaves responsibly by construction

> Crisis/sensitive content yields silence rather than mood music; pages that
> are already playing audio are not competed with; payment and browser-internal
> pages are bypassed; no browsing history leaves the device in plaintext.

* **Evidence:** S1 behavioural assertions (`chromiumExtension.e2e.mjs`
  sensitive case), the auto-mute telemetry from S5, code-level audit table.
* **Falsified if:** the sensitive-content detector's false-negative rate on an
  adversarial corpus is high enough that a crisis page reliably gets music.
* **Lands in:** §5.6, §6.5, and the Ethics statement.

### C6 — Short generated clips can be looped without an audible seam

> Bar-snapped loop-point detection plus an equal-power crossfade produces loops
> listeners cannot distinguish from continuous audio.

* **Evidence:** S3 — objective seam metric (`_seam_discontinuity`,
  `d4_process.py`) plus a forced-choice listening test.
* **Falsified if:** listeners identify the seam above chance.
* **Lands in:** §5.3, §6.6.

---

## 2. Section map

### §5 Results (target ~3.5 pages)

| # | Subsection | Study | Status |
|---|---|---|---|
| 5.1 | System latency and cost | S1 | `IN PROGRESS` — extraction cost `READY` (105/105 sites); `d4_latency.py` running |
| 5.2 | Page classification accuracy and the tier cascade | S2 | `TO BUILD` (corpus + annotation) — harness itself now `READY` |
| 5.3 | Generated-audio and loop quality | S3 | `READY` (objective, n=116) / `TO BUILD` (listening test) |
| 5.4 | Perceived music–page fit | S4 | `BLOCKED` (ethics) |
| 5.5 | Task performance and workload | S4 | `BLOCKED` (ethics) |
| 5.6 | Behaviour in the wild | S5 | `TO BUILD` (deployment) — analysis script now `READY` |

### §6 Discussion (target ~2 pages)

| # | Subsection | Draws on |
|---|---|---|
| 6.1 | What the conditioning actually buys | C1 |
| 6.2 | Latency is a design budget, not a constant | C2 |
| 6.3 | Cascades as a privacy/accuracy dial | C3 |
| 6.4 | Ambient music and attention | C4 |
| 6.5 | Restraint as a feature: silence, muting, bypass | C5 |
| 6.6 | Generating loopable material with a non-loop model | C6 |
| 6.7 | Limitations and threats to validity | all |
| 6.8 | Design implications for context-adaptive media | all |

---

## 3. Study designs

### S1 — Systems benchmark `INSTRUMENTED`

**Question:** where does the time and the money go?

**Instruments (all exist):**

| Instrument | Measures | Invocation |
|---|---|---|
| `audio-generation/experiments/d4_latency.py` | Feature D over HTTP: fallback, cache-hit, cache-miss, duration sweep, concurrency/batching | `npm run bench:d -- --sections all --out results/d-latency.json` |
| `ui/e2e/latency.e2e.mjs` | end-to-end in real Chromium: nav → extract → decide → generate → audible, plus decode/crossfade | `npm run test:latency -- --repeats 5 --out results/e2e-latency.json` |
| `data-extraction/benchmark/extractionCost.js` | Feature A extraction cost on real sites, forced layout, colour sampling | `npm run bench` |

**Hardware matrix — run every configuration, report all three:**

| Config | Why it is in the paper |
|---|---|
| CPU laptop (the honest default) | What a reader could actually run. |
| Single consumer GPU | What the fallback-then-swap design stops being necessary on. |
| Cache-warm vs cache-cold | The pre-warm grid is 11 moods × 3 styles × 3 bpm buckets = 99 combinations; steady-state performance depends entirely on hit rate. |

**Protocol:** ≥5 repeats per cell; discard the first load of each session (it
pays offscreen-document creation, AudioContext start and the ONNX model load —
`latency.e2e.mjs` already discards a warm-up load); report nearest-rank
percentiles, never bare means (the cache-hit/miss distribution is bimodal and a
mean over it describes nothing that ever happened).

**Cost accounting to report alongside latency:** LLM tokens per page, zero-shot
forward passes per page, bytes transferred per page, and cache hit rate over a
simulated browsing session. Reviewers at IUI ask "what does this cost to run?"
and the answer should not be improvised.

---

### S2 — Classification accuracy and tier cascade `TO BUILD`

**Question:** does the page-type and mood classification work, and what does
each tier contribute?

**Corpus.** Target **600 pages**, stratified: ~45 per content category across
the 13 categories, plus a deliberately adversarial slice:

* pages whose vocabulary does not match their category (the case tier 1.5 was
  added for — e.g. a gut-microbiome article with no Health keyword in it);
* non-English pages (the keyword tier is skipped by construction — `lang !== "en"`);
* mixed/ambiguous pages (a recipe blog post that is mostly a personal essay);
* sensitive/crisis pages, including near-misses ("The Great Depression",
  "grief counselling degree programs") that must **not** trigger silence;
* payment/checkout and `chrome://` pages, which must bypass entirely.

Collect via `data-extraction/benchmark/top-sites.txt` extended with a manual
long tail. Store extracted `pageData` (not live URLs) so the corpus is frozen
and re-runnable — live pages change under you and destroy replication.

**Ground truth.** Three annotators, independent, per page: content category
(13-way), mood (11-way), sensitive (binary). Report **Krippendorff's α** for
each; treat α ≥ .80 as good and α ≥ .667 as the minimum for drawing
conclusions. Disagreements resolved by majority; three-way splits discarded and
counted. **Mood ground truth is the weak point** — "what mood should this page
have" is not an objective fact. Mitigation: frame the annotation as *"which of
these 11 moods would you least object to hearing while reading this page"*, and
report the human ceiling (inter-annotator agreement) as the upper bound any
classifier can be expected to reach. Do not report classifier accuracy without
that ceiling next to it.

**Conditions (the tier ablation).** All run offline against the frozen corpus:

| # | Configuration | What it isolates |
|---|---|---|
| A1 | keyword only (tier 1) | the free baseline |
| A2 | zero-shot only (tier 1.5, `facebook/bart-large-mnli`) | the model with no heuristic help |
| A3 | LLM only (tier 2, Groq `llama-3.1-8b-instant`) | the expensive ceiling |
| A4 | keyword → LLM | **the shipped system before this work** |
| A5 | keyword → zero-shot → LLM | **the shipped system now** |
| A6 | A5 with the local distilled checkpoint | browser-feasible variant |
| A7 | A5 with `minScore`/`minMargin` swept | the confidence-gate sensitivity curve |

**Metrics:** macro-F1 and per-category F1; confusion matrix (A5); escalation
rate per tier; exposure rate (% of pages whose text left the device); wall-clock
per page per tier; abstention rate of tier 1.5 and its precision *when it does
not abstain* (this is the number that justifies putting it in front of the LLM).

**The A7 sweep is the interesting figure**, not a footnote: it shows the
accuracy/exposure trade-off as a continuous dial, which is a stronger
contribution than any single operating point.

---

### S3 — Audio and loop quality `INSTRUMENTED` / `TO BUILD`

**Objective (exists).** `d4_process.py` already returns `seam_discontinuity`
= `{energy_delta_db, spectral_centroid_delta_hz}` measured **before** the
crossfade, i.e. how large a jump the crossfade had to hide. Report the
distribution across ≥200 generated clips, pre- and post-crossfade, plus
loudness (LUFS via `pyloudnorm`) and clip-length compliance.
`experiments/d2_loop_test.py` is an empty stub — this is where it goes.

**Subjective (to build).** Forced-choice AB test, ~30 listeners, 20 clip pairs:
one loop played through two full cycles vs. a continuous excerpt of the same
length. Task: "which of these two contained a repeat?" Chance is 50%; C6 wants
the confidence interval to include 50%. Report per-mood, since dense/percussive
moods (`energetic`, `tense`) will seam worse than sparse ones (`calm`) and that
difference is itself a finding.

**Also report:** the fallback-clip fraction — how often D returned a canned
clip instead of generating. A high rate silently converts the whole system into
a mood-indexed jukebox, and any quality claim would then be about the fallback
library, not the generator.

---

### S4 — Controlled user study `BLOCKED` (ethics approval first)

**Design:** within-subjects, 4 conditions, order counterbalanced (Latin square).

| Condition | Description | Ablates |
|---|---|---|
| SILENCE | no audio | — (floor) |
| PLAYLIST | fixed lo-fi ambient loop, identical for every page | conditioning *and* generation |
| SHUFFLED | Web2Music generation, mood drawn from a *different* page in the corpus | conditioning only |
| ADAPTIVE | the real system | — |

SHUFFLED is the condition that makes C1 falsifiable and is non-negotiable. It
holds the generator, the loop processing, the crossfades and the latency
profile constant, and varies only whether the music matches the page.

**Tasks:** each participant browses 8 curated pages (2 per broad category:
reading/technical, news, entertainment, emotional), 4 minutes each, with a
comprehension question set per page. Pages come from the frozen S2 corpus.

**Measures**

* *Fit* (per page, primary for C1): "the music suited this page" 7-point Likert.
* *Comprehension* (per page, primary for C4): 4 questions, scored 0–4.
* *Workload*: NASA-TLX (raw TLX, per condition).
* *Distraction*: 3-item custom scale + count of self-reported "I wanted to turn
  it off" moments (a single-key logger during the task).
* *Preference*: forced ranking of the 4 conditions at the end + free text.
* *Behavioural*: skip/regenerate presses (`POPUP_REGENERATE`), volume changes,
  mute presses — all already recorded by `ui/src/telemetry.js` as
  `user_control` events, no new instrumentation needed.
* *Mood correction*: `POPUP_MOOD_CORRECTION` gives us, for free, a per-page
  human label of what the mood *should* have been. This doubles as extra S2
  ground truth from a second population and should be reported as such.

**N and power.** For a within-subjects contrast at dz = 0.4, α = .05
two-tailed, power = .80: N ≈ 52. For a 4-level repeated-measures omnibus at
f = 0.25 with ε ≈ .75: N ≈ 30. Recruit **N = 56** to survive ~10% exclusion.
If recruitment caps below 40, drop PLAYLIST (keep SILENCE / SHUFFLED /
ADAPTIVE) rather than under-powering four conditions — C1 needs SHUFFLED far
more than it needs PLAYLIST.

**Procedure:** 60 min; consent → headphone check → calibration page →
4 blocks (8 pages / 4 conditions, counterbalanced) → TLX after each block →
final ranking + semi-structured interview (10 min, recorded, for §6 quotes).
Compensation at local prevailing rate.

**Ethics:** the corpus must contain no crisis content in the user study
(the sensitive path is tested in S1/S2 offline, not on participants).
Telemetry export is opt-in and URL-hashed by construction
(`urlHash`, SHA-256, `ui/src/telemetry.js`). Participants are told what is
recorded and shown the export before it is taken.

---

### S5 — In-the-wild deployment `TO BUILD`

**Question:** does any of this survive contact with real browsing?

**Design:** 12–15 participants, 2 weeks, own machines, own browsing. The
extension records only the existing local telemetry ring buffer; participants
export it manually at the end (the popup already has the button). Daily
one-question diary prompt ("did the music get in the way today? 1–5, plus
optional note").

**What this uniquely gives us — none of it obtainable in the lab:**

* mood-transition frequency and stability in real sessions (how often does the
  5 s confidence window actually fire, and does it flap?);
* **auto-mute rate** — fraction of browsing time attenuated because the page
  itself was playing audio (`playback`/`attenuation` telemetry events, level
  `mute` vs `duck`); this is the number that says whether the auto-mute feature
  is load-bearing or decorative;
* cache hit rate over a real browsing distribution (the S1 pre-warm grid is a
  guess about which moods occur; this measures it);
* tier escalation rate on real pages vs the curated S2 corpus — expect the real
  distribution to be far more skewed, and say so;
* **voluntary disable (toggle-off) rate** and time-to-first-disable, the
  harshest usability measure we have available. This is *not* an uninstall
  rate, and uninstall rate is not obtainable in this build at all: Chrome
  deletes `chrome.storage.local` — the telemetry ring buffer with it — on
  uninstall, and the only surviving hook (`setUninstallURL`) requires a
  network call the local-only guarantee forbids. `POPUP_SET_ENABLED` toggles
  are the closest measurable proxy, not a substitute.

**Analysis caution:** N = 12 with unequal exposure supports description, not
inference. Report distributions and per-participant traces; do not run
significance tests on this.

---

## 4. Metrics dictionary

Every metric the paper may print, with the code that produces it. If it is not
in this table it does not go in a figure.

| Metric | Definition | Produced by |
|---|---|---|
| `time_to_first_sound` | nav → fallback clip audible | `latency.e2e.mjs`: `nav_to_fallback_request_ms` + decode |
| `time_to_generated_audio` | nav → generated clip audible (wall clock) | `latency.e2e.mjs`: `nav_to_first_audio_ms` |
| `compute_ms` | extract + classify + D round trip + decode, excluding the confidence window | `latency.e2e.mjs`: `compute_ms` |
| `extraction_cost` | Feature A per-stage wall time, forced-layout count | `extractionCost.js` |
| `d3_generate_ms` … `d5_save_ms` | Feature D per-stage server time | `main.py` `timings`, aggregated by `d4_latency.py` |
| `unaccounted_ms` | client wall clock − Σ server stages = queueing + transport | `d4_latency.py` |
| `rtf` (real-time factor) | `d3_generate_ms / 1000 / duration_seconds` | `d4_latency.py --sections duration` |
| `batching_speedup` | sequential wall / concurrent wall at k requests | `d4_latency.py --sections concurrency` |
| `cache_hit_rate` | `cache == "hit"` / total `/generate` | `main.py` response field, S5 telemetry |
| `fallback_rate` | `metadata.is_fallback` true / total | same |
| `macro_f1_category` | unweighted mean per-category F1, 13 classes | S2 harness (to build) |
| `macro_f1_mood` | unweighted mean per-mood F1, 11 classes | S2 harness (to build) |
| `escalation_rate[tier]` | share of pages decided at each tier | S2: `category.source` ∈ {`keyword`, `zero-shot`, `llm`, `default`}; S5: `tier_escalation_rate`/`tier_counts`, `s5_telemetry_analysis.js` (via `onDiagnostics`, every page, not just transitions) |
| `exposure_rate` | share of pages whose text left the device | S2: derived, `source == "llm"` (+ proxy zero-shot); S5: `llm_exposure_rate`, `s5_telemetry_analysis.js` |
| `disabled_rate` | share of session time the extension was toggled off | `s5_telemetry_analysis.js`: `user_enabled_toggle` events (`POPUP_SET_ENABLED`) — toggle-off, not uninstall; see §3 S5 |
| `disables_per_hour` | voluntary disable presses per hour of session | same |
| `abstention_rate` | tier-1.5 declines / tier-1.5 invocations | `b1_zeroShotCategory.js` abstain log |
| `zs_margin` | top score − runner-up score | `parseZeroShotResult` |
| `seam_energy_delta_db` | RMS dB difference across the loop seam, pre-crossfade | `d4_process._seam_discontinuity` |
| `seam_centroid_delta_hz` | spectral-centroid difference across the seam | same |
| `attenuation_rate` | share of session time at `duck` / `mute` | `audioTabs.js` → `playback`/`attenuation` telemetry |
| `skip_rate` | `POPUP_REGENERATE` presses per hour | `user_control` telemetry |
| `mood_correction_rate` | corrections per committed transition | `user_control` telemetry |
| `fit_rating` | 7-point Likert, per page | S4 |
| `comprehension` | 0–4 per page | S4 |
| `tlx` | raw NASA-TLX per condition | S4 |

---

## 5. Statistical analysis plan

**Pre-register this before collecting S4 data** (OSF or AsPredicted). A
pre-registration is cheap and pre-empts the "these comparisons look chosen
after the fact" review.

**Primary hypotheses (confirmatory, one family, Holm-corrected):**

* H1 (C1): `fit` ADAPTIVE > SHUFFLED.
* H2 (C1): `fit` ADAPTIVE > PLAYLIST.
* H3 (C4): `comprehension` ADAPTIVE ≥ SILENCE (equivalence test, TOST, bounds
  ±0.5 questions — an equivalence test, not a null-hypothesis test, because
  "no harm" is the claim and a non-significant t-test is not evidence of it).
* H4 (C4): `tlx` ADAPTIVE < PLAYLIST.

**Models.** Ordinal outcomes (Likert) → cumulative-link mixed models
(`ordinal::clmm`) with random intercepts for participant and page. Continuous
outcomes → linear mixed models (`lme4::lmer`), Satterthwaite df. Counts (skips,
mutes) → Poisson or negative-binomial GLMM with an exposure offset. Never
average Likert responses per participant and run a t-test on the averages;
the page-level variance is a substantial part of the story here (some pages are
simply harder to score music for) and collapsing it discards that.

**Reporting.** Effect sizes with 95% CIs for everything; exact p; model
formulae in an appendix; no bare "p < .05". For latency, bootstrap CIs
(10k resamples) on p50 and p95, since percentile estimates from ~50 samples are
noisier than they look.

**Exploratory analyses** (labelled as such, uncorrected): per-category fit
differences; correlation between `zs_margin` and human agreement; whether skip
rate predicts fit rating; time-of-day effects.

**Exclusions, defined in advance:** participants failing the headphone check;
comprehension at floor across all conditions (not engaging); sessions with
> 20% of pages producing no audio (a system failure, not a condition).

---

## 6. Table and figure inventory

| ID | Type | Content | Source |
|---|---|---|---|
| T1 | table | Latency by stage, CPU vs GPU, cache hit vs miss (p50/p95/max) | S1 |
| F1 | figure | Timeline diagram: nav → first sound → generated swap, with the confidence window shaded as a *design* interval | S1 |
| F2 | figure | Generation latency vs `duration_seconds`, with the real-time-factor line | S1 |
| F3 | figure | Batching speedup vs concurrency k | S1 |
| T2 | table | Classification accuracy per tier configuration A1–A6, with escalation and exposure rates | S2 |
| F4 | figure | 13×13 confusion matrix for the full cascade | S2 |
| F5 | figure | **Accuracy vs exposure trade-off curve** from the A7 threshold sweep — the money figure for C3 | S2 |
| F6 | figure | Seam discontinuity distribution, pre vs post crossfade, per mood | S3 |
| T3 | table | Loop AB-test detection rate per mood, with 95% CIs against the 50% chance line | S3 |
| F7 | figure | Fit ratings by condition (violin + per-participant lines) | S4 |
| T4 | table | Comprehension, TLX, distraction by condition, with effect sizes | S4 |
| F8 | figure | In-the-wild: attenuation, transitions/hour, cache hit rate over 2 weeks | S5 |
| T5 | table | Responsible-behaviour audit: each policy, its trigger, its test | S1/S2 |

Eight figures is too many for a 10-page submission. Priority order if cut:
**F5 > F7 > F1 > F6 > F4 > F2 > F8 > F3**. F3 and F2 move to the appendix
first; they are engineering detail, not argument.

---

## 7. Ablations

Beyond the S2 tier ablation, three system ablations are cheap because the
instruments already exist:

1. **Signal ablation (Feature A).** Re-run S2 classification with each input
   signal removed in turn: text only, − colour, − behaviour, − embedding.
   Answers "does the multimodal input earn its complexity, or is text doing all
   the work?" This is the question a reviewer *will* ask, and if colour and
   behaviour contribute nothing we should find that out ourselves and say so.
   `INSTRUMENTED` — `runB1`/`runB2` accept partial `pageData`.
2. **Prompt ablation (Feature D).** B4's engineered prompt vs D2's fallback
   prompt vs a bare mood word. Measured on S3's objective metrics plus a small
   preference test. `TO BUILD` — `experiments/d1_prompt_ablation.py` is an
   empty stub reserved for exactly this.
3. **Clip length.** 5/10/15/20/28 s against loop quality and latency; the
   product question is whether a shorter clip that loops sooner beats a longer
   one that arrives later. `TO BUILD` — `experiments/d3_clip_length.py`, empty
   stub; `d4_latency.py --sections duration` already produces the latency half.

---

## 8. Baselines

| Baseline | Why a reviewer wants it | Effort |
|---|---|---|
| Silence | The default state of the world. | free |
| Fixed lo-fi playlist | What people actually do today. This is the real competitor, not another research system. | low |
| Shuffled mood | Isolates conditioning from generation. | free (reuse corpus) |
| Page-agnostic single prompt | Isolates generation from conditioning. | low |
| Retrieval from a curated library instead of generation | The obvious cheaper design; we must say why generation is worth it. | medium |
| Human-chosen music per page | The ceiling. Even N = 20 pages is enough to bound the gap. | medium |

The retrieval baseline is the one most likely to be raised as "why generate at
all?" — the honest answer involves loop-ability, licensing, and the
combinatorial size of the (mood × style × bpm × energy) space, and that answer
belongs in §6.1 with a number attached, not as hand-waving.

---

## 9. Discussion outline

**6.1 What the conditioning buys.** Lead with the ADAPTIVE − SHUFFLED contrast;
that difference *is* the contribution. If the effect is modest, say so and
argue from the per-category breakdown (conditioning likely matters far more for
emotional/horror/news pages than for a settings screen). Address the retrieval
baseline here.

**6.2 Latency is a design budget.** Reframe: the interesting engineering result
is not "generation is slow" (everyone knows) but that a two-stage
fallback-then-swap makes a 15–95 s generator feel instant, and that the
dominant wall-clock term is a deliberate stability window we chose. Quantify
the budget: how much of the 5 s could be spent before users notice.

**6.3 Cascades as a privacy dial.** Generalise past this system: a cheap
heuristic, a local model that can *abstain*, and a remote model as last resort
is a reusable pattern for any browser-resident classifier. The abstention gates
(`minScore`, `minMargin`) are the dial; F5 is the curve. Note explicitly that
zero-shot NLI cannot hallucinate an out-of-vocabulary label, unlike the
generative tier — a robustness property, not just a cost property.

**6.4 Ambient music and attention.** Connect to the existing literature on
background music and cognitive performance (the irrelevant-speech effect,
arousal–mood hypothesis). Our contribution is not "music affects focus" but
"music that tracks the page affects it differently than music that does not".
Be careful not to overclaim from a 4-minute-per-page lab task.

**6.5 Restraint as a feature.** The silence-on-crisis-content policy, the
auto-mute, and the payment-page bypass are all decisions to *not* produce
output. Argue that for ambient/always-on systems, the quality of the abstention
policy is as much a part of the design as the generation, and that we can
measure it (T5, S5 attenuation rate).

**6.6 Loopable material from a non-loop model.** Bar-snapped self-similarity +
equal-power crossfade + gapless Ogg/Opus. The MP3-padding failure is worth two
sentences: it is a concrete, reproducible trap for anyone building on a
generative audio model, and we hit it.

**6.7 Limitations.** See §10 — do not bury these; a limitations section that
pre-empts the reviewer's objection reads as confidence.

**6.8 Design implications.** Three or four transferable rules, each traceable
to a result: (i) abstain rather than guess when the cost of a wrong output is
an intrusion; (ii) hide model latency with a cheap, correct-category
placeholder rather than a spinner; (iii) make stability a tunable window, not
an implicit consequence of polling; (iv) put the expensive model last and let
the cheap ones decline.

---

## 10. Threats to validity

**Internal**

* Order and fatigue effects across four 8-page blocks → Latin square, block
  order as a covariate.
* Demand characteristics: participants know which condition is "the system" —
  the swap is audible. → Do not name conditions; describe the study as
  comparing "four audio settings".
* The SHUFFLED condition can accidentally match (a shuffled `calm` on a calm
  page). → Force the shuffled draw to be at least 2 steps away in valence–arousal
  space, and report how often the draw was near-miss.

**External**

* The 8 curated pages are not the web. → S5 exists precisely to answer this;
  report the S2-corpus vs in-the-wild category distributions side by side.
* Participants will skew young, technical, and headphone-owning. → Report
  demographics; do not claim generality.
* English-only evaluation, while the pipeline explicitly handles non-English by
  skipping the keyword tier. → Include a non-English slice in S2 even if S4
  stays English, and label the limitation.

**Construct**

* "Mood of a page" is not well defined. → Report the inter-annotator ceiling
  alongside every accuracy number, and frame the task as preference, not truth.
* Fit ratings may measure "I liked this music" rather than "this music suited
  this page". → Include a liking item and report fit controlling for liking.

**Conclusion**

* Multiple comparisons across many measures → pre-registered families, Holm
  within family, exploratory analyses labelled.
* Small-N in S3/S5 → descriptive reporting, CIs, no inference from S5.

**System-specific**

* If the fallback-clip rate is high, S4 partly evaluates the fallback library
  rather than the generator. → Log and report `fallback_rate` for every study
  session; exclude sessions above a pre-set threshold.
* Cache hits change the latency *and* the audio (the same clip recurs). →
  Report cache state per session; consider forcing `nonce` in the S4 build so
  every page generates fresh, and note the latency cost of doing so.
* Groq model updates mid-study would silently change tier-2 behaviour. →
  Pin the model string, record it per session, and re-record the golden
  fixtures at study start and end (`fixture_staleness_test.js` already guards
  drift).

---

## 11. Reviewer pre-mortem

The twelve objections most likely to sink this, and where each is answered.

| # | Objection | Answer lives in |
|---|---|---|
| 1 | "MusicGen is off-the-shelf; where is the novelty?" | §6.1 — the contribution is the conditioning path and the interaction design, and SHUFFLED isolates it. |
| 2 | "Why not just retrieve from a library?" | §6.1 + the retrieval baseline in §8. |
| 3 | "The latency is unusable." | §5.1 F1 — first sound is sub-second via the fallback; the generated swap is crossfaded. |
| 4 | "Mood labels are arbitrary." | §5.2 — inter-annotator ceiling reported next to every accuracy figure. |
| 5 | "N is too small / underpowered." | §5 power analysis, pre-registered. |
| 6 | "You only tested on your own curated pages." | S5 in-the-wild deployment. |
| 7 | "Sending page text to Groq is a privacy problem." | §6.3 — exposure rate quantified, cascade reduces it, local-only variant measured (A6). |
| 8 | "Is the zero-shot tier actually pulling its weight?" | T2 escalation/exposure columns + F5 sweep; if it isn't, we report that. |
| 9 | "Music affecting focus is well-studied." | §6.4 — our claim is about *page-matched* music, not music per se. |
| 10 | "The system decides to go silent on crisis pages — how do you know it works?" | §5.6 adversarial slice with false-negative and false-positive rates. |
| 11 | "Results are from one machine." | §5.1 hardware matrix, three configs. |
| 12 | "Not reproducible." | §12 bundle: frozen corpus, pinned models, seeds, harness scripts, telemetry schema. |

---

## 12. Reproducibility bundle

Ship with the paper (anonymised for review):

* the frozen S2 corpus as extracted `pageData` JSON, not URLs;
* golden LLM fixtures (`mood-classification/fixtures/`) + the recording script,
  so tier-2 behaviour is replayable without a key;
* pinned model identifiers: `facebook/musicgen-small`,
  `facebook/bart-large-mnli`, `Xenova/all-MiniLM-L6-v2`,
  Groq `llama-3.1-8b-instant`, and the distilled MNLI checkpoint used for A6;
* generation seeds (`generation_seed` is already returned per clip) and the
  cache-key scheme;
* the harness scripts themselves — `d4_latency.py`, `latency.e2e.mjs`,
  `chromiumExtension.e2e.mjs`, `extractionCost.js`;
* the telemetry event schema and a sample export;
* analysis notebooks with the exact model formulae from §5.

**`audio-generation/research_log.md` is currently empty (0 bytes).** Every run
of every harness should append a dated entry there — command line, git SHA,
hardware, output path. Reconstructing "which build produced Table 1" three
months later, without that log, is how a resubmission dies.

---

## 13. Critical path

Ordered by what blocks what, not by who is free.

| Step | Blocks | Owner | Status |
|---|---|---|---|
| 1. Ethics/IRB submission | S4, S5 entirely | — | not started; **start this first, it has the longest latency of anything here** |
| 2. Freeze the S2 corpus (600 pages, extracted) | S2, S4 page selection | Feature A owner | not started |
| 3. Annotation round + α | S2, C1/C3 | all three annotators | blocked on 2 |
| 4. S2 harness (A1–A7 runner) | T2, F4, F5 | Feature B owner | **harness built and smoke-tested 2026-08-10** (`s2_tier_ablation.js`); real 600-page corpus + annotation still not started |
| 5. Run S1 on all three hardware configs | T1, F1–F3 | Feature D owner | **CPU config in progress 2026-08-10** (`extractionCost.js` done; `d4_latency.py` running); GPU config and cache-cold-vs-warm comparison still open |
| 6. Fill `d2_loop_test.py`, run S3 objective | F6 | Feature D owner | **done 2026-08-10** — n=141 after a compliance-check fix; see research_log.md. Note the new finding: median clip retains 50.3% of its requested duration |
| 7. Loop AB listening test | T3 | any | blocked on human listeners — objective half (6) no longer blocks this |
| 8. Pre-registration | S4 validity | lead | blocked on 4's real corpus (need pilot effect sizes) |
| 9. Pilot S4 (n = 6) | S4 protocol | lead | blocked on 1, 2 |
| 10. Run S4 | F7, T4 | lead | blocked on 9 |
| 11. S5 deployment (2 weeks) | F8 | any | blocked on 1; analysis script (`s5_telemetry_analysis.js`) is ready to receive its output the moment it isn't |

Steps 5 and 6 were the only ones runnable with what existed in the repo
before this session; 6 is now done and 5 is partway there. Step 1 (ethics)
is still the only one whose delay cannot be recovered by working harder
later — nothing above changes that it should have started already.

---

## 14. Kill criteria

Decided in advance, so the decision is not made by sunk cost at 3 a.m.:

* **ADAPTIVE ≈ SHUFFLED on fit** → the conditioning claim is dead. Reframe as a
  systems/engineering paper (cascade + loop generation + latency architecture)
  and target a systems venue, not CHI.
* **Comprehension regression vs SILENCE** → report as a negative result;
  the paper becomes "when context-adaptive ambient audio hurts", which is
  publishable and honest, but it is a different paper and needs a different
  framing throughout.
* **Cascade macro-F1 more than ~5 points below LLM-only with no exposure win**
  → drop C3 to a paragraph, keep the tier as an implementation detail.
* **Loop seam detected well above chance** → drop C6, present looping as
  future work, shorten §5.3 to the objective metric only.

---

## Appendix A — What exists in the repo today

**Updated 2026-08-10.** Everything below this line reflects an actual work
session, not a plan — every "ran" claim has a `research_log.md` entry with
a command, git SHA, and real numbers.

| Asset | State |
|---|---|
| `d4_latency.py` | Running now (`--sections all`, backgrounded) against a live backend. `fallback`/`warm` sections producing real cache-hit numbers as moods complete; `cold`/`duration`/`concurrency` still in flight. **Real finding: a single 28s CPU generation took ~19 min on this hardware** — far past the docstring's "15-95s" assumption; reinforces C2's fallback-then-swap argument, doesn't undermine it. |
| `latency.e2e.mjs` | Still not run — deliberately held back until `d4_latency.py`'s generation-heavy sections finish, since both hit the same MusicGen resource and would contaminate each other's timings if run concurrently. |
| `extractionCost.js` | **Done.** 105/105 real sites, clean run — see `research_log.md`. Found and fixed two real production bugs along the way (`syllableCounter.js` load order, and Feature A's link-dominated-page extraction — both below). |
| `chromiumExtension.e2e.mjs` | Re-confirmed passing, 12/12, after the fix below (rebuilt extension first) |
| `d2_loop_test.py` | **Written and run** (was an empty stub). Re-run after the compliance fix below: n=141 real clips (11 fallback + 130 audio-cache, joined against Postgres). Adds a genuinely new pre-vs-post-crossfade comparison the API response never exposed on its own, and now reports the duration-retention distribution rather than a pass/fail flag. |
| `d1_prompt_ablation.py`, `d3_clip_length.py` | Still empty stubs (0 bytes) — not touched this session |
| `research_log.md` | No longer empty — dated entries for every run above, each with command/git-SHA/output-path |
| Fallback clips | 11 moods present (`.ogg` + `.json`), all analysed by `d2_loop_test.py` |
| `_seam_discontinuity` | Implemented; now aggregated (`d2_loop_test.py`) across 141 clips, pre- **and** post-crossfade |
| Telemetry ring buffer | Implemented, URL-hashed, exportable; **analysis script now exists** (`ui/experiments/s5_telemetry_analysis.js`), smoke-tested against a synthetic session — real deployment still needed for real numbers |
| Zero-shot tier (B1.5) | Implemented, unit-tested, **off by default**; was **silently non-functional in production** — its HF Inference API endpoint (`api-inference.huggingface.co`) is fully decommissioned, every call failed "fetch failed" and fell through to the LLM tier. Fixed (`services/classify/classifyService.js` now uses `router.huggingface.co`); verified live against the plan's own gut-microbiome example. `classify-service` also had to be rebuilt — the running container predated the `/v1/zero-shot` route by 6 days. |
| S2 tier-ablation harness | **Built** (`mood-classification/experiments/s2_tier_ablation.js`), all tiers live (Groq + fixed HF proxy), A1–A7 sweep working. Smoke-tested on an 18-page single-annotator corpus (explicitly not the real S2 corpus) — real finding: A5 (shipped cascade) trades ~6 macro-F1 points for zero page-text exposure vs. A4 (previous keyword→LLM system). |
| Auto-mute | Implemented, unit-tested; no in-the-wild data (S5 analysis script above is ready to consume it once there is) |
| Production bug: `syllableCounter.js` missing from content-script load order | **Found and fixed.** `ui/manifest.json` + `ui/build.mjs` never included it before `Readability.js`, which reads it at top-level const-binding time — the shipped extension has thrown and silently swallowed this on every real page load since the syllable counter was split into its own file. `flesch`/`readingComplexity` has never once reached Handoff 1. Non-fatal today (B computes its own reading-complexity fallback) but was quietly dead code. |
| `audio-generation` test suite | **Fixed and green: 60 passed on Python 3.14.2 *and* 3.12.0.** The previous "numba access violation" diagnosis was wrong in every particular — it is a hang, not a crash (0% CPU across a 20s sample; `py-spy` shows the loop parked in `select`), and it reproduces identically on both interpreters with identical `numba==0.66.0`, so the interpreter was never the variable. All 13 `test_d4_process.py` tests, including the one named as the crash site, pass on both. **No dependency pin was needed to fix the hang** — `numba`/`llvmlite` were never the cause. A pin was made afterward anyway, for §12 reproducibility, not correctness: `requirements.txt` pulled both transitively via `librosa` with no version constraint, so a future install could silently resolve a different pair than the one actually verified here; now pinned to `numba==0.66.0`/`llvmlite==0.48.0`. Two independent bugs were behind the hang: (1) `d3_generate._run_batch` completed `asyncio.Future`s **across a thread boundary**, and `loop.call_soon` does not wake a sleeping loop, so a batch that is the last outstanding work is never collected — **a production defect on `/generate`**, masked in the field by ambient socket traffic; fixed with `call_soon_threadsafe`. (2) `test_main_roundtrip.py` re-imports `d3_generate`, leaving `prewarm` bound to the original module copy that `conftest.py` never reset — **test isolation only**; fixed by resetting every live copy. |
| Production bug: D3 batch futures resolved off-loop | **Found and fixed** (`audio-generation/d3_generate.py`). See the row above — the bug that had been misfiled for a session as a numba/Python-3.14 incompatibility. |
| Production bug: Feature A discards link-dominated pages | **Found and fixed** (`data-extraction/Textextractor.js`). `findMainContentElement` scores containers by *non-link* text but extraction then takes all text, so on a link directory the two measures come apart: crates.io's 238-char tagline held 95.6% of the page's 249 non-link chars (of 4541 total), was treated as the dominant child, and was returned as the whole page's content — 36 of 632 words extracted. A dominant child must now win on total text as well. crates.io 4.9% → 85.5% coverage; corpus p50 80.8% → 82.6%; zero genuine under-extractions left across 105 sites; text stage got faster (mean 17.1 → 10.7ms). Affects every aggregator/package-index/category page, not just crates.io. |
| Harness bug: `d2_loop_test.py` duration compliance | **Found and fixed.** The lower bound was a bare `3000` while the pipeline clamps to `MIN_LOOP_SECONDS` and *then* shrinks by `CROSSFADE_MS` — so the single "non-compliant" clip was behaving exactly as designed. 141/141 compliant once corrected. More importantly the check was near-vacuous (3s–28s counts as a pass), hiding the real distribution: **median clip retains only 50.3% of its requested duration, 12.8% retain under 20%**. §5.3/§6.6 need that number, not the 99.1% pass rate. **Whether the short retention is correct behaviour on non-self-similar audio or a loop-detector defect is undecidable from stored data** — `audio-cache/` holds clips post-trim, so the source audio the detector actually saw is gone. The obvious mechanism (chroma self-similarity decaying with distance, biasing argmax early) was tested on the three longest surviving clips and is **not supported** (corr(similarity, time) = +0.383, −0.130, +0.140 — no systematic decay). The loop objective was deliberately *not* changed on a hypothesis that failed to confirm; doing so would invalidate all 130 cached clips and every §5.3 number. Settling this needs retaining pre-trim audio for a sample of future generations. |
| S5 telemetry gaps (tier source, voluntary disable) | **Both closed.** `B_decision` now carries `categorySource`/`moodTier` for every page (via a new `onDiagnostics` hook on `runFeatureB`, deliberately *not* via handoff 2 — a handoff only exists on a transition, so that route would have measured a biased subset). `POPUP_SET_ENABLED` now emits `user_enabled_toggle`. `s5_telemetry_analysis.js` computes `tier_escalation_rate`, `llm_exposure_rate`, `tier_counts`, `disables_per_hour`, `disabled_rate`. **§3 S5 wording needs narrowing: this is a toggle-off rate, not an uninstall rate** — Chrome deletes the ring buffer on uninstall and `setUninstallURL` needs a network call the local-only guarantee forbids, so uninstall rate is not measurable in this build at all. |
| S2 corpus (600 pages, annotated), user study, S5 deployment | Still do not exist — need human annotators / ethics approval / participants, none of which a coding session can substitute for |
