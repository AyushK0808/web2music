# Web2Music — Paper Readiness Roadmap

> **Reviewed:** 2026-07-11 · All findings below were verified against the code at commit `dde6caf` (+ working tree).
> **Effort tags:** `[S]` = hours · `[M]` = days · `[L]` = weeks (these are the paper's actual workload).

---

## 0. Verdict & Contribution Framing

Using `facebook/musicgen-small` behind FastAPI is engineering, not a contribution. The **defensible novelty is the web-context → music conditioning pipeline and its human evaluation**: *"context-adaptive generative ambient music for web browsing."* Nobody has published a system that infers page mood from text + color + behavior and generates matching, seamlessly-looping ambient audio — lead with that, use the audio backend as substrate.

**A second citable contribution is within reach:** a public **webpage→mood annotated corpus** (none exists), which doubles as the eval set.

**A third path, if the fine-tuning track (§4.4) is taken:** conditioning MusicGen directly on continuous valence–arousal + tempo turns Feature D from *substrate* into a candidate **co-contribution** (mood/tempo-controllable ambient generation with a control-fidelity eval). This is a deliberate scope decision, not a free add-on: it is weeks of `[L]` work and shifts the paper's center of gravity. Doing the fine-tuning *and* under-claiming it in the write-up is the worst of both — decide up front whether D is substrate or a second contribution.

| Venue | Fit | Condition |
|---|---|---|
| **IUI / ACM Multimedia** (primary) | System + dataset + user study | Do the eval plan in §6 |
| **CHI / IMWUT** | Interaction contribution | Add a longitudinal field study |
| **ISMIR / DAFx / ICASSP** | Audio-loop *or* conditioning contribution | Seamless-loop work (§4) **or** the mood/tempo-conditioned fine-tuning track (§4.4) deepened into a core claim, with control-fidelity eval (§6) |
| **TAFFC** | Affective computing | Lean on the mood-classification eval + calibration |

---

## 1. Show-Stoppers — fix before running ANY experiment

These three bugs mean the system a study participant would experience today is a **non-adaptive, non-looping, constant calm clip**. Any data collected before fixing them measures a system that doesn't exist.

### X1 · The B→D handoff never connects `[L]` — **Tvisha + Sneha**
Feature B outputs a nested camelCase payload ([b4_promptEngineer.js:191-232](mood-classification/feature_b/b4_promptEngineer.js#L191-L232)); Feature D expects a flat snake_case profile ([main.py:26](audio-generation/main.py#L26)). Nothing flattens it ([background_integration.js:29-37](mood-classification/background_integration.js#L29-L37) forwards verbatim), so [d1_validate.py](audio-generation/d1_validate.py) fills **all defaults** → every page generates identical "calm ambient, 80 bpm, C major" audio. Even after flattening:

- [ ] D discards B4's engineered prompt entirely and rebuilds a weaker one in [d2_prompt.py](audio-generation/d2_prompt.py) (drops instruments, timbre, reverb, ambience, dynamics, atmosphere tags). Two competing MusicGen prompt builders exist; the system uses the weaker.
- [ ] Mood taxonomy mismatch: B emits 11 moods; D's instrument map ([d2_prompt.py:15-22](audio-generation/d2_prompt.py#L15-L22)) covers 6, of which `melancholic`/`positive` are unreachable, and 7 of B's 11 moods silently degrade to "ambient pads".
- [ ] `contentCategory` (B, camelCase) ≠ `content_category` (D, snake_case).
- [ ] B4's generic prompt requests "60–90 seconds per loop" ([b4_promptEngineer.js:103](mood-classification/feature_b/b4_promptEngineer.js#L103)); D generates ~5.1 s and accepts no duration parameter.
- [ ] **No continuous `valence` in the profile** — Handoff-2 today carries `mood` (discrete string), `energy` (≈ arousal), `bpm`, `key`. The fine-tuned model (§4.4) conditions on continuous `(valence, arousal, log bpm)`. B must emit a **`valence` scalar in `[-1, 1]`** (positive = positive affect — depends on X3 being fixed first) and rename/duplicate `energy` → `arousal`. — **Sneha** (emit) `[S–M]`
- [ ] **`d2_prompt.py` role changes under fine-tuning** — for the conditioned generator, `d2_prompt.py` builds a **conditioning vector** `(v, a, log bpm)` (+ optional text), not a mood→instrument text prompt. The discrete instrument map (`d2_prompt.py:15-22`) is bypassed entirely, which **dissolves the 11-vs-6 mood-taxonomy mismatch** flagged above rather than patching it. — **Tvisha** (consume) `[M]`

**Fix:** one JSON-schema'd Handoff-2 contract validated on both sides; D consumes B4's `prompt`; one shared mood taxonomy; add a `duration` field, plus `valence`/`arousal` scalars alongside it (keep the discrete `mood`/`style` fields for the `B0` text-prompt baseline in §4.4 so both generators read the same contract). Then A/B the two prompt builders (CLAP/FAD) and delete the loser — that's a free ablation for the paper.

### X2 · Loop-point detection is degenerate — always returns the full clip `[M]` — **Vedant**
The self-similarity search ([d4_process.py:42-51](audio-generation/d4_process.py#L42-L51)) compares the first 10 chroma frames against every window **including i=0**, where correlation is exactly 1.0 (self-match). `np.argmax` → always frame 0 → snaps to first beat → the `< 1000 ms` guard ([d4_process.py:62-63](audio-generation/d4_process.py#L62-L63)) fires → `loop_point_ms = len(audio)`, every time. (Any constant window instead propagates NaN through argmax to a garbage index.) The chroma analysis is effectively dead code; the README's `loop_point_ms: 18400` example is not producible.

**Fix:** start the search past a minimum loop length (≥ 2–4 s), `np.nan_to_num`, vectorize the correlation loop, snap to **bar** boundaries (not any beat), equal-power crossfade head→tail instead of `fade_out(50)` ([d4_process.py:65-66](audio-generation/d4_process.py#L65-L66)) — a fade to silence is audible on every repeat.

### X3 · Inverted valence scale in the tier-2 LLM prompt `[S]` — **Sneha**
[b2_moodClassifier.js:239](mood-classification/feature_b/b2_moodClassifier.js#L239) tells the model `"valenceHint": <-1.0 positive to 1.0 negative>`, but `computeValenceHint` ([b2:441-456](mood-classification/feature_b/b2_moodClassifier.js#L441-L456)), `pickKey` ([b3:178-184](mood-classification/feature_b/b3_musicProfileGenerator.js#L178-L184)), and B4's valence adjectives all treat positive-as-positive. **Every tier-2 result flips major/minor key choice and prompt tone.** Fix the prompt text and clamp the parsed value.

---

## 2. Feature A — `data-extraction/`

### 2.1 Changes

**Small `[S]`**
- [ ] **Embedding cache ignores backend/model** — [pageData.js:153](data-extraction/pageData.js#L153) keys on `url + text-hash` only; switching `local` (384-dim) → `openai` (1536-dim) returns a stale wrong-model vector. Include backend + model in `cacheKey()`. — **Pari**
- [ ] **No fetch timeout** — [Embeddingmodel.js](data-extraction/Embeddingmodel.js) `openai`/`service` backends can hang forever (Feature B uses 8 s AbortControllers; A has none). Add configurable AbortController timeout. — **Pari**
- [ ] **Failed local pipeline cached forever** — [Embeddingmodel.js:85-91](data-extraction/Embeddingmodel.js#L85-L91): a rejected `localPipelinePromise` never clears; every later call fails. Clear on rejection. — **Pari**
- [ ] **Embed service open to any local caller** — [embedService.js](data-extraction/docker/embedService.js) sends `Access-Control-Allow-Origin: *` (line 37) and binds all interfaces (line 107): any webpage/LAN host can burn the OpenAI key. Bind `127.0.0.1`, require a shared-secret header, restrict CORS. Also `readBody()` rejects >1 MB but never `req.destroy()`s. — **Pari**
- [ ] **`extractPageText` assumes `doc.body`** — [Textextractor.js:107](data-extraction/Textextractor.js#L107) throws before DOM-ready / on frameset pages → empty handoff. Null-guard. — **Pari**
- [ ] **Text-density scoring inert under jsdom** — [Textextractor.js:19](data-extraction/Textextractor.js#L19): `innerText` is undefined in jsdom so every candidate scores 0 and the playground exercises a different code path than the browser. Fall back to `textContent` in `textDensityScore` too. — **Pari**
- [ ] **First handoff always reports zero behaviour** — default tracker starts lazily ([behaviorTracker.js:158-164](data-extraction/behaviorTracker.js#L158-L164)); start at content-script init. Also only listens on `window` scroll — misses inner scrollable containers, horizontal scroll, touch; use `{capture: true}`. — **Pari**
- [ ] **English-only readability** — [Readability.js](data-extraction/Readability.js) Flesch is meaningless for non-English; `lang` is extracted but never gates it. Return the neutral 0.5 default when lang ≠ en. — **Pari**
- [ ] **Syllable counters drift** — [Readability.js:23](data-extraction/Readability.js#L23) returns 0 for an empty word; [b1_contentUnderstanding.js:93](mood-classification/feature_b/b1_contentUnderstanding.js#L93) returns 1 — despite both files claiming "identical mapping". Unify (the §5 integration test would have caught this). — **Pari**

**Medium `[M]`**
- [ ] **Boilerplate stripping uses substring matching** — [Textextractor.js:111-114](data-extraction/Textextractor.js#L111-L114): `[class*="ad"]` deletes `shadow`/`gradient`/`download`/`badge`/`loading`; `menu` matches `document-menu` content wrappers. Tokenize className/id and match whole words. — **Pari**
- [ ] **No test suite** — `package.json` has only `play` (eyeball-only [playground.js](data-extraction/playground.js)). Port playground scenarios to `node:test` + `assert`; jsdom is already a devDependency. — **Pari**

### 2.2 Additions for the paper
- [ ] Per-stage extraction latency + failure-rate telemetry (feeds the §6 systems eval). — **Pari**
- [ ] Element cap / sampling in [Colorextractor.js](data-extraction/Colorextractor.js) (`getComputedStyle` + `getBoundingClientRect` on every element = forced-layout risk) and measure extraction cost on the top-100 sites. — **Pari**

### 2.3 Limitations to declare (not fix)
- Color extraction sees only `background-color` — no background images, gradients, `<img>` content (photo-heavy pages read achromatic); `parseRgba` can't parse hex/named/oklch; overlapping elements double-count (no occlusion). Frame it as a **hue-bias signal, not ground truth**.
- Behaviour speeds (scroll/cursor px/s) are coarse proxies for affect; the doomscrolling→tense inference is an unvalidated assumption — say so.

---

## 3. Feature B — `mood-classification/`

### 3.1 Changes

**Small `[S]`**
- [ ] **X3 — inverted valence prompt** (see §1). — **Sneha**
- [ ] **Validate tier-2 LLM output** — [b2:400-414](mood-classification/feature_b/b2_moodClassifier.js#L400-L414) trusts `mood`/`pageType`/`confidence` as-is (B1 guards hallucinated categories; B2 has no equivalent). Validate against `MOODS` + page-type list, clamp numeric hints. — **Sneha**
- [ ] **Set `temperature: 0`** on both LLM calls (currently unset → Anthropic default 1.0 — nondeterministic classification; kills reproducibility). — **Sneha**
- [ ] **Prompt-injection hardening** — `summariseContent` puts the page's first two sentences **verbatim** into the LLM prompt ([b1:331-335](mood-classification/feature_b/b1_contentUnderstanding.js#L331-L335) → [b2:216-240](mood-classification/feature_b/b2_moodClassifier.js#L216-L240)). A page opening with "Ignore previous instructions…" can steer the classifier. Delimit page content clearly; demonstrate the attack + mitigation as a robustness subsection (cheap, reviewers love it). — **Sneha**
- [ ] **Browser CORS + client-side key** — direct `api.anthropic.com` calls lack `anthropic-dangerous-direct-browser-access: true` (works in Node tests, fails CORS in the extension) and ship the key client-side — the exact problem A's docker service was built to avoid. Header short-term; proxy long-term. — **Sneha**
- [ ] **Model ID hardcoded twice** — `claude-haiku-4-5-20251001` in [b1:241](mood-classification/feature_b/b1_contentUnderstanding.js#L241) and [b2:269](mood-classification/feature_b/b2_moodClassifier.js#L269); lift into `_config`. — **Sneha**
- [ ] **`registerFeatureBListener` returns `true` but never calls `sendResponse`** — [index.js:174-196](mood-classification/feature_b/index.js#L174-L196) leaks open message ports. Return `false`. — **Sneha**
- [ ] **Pipeline errors bypass the 5 s stability rule** — [index.js:144-151](mood-classification/feature_b/index.js#L144-L151): one transient error hard-switches to the calm fallback mid-session. Route through `shouldTransition` or emit only when nothing is playing. — **Sneha**
- [ ] **Bypass results drop pass-through fields** — [b2:344-349](mood-classification/feature_b/b2_moodClassifier.js#L344-L349) omit `category`/`colors`/`speeds`, so B3 labels payment pages `contentCategory: "Entertainment"`. — **Sneha**
- [ ] **Feature A's enrichment ignored** — `runB1` recomputes `readingComplexity` and derives its own `isImageOnly` ([b1:388-392](mood-classification/feature_b/b1_contentUnderstanding.js#L388-L392)), never reading `pageData.isImageOnly`/`flesch`/`wordCount`/`colorEnergy`; `embedding` passes through unused. Prefer A's values when present. — **Sneha**
- [ ] **Handoff-1 version never checked** — A stamps `handoffVersion: "1.0.0"`; B never validates it. Mirror the `d1_validate.py` philosophy the comments cite. — **Sneha**
- [ ] **English-only heuristics** — STOPWORDS / MOOD_RULES / CATEGORY_KEYWORDS / SENSITIVE_PATTERNS are English; `lang` arrives and is never used. When lang ≠ en, skip tier-1 and escalate straight to the LLM. — **Sneha**
- [ ] **Sensitive regexes false-positive easily** — [b1:28-33](mood-classification/feature_b/b1_contentUnderstanding.js#L28-L33): "The Great Depression", a war-history article, "grief counselling degree programs" all trigger the override. Require ≥2 hits or combine with category context. — **Sneha**
- [ ] **`runB3` always uses the wall clock** — [b3:214](mood-classification/feature_b/b3_musicProfileGenerator.js#L214) never passes the injectable hour; full-path untestable at fixed time. Accept an optional hour in `moodContext`. — **Sneha**
- [ ] **Test suite sleeps 10.5 s for real** — two 5.1 s `setTimeout`s ([feature_b_test.js:557](mood-classification/feature_b_test.js#L557), [:573](mood-classification/feature_b_test.js#L573)). Make `CONFIDENCE_WINDOW_MS` injectable. — **Sneha**
- [ ] **README drift** — references `feature_b.test.js` / `manual-tests/` (actual: `feature_b_test.js`, `manual_tests/`) and says tier-2 uses "claude-sonnet-4-6" ([README.md:99](mood-classification/README.md#L99)) while code uses Haiku 4.5. — **Sneha**
- [ ] **Bare `package.json`** — no `name`/`version`/`private: true`/`engines`; mirror data-extraction's metadata. — **Sneha**

**Medium `[M]`**
- [ ] **MV3 state won't survive** — `_pendingMood`/`_currentMood` are module globals ([index.js:29-32](mood-classification/feature_b/index.js#L29-L32)): service-worker restarts lose state (the 5 s window restarts forever), state is shared across tabs, and nothing schedules a re-check — a static page may never get music; the idle fade is event-driven so it never fires without a new handoff. Persist per-tab state in `chrome.storage.session`; use `chrome.alarms` to re-evaluate deadlines. — **Sneha**
- [ ] **Idle-fade design contradiction** — a user reading one long article for 6 min gets silence ([index.js:56-76](mood-classification/feature_b/index.js#L56-L76)), against the product story. Reset the idle clock on behaviour events, or justify via user study. — **Sneha**
- [ ] **Golden-fixture tests against the real API** — all LLM fetches are mocked ([feature_b_test.js:75-119](mood-classification/feature_b_test.js#L75-L119)); prompt-format drift would go undetected. Record real Claude responses as fixtures. — **Sneha**

### 3.2 Additions for the paper `[L]`
- [ ] **Labeled ground-truth corpus** — 200–500 pages, stratified across the 13 categories, ≥3 annotators, **valence–arousal (Russell's circumplex)** + categorical mood; report **Fleiss' κ**; release it (this is the second contribution).
- [ ] **Baselines** — random, majority-class, LLM-only (skip tier-1), and **embedding-kNN** (embeddings are shipped and never used — a free baseline). Justify the two-tier architecture as a measured tradeoff, not an implementation detail.
- [ ] **Ablations on hand-tuned constants** — `MIN_CATEGORY_HITS=3`, the 0.5 escalation threshold, colour/behaviour bias weights (0.1–0.3), `PAGE_TYPE_MODIFIERS`, time-of-day adjustments. "Why these numbers" needs an ablation answer.
- [ ] **Calibration** — tier-1 confidence is `hits/5` ([b2:201](mood-classification/feature_b/b2_moodClassifier.js#L201)), blended is `score/3` ([b2:375](mood-classification/feature_b/b2_moodClassifier.js#L375)) — arbitrary scalings vs. a 0.5 threshold; LLM self-reported confidence is miscalibrated. Report ECE / escalation-rate-vs-accuracy curves.
- [ ] **Tier-2 value quantification** — % of traffic staying tier-1; how often tier-2 *corrects* vs. agrees with tier-1; accuracy delta per added latency/cost.
- [ ] **Perceptual validation of B3's mood→BPM/key/instrument tables** against DEAM / PMEmo / EmoMusic or a listener study — currently music-theory intuition. Highest-value single addition if the claim involves music quality.
- [ ] **Taxonomy grounding** — cite Russell (1980) / Thayer to justify the 11 moods and valence/energy framing.
- [ ] **Telemetry** — log every `runFeatureB` decision (tier, confidence, latency, tokens) — prerequisite for the corpus and the cost/latency results.
- [ ] **Sensitive-content FNR/FPR evaluation** + ethics paragraph (see §7).

### 3.3 Limitations to declare
- Tier-1 is bag-of-words with **no negation handling** ("not scary" hits scary) and no context window.
- Time-of-day and colour priors are Western/design-convention assumptions.

---

## 4. Feature D — `audio-generation/`

### 4.1 Changes

**Small `[S]`**
- [ ] **GPU + fp16** — [d3_generate.py:7](audio-generation/d3_generate.py#L7) never sets a device (`pipeline(...)` defaults to CPU even when CUDA exists); `requirements.txt` pins nothing. 10–30× win: `device="cuda"`, `torch_dtype=float16`. — **Tvisha**
- [ ] **Blocking call in async endpoint** — [main.py:47](audio-generation/main.py#L47) runs multi-second `generate_audio` on the event loop; one request stalls all others. `await asyncio.to_thread(...)`. — **Tvisha**
- [ ] **Cache key omits `key`** — [d5_cache_local.py:22](audio-generation/d5_cache_local.py#L22) and [d5_cache.py:8](audio-generation/d5_cache.py#L8): `key` is in the prompt but not the cache key → "C major" and "A minor" requests collide to one clip. Add it or drop it from the prompt. — **Tvisha**
- [ ] **Docs vs. code: clip length** — README says "~28 s" ([README.md:19](audio-generation/README.md#L19)); `max_new_tokens=256` at 50 Hz = **~5.1 s** (28 s needs ~1400 tokens). Reconcile, and expose `duration` as an API parameter (X1). — **Tvisha**
- [ ] **Seed the generation** — `do_sample=True` unseeded; log seeds for reproducibility. — **Tvisha**
- [ ] **Pin `requirements.txt`**; add Pydantic request model (README already plans it); note `/generate` has no auth/rate-limiting (each request = GPU-minutes — cost-DoS surface; one sentence in deployment discussion). — **Tvisha**
- [ ] **`torch.compile`** for ~1.5–2× on warm calls; consider lower `guidance_scale` (CFG = 2 forward passes/step) when latency-bound. — **Tvisha**

**Medium `[M]`**
- [ ] **X2 — real loop detection + equal-power crossfade** (see §1). — **Vedant**
- [ ] **Gapless export** — MP3 (128k, [d4_process.py:69](audio-generation/d4_process.py#L69)) inserts encoder delay/padding → audible gap on loop even with a perfect cut. Export **WAV or Ogg/Opus** (Opus is gapless), or have the player decode into Web Audio `AudioBufferSourceNode` with `loopStart`/`loopEnd` from the `loop_point_ms` metadata. — **Vedant**
- [ ] **Longer / extendable audio** — raise tokens (500→10 s, 750→15 s; quality degrades past ~1500/30 s = training window); for arbitrary length use MusicGen **audio-continuation** (feed the tail back as audio prompt), or generate a clip whose end resolves toward its own start for intrinsic loopability. — **Tvisha**
- [ ] **Batch concurrent requests** (MusicGen supports batched generation — near-free throughput) and **pre-warm the cache** for the common mood×style×bpm grid at startup. — **Tvisha**
- [ ] **Retry logic + fallback clips** (README-planned; `fallback_clips/` referenced but absent). — **Tvisha**
- [ ] **`d3_generate.py` adapter switch** — when `USE_FINETUNED=true`, load the LoRA adapter + conditioning encoder (§4.4) instead of the stock pipeline; keep stock `facebook/musicgen-small` reachable as the `B0` baseline. Gate behind a config flag so the eval harness can A/B both from one server. — **Tvisha**

**Small `[S]`** (cache correctness under conditioning)
- [ ] **Cache key under continuous conditioning** — the low/mid/high bpm bucketing + energy-rounded key (README "Caching Logic") is too coarse once `(v, a, bpm)` are continuous and `duration`/`seed`/`guidance` matter. Key on quantized `(v, a, bpm, duration_s, seed, guidance_scales)`; document the granularity. Folds into the existing `d5` cache-key bug. — **Tvisha**

### 4.2 Additions for the paper `[L]`
- [ ] **Implement the four empty experiment stubs** — [experiments/](audio-generation/experiments/) (`d1_prompt_ablation.py`, `d2_loop_test.py`, `d3_clip_length.py`, `d4_latency.py`) are 1-line files that map 1:1 onto the results section: — **Tvisha**
  - **Objective metrics:** FAD (VGGish/CLAP embedding), CLAP score (prompt adherence), tempo accuracy (requested vs. librosa-detected BPM — already computed in d4), key accuracy (Krumhansl–Schmuckler), loudness consistency, **seam-discontinuity metric** (spectral/energy delta at the loop point: your method vs. naive cut vs. fade-out).
  - **Curves:** clip length vs. quality; latency distribution (cold/warm, cache hit/miss, CPU/GPU).
  - **Model comparison:** musicgen-small vs. medium vs. **MAGNeT** (~7× faster, non-autoregressive) vs. Stable Audio Open small.
- [ ] Fill in [research_log.md](audio-generation/research_log.md) (currently empty) as the running lab notebook. — **Tvisha**

### 4.3 Limitations to declare
- **MusicGen weights are CC-BY-NC 4.0** — fine for research, blocks commercial deployment; must appear in the artifact/limitations statement.
- musicgen-small quality ceiling; 30 s training-window constraint.
- **Valence < arousal controllability** — expect a per-axis asymmetry; report both axes, never an average.
- **Weak training labels** — tag→V-A via NRC-VAD is approximate; DEAM provides the gold continuous labels for eval only.

---

## 4.4 Feature D — Fine-Tuning Track (mood/tempo-conditioned MusicGen)

> Optional but high-value. Only start after X1/X2/X3 (Phase 1) — a conditioned model on a broken handoff still generates constant calm audio. Build the eval harness (§4.4.4) **before** any training run. See [FEATURE_DESCRIPTION.md](audio-generation/FEATURE_DESCRIPTION.md) for the full design.

### 4.4.1 Rationale — why fine-tune vs. prompt stock MusicGen

Three problems in the stock path are structural, not bugs: (1) the 11→6 mood-taxonomy collapse, (2) the lossy prompt rebuild that drops instrument/timbre/reverb tags, (3) text-prompt tempo ("75 bpm") only loosely honored. Continuous `(v, a, log bpm)` conditioning removes all three by construction. **Fine-tuning strategy itself is an ablation, not an assumption** — at 300M params, LoRA is the default for prior-preservation, not for memory (full FT fits the GPU too).

### 4.4.2 Datasets `[L]` — **(FT-lead)** / **Tvisha**

- [ ] **MTG-Jamendo** (mood/theme subset, ~18k CC-licensed tracks) — main training corpus. Instrumental filter via the `instrumental` tag + a vocal-activity check; **no Demucs separation** (artifacts leak into training).
- [ ] **DEAM** — per-0.5s continuous valence/arousal; the source of the *time-varying* control claim and the gold eval set. Also trains the V-A probe (§4.4.4).
- [ ] **NRC-VAD norms** — map Jamendo mood tags → weak `(v, a)` labels for the training corpus.
- [ ] **Tempo pseudo-labels** — beat-track the whole corpus (`madmom` / `BeatThis`); **GiantSteps Tempo** is a tracker sanity-check set only, not training data.
- [ ] **FAD reference** — held-out Jamendo-test + **Song Describer** (clean CC audio, never trained on).
- [ ] **Artist-level split** — no artist overlap across train/val/test; DEAM-test artists excluded from generator **and** probe training (track-level splits leak — reviewers catch this).
- [ ] **Pre-tokenize** with frozen EnCodec offline; cache tokens to disk.
- [ ] *(Optional)* EMOPIA (piano-only) as a clean single-instrument case study; PMEmo eval-only.

### 4.4.3 Conditioning + training `[L]` — **(FT-lead)** / **Tvisha**

- [ ] **Conditioning encoder** — `(v, a) ∈ [-1,1]²` and `log(bpm)` → Fourier features → MLPs → `K` prefix tokens via cross-attention. FiLM variant reserved as an ablation row.
- [ ] **Adapter** — LoRA (`r = 16–64`) on attention incl. cross-attention; conditioning MLPs trained in full at higher LR. DoRA as a same-cost drop-in row. Freeze EnCodec + T5.
- [ ] **Per-stream CFG dropout (~15%)** applied independently to text / mood / tempo → independent guidance scales at inference.
- [ ] **Train** — bf16 + grad checkpointing + 8-bit Adam, grad-accum to eff. batch 32–64; LR ~1e-4 (LoRA) / ~3e-4 (new MLPs), cosine + short warmup. Select checkpoints on **val control-fidelity, not NLL alone**. Skip QLoRA at 300M.
- [ ] **Tuning-strategy ablation** — conditioning-only (frozen backbone) → LoRA/DoRA → cross-attn-only unfreeze → full FT. Answers the "why not full FT at 300M?" reviewer question empirically. New stub: `experiments/d5_finetune_ablation.py`.

### 4.4.4 Eval harness — build & freeze BEFORE training `[L]` — **Vedant** (+ **Tvisha**)

Extends §4.2 audio metrics (FAD/CLAP/tempo/key/seam) with **control-fidelity**:

- [ ] **Tempo control** — beat-track *generated* audio → MAE + Accuracy@±4% vs target bpm.
- [ ] **Mood control** — frozen **MERT** encoder + MLP probe (trained on DEAM-train) → **per-axis** V-A MAE + R² on 5s windows. Report valence and arousal separately (valence is measurably harder to control — expect the asymmetry).
- [ ] **Trajectory tracking** — piecewise `(v, a, bpm)` ramps → tracking error + control lag.
- [ ] **Probe sanity** — report the V-A probe's own R² on held-out DEAM artists so control numbers are interpretable.

### 4.4.5 Baselines `[M]` — **Tvisha**

- [ ] `B0` — stock `musicgen-small`, mood+tempo in the **text prompt** (this is the current system; the honest "does fine-tuning help" comparison).
- [ ] `B1` — identical LoRA recipe but **discrete mood-tag tokens** (isolates the *continuous-V-A* claim from "any fine-tuning helps"). **This is the load-bearing ablation.**
- [ ] `B2` — MusiConGen (tempo-control comparison, inference only).
- [ ] `B3` — *(optional)* Magenta RealTime as a streaming-quality reference.

### 4.4.6 Decision gates — **(FT-lead)**

- [ ] **Gate A (improvement):** fine-tuned beats `B0` on tempo + V-A with bootstrap `p < 0.05`, else iterate (FiLM vs prefix, upweight DEAM, LR/rank sweep).
- [ ] **Gate B (no quality collapse):** FAD within ~10% of `B0`, else lower rank / mix in unconditioned data / fewer epochs.
- [ ] **Only after both gates:** post-training int8 weight-only quant of the LM (**keep EnCodec decoder fp16**); re-run tempo/V-A/FAD → bf16-vs-int8 RTF table. This is a deployment ablation, not a contribution.

**New experiment stubs:** `d5_finetune_ablation.py` (tuning-strategy sweep), `d6_control_fidelity.py` (tempo/V-A/trajectory metrics vs targets), `d7_baselines.py` (B0/B1/B2 generation + scoring harness) — under `audio-generation/experiments/`. Plus a `finetune/` package (`data/prepare.py`, `train/finetune.py`, `configs/*.yaml`) and `research_log.md` entries per run (data version, run ID, metric deltas).

---

## 5. Cross-Cutting

- [ ] **X1 — unified, validated Handoff-2 contract** (see §1) `[L]`. — **Tvisha + Sneha**
- [ ] **One end-to-end integration test** `[M]` — feed `buildPageData()` output (jsdom + mocked embedder) into `runFeatureB()` and its output into a `/generate` request validator, in one process. Would have caught X1, X3, and the enrichment-ignored bug. (Module-system split: A is CommonJS+globals, B is ESM — the test forces the interop decision.) — **Vedant**
- [ ] **Feature C source in the repo** `[M]` — the playback engine exists only as the compiled `ui.crx` binary. Artifact evaluation cannot run the loop end-to-end. Include source, Web Audio gapless looping, and **mute / skip / "wrong mood" controls** — which double as implicit ground-truth labels for the field study. — **Vedant**
- [ ] **Reproducibility bundle** `[S–M]` — pinned deps (Python + npm), pinned model IDs (HF revision + Claude), seeds, `temperature: 0`, released prompts, golden fixtures, experiment configs. — **Vedant**
- [ ] **End-to-end latency budget** `[M]` — page-load → music-playing percentiles across A extraction, B tiers, D generation (cold/warm, hit/miss). D's `timings` dict is the right skeleton; A and B have nothing. — **Vedant**

---

## 6. Evaluation Plan (the actual paper content) `[L]`

1. **Classification eval** on the annotated corpus (§3.2): accuracy + valence-arousal RMSE, κ, baselines, ablations, calibration, escalation analysis, non-English behavior.
2. **Audio eval** (§4.2): FAD / CLAP / tempo / key / loudness / seam metrics, ablations (prompt builders, loop methods, models, clip lengths), multiple seeds, means ± CI. If the fine-tuning track (§4.4) is taken, add **control-fidelity** (tempo MAE + Acc@±4%, per-axis V-A MAE/R², trajectory tracking) across the fine-tuned model + `B0`/`B1`/`B2`, fixed seeds, means ± CI, bootstrap significance for the fine-tuning vs `B0` deltas. The `B1` discrete-tag row is required to support the continuous-conditioning claim.
3. **Listening study:** N ≥ 20, MUSHRA-style pairwise on (a) quality, (b) page-mood match, (c) loop seamlessness (your loop vs. naive cut vs. no loop). Power analysis, Holm–Bonferroni, CIs.
4. **Browsing study (the headline):** adaptive generative music vs. **static playlist** vs. **retrieval from a curated loop library** vs. silence. The retrieval baseline is critical — reviewers *will* ask "why generate at all instead of picking from 50 pre-made loops?"; answer with data (mood-match ratings, annoyance, skip/mute rate, task performance, self-reported affect). Requires IRB/ethics approval.
5. **Artifact release:** corpus, prompts, generated-clip eval set, code, experiment scripts.

---

## 7. Ethics & Privacy (required section, not optional)

- **Data flow statement:** tier-2 sends title + summary + keywords + scroll/cursor speeds to Anthropic; embeddings default to **local MiniLM** (good — say so), but `openai`/`service` backends ship up to 8000 chars of page text to OpenAI. Browsing content is sensitive data: document what leaves the device, when, retention, and opt-in.
- [ ] **Fully-local mode** (tier-1 only + local embeddings) with its accuracy cost quantified — the privacy-utility tradeoff is itself a publishable ablation `[M]`. — **Pari**
- **Sensitive-content policy:** auto-playing *uplifting* music on grief/crisis pages ([b2:325-341](mood-classification/feature_b/b2_moodClassifier.js#L325-L341)) is contestable — some users will find any music inappropriate there. Consider **silence-by-default** with uplifting as opt-in; evaluate the detector's FNR/FPR (4 regexes today); write the ethics paragraph pre-empting reviewer pushback. — **Sneha**
- **IRB / informed consent** for all human studies; **CC-BY-NC** model license in the artifact statement.

---

## 8. Sequencing

| Phase | Contents | Gate |
|---|---|---|
| **1 · Correctness** | X1, X2, X3 + all `[S]` items in §2–§4 | Nothing before this counts — the system must actually adapt, loop, and use valence correctly |
| **2 · Instrumentation** | Telemetry, integration test, Feature C source, experiment harnesses runnable | Can measure the system |
| **3 · Data** | Corpus annotation ∥ objective audio metrics | Results tables exist |
| **3b · Fine-tuning** (optional) | Dataset prep → eval harness → training → tuning-strategy ablation → Gates A/B (§4.4) | Runs ∥ to Phase 3; ships only if Gate A beats B0 and Gate B holds FAD. If it doesn't converge, fall back to B0 and D stays substrate — no impact on the Phase 4 studies |
| **4 · Studies** | Listening study → browsing study | Headline findings exist |
| **5 · Write** | Paper + reproducibility artifact | Submit |

**One-sentence summary:** the existing findings list is accurate but is mostly Phase-1/2 hygiene; the paper lives or dies on Phases 3–4, and none of it can start until the B→D handoff connects, the valence sign is fixed, and the loop detector stops being a no-op. If the fine-tuning track (§4.4) is taken, the audio contribution stands on §4.4's control-fidelity results; if not, D remains substrate and the paper rests on Phases 3–4 as written.
