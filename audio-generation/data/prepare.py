"""Orchestrates the full Phase-1 data pipeline end to end (FEATURE_DESCRIPTION.md).

Mirrors the command in FEATURE_DESCRIPTION.md's Fine-tuning pipeline section:
    python -m data.prepare --config configs/data_jamendo_deam.yaml

Large downloads (Jamendo audio, DEAM, NRC-VAD, GiantSteps audio) are NOT
triggered by this orchestrator automatically — each is its own explicit,
sizeable network fetch, so they're run individually with --confirm first.
This script runs everything that is pure computation once those fetches have
happened, and tells you exactly which fetch is still missing if one hasn't.
"""

import argparse
import sys
from pathlib import Path

from data import artist_split, download_deam, download_jamendo, nrc_vad, pretokenize, tempo_labels
from data.common import get_logger, load_config

log = get_logger("prepare")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    cfg = load_config(args.config)

    steps = [
        ("Jamendo metadata", lambda: download_jamendo.fetch_metadata(cfg)),
        ("Jamendo instrumental filter", lambda: download_jamendo.filter_instrumental(cfg)),
        ("NRC-VAD tag map", lambda: nrc_vad.build_tag_map(cfg)),
        ("NRC-VAD weak track labels", lambda: nrc_vad.label_tracks(cfg)),
        ("DEAM annotations", lambda: download_deam.parse_annotations(cfg)),
        ("Artist-level split", lambda: artist_split.run_split(cfg)),
        ("Tempo pseudo-labels", lambda: tempo_labels.label_corpus(cfg)),
        ("EnCodec pre-tokenize (train)", lambda: pretokenize.run(cfg, "train")),
        ("EnCodec pre-tokenize (val)", lambda: pretokenize.run(cfg, "val")),
        ("EnCodec pre-tokenize (test)", lambda: pretokenize.run(cfg, "test")),
    ]

    for name, fn in steps:
        log.info(f"=== {name} ===")
        try:
            fn()
        except FileNotFoundError as e:
            log.error(
                f"{name} blocked: {e}\n"
                f"    -> this step depends on a large download that needs an "
                f"explicit --confirm run first (see data/download_jamendo.py, "
                f"data/download_deam.py, data/nrc_vad.py, data/tempo_labels.py). "
                f"Stopping here; re-run `python -m data.prepare` once that "
                f"fetch has completed."
            )
            sys.exit(1)
        except RuntimeError as e:
            log.error(f"{name} blocked: {e}")
            sys.exit(1)

    log.info("Phase 1 data pipeline complete.")


if __name__ == "__main__":
    main()
