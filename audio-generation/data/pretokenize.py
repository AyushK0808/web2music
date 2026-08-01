"""Offline EnCodec pre-tokenization (FEATURE_DESCRIPTION.md Phase 1, box B7).

Runs the frozen EnCodec codec once over every preprocessed crop and caches the
resulting codebook indices to disk, so the training loop never re-runs the
(frozen, non-trainable) audio codec on every step — it just loads token
tensors. 4 codebooks @ 50 Hz per FEATURE_DESCRIPTION.md's Architecture section.

Usage:
    python -m data.pretokenize run --config configs/data_jamendo_deam.yaml --split train
"""

import argparse
from pathlib import Path

from data.common import get_logger, jamendo_audio_path, load_config, read_manifest

log = get_logger("pretokenize")


def _load_encodec(cfg: dict):
    import torch
    from transformers import EncodecModel, AutoProcessor

    model_id = cfg["encodec"]["model_id"]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        log.warning(
            "no CUDA device found — EnCodec will run on CPU. Fine for a small "
            "smoke test, far too slow for the full corpus; run this on a GPU "
            "box once the data acquisition steps have actually produced audio."
        )
    model = EncodecModel.from_pretrained(model_id).to(device).eval()
    processor = AutoProcessor.from_pretrained(model_id)
    return model, processor, device


def tokenize_file(model, processor, device, wav_path: str, target_sr: int):
    import librosa
    import torch

    y, _ = librosa.load(wav_path, sr=target_sr, mono=True)
    inputs = processor(raw_audio=y, sampling_rate=target_sr, return_tensors="pt")
    with torch.no_grad():
        encoded = model.encode(
            inputs["input_values"].to(device), inputs["padding_mask"].to(device)
        )
    # encoded.audio_codes: (n_chunks, batch, n_codebooks, seq_len) -> squeeze to (n_codebooks, seq_len)
    codes = encoded.audio_codes[0, 0].cpu().numpy()
    return codes


def run(cfg: dict, split: str) -> None:
    import numpy as np

    ec = cfg["encodec"]
    manifest_path = Path(cfg["processed_dir"]) / f"jamendo_{split}.jsonl"
    tracks = read_manifest(str(manifest_path))
    if not tracks:
        raise FileNotFoundError(
            f"{manifest_path} empty/missing — run artist_split first "
            f"(needs the full Phase-1 pipeline to have produced labeled tracks)"
        )

    cache_dir = Path(ec["cache_dir"]) / split
    cache_dir.mkdir(parents=True, exist_ok=True)

    model, processor, device = _load_encodec(cfg)
    audio_root = Path(cfg["raw_dir"]) / "jamendo" / "audio"

    n_done, n_skipped = 0, 0
    for t in tracks:
        out_path = cache_dir / f"{t['track_id']}.npy"
        if out_path.exists():
            n_skipped += 1
            continue
        wav_path = jamendo_audio_path(audio_root, t["path"], cfg["jamendo"]["audio_type"])
        if not wav_path.exists():
            n_skipped += 1
            continue
        codes = tokenize_file(model, processor, device, str(wav_path), cfg["preprocess"]["sample_rate"])
        np.save(out_path, codes)
        n_done += 1

    log.info(f"[{split}] tokenized {n_done} tracks, skipped {n_skipped} -> {cache_dir}")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run")
    p_run.add_argument("--config", required=True)
    p_run.add_argument("--split", choices=["train", "val", "test"], required=True)

    args = parser.parse_args()
    cfg = load_config(args.config)

    if args.command == "run":
        run(cfg, args.split)


if __name__ == "__main__":
    main()
