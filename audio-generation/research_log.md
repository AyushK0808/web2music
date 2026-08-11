# Research log

Dated entries, one per harness run: command, git SHA, hardware, output path.
Exists per `RESULTS_AND_DISCUSSION_PLAN.md` §12 — "reconstructing which build
produced Table 1 three months later, without this, is how a resubmission
dies."

---

## 2026-08-10

**Wrote `experiments/d2_loop_test.py`** (was an empty stub; plan §13 step 6).
Aggregates `d4_process._seam_discontinuity` across every clip already on
disk, and — new, not previously computed anywhere — reapplies the same
metric to the finished exported clip itself (tail vs. head of the actual
`.ogg`), giving a genuine pre- vs. post-crossfade comparison instead of just
the pre-crossfade diagnostic `main.py` already returned.

```
python experiments/d2_loop_test.py --out results/d2-loop.json
```
- git `d75ba7f`, Windows-11-10.0.26200, CPU (no GPU used for this run)
- n=116 (11 `fallback_clips/` + 105 `audio-cache/`, joined against the local
  Postgres `audio_cache` table for pre-crossfade seam + target duration)
- **Pre-crossfade** energy_delta_db: p50 2.25 dB, p95 15.12 dB
- **Post-crossfade** energy_delta_db: p50 -1.57 dB, p95 3.25 dB
- **Crossfade improvement (median): +3.82 dB** of energy jump removed
- Per-mood ranking (post-crossfade |Δ|) roughly tracks density: `sad`/`calm`
  (sparse) seam best (1.86 / 2.13 dB), `joyful`/`focused` seam worst
  (7.31 / 4.57 dB) — `energetic`/`tense` (the plan's predicted worst case)
  land in the middle (4.20 / 3.72 dB), so the sparse-seams-better half of the
  hypothesis holds but "dense seams worst" does not cleanly; worth a closer
  look before writing this into §6.6.
- LUFS: p50 -18.10 (target -18.0, as expected from `process_audio`'s
  `pyln.normalize.loudness(..., -18.0)` call)
- Duration compliance: 115/116 (99.1%) within `[3s, target+50ms]`; one
  outlier flagged (`audio_cache/8412854cdd8c`, mood=curious, 2958ms vs.
  28000ms target — loop detector fell back to `MIN_LOOP_SECONDS`, worth
  checking whether this profile's audio genuinely has no self-similar
  region past 3s or whether this is a detector bug)
- **n=116 is short of the plan's >=200 target for F6** — the corpus grows
  automatically as more real `/generate` traffic lands in `audio-cache/`
  (S1's `cold`/`duration`/`concurrency` sections below add to it); re-run
  this script after those to widen n before finalising F6.
- Still missing: the subjective forced-choice AB listening test (T3) — no
  harness exists for that yet, needs ~30 human listeners.

---

## 2026-08-10 (same session, continued)

**Started `audio-generation` backend** (`uvicorn main:app --port 8000`) for
the first time against the local Docker Postgres + classify-service stack
(both already running, `docker compose -f docker/docker-compose.yml ps`).
Startup log confirmed: `musicgen-small` model load succeeded, D5 prewarm
grid ("Cache already warm for the full grid, nothing to do.") — the 99-combo
pre-warm grid described in plan §3 S1 had already been filled by a prior
session, giving the 105 real clips `d2_loop_test.py` used above.

---

## 2026-08-10 (same session, continued) — classify-service was silently broken

**Found and fixed a real production bug** while getting the zero-shot tier
(B1.5) ready to test for S2: `services/classify/classifyService.js`'s
`/v1/zero-shot` route called `https://api-inference.huggingface.co/...`,
which **no longer resolves in DNS at all** (`ENOTFOUND`) — HuggingFace
decommissioned that free serverless Inference API domain in favour of
`router.huggingface.co`. Every call was failing with a bare "fetch failed"
and B1.5 was silently falling through to the LLM tier on 100% of pages,
which — since the tier is off by default anyway
(`_config.zeroShot.enabled: false` in `feature_b/index.js`) — never
surfaced in production traffic, but would have made the S2 A2/A5/A6/A7
ablations all read "zero-shot contributes nothing" for a reason that has
nothing to do with the model. Also had to rebuild the `classify-service`
Docker image (`docker compose -f docker/docker-compose.yml build
classify-service`) — the running container was 6 days stale and predated
the `/v1/zero-shot` route existing at all.

Fix: point at `https://router.huggingface.co/hf-inference/models/{model}`,
and update response parsing — the router returns a flat array of
`{label, score}` objects (already ranked), not the old endpoint's
`{labels: [], scores: []}` parallel-array shape. Normalised back to the
parallel-array shape in `classifyService.js` so `parseZeroShotResult`
(`feature_b/b1_zeroShotCategory.js`) and the local transformers.js backend
stay interchangeable, per the module's existing contract.

Verified against the plan's own canonical tier-1.5 example (the
gut-microbiome/no-Health-keyword page, plan §3 S2): scores 0.35/0.29 top-2
across all 13 real category hypotheses (margin 0.06, below the 0.10 gate —
correctly abstains and escalates under production thresholds); a smaller
3-label sanity check on the same text scored 0.82 confidently correct.
`b1_zeroShot_test.js` still passes unchanged (it mocks `fetch`, so the live
endpoint bug never showed there — worth a regression test that hits the
real proxy in CI, flagged as a gap, not fixed here).

**Requires `HF_API_TOKEN` in `.env`** (added this session) — was previously
unset, so `zeroShotConfigured` was `false` in every prior `/health` check.

---

## 2026-08-10 (same session, continued) — S2 tier-ablation harness

**Wrote `mood-classification/experiments/s2_tier_ablation.js`** (plan §13
step 4, "not started" — no eval harness of any kind existed anywhere in the
repo for classification accuracy). Runs each of B1's three tiers exactly
once per page (zero-shot gates forced open so it always reports its raw
top-1, not an abstention), then replays every cascade configuration
(A1/A4/A5, plus the full A7 minScore x minMargin sweep) as pure post-hoc
arithmetic over the cached per-tier results — no extra API calls for the
sweep.

Shipped with `s2_smoke_corpus.json`, an **18-page, single-annotator smoke
corpus** — explicitly not the paper's real S2 corpus (600 pages, 3
independent annotators, Krippendorff's α; plan §3 S2), built only to prove
the harness is correct against live tiers. Includes the plan's own named
edge cases: the gut-microbiome/no-keyword page, both sensitive near-misses
("The Great Depression", "grief counselling degree programs" — neither
should trigger the silence path), one genuine crisis page (should), and one
non-English page (keyword tier must skip by construction).

```
node experiments/s2_tier_ablation.js --out results/s2-ablation-smoke.json
```
- git `d75ba7f`, classify-service rebuilt+patched (see above), Groq
  `llama-3.1-8b-instant`, HF `facebook/bart-large-mnli` via the now-fixed proxy
- All three tiers hit live (no mocks): 18/18 keyword calls (free), 18/18
  zero-shot calls (real HF router), 18/18 LLM calls (real Groq)
- **A1 keyword-only:** macro-F1 0.856, but only fires on 13/18 pages (72%
  coverage) — 100% precise when it fires (all 13 hits correct), exactly the
  "free but low-recall" profile the plan predicts
- **A2 zero-shot-only (ungated):** macro-F1 0.679 — confidently wrong on
  the emotional essay and the entertainment-celebrity page (both called
  "Educational"), and misread the genuine crisis page as "Horror"
- **A3 LLM-only:** macro-F1 0.828 (best single tier), exposure 100%
- **A4 keyword→LLM (pre-existing shipped system):** macro-F1 0.908,
  exposure_rate 0.222
- **A5 keyword→zero-shot→LLM (current shipped system, tier enabled):**
  macro-F1 0.846, **exposure_rate 0.000** — every non-keyword page this run
  was confidently (if not always correctly) resolved by zero-shot, so
  nothing reached the LLM at all
- **The trade-off C3/§6.3 is about, in one run:** A5 buys full exposure
  elimination (0.222 → 0.000) at a cost of ~6 macro-F1 points versus A4
  (0.908 → 0.846) on this corpus. Still comfortably inside the "falsified
  if >~5 points below LLM-only" bound (A3 macro-F1 0.828, A5 is *above*
  that), but the A4 comparison is the more interesting one to write into
  §6.3 once the real corpus makes it more than an n=18 anecdote.
