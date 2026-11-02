# R-1 — release checklist (CICT-2026 camera-ready)

Do this after the paper's numbers are final and `python analysis/numbers_diff.py --require-ack` prints `OK`.

## 1. Tag and archive

```powershell
git tag -a cict2026-camera-ready -m "CICT-2026 camera-ready"
git push origin cict2026-camera-ready
```

Then archive the tag on Zenodo (GitHub → Zenodo integration, or upload the source archive) and put the DOI in the paper's
data-availability sentence and in the response letter.

## 2. What goes in

| Item | Path | Notes |
|---|---|---|
| Code | the tagged repository | including all scripts named in `RUN_COMMANDS.md` |
| Corpus URLs, labels, guidelines | `analysis/corpus/urls*.jsonl`, `analysis/out/gold-*.json`, `analysis/annotate/GUIDELINES.md` | URLs and labels only |
| Per-annotator label files | `analysis/out/annotations/**` | anonymise names if the authors prefer |
| Result JSONs | `audio-generation/results/`, `mood-classification/results/`, `data-extraction/results/`, `analysis/out/`, `analysis/exposure/`, `analysis/proxies/out/fit_results.json`, `analysis/audit/results/` | every file a table or figure reads |
| Raw LLM responses | `analysis/llm-cache/*.jsonl` | lets anyone replay the cascade without a Groq key |
| Generated clips | `audio-generation/results/d7-clips/`, `d6-loop-seeds-clips/`, `analysis/proxies/out/clips/` | see licence note |
| Listening-study protocol (future work) | `analysis/PREREGISTRATION.md`, `analysis/loop_ab/`, `analysis/s4/session.html` | ready to run, not run |
| Hardware manifests | the `manifest` block in every result JSON | GPU, driver, CUDA, torch, precision, compile flag |

## 3. What stays out

- **No page text.** Do not release `analysis/corpus/s2_corpus*.json` (it holds `rawText`) or `analysis/proxies/out/profiles.json`
  (it holds a 600-character `lead` per page). Release URLs, ids and labels; people who need the text re-fetch the URLs. The LLM cache
  also holds prompts that embed page title/summary/keywords — release it only after checking that you are comfortable with that,
  or strip the `request` field (the `key` and `response` are enough to replay).
- No `.env`, no API keys, no `w2mTelemetrySecret`.

## 4. Licence notes to state in the README of the release

- MusicGen weights are **CC-BY-NC 4.0**: generated clips follow that licence (non-commercial, attribution). AudioLDM2 and the other models
  have their own terms; list each.
- Essentia models, LAION-CLAP and Audiobox Aesthetics are used as scorers only; cite them.

## 5. Final checks

- [ ] `npm test` and `python -m pytest` pass on the tagged commit
- [ ] `python analysis/numbers_diff.py --require-ack` → OK
- [ ] `grep -r "\\tbd" paper/main.tex` finds nothing
- [ ] DOI in the paper and the letter
