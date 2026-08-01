"""NRC-VAD weak-label mapping (FEATURE_DESCRIPTION.md Phase 1, box B2).

Maps Jamendo's mood/theme tags -> weak (valence, arousal) labels via the
NRC Valence-Arousal-Dominance lexicon (word-level norms in [0, 1], averaged
per tag then remapped to [-1, 1] to match Handoff-2's contract).

Non-commercial research use only; per saifmohammad.com/WebPages/nrc-vad.html
the raw lexicon must not be redistributed — this script fetches it directly
from the author's site and keeps it under raw_dir, gitignored.

Usage:
    python -m data.nrc_vad fetch --config configs/data_jamendo_deam.yaml --confirm
    python -m data.nrc_vad build-tag-map --config configs/data_jamendo_deam.yaml
    python -m data.nrc_vad label-tracks --config configs/data_jamendo_deam.yaml
"""

import argparse
import json
import re
import zipfile
from pathlib import Path

import requests

from data.common import get_logger, load_config, read_manifest, write_manifest

log = get_logger("nrc_vad")


def fetch(cfg: dict, confirm: bool) -> Path:
    nc = cfg["nrc_vad"]
    raw_dir = Path(cfg["raw_dir"]) / "nrc_vad"
    zip_path = raw_dir / f"NRC-VAD-Lexicon-{nc['version']}.zip"

    if zip_path.exists():
        log.info(f"{zip_path} already present, skipping fetch")
        return raw_dir

    if not confirm:
        log.warning(
            f"this pulls {nc['url']} (NRC-VAD Lexicon {nc['version']}, a few MB, "
            f"non-commercial research use per its license) — re-run with --confirm."
        )
        return raw_dir

    raw_dir.mkdir(parents=True, exist_ok=True)
    log.info(f"downloading {nc['url']}")
    # saifmohammad.com 406s requests with no User-Agent (blocks bare scripted fetches).
    headers = {"User-Agent": "Mozilla/5.0 (compatible; research-data-fetch/1.0)"}
    resp = requests.get(nc["url"], headers=headers, timeout=60)
    resp.raise_for_status()
    zip_path.write_bytes(resp.content)

    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(raw_dir)
    log.info(f"extracted NRC-VAD lexicon -> {raw_dir}")
    return raw_dir


def _find_lexicon_txt(raw_dir: Path) -> Path:
    candidates = list(raw_dir.rglob("*VAD-Lexicon*.txt")) + list(raw_dir.rglob("*.txt"))
    if not candidates:
        raise FileNotFoundError(f"no lexicon .txt found under {raw_dir} — run `fetch` first")
    return candidates[0]


def _load_lexicon(raw_dir: Path) -> dict[str, tuple[float, float]]:
    """word -> (valence, arousal). NRC-VAD v2.1 ships these natively in
    [-1, 1], positive-as-positive (verified against the file: min/max are
    exactly -1.000/1.000) — v1.0 used [0, 1] instead, so if you swap versions
    check this assumption again rather than trust the scale blindly."""
    path = _find_lexicon_txt(raw_dir)
    lex = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            word, valence, arousal = parts[0], parts[1], parts[2]
            try:
                lex[word.lower()] = (float(valence), float(arousal))
            except ValueError:
                continue  # header row or malformed line
    log.info(f"loaded {len(lex)} lexicon entries from {path}")
    return lex


def _tag_to_words(tag: str) -> list[str]:
    # Jamendo tags look like "mood/theme---filmscore" or "mood/theme---sad".
    stem = tag.split("---")[-1]
    stem = re.sub(r"[_\-]+", " ", stem)
    # Split "filmscore"-style compounds isn't reliable without a dictionary;
    # NRC-VAD is looked up on the whole stem first, then per split-word as a
    # fallback for tags that are naturally multi-word.
    words = [stem] + stem.split(" ")
    seen = []
    for w in words:
        if w and w not in seen:
            seen.append(w)
    return seen


