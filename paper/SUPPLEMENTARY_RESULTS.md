# Web2Music — supplementary results

Material cut from `main.tex` to meet the six-page limit. Section names refer to the
paper. Every number is from the same runs as the paper.

## S1. Evaluation hardware

| Tier | Device | Precision | Used for |
|---|---|---|---|
| CPU laptop | i7-1255U, 16 GB | fp32 | stubbed systems benchmark |
| M4 | Apple M4 (MPS) | fp32 | cold generation, first prompt study |
| GPU | RTX 5060 Laptop, 8 GB (driver 592.82, CUDA 12.8, PyTorch 2.11) | fp16 | generation, end to end, loops, fidelity |
| CPU only | i7-14650HX (the GPU host, GPU disabled) | fp32 | CPU-only generation |

Corpora and clips: the first loop study uses the 141 clips in the service's store
(130 generated, 11 per-mood fallbacks); the second generates 220 fresh clips from
fixed seeds; the fidelity study generates 702 clips; the generator comparison 55 per
generator. The development set has 255 pages (252 category-labelled); the majority
label resolves for 208 pages and agrees with the collection category on 85%.

## S2. Descriptor cost and signal value

- 105 live sites, automated Chromium: median descriptor construction 86 ms against a
  1,989 ms navigation; boilerplate removal keeps 80.8% of visible text. Embedding
  inference is stubbed, so 86 ms excludes the model.
- With the real MiniLM model, loaded once and warm, on 166 sites: median 360 ms (p95
  519 ms), of which the embedding stage is 343 ms (p95 430 ms). 38 of 204 sites could
  not be loaded (DNS or connection errors on infrastructure domains) and are excluded;
  the embedding failed on none of the 166.
- Text extraction, colour histogram and readability: medians 11.0, 3.9 and 1.5 ms.
  Most of the remainder, and the whole p95 tail, is the idle-scheduled vector-store
  search.
- Offline ablation on 255 pages (keyword stage replayed with one signal removed):
  removing colour changes the mood label on 7.5% of pages; reducing the descriptor to
  text alone changes 10.2% (the extra 2.7 points are the readability term). With no
  reliable mood ground truth this shows influence, not benefit.

## S3. Annotation agreement

Krippendorff's alpha over 255 pages: category 0.635, binary sensitivity 0.419, mood
0.195. Mood stays low after coarsening to valence–arousal quadrants (0.121) or NRC VAD
norms (0.300). Category agreement approaches but does not reach the 0.667 threshold,
so cascade results are read as tentative. The three labellers are authors.

## S4. Classifier details

- The shipped default is the full three-stage cascade with the on-device middle stage
  (A6b). The keyword stage stops the cascade at zero cost at confidence >= 0.5.
- Zero-shot back ends: hosted bart-large-mnli, or a quantised ONNX
  nli-deberta-v3-xsmall in the offscreen document. In the ablations the hosted back end
  is replaced by the same bart-large-mnli weights run locally at fp32 (transformers.js);
  the 8-bit quantised export of bart-large-mnli returned near-uniform scores and was not
  used. The deployed offscreen model remains the quantised deberta-v3-xsmall.
- The fully local configuration uses Qwen2.5-7B-Instruct (4-bit, Ollama); it builds the
  page profiles for the fidelity study and is reported separately from the Groq results.
- Hosted-gate sweep (twelve cells): macro-F1 .658–.685, LLM exposure .106–.576 (5.4x
  range), total off-device .756–.757 in every cell.
- Gate trace: lowering the local threshold from 0.45 to 0.30 gives off-device .290 at
  macro-F1 .675; opening it fully gives .594 (A2 is .595).
- Prompt construction: a committed mood selects a row of a per-mood table (tempo span,
  keys, timbre, instruments, reverb, style); tempo is interpolated from energy and tuned
  by one of nine page-type tuners and seven time-of-day tuners; key follows valence;
  darker pages get more reverb; the template ends with loop directives (no vocals, no
  percussion on the loop point).
- Generation worker: batches up to four queries in a 150 ms window, 50 tokens per second
  of requested audio, then upserts the index.

## S5. Latency — full table