- A7 sweep on this corpus is mostly flat until `minScore=0.75`, where
  exposure drops from 0.222 to 0.167 and macro-F1 jumps to 0.908 (matching
  A4) — a real accuracy/exposure knee, though at n=18 it's one page moving,
  not yet a curve worth publishing.
- **Not done:** mood (11-way, `b2_moodClassifier.js`) ablation — this
  harness only covers B1's content-category cascade. Krippendorff's α,
  the real 600-page corpus, and the local-backend (A6, distilled
  `Xenova/distilbart-mnli-12-1`) configuration are all still open.

---

## 2026-08-10 (same session, continued) — S5 telemetry analysis script

**Wrote `ui/experiments/s5_telemetry_analysis.js`.** Plan Appendix A already
said the telemetry ring buffer, URL-hashing, export button, and every event
this script reads (`A_extract`, `B_decision`, `D_generate`, `playback`,
`user_control`) were fully implemented — confirmed by reading every
`recordTelemetry` call site in `ui/src/background.entry.js` — but no script
existed to turn an exported ring buffer into the numbers plan §3 S5 and §4
actually ask for (`transitions_per_hour`, `attenuation_rate`, `cache_hit_rate`,
`fallback_rate`, `skip_rate_per_hour`, `mood_correction_rate`). This closes
that gap. Aggregation is deliberately descriptive-only (median/min/max per
metric across sessions, no significance tests) per the plan's own caution
("N=12 with unequal exposure supports description, not inference").

Smoke-tested against a **hand-built synthetic 1-hour session**
(`sample_exports/synthetic_session_1.json`, 25 events) — not real
telemetry, clearly flagged in the fixture itself. Every computed metric was
hand-verified against the fixture's raw events:

```
node experiments/s5_telemetry_analysis.js experiments/sample_exports/synthetic_session_1.json --out results/s5-wild-smoke.json
```
- transitions_per_hour 4 (4 `runFeatureB` events with `meta.transitioned:
  true` in a 1h span) ✓
- attenuation_rate 0.1 (60s `duck` + 300s `mute` = 360s of 3600s) ✓
- cache_hit_rate 0.6, fallback_rate 0.2 (3 hits + 1 fallback + 1 non-fallback
  miss, of 5 generations) ✓
- skip_rate_per_hour 1, mood_correction_rate 0.25 (1 correction / 4
  transitions) ✓

**Two real gaps surfaced while building this** (the script prints both at
the end of every run, not just noted here): B1's tier-cascade `source`
(keyword/zero-shot/llm/default) is not currently recorded anywhere in
telemetry — only `B_decision`'s timing is — so **tier escalation rate on
real browsing traffic cannot be computed from telemetry as it exists
today**, only from the S2 harness's offline corpus. And there is no
uninstall/toggle-off event, so **voluntary disable rate** (plan's own
"harshest usability measure we have") has nothing to read from either. Both
are one-line additions to existing `recordTelemetry` call sites
(`background.entry.js`) and worth landing before the real S5 deployment
starts, not discovered after it ends.

---

## 2026-08-10 (same session, continued) — S1 extractionCost.js, and a real production bug

**First real run** of `data-extraction/benchmark/extractionCost.js` (plan
Appendix A: "Written; never run") against 105 real sites from
`top-sites.txt`, real Chrome via `CHROME_PATH`:

```
CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" node benchmark/extractionCost.js
```
- 103/105 sites measured (2 navigation-context failures, not extraction
  bugs: arstechnica.com, dribbble.com)
- buildPageData() wall-clock: mean 463.8ms, p50 117.2ms, p95 2803.9ms
- **stage warnings: 97/103 sites** — every one the identical error:
  `readability: Cannot read properties of undefined (reading 'countSyllables')`

