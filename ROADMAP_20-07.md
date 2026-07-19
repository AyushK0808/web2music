# Web2Music — Roadmap Snapshot (2026-07-20)

> Status split of [PAPER_ROADMAP.md](PAPER_ROADMAP.md) by person: **what's done (merged into `main`)** vs. **what's still to do**.
> Verified against the code + merge history on branch `roadmap`, not against PR conversations.
>
> **Big change since the last roadmap:** every PR is now **merged into `main`** — #1, #2, #4 (carries #3), #5, #8 (supersedes #6/#7), #9, #10. The Phase-1 correctness gate ("merge the open PRs") is cleared. All three show-stoppers (X1 mostly, X2, X3) are on `main`. What remains below was never in a merged PR.
>
> Effort tags: `[S]` = hours · `[M]` = days · `[L]` = weeks.

---

## Show-Stopper status (all merged)

| ID | What | Owner | Status |
|---|---|---|---|
| **X1** | B→D handoff connects | Tvisha + Sneha | ⚠️ **Mostly** — D-side unwrap/prompt/instrument-map merged (PR #4/#3). **Open remnant:** camelCase↔snake_case leak + no `arousal` field. |
| **X2** | Real loop-point detection + equal-power crossfade | Vedant | ✅ **Done** (PR #9). Follow-up test/cleanup items open. |
| **X3** | Inverted valence scale in tier-2 prompt | Sneha | ✅ **Done** (PR #1). |

---

## Sneha — Feature B (`mood-classification/`)

### ✅ Done (merged)
- **X3** — inverted valence prompt fixed + `clampHint` + regression test (PR #1).
- Tier-2 LLM output validation (`validateLLMResult`, mood/pageType guards) (PR #1).
- `temperature: 0` on both LLM calls + regression tests (PR #1).
- Prompt-injection hardening (`<page_content>` delimiters, `escapePromptDelimiters`) (PR #1).
- Provider switch to GroqCloud `llama-3.1-8b-instant` + `llmConfig.js` single source of truth + Docker proxy (PR #1).
- Model ID hardcoded-twice → lifted into `llmConfig.js` (PR #1).
- Pipeline errors now routed through the 5 s stability gate instead of hard-switching (PR #1).
- Bypass results forward `colors`/`scrollSpeed`/`cursorSpeed` + explicit category (PR #1).
- Feature A enrichment (`readingComplexity`/`isImageOnly`/`wordCount`/`colorEnergy`) consumed (PR #1).
- Non-English pages force tier-2 escalation + skip keyword heuristic (PR #1).
- `confidenceWindowMs` injectable (no more 10.5 s real sleep in tests) (PR #1).
- README drift + bare `package.json` fixed (PR #1).
- Message-port leak — `registerFeatureBListener` returns `false` (PR #5).
- Handoff-1 version check (warn, don't throw) (PR #5).
- Sensitive regexes split into SEVERE (1 hit) vs AMBIGUOUS (≥2 hits) (PR #5).
- `runB3` accepts injectable `moodContext.hour` (PR #5).
- MV3 state survival — new `tabState.js` (`chrome.storage.session`, per-`tabId`) + heartbeat alarm + `tabs.onRemoved` cleanup (PR #10).
- Idle-fade re-based on `lastActivityAt` (long-read-goes-silent bug fixed) (PR #10).
- Golden Groq fixtures replayed in `npm test` (`fixtures/groq_*_response.json`) (PR #10).
- Sensitive-content **silence-by-default** (`mood:"silence"`, `volume:0`/`isSilent`); uplifting now opt-in (PR #10).

### ⬜ To do
- **[M] X1 B-side handoff contract** (with Tvisha) — B4 emits camelCase at the wrong nesting; D's Pydantic `MusicProfile` reads snake_case → silently defaults. Fix so these actually flow: `contentCategory`→`content_category` (also at top level in B, inside profile in D), `atmosphereTags`, `listeningContext`, `timeOfDay`, `sensitiveOverride`. ([b4_promptEngineer.js:208-231](mood-classification/feature_b/b4_promptEngineer.js#L208-L231) vs [models.py:11-24](audio-generation/models.py#L11-L24))
- **[S–M] Emit `arousal`** — no `arousal` field exists anywhere in B; rename/duplicate `energy` → `arousal` for the continuous V-A contract.
- **[S] Get owner sign-off** on the silence-vs-uplifting *default* (product/ethics call, not a bug fix) before it's considered settled (§7).
- **[S] Confirm** the `abuse`→AMBIGUOUS reclassification (PR #5) was intentional (a lone "domestic abuse hotline" no longer flags).
- **[S] Confirm** (with Tvisha) Feature D honors `volume:0`/`isSilent` so a silence outcome doesn't still burn GPU-minutes generating a muted clip.
- **[M] Write the prompt-injection robustness subsection** for the paper from the existing tests.
- **§3.2 paper additions `[L]`:** labeled ground-truth corpus (200–500 pages, ≥3 annotators, Fleiss' κ); baselines (random/majority/LLM-only/embedding-kNN); ablations on hand-tuned constants; calibration (ECE, escalation-vs-accuracy); tier-2 value quantification; perceptual validation of B3's mood→BPM/key/instrument tables; taxonomy grounding (Russell/Thayer); per-decision telemetry.
- **§7 `[S–M]`:** sensitive-content FNR/FPR evaluation + ethics paragraph.

---

## Tvisha — Feature D (`audio-generation/`)

### ✅ Done (merged)
- GPU + fp16 auto-select in `d3_generate.py` (PR #4).
- Blocking calls wrapped in `asyncio.to_thread` (PR #3, via #4).
- D1 unwraps `payload.musicProfile` + `payload.prompt`; profile fields flow through (PR #3, via #4).
- D2 prefers B4's engineered prompt over rebuilt one; logs source (PR #3, via #4).
- 11-mood instrument map + mood rejection (PR #3, via #4).
- Cache key includes `key` (both `d5_cache.py` + `d5_cache_local.py`); `IS_PROD` switch restored (PR #3/#4).
- Clip length default `max_new_tokens=1400` ≈ 28 s with `min_new_tokens` pinned (PR #4).
- Seed varies per retry (`42 + attempt`) + returned as `generation_seed` in metadata (PR #4 r2).
- Retry logic (3× exponential backoff) + `GenerationError` + `fallback.py` chain; 503 when no fallback (PR #4).
- Pydantic `MusicProfile`/`HandoffPayload` models; `d1_validate.py` + `/generate` use them (PR #8).
- `duration_seconds` exposed as API field (ge=5/le=30, default 28) → `generate_audio(prompt, duration_seconds)` — closes X1's duration-contract gap (PR #8).
- `bpm` lowered to `ge=20` to cover B3's reachable minimum of 25 (PR #8).
- Cache key adds `valence_tier` + `duration_bucket` (2 s tolerance) (PR #8).
- Pinned `requirements.txt` (PR #8).
- `torch.compile` on CUDA warm calls (PR #8).

### ⬜ To do
- **[S] Fallback clips don't exist** — `fallback_clips/` folder is absent and `generate_fallbacks.py` was never committed (despite PR #4's commit message). Fallback code is live but has nothing to serve → any generation failure returns 503. Now unblocked (X2 merged); create the 11 mood clips + the generator script.
- **[S] Cache key nits** — `duration_bucket` inline comment is off-by-one (`(27//2)*2=26`, `(29//2)*2=28`); `bpm` still coarse low/mid/high buckets; no `arousal` axis (blocked on B).
- **[S] Style nits** — `main.py:62` `try:` body indented 9 spaces; add the "no auth/rate-limiting on `/generate` = cost-DoS" deployment note.
- **[S] Benchmark `torch.compile`** across several prompt lengths (recompilation on shape change could erase the speedup — only tested on one clip so far).
- **[S] Automated tests** for the new Pydantic models (only 4 manual cases today).
- **[M] X1 D-side consume** (with Sneha) — accept `arousal`; under fine-tuning, `d2_prompt.py` builds a `(v, a, log bpm)` conditioning vector instead of the discrete instrument text map.
- **[M] Longer / extendable audio** — MusicGen audio-continuation for arbitrary length; or clips that resolve toward their own start.
- **[M] Batch concurrent requests** + pre-warm cache for the common mood×style×bpm grid.
- **[M] `d3_generate.py` adapter switch** — `USE_FINETUNED=true` loads LoRA + conditioning encoder; keep stock reachable as the `B0` baseline.
- **§4.2 `[L]`:** implement the four empty `experiments/*.py` stubs (`d1_prompt_ablation`, `d2_loop_test`, `d3_clip_length`, `d4_latency`) — all currently 0 lines; FAD/CLAP/tempo/key/loudness/seam metrics, quality/latency curves, model comparison.
- **§4.2 `[S]`:** fill in `research_log.md` (currently empty).
- **Fine-tuning track §4.4 `[L]`** (FT-lead / Tvisha) — datasets (MTG-Jamendo/DEAM/NRC-VAD/tempo pseudo-labels), conditioning encoder + LoRA training, per-stream CFG dropout, tuning-strategy ablation, baselines `B0`/`B1`/`B2`, Gates A/B.

---

## Vedant — Feature D loop + cross-cutting

### ✅ Done (merged)
- **X2** — real loop detection: `MIN_LOOP_SECONDS = 3.0` gate, `np.nan_to_num`, vectorized `sliding_window_view` correlation (numerically identical to old `np.corrcoef` to ~2.5e-16), bar-boundary snapping, equal-power sin/cos head→tail crossfade replacing `fade_out(50)` (PR #9).
- `loop_point_ms` surfaced in `/generate` response metadata ([main.py:123](audio-generation/main.py#L123)).

### ⬜ To do
- **[S] Commit PR #9's synthetic checks as a real test** — the vectorized-vs-`np.corrcoef` equivalence + NaN-free-on-silent-window assertions live only in the PR description; no CI regression guard exists. Add a test file under `experiments/` or `tests/`.
- **[S] Remove the dead `< 1000 ms` guard** — unreachable after `MIN_LOOP_SECONDS` gate; still at [d4_process.py:48-49](audio-generation/d4_process.py#L48-L49); harmless but confusing.
- **[S] Fail loud on the stereo-interleaving path** — crossfade is correct only because musicgen-small is mono; add a channel-count assert/branch in `d4_process.py` before any `-stereo` checkpoint.
- **[S] Log the seam-discontinuity metric** (spectral/energy delta at the cut) into `/generate` timings/metadata — feeds the §4.2 seam metric + §6.3 listening study for free.
- **[S] Round-trip test for `loop_point_ms`** — assert the value survives `main.py`'s response and matches the README contract so Feature C's gapless player can trust it.
- **[M] Gapless export** — MP3 encoder delay/padding is audible on loop; export WAV/Ogg-Opus, or have the player decode into Web Audio `AudioBufferSourceNode` with `loopStart`/`loopEnd`.
- **§5 cross-cutting:**
  - **[M] One end-to-end integration test** — `buildPageData()` → `runFeatureB()` → `/generate` validator in one process (forces the CommonJS/ESM interop decision; would have caught X1/X3/enrichment bugs). **This is the last Phase-1 gate.**
  - **[M] Feature C source in the repo** — playback engine exists only as compiled `ui.crx`; add source + Web Audio gapless looping + mute/skip/"wrong mood" controls (which double as implicit ground-truth labels).
  - **[S–M] Reproducibility bundle** — pinned deps, pinned model IDs (HF revision + Groq model+date), seeds, prompts, golden fixtures, experiment configs.
  - **[M] End-to-end latency budget** — page-load → music-playing percentiles across A/B/D (cold/warm, hit/miss).
- **§2.1 `[M]` (reassigned from Pari):** port playground scenarios to `node:test` + `assert` — `data-extraction` still has only the `play` eyeball script.
- **§4.4.4 eval harness `[L]`** (with Tvisha) — tempo/mood/trajectory control-fidelity (MERT probe, per-axis V-A MAE/R²).

---

## Pari — Feature A (`data-extraction/`)

### ✅ Done (merged, PR #2)
- `extractPageText` null-guards `doc.body` — returns well-formed empty result carrying `title`/`description`/`lang`.
- Text-density scoring falls back to `textContent` under jsdom (`innerText` undefined there).
- Boilerplate stripping rewritten from substring → whole-token matching (`classOrIdTokens`/`stripHintedElements`) — no more `shadow`/`gradient`/`download`/`badge` false positives. (This is the item that had been reassigned to Vedant; Pari did it here.)

### ⬜ To do (§2.1 small `[S]`, all still open)
- **Embedding cache ignores backend/model** — [pageData.js:153](data-extraction/pageData.js#L153) keys on `url + text-hash` only; switching local (384-dim) → openai (1536-dim) returns a stale wrong-model vector. Include backend + model in `cacheKey()`.
- **No fetch timeout** — [Embeddingmodel.js](data-extraction/Embeddingmodel.js) openai/service backends can hang forever; add a configurable AbortController.
- **Failed local pipeline cached forever** — [Embeddingmodel.js:85-91](data-extraction/Embeddingmodel.js#L85-L91): a rejected `localPipelinePromise` never clears; clear it on rejection.
- **Embed service open to any local caller** — [embedService.js](data-extraction/docker/embedService.js) sends `Access-Control-Allow-Origin: *` (line 37) and binds all interfaces (line 107); bind `127.0.0.1`, require a shared-secret header, restrict CORS, `req.destroy()` on oversized bodies.
- **First handoff reports zero behaviour** — [behaviorTracker.js](data-extraction/behaviorTracker.js) starts lazily and only listens on `window` scroll; start at content-script init and use `{capture:true}` for inner/horizontal/touch scroll.
- **English-only readability** — Flesch is meaningless for non-English; `lang` is extracted but never gates it; return neutral 0.5 when lang ≠ en.
- **Syllable counters drift** — `Readability.js:23` returns 0 for empty word, `b1_contentUnderstanding.js:93` returns 1 despite "identical mapping" claim; unify.

### ⬜ To do (§2.2 / §7)
- **[S] Per-stage extraction latency + failure-rate telemetry** (feeds §6 systems eval).
- **[S] Element cap / sampling in `Colorextractor.js`** (`getComputedStyle` + `getBoundingClientRect` per element = forced-layout risk); measure extraction cost on top-100 sites.
- **[M] Fully-local mode** (tier-1 only + local embeddings) with its accuracy cost quantified — the privacy-utility tradeoff is a publishable ablation (§7).

---

## Unassigned / shared paper work

- **§3.2, §4.2, §6** evaluation content is the bulk of the paper (`[L]`) — corpus, baselines, ablations, objective audio metrics, listening study, browsing study. Owners are Sneha (classification) + Tvisha (audio) as listed above; the studies (§6) need IRB/ethics approval and are not yet assigned.
- **§4.4 fine-tuning track** carries an unfilled **(FT-lead)** role on several items (datasets, conditioning/training, decision gates) — currently defaulting to Tvisha.
