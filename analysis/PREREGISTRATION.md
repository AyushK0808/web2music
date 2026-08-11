# Web2Music — S4 pre-registration (D-04)

**Status: DRAFT, not lodged.** Two fields cannot be honestly completed yet and
are marked `PENDING` below. Lodging it with those guessed would defeat the point
— a pre-registration whose effect sizes were invented after the fact is worse
than none, because it claims a rigour it does not have.

| | |
|---|---|
| Registry | OSF or AsPredicted (choose one; OSF preferred for the attachments) |
| Study | S4, controlled within-subjects laboratory study |
| Drafted | 2026-08-11 |
| Lodge before | the first non-pilot participant is run |
| Blocking | H-01 (ethics approval), D-01 (frozen corpus), H-04 (pilot effect sizes) |

---

## 1. Hypotheses

Four confirmatory hypotheses, one family, Holm-corrected together. Everything
else in the analysis is exploratory and labelled as such.

| # | Hypothesis | Outcome | Test |
|---|---|---|---|
| H1 | `fit` ADAPTIVE > SHUFFLED | 7-point Likert, per page | CLMM contrast |
| H2 | `fit` ADAPTIVE > PLAYLIST | 7-point Likert, per page | CLMM contrast |
| H3 | `comprehension` ADAPTIVE ≥ SILENCE | correct out of 4, per page | **TOST**, bounds ±0.5 questions |
| H4 | `tlx` ADAPTIVE < PLAYLIST | raw NASA-TLX, per block | LMM contrast |

H3 is an **equivalence** test, not a null-hypothesis one. The claim is "no
harm", and a non-significant *t*-test is not evidence of that.

**H1 is the one that matters.** ADAPTIVE − SHUFFLED holds the generator, the
loop processing, the crossfades and the latency profile constant and varies only
whether the music matches the page. If it is null, the conditioning contributes
nothing and the paper becomes a systems paper (see §7).

## 2. Design

Within-subjects, four conditions, order counterbalanced by a **Williams** Latin
square (not a cyclic one — a cyclic square leaves first-order carry-over
perfectly confounded with condition). Implemented in
`analysis/s4/assignment.mjs`, tested in `analysis/s4/assignment_test.mjs`.

| Condition | Description |
|---|---|
| SILENCE | no audio |
| PLAYLIST | one fixed lo-fi ambient loop, identical on every page |
| SHUFFLED | Web2Music generation, mood drawn from a different page |
| ADAPTIVE | the real system |

Eight pages per block, four minutes each, drawn from the frozen S2 corpus
(D-01). Conditions are never named to participants; each participant sees their
own mapping onto "Setting A"–"Setting D".

**The SHUFFLED draw** is forced at least two steps away from the page's true
mood in valence–arousal space, where one step is the median nearest-neighbour
distance among the eleven moods (0.2062, so the minimum distance is 0.4123).
Over 56 simulated participants the constraint was satisfiable on every trial —
observed near-miss rate 0.0%, median drawn distance 0.608. The observed rate
will be recomputed from the real sessions and reported either way.

**Cache.** Every trial carries a generation nonce, so no clip is ever replayed
across participants. This costs latency and the cost is acknowledged: without
it, "the same condition" would silently stop meaning the same thing.

## 3. Sample size

N = 56, recruited to survive ~10% exclusion.

* Within-subjects contrast at dz = 0.4, α = .05 two-tailed, power = .80: N ≈ 52.
* 4-level repeated-measures omnibus at f = 0.25 with ε ≈ .75: N ≈ 30.

If recruitment caps below 40, **drop PLAYLIST**, not SHUFFLED. H1 needs
SHUFFLED far more than the paper needs PLAYLIST.

**PENDING — pilot effect sizes.** The dz = 0.4 above is a convention, not an
estimate from this system. H-04 (n = 6, data discarded) supplies the real one
and this section is rewritten before lodging.

## 4. Measures