**Root cause, found and fixed**: `Readability.js` reads
`window.Web2MusicSyllableCounter` at top-level const-binding time (added
when the syllable heuristic was split out into its own shared
`syllableCounter.js`, so Feature A and Feature B1 can't drift apart). Both
places that decide content-script load order —
`data-extraction/benchmark/extractionCost.js`'s `MODULES` array *and*
**`ui/build.mjs`'s vendor-copy list / `ui/manifest.json`'s
`content_scripts.js` array** — were never updated to include
`syllableCounter.js` before `Readability.js`. That last pair means **this
is not just a benchmark-harness bug: the shipped Chrome extension has had
this exact same crash on every single real page load**, silently caught
and swallowed by `pageData.js`'s try/catch, since the day the syllable
counter was split out. `flesch`/`readingComplexity` has never once made it
into a real Handoff-1 payload. Not user-visible today only because Feature
B currently ignores A's `flesch` field and computes its own
`readingComplexity` independently (`b1_contentUnderstanding.js`'s
`computeReadingComplexity`, documented as a P3/optional-enrichment
fallback) — but that field exists specifically so B *could* consume it, and
silently never has been able to.

Fixed all three: added `syllableCounter.js` (before `Readability.js`) to
`extractionCost.js`'s `MODULES`, `ui/build.mjs`'s vendor-copy list, and
`ui/manifest.json`'s `content_scripts[0].js`. Verified:
- `node benchmark/extractionCost.js --limit 10` after the fix: **0/10
  readability failures**, real timings (mean 7.3ms, p50 4.8ms), no "stage
  warnings" line at all
- `data-extraction`'s unit suite: 45+16 passed, 0 failed (unaffected —
  those tests run in Node via `require`, which was never broken; only the
  browser/`window` injection path was)
- `npm run test:e2e` (`chromiumExtension.e2e.mjs`, C5 evidence): still
  12/12 after the manifest change — rebuilt via `node ui/build.mjs` first

Re-running the full 105-site benchmark now that the fix is in, to get the
real (not readability-broken) §5.1/T1 numbers — see next entry for results.

---

## 2026-08-10 (same session, continued) — extractionCost.js, clean run

```
CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" node benchmark/extractionCost.js --out benchmark/extraction-cost-results-fixed.json
```
- git `d75ba7f` + the syllableCounter fix above, 105/105 sites measured
  (both prior navigation failures were network flakiness, not the fix — they
  succeeded this run)
- **readability stage: 0/105 failures** (was 97/103) — mean 2.4ms, p50 1.5ms
- `buildPageData()` wall-clock: mean 311.8ms, p50 85.9ms, p95 1303.6ms, max
  5138.7ms (T1-adjacent — this is Feature A's extraction cost, not Feature
  D's generation latency, but the same "percentiles not means" discipline
  applies: p50 85.9ms vs. mean 311.8ms is a real, wide spread)
