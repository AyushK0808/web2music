# Web2Music — Paper Readiness Roadmap

> **Reviewed:** 2026-07-11 · All findings below were verified against the code at commit `dde6caf` (+ working tree).
> **Updated:** 2026-07-13 · Items marked ✅ were resolved by [PR #3](https://github.com/AyushK0808/web2music/pull/3) (`feature/d-audio-generation`, open at time of update): D-side Handoff-2 unwrapping, B-prompt consumption, 11-mood instrument map, `asyncio.to_thread`, cache-key fix.
> **Updated:** 2026-07-13 (2nd pass) · Also reflects [PR #1](https://github.com/AyushK0808/web2music/pull/1) (`feature_b`, Sneha, open) — fixes **X3**, tier-2 validation, `temperature: 0`, prompt-injection hardening, bypass pass-through, non-English escalation, injectable confidence window, and **switches the tier-2 LLM from Claude Haiku to GroqCloud `llama-3.1-8b-instant`** (+ Docker key proxy) — and [PR #4](https://github.com/AyushK0808/web2music/pull/4) (`fix/retry-fallback-logic`, Tvisha, open, includes PR #3's changes) — retry + fallback-clip system, GPU/fp16, ~28 s default clips.
> **Updated:** 2026-07-14 · PR #4's review-round-2 commit (`c36c54a`) resolved 3 of the 4 requested-changes items: seed now varies per retry and is logged in response metadata, total-failure path now returns 503, and the `IS_PROD`/`d5_cache_local.py` regression from PR #3 is restored. The 4th item — `generate_fallbacks.py` — is **not actually in the diff** despite the commit message and the author's PR reply both claiming it was added; verified against the branch tree, not just the PR conversation.
> **Updated:** 2026-07-15 · [PR #5](https://github.com/AyushK0808/web2music/pull/5) (`feature_b`, Sneha, open) fixes the message-port leak, Handoff-1 version check, sensitive-content false positives, and `runB3` wall-clock injection (§3.1) — reviewed clean, recommended for merge. [PR #6](https://github.com/AyushK0808/web2music/pull/6)/[#7](https://github.com/AyushK0808/web2music/pull/7)/[#8](https://github.com/AyushK0808/web2music/pull/8) (Tvisha) are **stacked, not independent** — #7 contains #6's commit, #8 contains both of #7's commits plus the Pydantic model (verified via commit counts + identical diffs) — merge #8 only, close #6/#7 as superseded. #8 is **not yet mergeable as-is**: its `MusicProfile.bpm` field enforces `ge=40`, but B3's own bpm formula ([b3_musicProfileGenerator.js:186-189](mood-classification/feature_b/b3_musicProfileGenerator.js#L186-L189)) can legitimately emit bpm as low as 25 (`sad` mood + `educational` page + `late-night` — a real, reachable combination), which the new validation would 422-reject. Items below left unchecked until that's fixed.
> **Updated:** 2026-07-18 · **[PR #9](https://github.com/AyushK0808/web2music/pull/9)** (`vedantwork`, Vedant, open) **resolves X2** — the last show-stopper: real minimum-loop-length gate, `np.nan_to_num`, vectorized correlation, bar-boundary snapping, equal-power crossfade. Verified independently: the vectorized correlation matches the old per-frame `np.corrcoef` to ~2.5e-16 and the NaN-poisoning is gone; signature `(mp3_bytes, loop_point_ms)` preserved so `main.py` is unaffected. **Recommended for merge** — one caveat: the PR's "synthetic checks" are *not committed as a test*, so the fix has no CI regression guard yet; stereo-interleaving limitation documented as dormant (musicgen-small is mono). **[PR #10](https://github.com/AyushK0808/web2music/pull/10)** (`feature_b`, Sneha, open) clears three §3.1 Medium items + the §7 sensitive-content policy (fixes 13/14/15/16): per-tab `chrome.storage.session` state + heartbeat alarm, idle-fade re-based on real activity, golden Groq fixtures, and **silence-by-default** on sensitive content (uplifting now opt-in). Full test suite runs green (verified). **Merge after two confirmations:** (a) explicit owner sign-off on the silence-vs-uplifting *default* (a product/ethics decision, not a bug fix), and (b) the Feature D / Handoff-2 consumer actually honors `volume:0`/`isSilent` so a "silence" outcome doesn't still spend GPU-minutes generating audio that's then muted. Both PRs are disjoint (audio-generation vs mood-classification), conflict-free, mergeable in either order — merge #9 first (clears the paper's last technical blocker).
> **Updated:** 2026-07-19 · **[PR #8](https://github.com/AyushK0808/web2music/pull/8)** review-round-2 (`feat/pydantic-request-model`, Tvisha) — **the prior blocker is fixed and the PR is now mergeable.** Commit `b780094` lowers `MusicProfile.bpm` to `ge=20` (covers B3's reachable minimum of 25 with margin), and the branch now **exposes `duration_seconds` as an API field** (ge=5/le=30, default 28) threaded through `generate_audio(prompt, duration_seconds)` — closing the long-open X1 `duration`-contract gap, not just the Pydantic item. The cache key also now includes `valence_tier` + a `duration_bucket` (2 s tolerance). Verified: clean merge into `main` (no conflicts), all touched Python files parse. Remaining nits are non-blocking: (a) [main.py:62](audio-generation/main.py#L62) `try:` body indented 9 spaces vs 8 (legal single-statement, just inconsistent); (b) the `duration_bucket` comment in [d5_cache.py](audio-generation/d5_cache.py)/[d5_cache_local.py](audio-generation/d5_cache_local.py) is off-by-one (`(27//2)*2=26` and `(29//2)*2=28`, not `→28`/`→30` as written — the bucketing itself is correct); (c) no automated tests for the new models (4 manual cases only), and the "no auth/rate-limiting on `/generate`" deployment note is still unwritten. **Still bundles** the `torch.compile` (`b6653bf`) + `requirements.txt`-pin (`430ad8e`) commits, so merging #8 lands those too — merge #8 only, close #6/#7.
> **Updated:** 2026-07-19 (2nd pass) · **[PR #2](https://github.com/AyushK0808/web2music/pull/2)** (`data-extraction_1`, Pari, open) clears three §2.1 Feature A items on the text extractor: the `doc.body` null-guard, the jsdom `textContent` fallback in `textDensityScore` (element + link text), and the Medium **boilerplate substring→whole-token** rewrite (the item that had been reassigned to Vedant — Pari did it here) via new `classOrIdTokens`/`stripHintedElements` helpers, now exported. Reviewed against the actual diff: **`extractMetadata` and the `description`/`lang` fields are retained and still exported** — no `pageData.js`/`b1` regression (the PR title "Remove extract data function" is misleading; nothing is removed, and the owner's "changes requested" — metadata removal — is not present in the current head, so that review is stale and should be re-cleared). Token matching splits on whitespace only, so hyphenated compounds (`main-nav`, `navbar`) are no longer stripped — this is *correct* per both roadmap false-positive examples (`shadow`, `document-menu`→`menu`), a deliberate precision-over-recall choice worth a code comment. **Mergeable after two non-blocking nits:** (a) revert the stray trailing-newline removal in [Colorextractor.js](data-extraction/Colorextractor.js) (unrelated to the PR), (b) no `node:test` added despite the "for testability" exports (§2.1 test-suite item still open).
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

These three bugs mean the system a study participant would experience today is a **non-adaptive, non-looping, constant calm clip**. Any data collected before fixing them measures a system that doesn't exist. *(Post-PR #3: the "non-adaptive" leg is largely fixed on the main path — X1 below is mostly resolved on the D side. Post-PR #1: X3 is fixed. Post-PR #9: **X2 is now resolved on its branch too** (reviewed, recommended for merge) — so all three show-stoppers have a fix in flight, though none has landed on `main` yet. X2's merge also unblocks PR #4's fallback-clip generation.)*

### X1 · The B→D handoff never connects `[L]` — **Tvisha + Sneha** — ⚠️ partially resolved (PR #3, D side)
Feature B outputs a nested camelCase payload ([b4_promptEngineer.js:191-232](mood-classification/feature_b/b4_promptEngineer.js#L191-L232)); Feature D expects a flat snake_case profile ([main.py:26](audio-generation/main.py#L26)). Nothing flattens it ([background_integration.js:29-37](mood-classification/background_integration.js#L29-L37) forwards verbatim), so [d1_validate.py](audio-generation/d1_validate.py) fills **all defaults** → every page generates identical "calm ambient, 80 bpm, C major" audio.

> ✅ **PR #3:** `d1_validate.py` now unwraps `payload.musicProfile` and extracts `payload.prompt`; the single-word profile fields (`mood`, `bpm`, `key`, `energy`, `valence`, `intensity`, `reverb`, `ambience`, `timbre`, `instruments`, `dynamics`, `style`) match D's names directly and flow through. The all-defaults → identical-calm-audio failure is gone on the main path. Remaining sub-items:

- [x] ✅ **PR #3** — D discards B4's engineered prompt entirely and rebuilds a weaker one in [d2_prompt.py](audio-generation/d2_prompt.py). *Fixed: `build_prompt` now prefers `prompt_from_b` (>20 chars) and `main.py` logs the prompt source. The CLAP/FAD A/B of the two builders (see Fix below) is still unclaimed — PR #3 short-circuits rather than ablates.*
- [x] ✅ **PR #3** — Mood taxonomy mismatch: D's instrument map now covers all 11 of B's moods, and `d1_validate` rejects moods outside the shared list. (Only reachable via the D2 fallback path now that B's prompt is preferred.)
- [ ] `contentCategory` (B, camelCase) ≠ `content_category` (D, snake_case) — **still open post-PR #3**: B4 emits `contentCategory` at the handoff *top level*, D's validator reads snake_case `content_category` from inside the profile → still defaults. Same for `atmosphereTags`/`listeningContext` (fallback-prompt/metadata impact only).
- [x] B4's generic prompt requests "60–90 seconds per loop" ([b4_promptEngineer.js:103](mood-classification/feature_b/b4_promptEngineer.js#L103)); ~~D generates ~5.1 s~~ PR #4 raised the default to `max_tokens=1400` ≈ **28 s** (with `min_new_tokens` pinned), and ✅ **PR #8** now **exposes `duration_seconds` as an API field** (ge=5/le=30, default 28) that flows `HandoffPayload → profile → generate_audio(prompt, duration_seconds)` where `max_tokens = duration_seconds * 50` — so the contract field is now open on the wire. (B4's prompt still asks for 60–90 s in text while musicgen-small caps quality at ~30 s — a prompt-vs-capability mismatch, but D no longer silently ignores duration.)
- [ ] **No continuous `valence` in the profile** — *mostly done*: B3 now emits `valence` ([b3:264](mood-classification/feature_b/b3_musicProfileGenerator.js#L264)), ✅ PR #3 makes D accept + clamp it, and ✅ PR #1 fixes the sign (X3), so the value is now trustworthy. **Still open:** rename/duplicate `energy` → `arousal` (no `arousal` field exists anywhere in B). — **Sneha** (emit) `[S–M]`
- [ ] **`d2_prompt.py` role changes under fine-tuning** — for the conditioned generator, `d2_prompt.py` builds a **conditioning vector** `(v, a, log bpm)` (+ optional text), not a mood→instrument text prompt. The discrete instrument map (`d2_prompt.py:15-22`) is bypassed entirely, which **dissolves the 11-vs-6 mood-taxonomy mismatch** flagged above rather than patching it. — **Tvisha** (consume) `[M]`

**Fix:** one JSON-schema'd Handoff-2 contract validated on both sides *(open — PR #3 is D-side only; B side unchanged)*; ~~D consumes B4's `prompt`~~ ✅ PR #3; ~~one shared mood taxonomy~~ ✅ PR #3; add a `duration` field ✅ **PR #8** (`duration_seconds`, ge=5/le=30, consumed by D), plus `valence` ✅ / `arousal` *(open)* scalars alongside it (keep the discrete `mood`/`style` fields for the `B0` text-prompt baseline in §4.4 so both generators read the same contract). Then A/B the two prompt builders (CLAP/FAD) and delete the loser — that's a free ablation for the paper *(open — PR #3 short-circuits to B's prompt without measuring)*.

### X2 · Loop-point detection is degenerate — always returns the full clip `[M]` — **Vedant** — ✅ resolved (PR #9, open)
The self-similarity search ([d4_process.py:42-51](audio-generation/d4_process.py#L42-L51)) compares the first 10 chroma frames against every window **including i=0**, where correlation is exactly 1.0 (self-match). `np.argmax` → always frame 0 → snaps to first beat → the `< 1000 ms` guard ([d4_process.py:62-63](audio-generation/d4_process.py#L62-L63)) fires → `loop_point_ms = len(audio)`, every time. (Any constant window instead propagates NaN through argmax to a garbage index.) The chroma analysis is effectively dead code; the README's `loop_point_ms: 18400` example is not producible.

**Fix:** start the search past a minimum loop length (≥ 2–4 s), `np.nan_to_num`, vectorize the correlation loop, snap to **bar** boundaries (not any beat), equal-power crossfade head→tail instead of `fade_out(50)` ([d4_process.py:65-66](audio-generation/d4_process.py#L65-L66)) — a fade to silence is audible on every repeat.

> ✅ **PR #9** implements every prescribed fix: `MIN_LOOP_SECONDS = 3.0` gate (so i=0's self-match can't win), `np.nan_to_num` on the correlation output, a vectorized `sliding_window_view` correlation (verified numerically identical to the old `np.corrcoef` loop to ~2.5e-16, and NaN-free on zero-variance/silent windows where the old code produced NaN), every-4th-beat bar-boundary snapping (approximate 4/4 downbeats — librosa exposes no true downbeats), and a sin/cos equal-power head→tail crossfade replacing `fade_out(50)`. Return signature unchanged, so `main.py` is unaffected. **Remaining before this can be called fully done:** (1) the "synthetic checks" from the PR description aren't committed as an actual test file — land them so the critical loop logic has a CI regression guard; (2) the now-dead `< 1000 ms` guard in `process_audio` should be cleaned up (harmless but confusing); (3) stereo-interleaving bug is documented and dormant (musicgen-small is mono) — must fix before any `-stereo` checkpoint.

> ⚠️ **Also unblocks PR #4:** the fallback-clip generation (`generate_fallbacks.py`, per the PR #4 description) was deliberately deferred until X2 landed so the 11 pre-generated clips loop properly. With PR #9's fix in flight that dependency clears on merge — but note as of 2026-07-14 `generate_fallbacks.py` still isn't actually in PR #4's branch either (see §4.1), so confirm that file lands alongside once X2 merges.

### X3 · Inverted valence scale in the tier-2 LLM prompt `[S]` — **Sneha** — ✅ resolved (PR #1)
[b2_moodClassifier.js:239](mood-classification/feature_b/b2_moodClassifier.js#L239) tells the model `"valenceHint": <-1.0 positive to 1.0 negative>`, but `computeValenceHint` ([b2:441-456](mood-classification/feature_b/b2_moodClassifier.js#L441-L456)), `pickKey` ([b3:178-184](mood-classification/feature_b/b3_musicProfileGenerator.js#L178-L184)), and B4's valence adjectives all treat positive-as-positive. **Every tier-2 result flips major/minor key choice and prompt tone.** Fix the prompt text and clamp the parsed value.

> ✅ **PR #1:** prompt now reads `<-1.0 negative to 1.0 positive>`, the parsed value is clamped to `[-1, 1]` via the new `validateLLMResult`/`clampHint`, the missing-value fallback uses `computeValenceHint(finalResult.mood)` (the LLM's mood, not the pre-LLM blend), and a regression test pins the direction so the inverted wording can't resurface. **This unblocks the "valence sign trustworthy" caveat in X1's valence sub-item.**

---

## 2. Feature A — `data-extraction/`

### 2.1 Changes

**Small `[S]`**
- [ ] **Embedding cache ignores backend/model** — [pageData.js:153](data-extraction/pageData.js#L153) keys on `url + text-hash` only; switching `local` (384-dim) → `openai` (1536-dim) returns a stale wrong-model vector. Include backend + model in `cacheKey()`. — **Pari**
- [ ] **No fetch timeout** — [Embeddingmodel.js](data-extraction/Embeddingmodel.js) `openai`/`service` backends can hang forever (Feature B uses 8 s AbortControllers; A has none). Add configurable AbortController timeout. — **Pari**
- [ ] **Failed local pipeline cached forever** — [Embeddingmodel.js:85-91](data-extraction/Embeddingmodel.js#L85-L91): a rejected `localPipelinePromise` never clears; every later call fails. Clear on rejection. — **Pari**
- [ ] **Embed service open to any local caller** — [embedService.js](data-extraction/docker/embedService.js) sends `Access-Control-Allow-Origin: *` (line 37) and binds all interfaces (line 107): any webpage/LAN host can burn the OpenAI key. Bind `127.0.0.1`, require a shared-secret header, restrict CORS. Also `readBody()` rejects >1 MB but never `req.destroy()`s. — **Pari**
- [x] ✅ **PR #2** — **`extractPageText` assumes `doc.body`** — [Textextractor.js:107](data-extraction/Textextractor.js#L107) threw before DOM-ready / on frameset pages → empty handoff. Now null-guarded: returns a well-formed empty result (`mainText:''`, `wordCount:0`) that still carries `title`/`description`/`lang`. — **Pari**
- [x] ✅ **PR #2** — **Text-density scoring inert under jsdom** — [Textextractor.js:19](data-extraction/Textextractor.js#L19): `innerText` is undefined in jsdom so every candidate scored 0 and the playground exercised a different code path than the browser. Now falls back to `textContent` in `textDensityScore` (both element and link text). — **Pari**
- [ ] **First handoff always reports zero behaviour** — default tracker starts lazily ([behaviorTracker.js:158-164](data-extraction/behaviorTracker.js#L158-L164)); start at content-script init. Also only listens on `window` scroll — misses inner scrollable containers, horizontal scroll, touch; use `{capture: true}`. — **Pari**
- [ ] **English-only readability** — [Readability.js](data-extraction/Readability.js) Flesch is meaningless for non-English; `lang` is extracted but never gates it. Return the neutral 0.5 default when lang ≠ en. — **Pari**
- [ ] **Syllable counters drift** — [Readability.js:23](data-extraction/Readability.js#L23) returns 0 for an empty word; [b1_contentUnderstanding.js:93](mood-classification/feature_b/b1_contentUnderstanding.js#L93) returns 1 — despite both files claiming "identical mapping". Unify (the §5 integration test would have caught this). — **Pari**

**Medium `[M]`**
- [x] ✅ **PR #2** — **Boilerplate stripping uses substring matching** — [Textextractor.js:111-114](data-extraction/Textextractor.js#L111-L114): `[class*="ad"]` deleted `shadow`/`gradient`/`download`/`badge`/`loading`; `menu` matched `document-menu` content wrappers. Now tokenizes className/id (`classOrIdTokens`, SVG-safe via `getAttribute('class')`) and matches whole tokens in both `looksLikeBoilerplate` and the new `stripHintedElements`. ⚠️ Splits on whitespace only, so hyphenated compounds (`main-nav`, `navbar`, `related-posts`) are no longer stripped — intended (aligns with both false-positive examples above) but should carry a code comment. — ~~**Vedant** (reassigned from Pari)~~ **Pari** (done in PR #2)
- [ ] **No test suite** — `package.json` has only `play` (eyeball-only [playground.js](data-extraction/playground.js)). Port playground scenarios to `node:test` + `assert`; jsdom is already a devDependency. — **Vedant** (reassigned from Pari)

### 2.2 Additions for the paper
- [ ] Per-stage extraction latency + failure-rate telemetry (feeds the §6 systems eval). — **Pari**
- [ ] Element cap / sampling in [Colorextractor.js](data-extraction/Colorextractor.js) (`getComputedStyle` + `getBoundingClientRect` on every element = forced-layout risk) and measure extraction cost on the top-100 sites. — **Pari**

### 2.3 Limitations to declare (not fix)
- Color extraction sees only `background-color` — no background images, gradients, `<img>` content (photo-heavy pages read achromatic); `parseRgba` can't parse hex/named/oklch; overlapping elements double-count (no occlusion). Frame it as a **hue-bias signal, not ground truth**.
- Behaviour speeds (scroll/cursor px/s) are coarse proxies for affect; the doomscrolling→tense inference is an unvalidated assumption — say so.

---

## 3. Feature B — `mood-classification/`

> ⚠️ **Provider switch (PR #1):** tier-2 no longer calls Anthropic/Claude at all — both LLM calls now hit **GroqCloud's** OpenAI-compatible API with **`llama-3.1-8b-instant`** (single source of truth in the new `feature_b/llmConfig.js`, overridable via `_config.llmModel`), optionally through a new Docker proxy (`mood-classification/docker/classifyService.js`) that keeps the key server-side. This ripples into the paper: the two-tier cost/latency story, the reproducibility bundle (§5), and the ethics data-flow statement (§7) must all now name Groq/Llama, not Anthropic/Claude — and tier-2 accuracy claims should be re-checked against the smaller 8B model (the LLM-only baseline in §3.2 measures this anyway).

### 3.1 Changes

**Small `[S]`**
- [x] ✅ **PR #1** — **X3 — inverted valence prompt** (see §1). — **Sneha**
- [x] ✅ **PR #1** — **Validate tier-2 LLM output** — new `validateLLMResult` guards mood/pageType against the shared lists and `clampHint` clamps `confidence`/`energyHint`/`valenceHint` (rejecting null/blank instead of coercing to 0, so `??` fallbacks still fire). — **Sneha**
- [x] ✅ **PR #1** — **Set `temperature: 0`** on both LLM calls, with regression tests asserting it. — **Sneha**
- [x] ✅ **PR #1** — **Prompt-injection hardening** — page text now wrapped in `<page_content>` delimiters with explicit treat-as-data instructions, plus whitespace-tolerant `escapePromptDelimiters` stripping forged closing tags; attack + mitigation demonstrated in tests. *Still to do for the paper: write the robustness subsection itself from these tests.* — **Sneha**
- [x] ✅ **PR #1** — **Browser CORS + client-side key** — resolved by the provider switch + proxy: "proxy" backend calls the local Docker container (`classifyService.js`) which holds `GROQ_API_KEY` server-side, no key in the browser, no CORS question. ⚠️ "direct" mode (the default) still ships the Groq key client-side and its extension CORS behaviour is unconfirmed — the study deployment should use `proxy`. — **Sneha**
- [x] ✅ **PR #1** — **Model ID hardcoded twice** — lifted into `llmConfig.js` `DEFAULT_MODEL` + `_config.llmModel`; integration test asserts both calls use the single knob. — **Sneha**
- [x] ✅ **PR #5** — **`registerFeatureBListener` returns `true` but never calls `sendResponse`** — [index.js:174-196](mood-classification/feature_b/index.js#L174-L196) leaked open message ports; now returns `false`, regression-tested. — **Sneha**
- [x] ✅ **PR #1** — **Pipeline errors bypass the 5 s stability rule** — the catch block now routes `"calm"` through the same `decideTransition`/`shouldTransition` gate as a real mood; a single transient error no longer hard-switches, a persistent one still settles to calm after the window (both regression-tested). — **Sneha**
- [x] ✅ **PR #1** — **Bypass results drop pass-through fields** — B1's and B2's bypass returns now forward `colors`/`scrollSpeed`/`cursorSpeed` and set an explicit `category` (`"Finance"` for payment pages); end-to-end test pins that a checkout page reaches B3 as `contentCategory: "Finance"`, not `"Entertainment"`. — **Sneha**
- [x] ✅ **PR #1** — **Feature A's enrichment ignored** — B1 now prefers `pageData.readingComplexity`/`isImageOnly` when present and passes through `wordCount`/`colorEnergy`, falling back to its own computation otherwise. *`embedding` still passes through unused — that's the §3.2 embedding-kNN baseline.* — **Sneha**
- [x] ✅ **PR #5** — **Handoff-1 version never checked** — A stamps `handoffVersion: "1.0.0"`; B1 now checks the major version against Feature A's, warns on mismatch but never throws (mirrors `d1_validate.py`'s philosophy), unstamped/minor-bump payloads stay silent. — **Sneha**
- [x] ✅ **PR #1** — **English-only heuristics** — non-English pages now force tier-2 escalation in B2 (even when colour/behaviour bias would clear the 0.5 threshold) and skip the keyword category heuristic in B1, both regression-tested. — **Sneha**
- [x] ✅ **PR #5** — **Sensitive regexes false-positive easily** — [b1:28-33](mood-classification/feature_b/b1_contentUnderstanding.js#L28-L33): "The Great Depression", "grief counselling degree programs", historical "genocide" all triggered the override. Now split into SEVERE (1 hit is enough — suicide, self-harm, rape, terrorism) vs. AMBIGUOUS (needs ≥2 distinct terms — grief, depression, trauma, genocide, **abuse**), regression-tested against all three reported false positives. ⚠️ **Worth confirming with Sneha:** `abuse` moved from the old severe-equivalent group into AMBIGUOUS, so a lone "domestic abuse hotline" mention alone no longer flags — check this was intentional, not an incidental reclassification. — **Sneha**
- [x] ✅ **PR #5** — **`runB3` always uses the wall clock** — [b3:214](mood-classification/feature_b/b3_musicProfileGenerator.js#L214) never passed the injectable hour; now accepts optional `moodContext.hour`, forwarded to `getTimeOfDayContext()`, regression-tested (fixed-hour determinism + wall-clock fallback when omitted). — **Sneha**
- [x] ✅ **PR #1** — **Test suite sleeps 10.5 s for real** — `confidenceWindowMs` is now injectable via `configureFeatureB`; tests run with a 50 ms window. — **Sneha**
- [x] ✅ **PR #1** — **README drift** — filenames fixed (`feature_b_test.js`, `manual_tests/`) and the model line now matches the code (GroqCloud `llama-3.1-8b-instant`). — **Sneha**
- [x] ✅ **PR #1** — **Bare `package.json`** — `name`/`version`/`private`/`engines` added. — **Sneha**

**Medium `[M]`**
- [x] ✅ **PR #10** — **MV3 state won't survive** (fix 13) — the module globals are gone; per-tab state now lives in the new `feature_b/tabState.js` (`chrome.storage.session`, keyed per `tabId`, in-memory `Map` fallback for Node/tests), surviving service-worker respawn and never crossing tabs. A `chrome.alarms` heartbeat (`feature-b-heartbeat`, 1-min period — Chrome's published-extension floor) re-evaluates a static page's pending/idle deadlines with no fresh handoff, and `tabs.onRemoved` cleans up closed tabs. `resetConfidenceWindow`/`decideTransition`/`runFeatureB` are now async and take a `tabId`. Integration-tested (persistence via a fresh `getTabState` path, two-tab isolation, heartbeat resolving both a stuck-pending mood and an idle fade). — **Sneha**
- [x] ✅ **PR #10** — **Idle-fade design contradiction** (fix 14) — the long-article-goes-silent bug is fixed by re-basing `idleMs` on `lastActivityAt` (last *real* `FEATURE_A_HANDOFF`) instead of `currentMoodSince`; the heartbeat's own re-checks deliberately do **not** count as activity (else the clock never expires). A steady 6-min read now keeps its music as long as Feature A keeps observing activity; regression-tested end-to-end. — **Sneha**
- [x] ✅ **PR #10** — **Golden-fixture tests against the real API** (fix 15) — real recorded Groq responses checked in at `fixtures/groq_{category,mood}_response.json` (with the actual `usage`/`x_groq`/`system_fingerprint` wrapper fields, not hand-typed), replayed through `callCategoryLLMClassifier`/`callLLMClassifier` in the default `npm test` run (no key needed); `manual_tests/record_groq_fixtures.js` refreshes them against the live API. Catches response-shape drift the hand-typed mocks couldn't. — **Sneha**

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
- [x] ✅ **PR #4** — **GPU + fp16** — `d3_generate.py` now auto-selects CUDA when available with `torch_dtype=float16` (fp32 on CPU) and logs the device. `requirements.txt` still pins nothing (see the pinning item below). — **Tvisha**
- [x] ✅ **PR #3** — **Blocking call in async endpoint** — both `generate_audio` and `process_audio` now run via `await asyncio.to_thread(...)`; verified with concurrent requests (cache hits return while generation runs). — **Tvisha**
- [x] ✅ **PR #3 + PR #4** — **Cache key omits `key`** — `"key"` added to `make_cache_key()` in [d5_cache.py](audio-generation/d5_cache.py). PR #3 had made `d5_cache_local.py` dead code (dropped the `IS_PROD` switch, imported `d5_cache` unconditionally); ✅ **PR #4's review-round-2 commit restores the `IS_PROD` switch in `main.py`** and ports the same `"key"` fix into `d5_cache_local.py`, so both cache backends are live and consistent again. — **Tvisha**
- [x] ✅ **PR #4 + PR #8** — **Docs vs. code: clip length** — default is `max_new_tokens=1400` ≈ **28 s** (PR #4, `min_new_tokens` pinned to match), so code and README agree, and ✅ **PR #8 exposes `duration_seconds` as an API parameter** (ge=5/le=30) so length is no longer hardcoded (X1). **Still note for §5:** ~28 s at fp16 is a much longer per-request GPU time than the old 5 s clips, and duration is now caller-controllable up to 30 s — latency budget should be re-measured across the duration range, not just at the default. — **Tvisha**
- [x] ✅ **PR #4 (review round 2)** — **Seed the generation** — `d3_generate.py` now varies the seed per retry (`seed = 42 + attempt`, [d3_generate.py:35](audio-generation/d3_generate.py#L35)) instead of reapplying `42` identically, so a deterministic failure no longer repeats across all 3 attempts. The seed is also returned as `generation_seed` in the `/generate` response metadata ([main.py:122](audio-generation/main.py#L122)) for reproducibility. Still hardcoded as a base constant (`42 + attempt`, not configurable) — fine for now, revisit if reproducibility work (§5) wants a request-level seed override. — **Tvisha**
- [x] ✅ **PR #8** — **Pin `requirements.txt`**; add Pydantic request model (README already plans it); note `/generate` has no auth/rate-limiting (each request = GPU-minutes — cost-DoS surface; one sentence in deployment discussion). — **Tvisha** — ⚠️ **[PR #8](https://github.com/AyushK0808/web2music/pull/8)** (open; supersedes [PR #6](https://github.com/AyushK0808/web2music/pull/6)/[#7](https://github.com/AyushK0808/web2music/pull/7), which contain strict subsets of #8's commits — merge #8 only) has both pieces code-complete: `requirements.txt` pins to real, currently-published versions (verified against PyPI); `models.py` adds `MusicProfile`/`HandoffPayload` Pydantic models, `d1_validate.py` and `main.py`'s `/generate` now use them. ✅ **Now mergeable (review round 2, 2026-07-19)**: commit `b780094` lowers `MusicProfile.bpm` to `Field(ge=20, le=200)`, covering B3's reachable minimum of 25 (`clamp(raw, lo-20, hi+20)` with `sad`'s `bpmRange:[45,65]`, verified against [b3_musicProfileGenerator.js:186-189](mood-classification/feature_b/b3_musicProfileGenerator.js#L186-L189)) — the 422-rejection is gone. The branch also adds `duration_seconds` (X1, see §1) and folds `valence_tier`/`duration_bucket` into the cache key. Clean merge into `main`, all touched files parse. **Remaining (non-blocking):** auth/rate-limiting deployment note still unwritten; no automated tests for the new models (4 manual cases only); minor style nits ([main.py:62](audio-generation/main.py#L62) 9-space indent, off-by-one `duration_bucket` comment in the cache modules).
- [x] ✅ **PR #8** — **`torch.compile`** for ~1.5–2× on warm calls; consider lower `guidance_scale` (CFG = 2 forward passes/step) when latency-bound. — **Tvisha** — ⚠️ **PR #8** (same branch as above) wraps `synthesiser.model` in `torch.compile()` on CUDA; `guidance_scale` is explicitly *not* implemented (documented as blocked on `TextToAudioPipeline` not accepting the param — would need a manual `.generate()` + EnCodec path). The compile change is only tested against one clip/one prompt length in the PR description — since `.generate()`'s input length varies per request, recompilation on shape change could erase the claimed speedup; benchmark across several different prompt lengths before trusting the number.

- [ ] **Land PR #9's synthetic loop checks as a committed regression test** — the "synthetic checks" in PR #9's description aren't in the tree; port them to a real test so X2's loop logic has a CI guard against regression. — **Vedant**
- [ ] **Remove the now-dead `< 1000 ms` loop guard** in `process_audio` ([d4_process.py:62-63](audio-generation/d4_process.py#L62-L63)) — unreachable after PR #9's `MIN_LOOP_SECONDS` gate; harmless but confusing. — **Vedant**
- [ ] **Fix stereo channel-interleaving in the crossfade path** — documented dormant (musicgen-small is mono) but must be corrected before any `-stereo` checkpoint. — **Vedant**
- [ ] **Emit the seam-discontinuity metric** (spectral/energy delta at the loop point) as a logged field — feeds the §4.2 seam metric and the §6.3 loop-seamlessness listening study for free. — **Vedant**
- [ ] **Surface `loop_point_ms` in the `/generate` response metadata** so Feature C's Web Audio player can set `loopStart`/`loopEnd` from it — pairs with the gapless-export item below. — **Vedant**

**Medium `[M]`**
- [x] ✅ **PR #9** (open) — **X2 — real loop detection + equal-power crossfade** (see §1); reviewed, recommended for merge. — **Vedant**

**Small `[S]`** (X2 loop follow-ups — from PR #9's review)
- [ ] **Land PR #9's synthetic checks as a real test** — the vectorized-correlation-vs-`np.corrcoef` equivalence (~2.5e-16) and the NaN-free-on-silent-window assertions currently live only in the PR description. Commit them as an actual test file (under `audio-generation/experiments/` or a `tests/` module) so the critical loop logic gets a CI regression guard. — **Vedant**
- [ ] **Remove the now-dead `< 1000 ms` guard** — after PR #9's `MIN_LOOP_SECONDS = 3.0` gate, the old `< 1000 ms` short-clip guard in `process_audio` ([d4_process.py:62-63](audio-generation/d4_process.py#L62-L63)) can never fire; harmless but confusing. Delete it. — **Vedant**
- [ ] **Fail loud on the stereo-interleaving path** — the loop cut/crossfade is correct only because musicgen-small is mono; the stereo bug is documented but dormant. Add an explicit channel-count assert/branch in `d4_process.py` so it raises rather than silently mangling audio before any `-stereo` checkpoint. — **Vedant**
- [ ] **Log the seam-discontinuity metric at generation time** — d4 already computes the loop-point correlation; emit the spectral/energy delta at the chosen cut into `/generate`'s `timings`/response metadata so the §4.2 seam-discontinuity metric has data without a separate analysis pass. — **Vedant**
- [ ] **Round-trip test for `loop_point_ms`** — assert the value `process_audio` returns survives `main.py`'s response and matches the README contract (`loop_point_ms: 18400`-style example), so the Feature C gapless player (`loopStart`/`loopEnd`) can trust it. — **Vedant**

- [ ] **Gapless export** — MP3 (128k, [d4_process.py:69](audio-generation/d4_process.py#L69)) inserts encoder delay/padding → audible gap on loop even with a perfect cut. Export **WAV or Ogg/Opus** (Opus is gapless), or have the player decode into Web Audio `AudioBufferSourceNode` with `loopStart`/`loopEnd` from the `loop_point_ms` metadata. — **Vedant**
- [ ] **Longer / extendable audio** — raise tokens (500→10 s, 750→15 s; quality degrades past ~1500/30 s = training window); for arbitrary length use MusicGen **audio-continuation** (feed the tail back as audio prompt), or generate a clip whose end resolves toward its own start for intrinsic loopability. — **Tvisha**
- [ ] **Batch concurrent requests** (MusicGen supports batched generation — near-free throughput) and **pre-warm the cache** for the common mood×style×bpm grid at startup. — **Tvisha**
- [x] ✅ **PR #4** — **Retry logic + fallback clips** — code complete: `d3_generate.py` retries 3× with exponential backoff (2/4/8 s) + duration validation and raises `GenerationError`; new `fallback.py` picks a mood-matched clip from `fallback_clips/` with a neutral→calm→focused fallback chain; `main.py` catches the error and, if a fallback clip exists, serves it with `is_fallback: true` (200) — if none exists, now returns **503** (review-round-2 fix, see below) instead of a silent 200. ⚠️ **The actual clips still don't exist** — `fallback_clips/` is empty, and despite the review-round-2 commit message claiming `generate_fallbacks.py` was added, **the file is still not in the diff/tree** (verified `git show --stat` on that commit and `git ls-tree` on the branch tip — only `d1_validate.py`, `d2_prompt.py`, `d3_generate.py`, `d5_cache.py`, `d5_cache_local.py`, `main.py` changed). The reviewer's point #1 is not actually resolved; flag this back to Tvisha rather than trusting the "all fixed" reply. Clip generation is deliberately blocked on **X2** anyway so the pre-generated clips loop properly — follow up once X2 lands, and confirm `generate_fallbacks.py` lands with it. — **Tvisha**
- [ ] **`d3_generate.py` adapter switch** — when `USE_FINETUNED=true`, load the LoRA adapter + conditioning encoder (§4.4) instead of the stock pipeline; keep stock `facebook/musicgen-small` reachable as the `B0` baseline. Gate behind a config flag so the eval harness can A/B both from one server. — **Tvisha**

**Small `[S]`** (cache correctness under conditioning)
- [ ] **Cache key under continuous conditioning** — ⚠️ *partially done (PR #8)*: `make_cache_key()` in both [d5_cache.py](audio-generation/d5_cache.py) and [d5_cache_local.py](audio-generation/d5_cache_local.py) now adds `valence_tier` (`round(valence,1)`) and `duration_bucket` (`(d//2)*2`, 2 s tolerance) alongside the existing mood/bpm-bucket/energy-tier/style/key. **Still open:** no `arousal` axis (doesn't exist in B yet), `bpm` remains coarse low/mid/high buckets rather than quantized continuous, and `seed`/`guidance_scale` are deliberately excluded (documented: seed varies per retry, so including it would defeat caching). Once fine-tuning makes `(v, a, bpm)` fully continuous, revisit the bpm granularity and document it against README "Caching Logic". Minor: the `duration_bucket` inline comment is off-by-one (`27→26`, `29→28`, not as written). — **Tvisha**

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
- [ ] **Reproducibility bundle** `[S–M]` — pinned deps (Python + npm), pinned model IDs (HF revision + **Groq `llama-3.1-8b-instant`** — post-PR #1 the classifier is no longer Claude; note Groq-hosted models can be deprecated, so record the exact model + date), seeds (✅ `temperature: 0` landed in PR #1; ✅ D's seed varies per retry attempt and is now logged in `/generate`'s response metadata as `generation_seed`, PR #4 review-round-2), released prompts, golden fixtures, experiment configs. — **Vedant**
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

- **Data flow statement:** tier-2 sends title + summary + keywords + scroll/cursor speeds to **GroqCloud** (post-PR #1 — was Anthropic; update any drafted text, and note Groq's data-retention terms differ from Anthropic's); embeddings default to **local MiniLM** (good — say so), but `openai`/`service` backends ship up to 8000 chars of page text to OpenAI. Browsing content is sensitive data: document what leaves the device, when, retention, and opt-in. PR #1's Docker proxy changes where the *key* lives, not what page data leaves the device — the same content reaches Groq either way.
- [ ] **Fully-local mode** (tier-1 only + local embeddings) with its accuracy cost quantified — the privacy-utility tradeoff is itself a publishable ablation `[M]`. — **Pari**
- **Sensitive-content policy:** auto-playing *uplifting* music on grief/crisis pages was contestable — some users will find any music inappropriate there. ✅ **PR #10 (fix 16)** implements exactly the recommended **silence-by-default** (`mood: "silence"`, `energyHint/valenceHint: 0`, `silent: true` → index.js forces `volume:0`/`isSilent:true`), with `sensitiveContentMode: "uplifting"` retained as an explicit opt-in; the code carries a substantial ethics-rationale comment and it's tested end-to-end both ways. **Two things still owed before/at merge:** (a) this flips a user-facing *default* — get explicit owner sign-off, it's a product decision not a bug fix; (b) confirm the Handoff-2 consumer (Feature D) honors `volume:0`/`isSilent` so a silence outcome doesn't still spend GPU-minutes generating a (neutral) clip that's then muted — currently `buildHandoffFromRecord` still builds a full profile before the volume override. Still open regardless: evaluate the detector's FNR/FPR (~18 terms today, SEVERE vs AMBIGUOUS split from PR #5) and write the ethics paragraph pre-empting reviewer pushback. — **Sneha**
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

**One-sentence summary:** the existing findings list is accurate but is mostly Phase-1/2 hygiene; the paper lives or dies on Phases 3–4, and none of it can start until the B→D handoff connects (✅ mostly, PR #3 — `duration` + B-side contract still open), the valence sign is fixed (✅ PR #1, X3), and the loop detector stops being a no-op (✅ PR #9, X2 — reviewed, recommended for merge; also unblocks PR #4's fallback clips). **All three show-stoppers now have a reviewed fix in flight** — the critical-path gate has shifted from "does a fix exist" to "merge the open PRs (#1/#2/#3/#4/#5/#8/#9/#10) into `main` and run the one end-to-end integration test (§5)." If the fine-tuning track (§4.4) is taken, the audio contribution stands on §4.4's control-fidelity results; if not, D remains substrate and the paper rests on Phases 3–4 as written. *(Note: PRs #1, #2, #3, #4, #5, #8, #9, #10 are all still open — the ✅ marks describe their branches, not `main`. PR #2 adds the Feature A text-extractor cleanups on top of the earlier B/D-focused set.)*
