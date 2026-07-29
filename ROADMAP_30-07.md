# Web2Music — Roadmap Snapshot (2026-07-30)

> Per-person done/to-do split of [PAPER_ROADMAP.md](PAPER_ROADMAP.md). Supersedes `ROADMAP_20-07.md`.
> Verified against the working tree on branch `roadmap` (through `bf36137`, incl. the `89cdf29` merge) — code, not PR conversations.
>
> **Biggest change since 07-20:** a large batch of work landed after PR #15 that no roadmap had recorded — **all of Feature A's §2.1/§2.2 list is now clear**, plus a data-extraction test suite, per-stage telemetry, a 783-line `VectorStore.js`, D-side **gapless Ogg/Opus export**, X1's `profile` field genuinely consumed with a first-class `arousal`, and the **§5 A→B→D integration test**.
>
> **And the new headline problem:** the shipped extension (`ui/`) doesn't call Feature A, B, or D at all — it plays a hardcoded demo MP3. Tracked as **X4** and it is now the only thing standing between us and Phase 2/3.
>
> Effort tags: `[S]` = hours · `[M]` = days · `[L]` = weeks.

---

## Show-stopper status

| ID | What | Owner | Status |
|---|---|---|---|
| **X1** | B→D handoff connects | Tvisha + Sneha | ✅ **Done** — `profile` (flat snake_case) emitted by B4 *and* now actually preferred by `d1_validate.py`; `arousal` is a first-class `MusicProfile` field; the integration test pins all of it. Open remnant: no *shared schema artifact* (agreement is convention + one fixture), and B's `arousal` is a `[0,1]` behavioural proxy, not Russell's `[-1,1]` axis. |
| **X2** | Real loop detection + equal-power crossfade | Vedant | ✅ **Done** (PR #9 + #15 tests). |
| **X3** | Inverted valence scale in tier-2 prompt | Sneha | ✅ **Done** (PR #1). |
| **X4** | **The extension is not wired to the pipeline** | **Vedant + owner** | ⬜ **NEW, the current gate.** `ui/content.js` uses its own 2000-char `innerText` extractor and loads none of Feature A; `ui/background.js` has zero references to Feature B; `/generate` is never called (hardcoded SoundHelix MP3, real calls commented out, and the commented code targets a nonexistent `/profile`); `Tone.Player({loop:true})` ignores `loop_point_ms`; no mute/skip/wrong-mood controls. |

**Read X4 first.** Until it closes, every merged fix is invisible end-to-end, no §6 study can run, and the §5 latency budget has nothing to measure.

---

## Vedant — X4 + Feature D loop + cross-cutting

### ✅ Done
- **X2** — `MIN_LOOP_SECONDS = 3.0` gate, `np.nan_to_num`, vectorized `sliding_window_view` correlation, bar-boundary snapping, equal-power sin/cos crossfade (PR #9).
- X2 follow-ups: committed regression tests (`tests/test_d4_process.py`, `tests/test_main_roundtrip.py`), dead `< 1000 ms` guard removed, stereo path fails loud with `ValueError`, `_seam_discontinuity()` metric surfaced in `/generate` metadata, cache-hit/miss response shapes unified (PR #15).
- `loop_point_ms` in `/generate` metadata.
- **Gapless export (D side)** — `d4_process.py` exports Ogg/Opus via libopus instead of MP3, with the LAME priming/padding rationale documented; both cache backends write `.ogg` (`89cdf29`).
- **§5 one end-to-end integration test** — `tests/test_integration_handoff.py` + `manual_tests/record_integration_fixture.js` + a recorded real Handoff-2 fixture. Caught a live X1 regression (`profile` was being ignored in favour of `musicProfile`) (`89cdf29`).
- **§5 Feature C source in the repo** — `ui/` is present (1303 lines); artifact evaluation can read the player. *(The rest of that item became X4.)*

### ⬜ To do
- **[M] X4 — wire the extension** (the gate; split into five sub-items in §1 of the paper roadmap):
  - Load Feature A's modules as content scripts in `manifest.json` and emit a real `FEATURE_A_HANDOFF`.
  - Import `background_integration.js` in the service worker; let Feature B own classification (`tabState`, stability window, idle fade, silence policy are all currently unreachable).
  - Delete `fetchMusicProfile`/`/profile`; POST the Handoff-2 `profile` to `/generate` and use the returned `audio_url`.
  - Replace `Tone.Player({loop:true})` with `decodeAudioData` → `AudioBufferSourceNode` with `loopStart: 0` / `loopEnd: loop_point_ms/1000`, so the Ogg/Opus + crossfade work is actually audible.
  - Add mute / skip / "wrong mood" controls wired to a telemetry sink — these are §6.4's implicit ground-truth labels.
- **[S] Put the fixture recorder in CI** (or staleness-check the fixture) — the integration test is fixture-mediated, so a Handoff shape change is only caught when someone re-runs `record_integration_fixture.js`. Without this it decays into a July snapshot.
- **[S–M] Reproducibility bundle** — pinned deps ✅, pinned model IDs (HF revision + Groq `llama-3.1-8b-instant` + date), seeds ✅, released prompts, golden fixtures ✅, experiment configs.
- **[M] End-to-end latency budget** — A has `getExtractionTelemetry()` and D has `timings`; **B has no per-decision timing and there's no common sink.** Add `VectorStore` similarity-hit rate as its own row (it short-circuits B *and* D, so it dominates the warm path). Blocked on X4 for the real end-to-end number.
- **§4.4.4 eval harness `[L]`** (with Tvisha) — tempo/mood/trajectory control-fidelity (MERT probe, per-axis V-A MAE/R²), only if the fine-tuning track is taken.

---

## Tvisha — Feature D (`audio-generation/`)

### ✅ Done
- GPU + fp16 auto-select; `asyncio.to_thread` on blocking calls; D1 unwraps `musicProfile`/`prompt`; D2 prefers B's prompt; 11-mood instrument map; cache key includes `key`; `IS_PROD` switch restored (PRs #3/#4).
- Clip length ≈ 28 s with `min_new_tokens` pinned; seed varies per retry and is returned as `generation_seed`; retry (3× backoff) + `GenerationError` + 503 when no fallback (PR #4).
- Pydantic `MusicProfile`/`HandoffPayload`; `duration_seconds` (ge=5/le=30); `bpm ge=20`; `valence_tier` + `duration_bucket` in the cache key; pinned `requirements.txt`; `torch.compile` on CUDA (PR #8).
- **Batching + pre-warm** — up to 4 requests coalesced into one MusicGen forward pass within a 150 ms window; `prewarm.py` warms a 45-combo grid via a `lifespan` hook (PR #12).
- **X1 D-side consume** — `MusicProfile.arousal` as a first-class field (`ge=0/le=1`), `d1_validate.py` prefers B's flat `profile` and keeps `intensity` as its own axis (`89cdf29`).
- `main.py` robustness — shared `_fallback_response` now also covers D4 (codec) and D5 (save) failures, and a broken cache lookup degrades to a miss instead of a 500 (`89cdf29`).

### ⬜ To do
- **[S] Fix `generate_fallbacks.py` and actually generate the clips.** The file landed but was written against the pre-#12/#15 API and is broken three ways: `generate_audio` is now `async` (line 51 binds a coroutine), `process_audio` returns a **3-tuple** (line 52 unpacks 2), and it writes `.mp3` while D4 emits **Ogg/Opus**. `fallback.py`'s `.mp3` name map and `list_fallback_clips()` filter must change in step. `fallback_clips/` is still absent, so any generation failure still 503s.
- **[S] The fallback path returns no audio.** `_fallback_response()` reads the clip bytes, null-checks them, then returns `"audio_url": None` and throws them away ([main.py:52-77](audio-generation/main.py#L52-L77)) — the whole retry/fallback subsystem is a no-op even once clips exist. Save through `save_to_cache` (or a static mount) and return that URL; also enumerate `loop_point_ms`/`seam_discontinuity` there so all three response shapes match.
- **[S] Cache schema doesn't persist the metadata `main.py` promises.** The hit path lists `valence`, `intensity`, `duration_seconds`, `seam_discontinuity`, `prompt_source`, `generation_seed`, but `docker/init.sql` has no columns for them → `null` on every hit. Needs the migration before any §4.2 analysis joins on cached rows.
- **[S] Cache key nits** — `duration_bucket` comment is off-by-one; `bpm` still coarse low/mid/high buckets; no `arousal` axis in the key (it exists in the model now, so this is unblocked).
- **[S] Style / deployment** — `main.py:62` 9-space indent; write the "no auth/rate-limiting on `/generate` = cost-DoS" deployment note.
- **[S] Benchmark `torch.compile`** across several prompt lengths (recompilation on shape change could erase the speedup).
- **[S] Automated tests for the Pydantic models** (4 manual cases today).
- **[S] Per-clip seeds inside a batch** — PR #12's batched sampling shares one RNG seed across the batch (seeded from the first queued item). Needed if §5's reproducibility work wants per-clip seeds.
- **[M] Longer / extendable audio** — MusicGen audio-continuation, or clips that resolve toward their own start.
- **[M] `d3_generate.py` adapter switch** — `USE_FINETUNED=true` loads LoRA + conditioning encoder; keep stock reachable as the `B0` baseline.
- **§4.2 `[L]`: the four `experiments/*.py` stubs are still 0 bytes** — `d1_prompt_ablation`, `d2_loop_test`, `d3_clip_length`, `d4_latency`. FAD/CLAP/tempo/key/loudness/seam metrics, quality + latency curves, musicgen-small vs medium vs MAGNeT vs Stable Audio Open. This is the results section.
- **§4.2 `[S]`: `research_log.md` is still 0 bytes.**
- **[S] B4-vs-D2 prompt-builder A/B** (CLAP/FAD) — the free ablation X1 short-circuited rather than measured.
- **Fine-tuning track §4.4 `[L]`** — datasets, conditioning encoder + LoRA, per-stream CFG dropout, tuning-strategy ablation, baselines `B0`/`B1`/`B2`, Gates A/B. Note B's `arousal` is `[0,1]` behavioural, not Russell `[-1,1]` — needs an explicit documented rescale, not a passthrough.

---

## Sneha — Feature B (`mood-classification/`)

### ✅ Done
- **X3** inverted valence + `clampHint` + regression test; tier-2 output validation; `temperature: 0`; prompt-injection hardening; Groq provider switch + `llmConfig.js` + Docker proxy; error path routed through the stability gate; bypass pass-through fields; Feature A enrichment consumed; non-English escalation; injectable `confidenceWindowMs`; README + `package.json` fixes (PR #1).
- Message-port leak; Handoff-1 version check; SEVERE vs AMBIGUOUS sensitive regexes; injectable `moodContext.hour` (PR #5).
- MV3 `tabState.js` + heartbeat alarm + `tabs.onRemoved`; idle-fade re-based on `lastActivityAt`; golden Groq fixtures in `npm test`; sensitive-content **silence-by-default** (PR #10).
- **X1 B-side** — `toFeatureDProfile()` emits a flat snake_case `profile`; `background_integration.js` forwards it and short-circuits on `isSilent` with a local `FEATURE_D_SILENCE` (PR #13). Suite green as of this pass.
- **Integration fixture recorder** — `manual_tests/record_integration_fixture.js` produces the real Handoff-2 that D's §5 test replays (`89cdf29`).

### ⬜ To do
- **[S] ✅-adjacent, now confirmable:** the "does D expect `arousal` this way?" question is answered — D has a first-class `arousal` field and maps it straight across. **But** B sends `[0,1]` behavioural intensity while §4.4 conditions on Russell's `[-1,1]` arousal; decide and document the rescale with Tvisha.
- **[S] `duration_seconds` is never emitted by B** — D exposes it (ge=5/le=30) and the fixture shows B omitting it, so every request silently takes the 28 s default. Either emit it deliberately or record "B doesn't control duration" as a decision.
- **[S] Owner sign-off on silence-vs-uplifting default** (product/ethics call, still open).
- **[S] Confirm** the `abuse` → AMBIGUOUS reclassification was intentional (a lone "domestic abuse hotline" no longer flags).
- **[S] Per-decision telemetry** — log tier, confidence, latency, tokens for every `runFeatureB`. Prerequisite for the corpus, the cost/latency story, and the §5 latency budget (B is the one stage with no instrumentation).
- **[S] A shared schema artifact for Handoff-2** (with Tvisha) — the `profile`-vs-`musicProfile` regression got in precisely because agreement is convention plus one fixture.
- **[M] Write the prompt-injection robustness subsection** from the existing tests.
- **§3.2 `[L]`** — labeled ground-truth corpus (200–500 pages, ≥3 annotators, Fleiss' κ); baselines (random / majority / LLM-only / embedding-kNN — now cheap, `VectorStore.js` already does namespaced kNN); ablations on the hand-tuned constants (`MIN_CATEGORY_HITS`, 0.5 escalation threshold, bias weights, `PAGE_TYPE_MODIFIERS`, time-of-day, **and VectorStore's `0.85` similarity threshold**); calibration (ECE, escalation-vs-accuracy); tier-2 value quantification; perceptual validation of B3's mood→BPM/key/instrument tables; taxonomy grounding (Russell/Thayer).
- **§7 `[S–M]`** — sensitive-content FNR/FPR evaluation + the ethics paragraph.

---

## Pari — Feature A (`data-extraction/`)

### ✅ Done — **§2.1 and §2.2 are now fully clear**
- `extractPageText` null-guards `doc.body`; text-density falls back to `textContent` under jsdom; boilerplate stripping rewritten substring → whole-token (PR #2).
- **Embedding cache keyed on `backend:model`** via `resolveEmbeddingIdentity()` — no more stale wrong-model vectors across a 384↔1536-dim switch (`dbd3389`).
- **`fetchWithTimeout` AbortController** on the `openai`/`service` backends, at parity with Feature B's 8 s controllers (`0ab257b`).
- **`localPipelinePromise` cleared on rejection** — a transient load failure no longer poisons every later call (`0ab257b`).
- **`embedService.js` locked down** — binds `127.0.0.1` by default, optional `x-service-secret` vs `SERVICE_SECRET` (constant-time compare), CORS scoped to `ALLOWED_ORIGIN`, `req.destroy()` on oversized bodies (`0ab257b`).
- **Behaviour tracker auto-starts at init** and binds scroll with `{ capture: true }` (+ `mousemove`/`touchmove`), so inner scrollable containers are observed (`0ab257b`/`a7dc854`).
- **Readability gated on `lang`** — neutral `0.5`/`50` for non-`en`, and `pageData.js` actually passes `page.lang` (`0ab257b`).
- **Syllable counters unified** with B1 (both return 1 for a degenerate word) (`0ab257b`).
- **Real test suite** — `npm test` runs `globals_test.js` + `vectorStore_test.js` + `pageData_test.js` + `qdrant_test.js` (skips cleanly without Docker) (`dbd3389`). *(This was the item reassigned to Vedant; Pari did it.)*
- **§2.2 per-stage telemetry** — `timeStage`/`recordStage`/`getExtractionTelemetry` with latency + failure rate per stage (`a7dc854`).
- **§2.2 element cap** — `MAX_ELEMENTS_TO_SAMPLE = 800` with evenly-spaced sampling (not first-N, which would bias toward the top of the DOM), `sampledCount`/`totalElementCount` reported, plus a new `representativeColor` (`a7dc854`/`3bfef15`).
- **Extraction-cost benchmark harness** — `npm run bench` → `benchmark/extractionCost.js` (puppeteer-core, auto-discovers Chrome) over `benchmark/top-sites.txt` (138 sites) (`dbd3389`).
- **`VectorStore.js`** (783 lines, unplanned) — namespaced `backend:model:dims` similarity store, memory/IndexedDB/Qdrant adapters, unit-normalised dot-product scan, threshold-based revisit short-circuit (`dbd3389`).

### ⬜ To do
- **[S] Run the benchmark and commit the results.** The harness exists but has never been run — no results file, and `research_log.md` is empty. "Measure extraction cost on the top-100 sites" is tooling-done, measurement-open.
- **[S] Ship the telemetry somewhere.** `getExtractionTelemetry()` returns good numbers that nothing collects — and X4 means the code doesn't run in the extension at all, so the §6 systems-eval table has no data behind it.
- **[M] Fully-local mode — finish the publishable half.** `buildPageData({ fullyLocal: true })` exists and guarantees zero network calls, but it only forces A's embedding backend; there's no end-to-end flag that also pins B to tier-1, and **the accuracy cost has not been measured** — the measurement is the contribution (§7 privacy-utility ablation).
- **[S] Document `SERVICE_SECRET` as required for the study deployment** — unset means the embed service is still open (currently labelled "dev convenience"). One line in §7's data-flow statement.
- **[S] Pin the duplicated syllable counter with a shared test** — A and B now match token-for-token, but nothing prevents a future edit to one from silently re-opening the drift.
- **[S] Justify or ablate `VectorStore`'s `0.85` threshold** — it's a hand-picked constant on the critical path that can skip B and D entirely; it belongs in §3.2's ablation list and needs a hit-rate row in the §5 latency budget.

---

## Unassigned / shared

- **§6 studies** — listening study (N ≥ 20, MUSHRA-style) and the browsing study (adaptive vs. static playlist vs. curated-loop retrieval vs. silence) need **IRB/ethics approval** and still have no owner. Both are blocked on X4.
- **§4.4 fine-tuning track** carries an unfilled **(FT-lead)** role (datasets, conditioning/training, decision gates), currently defaulting to Tvisha. The scope decision — is Feature D substrate or a second contribution? — is still undecided and should be made before any training run.