def build_tag_map(cfg: dict) -> Path:
    raw_dir = Path(cfg["raw_dir"]) / "nrc_vad"
    lex = _load_lexicon(raw_dir)

    jamendo_tsv = Path(cfg["raw_dir"]) / "jamendo" / "autotagging_moodtheme.tsv"
    if not jamendo_tsv.exists():
        raise FileNotFoundError(f"{jamendo_tsv} missing — run download_jamendo metadata first")

    from data.common import read_jamendo_tsv
    records = read_jamendo_tsv(str(jamendo_tsv))
    all_tags = sorted({t for r in records for t in r["TAGS"] if t.startswith("mood/theme")})

    tag_map = {}
    unmatched = []
    for tag in all_tags:
        hits = [lex[w] for w in _tag_to_words(tag) if w in lex]
        if not hits:
            unmatched.append(tag)
            continue
        v = sum(h[0] for h in hits) / len(hits)
        a = sum(h[1] for h in hits) / len(hits)
        # Already [-1, 1] positive-as-positive in v2.1 — matches Handoff-2's
        # contract directly (X3-consistent), no rescale needed.
        tag_map[tag] = {"valence": v, "arousal": a, "n_words_matched": len(hits)}

    out_path = Path(cfg["processed_dir"]) / "jamendo_tag_va_map.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(tag_map, indent=2), encoding="utf-8")

    log.info(f"mapped {len(tag_map)}/{len(all_tags)} mood/theme tags -> {out_path}")
    if unmatched:
        log.warning(
            f"{len(unmatched)} tags had no lexicon match, need manual curation: "
            f"{unmatched}"
        )
    return out_path


def label_tracks(cfg: dict) -> Path:
    """Averages each track's per-tag (v,a) into one weak label, per box B2."""
    tag_map_path = Path(cfg["processed_dir"]) / "jamendo_tag_va_map.json"
    candidates_path = Path(cfg["processed_dir"]) / "jamendo_instrumental_candidates.jsonl"
    if not tag_map_path.exists():
        raise FileNotFoundError(f"{tag_map_path} missing — run build-tag-map first")
    if not candidates_path.exists():
        raise FileNotFoundError(
            f"{candidates_path} missing — run download_jamendo filter-instrumental first"
        )

    tag_map = json.loads(tag_map_path.read_text(encoding="utf-8"))
    tracks = read_manifest(str(candidates_path))

    labeled = []
    skipped = 0
    for t in tracks:
        mood_tags = [tag for tag in t["tags"] if tag.startswith("mood/theme")]
        va_hits = [tag_map[tag] for tag in mood_tags if tag in tag_map]
        if not va_hits:
            skipped += 1
            continue
        t = dict(t)
        t["valence"] = sum(h["valence"] for h in va_hits) / len(va_hits)
        t["arousal"] = sum(h["arousal"] for h in va_hits) / len(va_hits)
        t["va_label_source"] = "nrc_vad_weak"
        labeled.append(t)

    out_path = Path(cfg["processed_dir"]) / "jamendo_weak_va_labels.jsonl"
    write_manifest(str(out_path), labeled)
    log.info(f"labeled {len(labeled)} tracks ({skipped} skipped, no matched tag) -> {out_path}")
    return out_path


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_fetch = sub.add_parser("fetch")
    p_fetch.add_argument("--config", required=True)
    p_fetch.add_argument("--confirm", action="store_true")

    p_map = sub.add_parser("build-tag-map")
    p_map.add_argument("--config", required=True)

    p_label = sub.add_parser("label-tracks")
    p_label.add_argument("--config", required=True)

    args = parser.parse_args()
    cfg = load_config(args.config)

    if args.command == "fetch":
        fetch(cfg, args.confirm)
    elif args.command == "build-tag-map":
        build_tag_map(cfg)
    elif args.command == "label-tracks":
        label_tracks(cfg)


if __name__ == "__main__":
    main()