| Path | HW | n | p50 | p95 |
|---|---|---|---|---|
| Fallback clip served | CPU laptop | 33 | 7 ms | 153 ms |
| Cache hit, end to end | CPU laptop | 93 | 2.09 s | 2.11 s |
| Cache check, pooled connection | M4 | 30 | 8 ms | 41 ms |
| Cold generation, 10 s clip | CPU only | 12 | 38.5 s | 39.5 s |
| Cold generation, 15 s clip | CPU only | 12 | 62.2 s | 63.6 s |
| Cold generation, 28 s clip, one mood | M4 | 30 | 72.1 s | 105.9 s |
| Cold generation, 28 s clip, 11 moods | M4 | 110 | 72.2 s | 119.4 s |
| Cold generation, 28 s clip | GPU | 33 | 24.3 s | 25.0 s |
| Cold generation, 15 s clip | GPU | 33 | 13.3 s | 13.6 s |
| Navigation to generated audio, A6 (LLM off) | GPU | 110 | 7.7 s | 37.6 s |
| Navigation to generated audio, A6b (local 7B LLM) | GPU | 110 | 7.9 s | 64.6 s |
| Navigation to audible, stubbed | CPU laptop | 54 | 6.86 s | 11.28 s |

Notes. M4: all 140 cold 28 s generations complete; RTF 1.8–2.3; the generator is 71.5 s
of the 72 s median and every other stage is under a second. CPU only: RTF 3.9–4.2, 12
requests per length over three moods, none timed out. Cache hits spend almost all of
their 2.09 s in the cache lookup; pooled Postgres connections lower it to 8 ms. GPU:
RTF 0.87–0.91 end to end across 8–28 s clips, the generator call alone 0.83–0.85; 33
cold requests per length over all 11 moods, none failed or fell back. The M4 row of the
exposure simulation rests on a three-request-per-length duration sweep.

End to end (11 fixture pages x 10 loads = 110 per setup; the first load of each page
generates, the rest hit the cache): A6 first sound 7.7 s median (p95 12.1 s), almost all
of it the 5 s confidence window; generation round trip 29.8 s at p95 for the 28 s
default. A6b first sound 7.9 s (p95 9.2 s); a classifier decision takes 1.2 s against
0.9 s; generated clip at p95 64.6 s because the local 7B LLM shares the 8 GB GPU with
MusicGen, which roughly doubles generation time (so this row bounds a fully local setup
on one GPU, not a hosted LLM). All 220 loads became audible, none timed out.

Concurrency: k = 2, 4, 8 simultaneous 15 s requests finish in 28.3, 54.8, 111.3 s,
within 1–2% of sequential (speedup 1.02, 1.01, 1.01x; five repeats per level), so
batching gives no gain on this GPU and queueing delay grows linearly with k.

Stubbed browser test (11 fixtures, 55 loads, 54 audible): first extraction 0.86 s; mood
stable through the confidence window (median 6.0 s); fallback audible a median 36 ms
(p95 54 ms) after the mood commits. The p95 of 11.28 s is one fixture needing five
extraction passes before its mood commits.

## S6. Exposure simulation details

Moods follow a Markov chain fitted to corpus mood frequencies (curious 36%, focused
18%, neutral 12%, calm 2%); dwell times are Weibull with the median swept 10–120 s and a
longer median for long-form pages; generation times are drawn from the measured
distribution of each tier and clip length; one worker; generation is cancelled when the
next page needs a different clip. Cache keys include the exact profile (mood, tempo,
key, energy, style string) and the cache starts empty each session. The 99-entry
pre-warm grid is credited with the hit rate measured on real profiles: of the 235 corpus
pages none falls on a grid key (75 distinct keys occur), so L2 arises only from an
earlier visit to the same key within a session.

Sensitivity: GPU, 15 s clips: 37%, 52%, 64% of visits at median dwell 10, 30, 120 s;
long-form pages 52%, 62%, 68%. If half the pages hit the pre-warm grid (not observed),
the GPU share falls to 29% of visits at 30 s because a grid hit is served as L2. If the
cache persisted across sessions, 81% of visits would be L2 at 30 s (a trivial upper
bound, since the corpus has 75 distinct keys).

## S7. Conditioning fidelity — statistics

Paired Wilcoxon p = .010, .029 and 4e-5 on the three scorers; mixed-model intercepts
(accounting for the three seeds per page) p = 2e-6, .004 and 3e-8; valence/arousal
Spearman rho = .40 and .51, p < 1e-27. Tagger hit rate for a shuffled mood is already
52%. Audiobox Production Quality: matched 7.03 [6.97, 7.09], 11 shipped fallbacks 7.33,
fixed-prompt control (3 clips) 6.95. Agreement between a prompt and its audio shows only
that the generator follows its prompt, which is why page text against audio is the
primary CLAP measure. A page-agnostic fixed-prompt control was also generated.

