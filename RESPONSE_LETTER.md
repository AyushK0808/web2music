# Response to reviewers — CICT-2026, "Web2Music"

**Draft.** Cells marked ⟦…⟧ are filled from the result files when the studies in
[RUN_COMMANDS.md](RUN_COMMANDS.md) have run. Locations are given by section title; add the numbers from the compiled PDF before sending.

We thank both reviewers for a careful reading and for recommending acceptance after minor revision.
Below, each comment is followed by what changed and where. Two requests could not be met in the revision
window: we ran **no human listening study** and we could **not recruit independent annotators**. For each we explain what we did instead and
we narrowed the claims accordingly.

## Two requests we could not meet

**Listening study (R3 W1/R1; R4 #2).**

> We were unable to run a human listening study within the revision period. Rather than leave the claim unsupported, we (i) removed all claims that the music is perceived as fitting the page, (ii) added objective tests of conditioning fidelity — audio valence/arousal regressors, mood tagging and CLAP retrieval, each comparing page-matched against shuffled-mood clips over ⟦N⟧ pages × 3 seeds — and (iii) separated *gapless* playback, which we now verify from rendered output, from *perceptual* seamlessness, which we report as seam discontinuity relative to each clip's own variation. The listening protocol and instruments are released for follow-up work.

**Independent annotators (R3 W3/R3; R4 #1).**

> We were not able to recruit independent annotators. To address the underlying concern, we (i) more than doubled the labelled corpus, adding a ⟦~350⟧-page held-out test set captured after the system was frozen and never used for tuning; (ii) chose all cascade thresholds on the original 255-page set only; (iii) made labelling blind to the collection category, to system outputs and to the other annotators, under guidelines frozen before the test set was labelled; (iv) kept LLMs out of page selection, labelling and judging, froze the LLM stage before the test set was seen, and report results on pages published after the LLM's knowledge cutoff; and (v) removed every claim that depends on mood labels. We report agreement on the test set and list author annotation as a limitation.

## Reviewer 3

| # | Comment | What we did | Where |
|---|---|---|---|
| W1 / R1 | Fit to the page is never evaluated with listeners | Narrowed the claim to music *conditioned on* the page; removed "suits/suitable for the page" wording; added objective conditioning-fidelity measures (matched vs shuffled clips): ⟦result⟧. Listening protocol released. | Abstract; Introduction; Results: Conditioning fidelity (Table fidelity); Limitations |
| W2 / R2 | "36 ms" is the fallback clip, and users mostly hear the fallback | Restated the claim as three levels of conditioning (L1 mood-level, L2 profile-level, L3 page-level). Measured generation on a consumer GPU across clip lengths (median ⟦s⟧ s for a 15 s clip); simulated how often each level is heard: ⟦L3 share⟧% of visits on the GPU and ⟦CPU share⟧% on CPU, stratified by page type, with a dwell-time sensitivity sweep. | Abstract; Introduction; Results: Generation latency, How often generated audio is heard (Table exposure, eq. 4) |
| W3 / R3 | Labels come from the authors; α below threshold; mood α = 0.195 | Partly addressed (see above): blind labelling under frozen guidelines; corpus grown ⟦2.3×⟧ with a held-out test split; test α = ⟦category⟧ / ⟦sensitivity⟧; mood is no longer an evaluated target; author labelling stated as a limitation. | Results: Evaluation design, Annotation agreement; Limitations |
| W4 | Headline latencies come from stubbed benchmarks | Re-measured end to end with the real embedding model, classifier and generator, n = ⟦110⟧ loads per setup with p95 and bootstrap CIs; descriptor cost with real embedding ⟦ms⟧; timeouts reported as censored. | Abstract; Results: Descriptor cost, Generation latency (Table latency) |
| R4 (clarity) | Garbled sentences; "bart-large-mini"; dense notation | Rewrote the abstract, introduction, §III-A and §III-B in plain language; the model is `bart-large-mnli` / `nli-deberta-v3-xsmall` throughout; four numbered equations, each explained in words; terms (macro-F1, NLI, off-device rate, RTF, LUFS, α) defined at first use. | Throughout |

## Reviewer 4

| # | Comment | What we did | Where |
|---|---|---|---|
| 1 | Independent held-out corpus and annotators; tune thresholds on a separate set | Held-out test set ⟦n⟧ pages, never used for tuning; gates chosen on the 255-page development set, every configuration scored once on test (macro-F1 ⟦…⟧ [CI]). Independent annotators: not possible; mitigated as above. | Results: Evaluation design, Classification and disclosure (Table cascade-test) |
| 2 | Listening study for fit and gapless loops | Not possible. Gapless playback verified objectively: ⟦k/30⟧ clips show no inserted silence over 10 loop cycles; seam size reported relative to each clip's own variation (within the clip's 95th percentile in ⟦%⟧ of clips). "Seamless/inaudible" is not claimed. | Results: Loop quality |
| 3 | Improve and re-measure the sensitive detector, incl. the on-device model | Added an "unrelated" hypothesis (3-way) and ran the on-device NLI back end; evaluated on ⟦n⟧ real black-box crisis/support pages and ⟦n⟧ benign pages: recall ⟦…⟧, false-positive rate ⟦…⟧ (Wilson CIs); latency ⟦ms⟧. | Results: Restraint (Table sensitive) |
| 4 | Real end-to-end latency; enough runs for p95; CPU-only case | See R3 W4; CPU-only discussion and censored timeouts added. | Results: Generation latency (Table latency) |
| 5 | Seeds and intervals for prompt and loop studies; compare another generator | Fixed seed lists, paired tests and bootstrap CIs for both studies (220 loop clips; 165 prompt clips); generator comparison against MusicGen-medium and AudioLDM2-music. | Results: Loop quality, Prompt ablation, Generator comparison (Table generators) |
| 6 | Rewrite abstract and intro; define terms; release code and data | Rewritten; terms defined; code, URLs, labels, result files and raw LLM responses released with a DOI ⟦doi⟧ (page text withheld for copyright). | Abstract; Introduction; Data availability |
| 7 | Mathematical modelling, annotation reliability, privacy validation, perception, clarity | Four numbered equations (gate rule, disclosure, seam cost, exposure); α on dev and test; network-level privacy audit (⟦verdict⟧), and URL hashes now use a keyed HMAC; perception handled as above. | System architecture; Results: Annotation agreement, Restraint (network audit) |
| W | Limited comparison with alternatives | Generator comparison added; the cascade table's seven configurations are the baselines and are now named as such. | Table cascade; Table generators |

## Other changes we made

- The shipped build now matches the evaluated system: the on-device zero-shot middle stage and the measured-seam loop selector are the defaults.
- The paper previously described a 50 ms default crossfade; the shipped default is 250 ms, and the text now says so.
- AI-assisted language editing is disclosed in the acknowledgments.
