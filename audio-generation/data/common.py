"""Shared helpers for the fine-tuning data pipeline (FEATURE_DESCRIPTION.md Phase 1)."""

import csv
import json
import logging
from pathlib import Path

import yaml

logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def read_manifest(path: str) -> list[dict]:
    """Reads a JSONL manifest (one track record per line)."""
    records = []
    p = Path(path)
    if not p.exists():
        return records
    with open(p, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def write_manifest(path: str, records: list[dict]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def jamendo_audio_path(audio_root: Path, tsv_path_field: str, audio_type: str) -> Path:
    """The moodtheme TSV's PATH column (e.g. "00/1009600.mp3") always names the
    full-quality file. When the corpus was downloaded as `audio-low`, the file
    actually on disk has ".low" inserted before the extension
    ("00/1009600.low.mp3") — verified directly against an extracted shard.
    Directory and numeric id are otherwise identical, so this is the only
    transform needed."""
    p = Path(tsv_path_field)
    if audio_type == "audio-low":
        return audio_root / p.parent / f"{p.stem}.low{p.suffix}"
    return audio_root / p


def read_jamendo_tsv(path: str) -> list[dict]:
    """Parses the MTG-Jamendo autotagging TSV (TRACK_ID, ARTIST_ID, ALBUM_ID, PATH,
    DURATION, TAGS...) into one dict per track, tags as a list."""
    records = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        header = next(reader)
        tag_start = header.index("TAGS") if "TAGS" in header else 5
        for row in reader:
            if not row:
                continue
            fixed = dict(zip(header[:tag_start], row[:tag_start]))
            fixed["TAGS"] = row[tag_start:]
            records.append(fixed)
    return records