## S8. Generator comparison and prompt ablation

15 s requests, RTX 5060; 11 moods x 5 seeds = 55 clips per generator, paired by mood
and seed. RTF is end to end. FAD is the Fréchet distance in LAION-CLAP audio space to
the 11 shipped fallback clips (lower is closer); PQ is Audiobox Production Quality.

| Generator | RTF | Seam abs dE p50 | Retention p50 | FAD (CLAP) | PQ |
|---|---|---|---|---|---|
| MusicGen-small | 0.89 | 0.11 dB | .548 | 0.33 | 7.34 |
| MusicGen-medium | 1.61 | 0.12 dB | .536 | 0.37 | 7.47 |
| AudioLDM2-music | 0.51 | 0.05 dB | .602 | 0.68 | 6.87 |

MusicGen-medium: seam differs from small's by -0.03 dB [-0.08, 0.01]; PQ and FAD within
the small model's interval or marginally worse; a 15 s clip is not ready before it
would have finished playing. AudioLDM2-music: fastest, smallest seam jump, but farthest
from the fallbacks in CLAP space and lowest PQ (6.87 [6.68, 7.05]). Without a listening
study we cannot say which timbre is preferred.

Prompt ablation (bare mood word 3–9 chars, service template ~175, engineered 312),
M4, 15 generations per prompt, no testing:

| Prompt | Chars | abs dE | abs dc | Retention |
|---|---|---|---|---|
| P1 bare mood word | 6 | 3.75 dB | 565 Hz | .527 |
| P2 service template | 175 | 2.63 dB | 509 Hz | .444 |
| P3 engineered (default) | 312 | 4.35 dB | 316 Hz | .393 |

Fixed-seed GPU rerun (11 moods x 5 seeds x 3 prompts = 165 clips, paired): median seam
abs dE 0.14 dB (bare), 0.11 dB (template), 0.14 dB (engineered); engineered minus
template 0.00 dB [-0.10, 0.04] (Wilcoxon p = 0.88); bare minus template -0.05 dB
[-0.11, 0.05] (p = 0.34). Generation time 13.2–13.3 s median for all three; retention
47–55%. The prompt has no measurable effect on loop quality here; whether the
engineered prompt's timbre is preferred is untested.

## S9. Loop quality — full table and checks

| Cut point, crossfade | abs dE p50 | abs dE p95 | >1 dB | abs dc p50 |
|---|---|---|---|---|
| Chroma, 50 ms (orig. default) | 2.44 dB | 10.29 dB | 74% | 405 Hz |
| Chroma, 100 ms | 2.03 dB | 7.87 dB | 81% | 314 Hz |
| Chroma, 250 ms | 2.18 dB | 7.41 dB | 71% | 190 Hz |
| Chroma, 500 ms | 1.82 dB | 7.56 dB | 67% | 133 Hz |
| Measured seam, 50 ms | 0.14 dB | 1.54 dB | 12% | 288 Hz |

113 usable clips of the 141 in the store. The 50 ms crossfade alone lowers the median
discontinuity from 3.73 to 2.64 dB and improves 58.9% of seams. Loudness lands at
-18.09 LUFS against the -18.0 target. The measured-seam selector keeps internal
duration retention (.695 vs .690), is better on 102 of 113 clips and worse on two, and
brings the share above 3 dB from 36% to 1%. The 500 ms crossfade still gives the
smallest centroid jump. The shipped 250 ms crossfade with the selector is not in this
table; it was measured on the fresh study below.

Fresh study: 220 clips (11 moods x 20 seeds); 176 scoreable (39 have a tail under
500 ms, too short for the 250 ms crossfade; 5 have no detectable loop point). Median
abs dE 2.08 dB [1.69, 2.33] (chroma) vs 0.16 dB [0.12, 0.23] (measured seam); share
above 1 dB 72.7% [65.9, 79.0] vs 8.5% [4.5, 12.5] (McNemar p = 2e-34); the 145 clips
that fit the full crossfade give 71.7% and 6.2%. Gapless check: 30 of 30 clips
rendered for 10 cycles through the browser decoder and a looping buffer source show no
inserted silence and are sample-identical cycle to cycle. The seam's centroid change is
within the clip's 95th percentile of interior change in 91.4% [87.7, 95.0] of the 220
clips; the energy jump is within its 95th percentile in all 220, which is expected
because the selector minimises it, so it is not counted as evidence.