- Per-stage p50/mean (ms): text 11.0/17.1, colors 3.9/4.3, behavior 0.1/0.2,
  readability 1.5/2.4, embedding 1.2/1.3 (embedding is stubbed — not a real
  model cost, per the script's own reminder)
- Colour extraction (the forced-layout risk the script exists to quantify):
  mean 11.5ms, p95 38.9ms; sampling cap engaged on 68/102 sites (i.e. the
  cap is doing real work on two-thirds of real pages, not a rare edge case)
- Chrome engine counters: layout mean 224.8ms/p95 620.6ms, recalcStyle mean
  224.3ms/p95 551.5ms per page — these dwarf Feature A's own stage times,
  meaning **the browser's own rendering work, not Feature A's code, is the
  actual extraction cost floor** — worth stating explicitly in §5.1/§6.2
  rather than implying extraction itself is slow
- Signal quality: colour signal live on 89/105 (rest grey-default fallback);
  isImageOnly on 14/105; text coverage p50 80.8%; 3/98 text-rich sites
  under-extracted (<10% of visible words) — crates.io (real extraction gap,
  worth a look) and two retail sites correctly caught by the isImageOnly
  guard (walmart.com, wayfair.com — both are bot-check/promo-banner pages,
  not genuine under-extraction)

---

## 2026-08-10 (same session, continued) — environment bug, not a regression

**`python -m pytest audio-generation/tests` crashes the interpreter**
(`Windows fatal exception: access violation`), reproducibly, always at the
same spot: `numba`'s JIT'd ufunc inside `librosa.beat.beat_track`, called
from `_detect_loop_point_ms` (`d4_process.py`), during
`test_d4_process.py::test_normal_phrase_clip_snaps_near_true_phrase_boundary`.
Reproduced twice, identical stack both times — not transient resource
contention from the concurrent `d4_latency.py` run.

**Confirmed not caused by anything this session touched**: `git status`
shows `d4_process.py` untouched; `d2_loop_test.py` never calls
`_detect_loop_point_ms` (only `_seam_discontinuity`, which doesn't invoke
`librosa.beat`), which is why it ran clean earlier. `numba==0.66.0` against
`Python 3.14.2` — numba's LLVM-backed JIT (`llvmlite`) historically trails
new CPython releases by months for full ABI stability; a native access
violation inside JIT-compiled code on a very new interpreter version is the
textbook signature of exactly that kind of gap, not a bug in this repo's
loop-detection algorithm.

**Not fixed here** — this is a dependency/interpreter compatibility
decision (pin `numba`/`llvmlite` to versions with confirmed 3.14 support,
or run the test suite under an older Python), not a source-code fix, and
changing either without confirming compatibility ranges risks trading one
unverified state for another. Flagging prominently because it means **the
full `audio-generation` test suite cannot currently run to completion in
this environment at all** — relevant to plan §12's reproducibility bundle
and worth resolving before any CI run is trusted here.

> **RETRACTED 2026-08-10 (later same day). The diagnosis above is wrong.**
> See "the pytest 'numba crash' was neither numba nor a crash" below. The
> numba/3.14 story did not survive a controlled test: `test_d4_process.py`
> passes in full on Python 3.14.2 *and* 3.12.0 with identical numba. Kept
> here unedited rather than deleted, because the reasoning error is worth
> not repeating — it was a plausible mechanism asserted from a stack trace
> without running the one comparison that would have falsified it.

---

## 2026-08-10 (same session, continued) — the pytest "numba crash" was neither numba nor a crash

Went to pin `numba` per the entry above, and started by trying to reproduce.
It did not reproduce, and the real cause turned out to be a **production
concurrency bug in `d3_generate.py`**.

**What the controlled comparison showed.** `venv/` (Python 3.14.2) and
`venv312/` (Python 3.12.0) carry *identical* `numba==0.66.0`,
`llvmlite==0.48.0`, `librosa==0.11.0` — so they isolate the interpreter as
the only variable. That comparison was never run before the entry above was
written.

```
./audio-generation/venv/Scripts/python.exe -m pytest audio-generation/tests -v
./audio-generation/venv312/Scripts/python.exe -m pytest audio-generation/tests -v
```
- git `d75ba7f`, Windows-11-10.0.26200
- **All 13 `test_d4_process.py` tests pass on both interpreters**, including
  `TestLoopDetection::test_normal_phrase_clip_snaps_near_true_phrase_boundary`
  — the exact test the entry above names as the crash site. It also passes
  standalone on 3.14 in 21.6s.
- Both interpreters then stop at the *same* later test,
  `test_prewarm.py::test_warm_cache_generates_nothing`. Python version
  changes nothing, which is what kills the numba/3.14 hypothesis outright.
- It is a **hang, not a crash**: sampling the process twice 20s apart showed
  *zero* CPU consumed (`308.171875s` both times). An access violation
  terminates a process; this one sits still. `py-spy dump` confirmed the
  main thread parked in `_poll`/`select` inside the event loop with every
  `asyncio_N` pool thread idle — nothing running, nothing scheduled.

**Where the original "access violation" probably came from.** A `uvicorn
main:app --port 8000` started at 01:33 that session was *still running* ten
hours later, having accumulated **91,268s (~25.4 CPU-hours)** — i.e. ~2.5
cores saturated continuously while the earlier pytest runs were happening.
The entry above explicitly rules out "transient resource contention from the
concurrent `d4_latency.py` run"; that run's server never stopped, so the one
confounder that was dismissed is the one that was actually present. Not
provable after the fact, but it is the available explanation, and "reproduced
twice with an identical stack" carries no weight when both reproductions ran
under the same contention.

**The real bug.** `d3_generate._run_batch` runs in a worker thread
(`asyncio.to_thread`) and completed each request's `asyncio.Future` by
calling `future.set_result()` / `set_exception()` **directly across the
thread boundary**. `asyncio.Future` is not thread-safe: `set_result`
schedules the waiting task via `loop.call_soon`, which does not wake a loop
already blocked in `select()`. Whenever any other event happened to wake the
loop shortly after, the result got picked up and everything looked fine —
so the failure only appears when a batch is the *last* outstanding work on
the loop. That is exactly the tail of a prewarm grid, which is why
`test_prewarm` is where it shows up and why it looked intermittent.

This is **not test-only**. `main.py`'s `/generate` goes through the same
`generate_audio` → `_run_batch` path. In production a live server almost
always has other socket traffic to wake the loop, which is why it has never
been seen there — but a `/generate` that lands on an otherwise-idle backend
can stall indefinitely, and "prompt logged, then nothing" is precisely the
symptom `d3_generate.py`'s own PRIORITY_* comment describes chasing before.

Fix: carry the owning loop on `_BatchItem` and resolve every future through
`loop.call_soon_threadsafe` (new `_resolve_threadsafe`, which also does the
`future.done()` check on the loop thread, since checking it off-thread is
the same race in miniature). A closed loop raises `RuntimeError` and is
swallowed — the awaiting caller died with the loop, so there is nothing to
deliver.

Verified: `test_prewarm.py` — the file that hung indefinitely — now passes
**4/4 in 209s** on Python 3.14.

**Second, independent bug — found by bisecting, now also fixed.** The
`call_soon_threadsafe` fix was correct but not the whole story: the *full*
suite still hung at the same test. Bisecting module pairs against
`test_prewarm.py` isolated it — `test_batching.py + test_prewarm.py` passed
8/8, `test_main_roundtrip.py + test_prewarm.py` hung at exactly the same
test.

`test_main_roundtrip.py`'s `main_client` fixture does
`sys.modules.pop("d3_generate")` and re-imports, producing a **second
`d3_generate` module object**. `prewarm.py` was imported earlier and did
`from d3_generate import generate_audio`, so it still calls the *original*
module's function, which reads the *original* module's
`_queue`/`_worker_task` globals. `conftest.py`'s `_reset_d3_worker_state`
only reset `sys.modules["d3_generate"]` — the new copy — so the copy prewarm
actually calls kept a `_worker_task` created on a long-closed event loop.
That task is pending forever, so `_worker_task.done()` is `False`,
`_ensure_worker()` concluded a worker already existed and never started one
on the live loop, and the queued item had no consumer. Same 0%-CPU
signature, entirely different cause.

Fix: `_live_d3_namespaces()` in `conftest.py` now resets every live copy,
reaching the otherwise-unreachable one through
`prewarm.generate_audio.__globals__` (a function's `__globals__` *is* its
defining module's namespace), and cancels stale worker tasks instead of
just dropping them.

Unlike the `call_soon_threadsafe` bug, **this one is genuinely test-only** —
production never reloads modules. Worth stating plainly rather than
inflating the find: one of the two bugs behind this hang was a real
production defect, the other was test isolation.

Verified: `test_main_roundtrip.py + test_prewarm.py` **12/12 passed in
196s**, the exact pair that hung indefinitely before.

**Full suite, both interpreters, after both fixes:**
```
./audio-generation/venv/Scripts/python.exe    -m pytest audio-generation/tests -q   # 3.14.2
./audio-generation/venv312/Scripts/python.exe -m pytest audio-generation/tests -q   # 3.12.0
```
- **Python 3.14.2: 60 passed in 215s (exit 0)**
- **Python 3.12.0: 60 passed in 234s (exit 0)**

So the earlier entry's headline — "the full `audio-generation` test suite
cannot currently run to completion in this environment at all" — is no
longer true, and its stated cause never was. **No dependency pin was needed
and none was made**: `numba==0.66.0` / `llvmlite==0.48.0` are untouched and
pass on both interpreters. Plan §12's reproducibility bundle can rely on the
suite again.

Worth keeping separate in the write-up: of the two bugs behind this, the
`call_soon_threadsafe` one is a **real production defect on the `/generate`
path** that was masked by ambient socket traffic, and the conftest one is
**test isolation only**. The dependency-pinning decision the earlier entry
asked for turned out to be a non-issue, but `requirements.txt` still does
not pin `numba`/`llvmlite` at all (they arrive transitively via `librosa`),
which remains a genuine reproducibility gap for §12 — just not the one that
was breaking anything.

---

## 2026-08-10 (same session, continued) — the d2 "loop-detector outlier" was a harness bug

Chased the flagged outlier from the first entry (`audio_cache/8412854cdd8c`,
mood=curious, 2958ms against a 28000ms target, "worth checking whether this
profile's audio genuinely has no self-similar region past 3s or whether this
is a detector bug"). **Neither. It was a bug in `d2_loop_test.py` itself.**

`_detect_loop_point_ms` clamps its answer to `MIN_LOOP_SECONDS` (3.0s), and
`_crossfade_loop` then shrinks the exported clip by `CROSSFADE_MS` (50ms).
So a clip that lands exactly on the legal floor exports at ~2950ms. The
compliance check read:

```python
out["duration_compliant"] = 3000 <= out["duration_ms"] <= target_ms + CROSSFADE_MS
```

The upper bound adds `CROSSFADE_MS`; the lower bound is a bare `3000` and
never subtracts it. The clip was doing exactly what the pipeline is designed
to do, and was marked non-compliant for it. Fixed to
`MIN_LOOP_SECONDS * 1000 - CROSSFADE_MS`.

**The more interesting finding is what that check was hiding.** Its legal
range spans 3s-28s, so a clip retaining 11% of the requested duration
"passes" identically to one retaining 96%. `duration_ratio` is now carried
per clip and the summary reports its distribution instead of a near-vacuous
pass rate:

```
cd audio-generation && ./venv/Scripts/python.exe experiments/d2_loop_test.py --out results/d2-loop.json
```
- git `d75ba7f` + this fix, n=141 (11 `fallback_clips/` + 130 `audio-cache/`
  -- the corpus grew from 116 as more real traffic landed)
- **141/141 (100%) duration-compliant** under the corrected floor
- **duration retained vs. target: p50 0.503, p10 0.177, p90 0.850,
  min 0.106, max 0.961**
- **18/141 (12.8%) retain under 20%** of the requested duration;
  **70/141 (49.6%) retain under 50%**

So the honest headline is not "1 outlier of 116" but "the median clip loops
about half of what the profile asked for, and an eighth of them loop under a
fifth of it". That belongs in §5.3/§6.6 and it is a materially weaker
position than the original entry implied.

**What I could not determine.** Whether short loops are correct behaviour on
genuinely non-self-similar audio, or a detector defect, is **not decidable
from the stored artifacts** -- `audio-cache/` holds the clip *after*
trimming, so the 28s source the detector actually saw is gone. I tested the
obvious mechanism (that chroma self-similarity decays with distance, biasing
argmax toward the earliest legal frame) on the three longest surviving clips
and **it is not supported**: corr(similarity, time) came out +0.383, -0.130,
+0.140 -- no systematic decay, and argmax landed late (25.7s, 9.9s, 24.6s)
on those. Deliberately not "fixing" the detector on the strength of a
hypothesis I just failed to confirm; changing the loop objective would
invalidate all 130 cached clips and every §5.3 number with them. Retaining
the pre-trim audio for a sample of generations is the experiment that would
actually settle it.

---

## 2026-08-10 (same session, continued) — crates.io under-extraction was a real Feature A bug

The first `extractionCost.js` run flagged crates.io as a genuine extraction
gap ("worth a look"). It was: **`findMainContentElement` returned a 238-char
tagline as the main content of the entire page.**

Reproduced (36 of 632 words, 4.9% coverage), then instrumented each stage of
`extractPageText` live in Chrome. Tag-stripping and hint-stripping were
innocent -- 4541 chars of text survived both. The failure is in the descent
loop:

- `nonLinkTextLength(clone)` = **249** of 4541 total chars. crates.io's
  homepage is a link directory; essentially all its text is inside `<a>`.
- The walk scores candidate children by *non-link* text, so the one
  incidental prose block (the `.blurb` tagline, 238 chars, no links) held
  **95.6%** of it, counted as the dominant child, and the walk descended
  into it.
- Extraction then takes `innerText` -- *all* text -- of whatever was
  selected. Selection and extraction disagree about what "text" means, and
  on a link-dominated page they come apart completely.

Fix (`data-extraction/Textextractor.js`): a dominant child must now clear
`DOMINANT_CHILD_SHARE` on **both** non-link text and total text. A real
article container dominates on both at once, so article pages are
unaffected; a rounding error can no longer be mistaken for the content. This
is not crates.io-specific -- every aggregator, package index, and category
page has this shape.

Verified on the full corpus, not just the one site:

```
CHROME_PATH="..." node data-extraction/benchmark/extractionCost.js
```
- crates.io: **4.9% -> 85.5%** text coverage
- corpus text coverage **p50 80.8% -> 82.6%**
- **under-extraction 3/98 -> 3/101, and all 3 remaining correctly trip
  `isImageOnly`** (open.spotify.com, target.com, wayfair.com -- bot-check
  and loading-skeleton pages, where B skips the text path by design). Zero
  genuine under-extraction failures remain.
- no cost regression -- the text stage got *faster*: mean 17.1->10.7ms,
  p50 11.0->6.6ms. readability still 0/105 failures.
- `npm run test:a` 16/16 (includes "extracted the article text, not a
  fragment"), `npm test` green, `npm run test:e2e` 12/12

---

## 2026-08-10 (same session, continued) — closed the two S5 telemetry gaps

Both gaps the S5 script printed at the end of every run are now closed.

**B1 tier source.** `moodContext.category.source`
(keyword/zero-shot/llm/default/skipped-sensitive/bypass) existed all along
but never reached telemetry. The non-obvious part: `B_decision` is recorded
from `handoff2`, which is `null` on every page that doesn't clear the
confidence gate -- but a tier fires on *every* page. Plumbing `source`
through `handoff2` would have silently measured the transition subset only
and reported a biased escalation rate, which is worse than reporting none.
`runFeatureB` now takes an optional `onDiagnostics` callback invoked after
B1/B2 and *before* the gate, so every page is counted;
`background.entry.js` folds `categorySource` + `moodTier` into
`B_decision.meta`. The observer is exception-isolated -- a measurement hook
must not be able to take the audio pipeline down with it.

**Voluntary disable.** `POPUP_SET_ENABLED` recorded nothing; it now emits
`user_control` / `user_enabled_toggle`. **Scope correction for plan §3 S5:
this is a toggle-off rate, not an uninstall rate, and an uninstall rate is
not obtainable in this build at all** -- Chrome deletes
`chrome.storage.local` (the ring buffer with it) on uninstall, and the only
surviving hook, `setUninstallURL`, requires a network call the local-only
guarantee forbids. The plan's "voluntary disable rate" wording should be
narrowed accordingly rather than left implying something the instrument
cannot measure.

`s5_telemetry_analysis.js` now computes `tier_escalation_rate`,
`llm_exposure_rate`, pooled `tier_counts`, `disables_per_hour` and
`disabled_rate`, and prints the uninstall caveat instead of the two
"gaps, not bugs" paragraphs. Decisions from older exports carry
`categorySource: null` and are *excluded* rather than counted as "keyword",
so a pre-field export reads as n=0 instead of as a falsely cheap cascade.

```
node ui/experiments/s5_telemetry_analysis.js experiments/sample_exports/synthetic_session_1.json --out results/s5-wild-smoke.json
```
Synthetic fixture extended (5 tier sources, one toggle-off/on pair), every
new metric hand-verified against the raw events:
- tier_escalation_rate 0.4 (zero-shot+llm = 2 of 5 decisions) ✓
- llm_exposure_rate 0.2 (1 of 5) ✓
- tier_counts keyword=3, llm=1, zero-shot=1 ✓
- disables_per_hour 1, disabled_rate 0.1 (360s disabled of a 3600s span) ✓
- **every pre-existing metric unchanged** (transitions/h 4, attenuation 0.1,
  cache_hit 0.6, fallback 0.2, skip/h 1, mood_correction 0.25) -- the point
  of re-running the old fixture's assertions alongside the new ones

---

## 2026-08-10 (same session, continued) -- pinned numba/llvmlite

Closed the reproducibility gap flagged in the "pytest 'numba crash'" entry
above: `requirements.txt` pulled `numba`/`llvmlite` transitively via
`librosa` with no version pin, so a future install could resolve a
different pair than the one actually verified (`numba==0.66.0`,
`llvmlite==0.48.0` -- confirmed identical across both `venv/` (3.14.2) and
`venv312/` (3.12.0) in the comparison that found the real `d3_generate.py`
bug). Pinned both explicitly to the confirmed-working versions rather than
leaving them to float. No install or test re-run needed -- both
environments already had exactly these versions.

---

# 2026-08-11 — Track C and Track D wrap-up

Session goal: complete every Track C item and the Track D items that do not need
the 600-page corpus (excluded by request). Git SHA at session start: `d75ba7f`.
Hardware: Windows 11, CPU only — no GPU was available, which is why C-17 is the
one Track C item not done.

## Two production bugs found

**1. The local zero-shot tier has been dead since it shipped.**
`ui/src/zeroshot.worker.js` defaulted to `Xenova/distilbart-mnli-12-1`. That
repo now answers **401 Unauthorized** to anonymous downloads, and so does
`-12-3`:

    curl -o /dev/null -w '%{http_code}' .../api/models/Xenova/distilbart-mnli-12-1
    401    ({"error":"Invalid username or password."})
    curl -o /dev/null -w '%{http_code}' .../api/models/Xenova/all-MiniLM-L6-v2
    200    (control, same machine, same minute)

So this is the repo being gated or gone, not a network problem here. Effect: the
first classification on the local backend fails at model download,
`getClassifier` drops the rejected promise, and the tier silently falls through
to the LLM — the "privacy-preserving local option" was, in production, always
the remote one. Structurally identical to the decommissioned
`api-inference.huggingface.co` endpoint that killed the proxy backend earlier.

Fixed: `DEFAULT_MODEL_ID = "Xenova/nli-deberta-v3-xsmall"`. Measured on this
repo's own 13 hypotheses: 9.5 s first load, ~420 ms per full 13-label
classification, and it puts the plan's gut-microbiome example on `Educational`.
`Xenova/mobilebert-uncased-mnli` also works (4.5 s / 423 ms) and is reachable
via `W2M_ZEROSHOT_MODEL` for comparison. `localZeroShot.js` now turns a 401 into
an error naming the real cause, because "Unauthorized access to file" reads like
a local credentials problem and sends you looking in the wrong place.

**2. `exposure_rate` was being reported in a way that flattered A5.**
The metrics dictionary defines exposure as `source == "llm"`, which is right for
cost and wrong for privacy: A5's zero-shot tier sends page text to a *hosted HF
proxy*. Scoring that as zero exposure put the shipped cascade on the privacy
axis next to A6, the configuration that genuinely sends nothing. Added
`total_offdevice_rate` (proxy + LLM) and made F5 plot that.

**This changes the §6.3 story materially.** The earlier entry's "A5 trades ~6
macro-F1 points for zero page-text exposure vs A4" does not survive the
correction. On the same 18-page smoke corpus:

| config | macro-F1 | LLM exposure | total off-device |
|---|---|---|---|
| A4 keyword→LLM | 0.908 | 0.222 | **0.222** |
| A5 keyword→ZS(proxy)→LLM | 0.846 | 0.000 | **0.222** |
| A6 keyword→ZS(local), no LLM | 0.810 | 0.000 | **0.000** |
| A6b keyword→ZS(local)→LLM | 0.897 | 0.111 | **0.111** |

A5 does not reduce total exposure at all — it moves which vendor receives the
text, at a cost of 6 macro-F1 points. **A6b is the configuration that actually
buys something**: half the exposure of A4 for 1 macro-F1 point. n=18, one
annotator, so this is a harness result and not a finding; but the *shape* is a
correction to an argument the plan currently makes, and it should be re-checked
first thing on the real corpus.

## Built and run

| Item | State | Evidence |
|---|---|---|
| C-01 metrics registry + figure pipeline | done | `analysis/build_all.py` — **6 artefacts built from data already on disk** (T1, F1, F2, F3, F6, T5); 7 correctly reported blocked with reasons |
| C-02 A6 local distilled | done | runs through `classifyCategoryZeroShot`'s `local` backend; A6 + A6b in `s2_tier_ablation.js --with-a6` |
| C-03 Krippendorff's alpha | done | `analysis/krippendorff.py --self-test`, 6/6, hand-derived cases |
| C-04 corpus capture harness | done | 13/13 self-test; 3-page live run **deterministic across 3 repeats** |
| C-05 annotation tool | done | 16/16 Playwright tests |
| C-06 `d1_prompt_ablation.py` | done | was 0 bytes; `--dry-run` shows the three prompt conditions |
| C-07 `d3_clip_length.py` | done | was 0 bytes; ran offline over the n=141 set |
| C-08 signal ablation | done | smoke-run; **colour moved the mood on 1 of 2 pages**, behaviour and embedding moved nothing |
| C-09 pre-trim retention | done | `RETAIN_PRETRIM_EVERY`; +4 tests, `test_d4_process.py` **17 passed** |
| C-10 cost accounting | done | $0.0040 / 1000 pages at 22.2% escalation; cache sim 57–83% hit rate |
| C-11 T5 audit generator | done | 7 policies + 7 assertions all pass, **detector FN 0.455 / FP 0.333** |
| C-12 loop AB test | done | **22 real stimulus pairs across all 11 moods**; scorer recovers a planted effect exactly |
| C-13 S4 runner | done | `assignment_test.mjs` **26/26**; session app, session builder, exporter |
| C-14 baselines | done | request space **1,925 cells**; a 1,000-track library covers 40.5% |
| C-15 S5 participant build | done | delta vs `ui/dist` is exactly 3 files + INSTALL.md |
| C-16 analysis scripts | done | **all four planted effects recovered inside their intervals** at N=56 |
| C-17 GPU matrix | **NOT DONE** | no GPU on this machine; the only Track C item needing hardware |
| C-18 bundle packager | done | 46 items present, 5 correctly flagged as not-yet, secret scan clean |
| C-19 fixture re-record | done | folded into C-18: age check + staleness test + a re-record instruction at 30 days |

## Real numbers now on disk

**T1 (Feature D latency, CPU).** Fallback endpoint p50 **7 ms**; cache hit p50
**2,090 ms**, of which **2,082 ms is the D5 cache check** — the cache check *is*
the cache-hit latency; generated p50 **139 s** (n=3). 12 of 144 requests hit the
300 s client timeout (8.3%). **The run's `cold` section contains 33 cache hits
and zero misses**, so there is no cold-cache measurement in
`d1-latency-full.json` at all — the pre-warm grid was already populated. T1 says
so rather than printing a cold column.

**F1.** The 5 s confidence window is **70.5% of the cache-hit wait and 3.5% of
the cache-miss wait**. Drawn as two panels on different scales, because on one
shared axis whichever path is drawn second is invisible.

**F3.** Every request in the concurrency sweep was a cache hit, so the
near-linear speedup (7.94x at k=8) describes the HTTP and cache path, **not
MusicGen batching**. Reporting it as batching needs a cold-cache re-run.

**F6.** n=141. |seam energy| p50 3.73 dB pre-crossfade -> 2.64 dB post. Duration
retention p50 **0.503**, 12.8% below 0.20. Per-mood: `calm` is the one mood
where the post-crossfade seam is *worse* than the pre — worth a look.

**T5.** The sensitive detector on a 20-page adversarial slice: **FN 0.455, FP
0.333**. Both of the plan's own named near-misses behave badly — "grief
counselling degree programs" trips it (two ambiguous terms), and so does a
clinical eating-disorder chapter (one severe term). Euphemism, non-English and
three whole topics outside the term list are all missed. This is what pre-mortem
#10 demands and it is not a flattering number; it belongs in §5.6 as-is.

**C-14.** The mood x style x bpm x energy request space is **1,925 cells**. The
99-entry pre-warm grid covers 5.1% of it *even if every entry is distinct* —
which is the point: it is a cache, not a library. A 1,000-track curated library
covers 40.5% under uniform commissioning, 20.4% under realistic skew.

**C-16.** At N=56 the pipeline recovers every planted effect: H1 +0.754 (planted
+0.8), H2 +1.187 (+1.2), H3 -0.076 (0.0, and TOST declares equivalence), H4
-7.459 (-6.0). Two bugs were flushed out by doing this before the data exists,
which is the entire argument for doing it: statsmodels' MixedLM dies with
"Singular matrix" when `groups` is a pandas-3.0 Arrow-backed string column, and
F7 crashed on SILENCE because fit there is *undefined* rather than missing.

## Not done, and why

* **C-17 (GPU + hardware matrix)** — needs rented hardware. Everything else in
  §3 S1's three-configuration matrix is ready to re-run against it unchanged.
* **D-01/D-02/D-03/D-06** — the 600-page corpus, annotation and the real S2
  sweep. Excluded from this session by request. Every instrument they need now
  exists and is tested.
* **D-05** — S5 deployment. Blocked on H-01; the participant build (C-15) and
  the analysis script are both ready.
* **D-04** — drafted at `analysis/PREREGISTRATION.md` with two fields honestly
  marked `PENDING` (pilot effect sizes, final page set). Lodging it with those
  guessed would defeat its purpose.

## Commands

    python analysis/build_all.py
    python analysis/krippendorff.py --self-test
    python analysis/s4/simulate_and_check.py --n 56
    python analysis/loop_ab/build_stimuli.py --pairs-per-mood 2
    python analysis/loop_ab/score_loop_ab.py --simulate 30
    python audio-generation/experiments/d3_clip_length.py --from-cache results/d2-loop.json
    node analysis/audit/t5_audit.mjs
    node analysis/cost/cost_accounting.js
    node analysis/baselines/retrieval_baseline.mjs
    node analysis/corpus/capture_corpus.mjs --self-test
    node analysis/annotate/annotate_test.mjs
    node analysis/s4/assignment_test.mjs
    node analysis/bundle/make_bundle.mjs --milestone dev
    node mood-classification/experiments/s2_tier_ablation.js --corpus s2_smoke_corpus.json --with-a6
    node mood-classification/experiments/s3_signal_ablation.js --corpus <corpus> --offline

---

# 2026-08-11 (continued) — converting valhalla/distilbart-mnli-12-1 to ONNX

User request: get `valhalla/distilbart-mnli-12-1` (the original, non-mirror
checkpoint the now-dead `Xenova/distilbart-mnli-12-1` was converted from)
working locally, converting to ONNX if required.

## Three real toolchain bugs found and fixed, none specific to this checkpoint

**1. PyPI's `optimum`/`optimum-onnx` wheels are incomplete.** Every
combination tried — `optimum==2.1.0`+`optimum-onnx==0.1.0`,
`optimum[exporters]==1.24.0`, `optimum==1.20.0`, `optimum==1.23.3` — either
lacked `exporters/onnx/model_configs.py`/`base.py`/`convert.py` entirely or
lacked `commands/export/onnx.py`, regardless of the paired `transformers`
version. Confirmed by direct file listing of the installed wheel, not
inference from error messages. Fix: `pip install optimum[exporters] @
git+https://github.com/huggingface/optimum.git@v1.23.3` — building from the
actual GitHub source tree has every file the PyPI wheel is missing.

**2. Python 3.14 made `functools.partial` implement the descriptor protocol.**
Confirmed with a five-line reproduction outside optimum entirely
(`Foo.bar = functools.partial(int, base=10); Foo().bar` prints `<bound method
?>` on 3.14, a bare partial on 3.13). `optimum` stores every
`NORMALIZED_CONFIG_CLASS` this way; instance access now silently inserts
`self` as an extra positional argument, producing
`TypeError: NormalizedConfig.__init__() got multiple values for argument
'allow_new'` — a message that gives no hint the real cause is a Python
version, not an optimum bug. Fix:
`mood-classification/experiments/_optimum_py314_shim.py`, which wraps
`NormalizedConfig.with_args`'s return in `staticmethod(...)`, opting out of
the new descriptor binding. Self-tests itself on import.

**3. torch 2.12's `torch.onnx.export` defaults to `dynamo=True`** (the newer,
symbolic-shape-*proving* tracer), which `optimum`'s call site was never
updated for (still passes the legacy-only `dynamic_axes` kwarg). That tracer
also correctly *refused* to trace `BartForSequenceClassification` as shipped:
its EOS-token pooling (`hidden_states[input_ids.eq(eos_token_id), :]`) is
genuinely value-dependent
(`GuardOnDataDependentSymNode` at `modeling_bart.py:1783`). Forcing the
legacy tracer instead (`dynamo=False`) makes the export "succeed" — and
produces a model that **silently gives wrong answers on real input**: fp32,
confidently backwards entailment/contradiction logits on 2 of 3 spot-check
sentences, verified before any quantization was involved. The real fix,
`mood-classification/experiments/_bart_seqcls_onnx_patch.py`, replaces the
boolean-mask pooling with `attention_mask.sum(dim=1) - 1` (static, shape-
generic, numerically verified identical to the original on a real padded
batch — max abs diff **0.0**). With that patch applied, the *proving* dynamo
tracer succeeds cleanly instead of refusing.

## A methodology trap that cost real time

Chasing bug 3, the "confidently backwards" logits looked like an export
correctness bug and drove the whole patch investigation. It wasn't, mostly:
zero-shot-via-NLI picks the label whose entailment logit is highest
**relative to the other candidate labels for the same premise** (softmax
across labels), never whether entailment beats contradiction **in isolation**
for one pair — checking the latter is simply the wrong decision rule, and it
made a correct, unpatched export look broken. Once re-checked with the
correct full 13-way ranking, **all three fp32 export variants (unpatched
legacy tracer, patched legacy tracer, patched dynamo tracer) matched eager
PyTorch ground truth exactly**, byte-for-byte, on every spot-check sentence.
The BART pooling patch turned out to be correct and worth keeping (it's what
lets the proving tracer succeed at all, and it's still a real, if latent,
export-safety fix) but was not fixing the symptom that was actually observed.
Recorded in the conversion script's docstring so this isn't re-discovered the
hard way next time.

## The real, measured problem: quantization

INT8 dynamic quantization meaningfully degrades this specific checkpoint.
7-sentence full-ranking spot check against fp32 ground truth:

| variant | size | correct |
|---|---|---|
| fp32 | 890 MB | 7/7 |
| int8 per-tensor | 224 MB | 0/7 — near-uniform, unusable |
| int8 per-channel | 224 MB | 5/7 |
| int8 per-channel, classification head excluded from quantization | 224 MB | 5/7 (no improvement — the head isn't the bottleneck) |

fp32 is far too large to vendor in a browser extension. Per-channel int8 is
what's vendored. On the same 7-sentence check, the **currently-shipped**
default (`Xenova/nli-deberta-v3-xsmall`, fixed earlier this session) scored
**3/7** — so the quantized valhalla conversion is not clearly worse, but at
~10x the download size for a same-ballpark result on a 7-sentence sample,
that's not a clear enough win to justify swapping the shipped default either.
Decision: vendor it as a documented, opt-in alternative
(`ui/models/valhalla/distilbart-mnli-12-1/`, selectable via
`W2M_ZEROSHOT_MODEL` or `s2_tier_ablation.js --with-a6 --a6-model
valhalla/distilbart-mnli-12-1`), leave the shipped default unchanged.

## What's on disk now

* `mood-classification/experiments/_optimum_py314_shim.py` — the Python 3.14
  compatibility patch, reusable for converting any HF model in this
  environment, not specific to BART or MNLI.
* `mood-classification/experiments/_bart_seqcls_onnx_patch.py` — the
  BART-sequence-classification pooling fix, reusable for
  `bart-large-mnli`/`distilbart-mnli-*`/any `BartForSequenceClassification`
  export.
* `mood-classification/experiments/convert_bart_mnli_to_onnx.py` — the
  packaging script: export, quantize, fix the tokenizer.json merges-format
  mismatch (current `tokenizers` serializes merges as `[left, right]` pairs;
  transformers.js 2.x's BPE loader expects legacy space-joined strings — also
  fixed here, unrelated to the three bugs above, found while first loading the
  vendored model in Node), verify against ground truth, vendor. Validated
  end-to-end: re-running it against the existing export reproduces the same
  vendored artifact and passes 4/4 on its spot check.
* `ui/models/valhalla/distilbart-mnli-12-1/` — the vendored checkpoint,
  217 MB, config + tokenizer + `onnx/model_quantized.onnx`.
* `ui/models/README.md` — updated with the full picture: why it's not the
  default, the three bugs, the measured quantization tradeoff.

No shipped extension code changed this entry (`DEFAULT_MODEL_ID` stays
`Xenova/nli-deberta-v3-xsmall`, set earlier this session). This is additive:
a working, verified, documented alternative, not a default swap.
