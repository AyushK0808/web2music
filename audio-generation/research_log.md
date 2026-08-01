# Research Log

Running lab notebook for the fine-tuning track (FEATURE_DESCRIPTION.md). Data
versions, run IDs, metric deltas — append, don't rewrite history.

## 2026-07-31 — Phase 1 data pipeline scaffolded

Built `data/` package implementing FEATURE_DESCRIPTION.md Phase 1 end to end:

- `data/download_jamendo.py` — metadata fetch (raw TSV from GitHub) +
  instrumental tag-candidate filter. Audio fetch (~46 GB `audio-low` via the
  official `download.py`) gated behind `--confirm`, not run yet.
- `data/download_deam.py` — DEAM_audio.zip (1.3 GB) + DEAM_Annotations.zip
  (4.7 MB) from cvml.unige.ch/databases/DEAM/, per-0.5s V-A parser. Gated
  behind `--confirm`, not run yet.
- `data/nrc_vad.py` — NRC-VAD Lexicon v2.1 fetch (saifmohammad.com, research
  use only, no redistribution) + tag->(v,a) mapping for Jamendo's mood/theme
  tags + per-track weak-label averaging. Gated behind `--confirm`, not run yet.
- `data/artist_split.py` — deterministic hash-based artist-level split (no
  `random.shuffle`, so it doesn't depend on run order or hash-seed). **Verified
  now** via `self-test`: 80 synthetic artists / 528 tracks, zero artist overlap
  across train/val/test, split reproducible across two runs with the same
  seed. DEAM-test-artist exclusion implemented; flagged that DEAM's shipped
  metadata has no reliable `artist_id` column, so that specific exclusion
  falls back to `song_id` — weaker than a true artist split for DEAM, note in
  the paper's limitations.
- `data/tempo_labels.py` — pluggable tracker (madmom > beat_this > librosa
  fallback) + GiantSteps Tempo sanity-check gate with raw-vs-octave-corrected
  MAE reporting (per the roadmap's octave-error warning). `label-corpus`
  refuses to run until the gate has passed. Not run yet — needs GiantSteps
  audio (~1 GB, beatport previews) and the real corpus audio.
- `data/pretokenize.py` — offline EnCodec (`facebook/encodec_32khz`) tokenizer,
  4 codebooks @ 50 Hz, cached per-track `.npy` to `data_processed/encodec_tokens/`.
  Not run yet — needs a CUDA box and the upstream audio.
- `data/prepare.py` — orchestrates all of the above in the order Phase 1
  specifies; stops with a clear message at the first step still blocked on an
  un-confirmed download.
- `configs/data_jamendo_deam.yaml` — single source of truth for URLs/paths/
  thresholds across all of the above.
- `requirements-training.txt` — fine-tuning-track deps, separate from the API
  server's pinned `requirements.txt`.

**Environment note:** dev machine has no CUDA GPU and no pre-existing Python
env; installed `pyyaml`/`requests` to smoke-test the CPU-only steps. The
actual GPU-bound stages (tempo tracking at scale, EnCodec tokenization,
training itself) need a real training box — not attempted here.

**Not yet done / explicitly deferred pending user confirmation:** the four
large downloads (Jamendo audio ~46 GB, DEAM ~1.3 GB, NRC-VAD lexicon, GiantSteps
audio ~1 GB) haven't been triggered — each is gated behind `--confirm` by
design (see chat for the ask).