## S10. Restraint

| Detector | Missed | False alarms | Non-English caught |
|---|---|---|---|
| Term lists (default) | 19/29 | 3/18 | 0/4 |
| Term lists + NLI (hosted) | 0/29 | 11/18 | 4/4 |

Hand-written slice: 29 sensitive, 18 not, built from the term lists' own vocabulary.
Misses by cause: out-of-list terms 7, euphemisms 4, non-English 4, single ambiguous
terms 4. NLI scores on detected pages 0.83–0.92. The hosted run receives every page
without a hard-severe term, so the check itself discloses the pages it protects; the
disclosure property holds only with the on-device back end. Its eleven false alarms
include all six plainly benign pages (e.g. a Rust tutorial) because the prompt had no
"unrelated" option. The shipped on-device check adds that third hypothesis and is not
evaluated. Restraint policies: fourteen executable, all pass (silence on sensitive
pages, muting and ducking, bypass of payment and browser-internal pages, hashed-URL
telemetry, seven unit cases).

Network audit: 12 fixture pages (one per mood plus a crisis-support page), three visits
each. A6: no request body carried page text; 850 bytes per page to the generation
service. A6b: page text left on 30 of 36 visits (83%), all to the LLM proxy (5.9 kB per
page; 0.8 kB to the generation service). The fixtures are not representative, so 83% is
not the disclosure rate (47% of the 255 development pages in the replayed cascade). No
telemetry left the browser. The generation service sees category and mood per page.

## S11. Architecture details

Descriptor: 384-dimensional MiniLM embedding; area-weighted HSL histogram over up to
800 elements; scroll and cursor velocity; readability; revisit detection by cosine
similarity against an IndexedDB store capped at 2,000 entries. Cache index: exact on
mood, style and key; bucketed on energy, valence, arousal, tempo, duration. Generator
back ends: MusicGen-small (300M, default), MusicGen-medium, AudioLDM2-music. Playback:
two decks alternating raw audio buffers; three multiplicative gain stages; fallback
crossfaded to the generated clip over 3 s on an equal-power curve; background tabs
ducked to 0.1 of volume; payment, banking and browser-internal URLs exempt; telemetry
ring buffer of 2,000 events with HMAC-SHA-256 URL digests under a random per-install key;
the buffer is sent nowhere unless the user exports it.

## S12. Related work (cut detail)

MusicGen uses a frozen T5 text encoder, optional melody conditioning and checkpoints
from 300M to 3.3B. MusicLM generates hierarchically from semantic to SoundStream tokens
conditioned on MuLan embeddings; weights are not released. AudioLDM uses CLAP embeddings
for latent diffusion; Stable Audio uses timing embeddings for arbitrary length. LoopGen
adapts MAGNeT so the end of the sequence is generated with the start as context.
MetaBGM keeps music across scene changes. Discussion Jockey 2 showed a relaxation effect
in a user study. Context-AI Tunes was tested on 26 users. Casper uses identifier rules,
NER and an LLM. FrugalGPT reaches GPT-4-level performance at up to 98% lower cost;
Hybrid LLM uses up to 40% fewer large-model calls at similar quality.

## S13. Limitations (long form)

The protocol and instruments for a within-subjects listening study (page-matched
against shuffled audio; forced choice, Likert ratings, dwell, skip, mute) are released
with the code. Fidelity proxies inherit model biases (CLAP trained on music captions;
mood-to-tag mapping an assumption); the effects are small (CLAP retrieval 12.5% against
10% chance). Agreement between authors who share a design may overstate reliability.
The on-device sensitive-page check was not evaluated on real crisis pages. The
Weibull shape and long-form multiplier of the dwell model are modelled, not measured;
the corpus is not a sample of real browsing; the median-dwell sweep shows sensitivity,
not truth for any user. The end-to-end and network runs use 11 and 12 fixture pages.
The A6b run used a local 7B LLM on the same GPU as the generator. Macro-F1 intervals are
about +/-.05, so smaller differences are not resolved. The hosted LLM's behaviour can
change under the same model name and the local Qwen2.5-7B configuration gives
different answers. Hardware: one laptop GPU (also CPU-only), one Apple M4, one CPU
laptop. Future work: loop-closed generation, independent annotators, a listening study,
other continuous contexts such as documents and code editors.