| Measure | Grain | Instrument |
|---|---|---|
| Fit ("the music suited this page") | per page | `session.html`, 7-point |
| Liking ("I liked the music itself") | per page | `session.html`, 7-point |
| Comprehension | per page | 4 items, scored 0–4 |
| Raw NASA-TLX | per block | 6 subscales, 21-point, unweighted, rescaled 0–100 |
| Distraction | per block | 3 items, third reverse-coded |
| "I wanted to turn it off" | continuous | space bar, timestamped |
| Preference ranking | per session | forced ranking of the four settings |
| Skip / volume / mute / mood correction | continuous | existing `user_control` telemetry — **no new instrumentation** |

`POPUP_MOOD_CORRECTION` gives a free per-page human mood label from a second
population and is reported as additional S2 ground truth.

Liking is collected specifically so fit can be reported **controlling for
liking**: a fit rating may really be measuring "I liked this music", and the
honest response is to report both rather than to argue about it.

## 5. Analysis

Specified in `analysis/s4/models.R`, and the same specification is implemented
and executed in `analysis/s4/simulate_and_check.py`. Formulae, verbatim:

```
fit           ~ condition + (1 | participant) + (1 | page)      clmm
fit           ~ condition + scale(liking) + (1|participant) + (1|page)   clmm
comprehension ~ condition + (1 | participant) + (1 | page)      lmer
tlx           ~ condition + (1 | participant)                   lmer
turnoff       ~ condition + (1 | participant)                   glmer, Poisson → NB if dispersion > 1.5
```

Ordinal outcomes get cumulative-link mixed models. Likert responses are **not**
averaged per participant and *t*-tested: page-level variance is a substantial
part of the story (some pages are simply harder to score music for) and
collapsing it discards exactly that.

Effect sizes with 95% CIs for everything, exact *p*, no bare "p < .05". Latency
percentiles get 10k-resample bootstrap CIs.

**Verified in advance.** Simulating 56 participants under planted effects
(fit ADAPTIVE−SHUFFLED = +0.8, ADAPTIVE−PLAYLIST = +1.2, comprehension Δ = 0.0,
TLX Δ = −6.0) recovers all four inside their intervals, and the pipeline runs
end to end from raw export to F7 and T4. A model that could not recover an
effect it was handed would not find one that was really there.

## 6. Exclusions, defined in advance

Implemented in `analysis/s4/export_s4.mjs`, not decided while looking at data:

1. failed the headphone check;
2. comprehension at floor across every condition (mean ≤ 0.5 of 4) — not engaging;
3. more than 20% of pages produced no audio — a system failure, not a condition.

Excluded rows are retained in the export under `exclusions` with their reason.

## 7. Outcome-neutral conditions

Decided now, so they are not decided by sunk cost at 3 a.m.

* **ADAPTIVE ≈ SHUFFLED on fit** → the conditioning claim is dead. Reframe as a
  systems paper (cascade + loop generation + latency architecture) and target a
  systems venue.
* **Comprehension regression vs SILENCE** → report as a negative result. That is
  a different paper — "when context-adaptive ambient audio hurts" — and it needs
  a different framing throughout, not a patched discussion section.
* **Cascade macro-F1 more than ~5 points below LLM-only with no exposure win** →
  drop C3 to a paragraph.
* **Loop seam detected well above chance** → drop C6, present looping as future
  work.

## 8. What is not pre-registered

Explicitly exploratory, reported as such, uncorrected: per-category fit
differences; correlation between `zs_margin` and human agreement; whether skip
rate predicts fit rating; time-of-day effects; anything arising from the free-text
responses.

## 9. Materials

Lodged with the registration: the frozen corpus manifest (hashes, not content),
`assignment.mjs` and its tests, `session.html`, `models.R`,
`simulate_and_check.py`, and the metrics registry `analysis/metrics.json`.

---

### Remaining `PENDING` items

| Field | Blocked on |
|---|---|
| Pilot effect sizes in §3 | H-04 |
| Final page set and comprehension items in §2 | D-01, then item writing and piloting |
