"""DEAM acquisition (FEATURE_DESCRIPTION.md Phase 1, box B4).

DEAM supplies the gold, time-varying (per-0.5s) valence/arousal trajectories —
the source of the trajectory-control claim and the V-A probe's training data.
Much smaller than Jamendo (~1.3 GB audio + ~5 MB annotations), but the actual
fetch+unzip is still a permission-gated download, not silently automatic.

Usage:
    python -m data.download_deam fetch --config configs/data_jamendo_deam.yaml --confirm
    python -m data.download_deam parse-annotations --config configs/data_jamendo_deam.yaml
"""

import argparse
import time
import zipfile
from pathlib import Path

import requests

from data.common import get_logger, load_config, write_manifest

log = get_logger("deam")


def _download_one(url: str, dest: Path, max_retries: int = 6) -> None:
    """cvml.unige.ch resets the connection mid-transfer often enough on a
    ~1.3 GB file that a plain single-shot GET isn't reliable — resume via
    Range requests against a .part file instead of restarting from zero."""
    if dest.exists():
        log.info(f"{dest.name} already present, skipping")
        return

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")

    for attempt in range(1, max_retries + 1):
        resume_at = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={resume_at}-"} if resume_at else {}
        try:
            with requests.get(url, headers=headers, stream=True, timeout=60) as resp:
                if resume_at and resp.status_code == 200:
                    # server ignored the Range header — start over cleanly
                    resume_at = 0
                    part.unlink(missing_ok=True)
                elif resp.status_code not in (200, 206):
                    resp.raise_for_status()
                mode = "ab" if resume_at else "wb"
                with open(part, mode) as f:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
            part.rename(dest)
            log.info(f"wrote {dest} ({dest.stat().st_size / 1e6:.1f} MB, attempt {attempt})")
            return
        except (requests.exceptions.ChunkedEncodingError, requests.exceptions.ConnectionError) as e:
            log.warning(
                f"attempt {attempt}/{max_retries} for {dest.name} dropped ({e.__class__.__name__}), "
                f"{'retrying with resume' if part.exists() else 'retrying'}..."
            )
            if attempt == max_retries:
                raise
            time.sleep(min(2 ** attempt, 30))


def fetch(cfg: dict, confirm: bool) -> None:
    dc = cfg["deam"]
    if not confirm:
        log.warning(
            "this pulls DEAM_audio.zip (~1.3 GB) + DEAM_Annotations.zip (~4.7 MB) "
            f"+ metadata.zip from {dc['base_url']} — re-run with --confirm to proceed."
        )
        return

    raw_dir = Path(cfg["raw_dir"]) / "deam"
    for key, filename in dc["files"].items():
        url = f"{dc['base_url']}/{filename}"
        dest = raw_dir / filename
        _download_one(url, dest)
        with zipfile.ZipFile(dest) as zf:
            extract_to = raw_dir / key
            extract_to.mkdir(parents=True, exist_ok=True)
            zf.extractall(extract_to)
            log.info(f"extracted {filename} -> {extract_to}")


def _load_artist_map(cfg: dict) -> dict[str, str]:
    """DEAM's metadata.zip has one CSV per release year with a DIFFERENT
    header each time (song_id/Id/id, Artist/artist) — real, messy data, not a
    single clean schema. Match columns case-insensitively per file rather than
    hardcode one header shape."""
    meta_dir = Path(cfg["raw_dir"]) / "deam" / "metadata"
    csvs = sorted(meta_dir.rglob("metadata_*.csv"))
    artist_by_song: dict[str, str] = {}

    import csv as csv_mod

    for path in csvs:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            reader = csv_mod.reader(f)
            header = [h.strip().lower() for h in next(reader)]
            id_col = next((i for i, h in enumerate(header) if h in ("song_id", "id")), None)
            artist_col = next((i for i, h in enumerate(header) if h == "artist"), None)
            if id_col is None or artist_col is None:
                log.warning(f"{path.name}: no id/artist columns found in header {header}, skipping")
                continue
            for row in reader:
                if len(row) <= max(id_col, artist_col):
                    continue
                song_id = row[id_col].strip()
                artist = row[artist_col].strip()
                if song_id and artist:
                    artist_by_song[song_id] = artist

    log.info(f"loaded artist for {len(artist_by_song)} DEAM songs from {len(csvs)} metadata files")
    return artist_by_song


def parse_annotations(cfg: dict) -> Path:
    """DEAM ships per-0.5s valence/arousal as separate CSVs (one row per song,
    one column per timestep) under annotations/annotations averaged per song/
    dynamic (per second). Build one JSONL record per song: {song_id, times,
    valence[], arousal[]}."""
    raw_dir = Path(cfg["raw_dir"]) / "deam" / "annotations"
    if not raw_dir.exists():
        raise FileNotFoundError(f"{raw_dir} missing — run `fetch --confirm` first")

    # DEAM's own directory layout varies slightly by release year; search for
    # the dynamic (per-second) valence/arousal CSVs rather than hardcode a path.
    valence_csvs = sorted(raw_dir.rglob("*valence*.csv"))
    arousal_csvs = sorted(raw_dir.rglob("*arousal*.csv"))
    if not valence_csvs or not arousal_csvs:
        raise FileNotFoundError(
            f"no valence/arousal CSVs found under {raw_dir} — "
            f"check the extracted DEAM_Annotations.zip layout"
        )

    import csv as csv_mod

    def load_wide_csv(path: Path) -> dict[str, list[float]]:
        out = {}
        with open(path, "r", encoding="utf-8") as f:
            reader = csv_mod.reader(f)
            header = next(reader)
            time_cols = header[1:]
            for row in reader:
                song_id = row[0].strip()
                vals = [float(v) if v.strip() not in ("", "NaN") else None
                        for v in row[1:]]
                out[song_id] = vals
        return time_cols, out

    artist_by_song = _load_artist_map(cfg)

    records = []
    n_unknown_artist = 0
    for v_path, a_path in zip(valence_csvs, arousal_csvs):
        v_times, v_data = load_wide_csv(v_path)
        _, a_data = load_wide_csv(a_path)
        for song_id in v_data:
            if song_id not in a_data:
                continue
            artist = artist_by_song.get(song_id)
            if artist is None:
                # Genuinely no metadata row for this song — falling back to a
                # per-song "artist" means this one song gets zero overlap
                # protection, unlike everything else here which is grouped by
                # its real artist name.
                artist = f"__unknown_artist_song_{song_id}"
                n_unknown_artist += 1
            records.append({
                "song_id": song_id,
                "artist_id": artist,
                "time_cols_ms": v_times,
                "valence": v_data[song_id],
                "arousal": a_data[song_id],
                "source_file": v_path.name,
            })

    out_path = Path(cfg["processed_dir"]) / "deam_va_trajectories.jsonl"
    write_manifest(str(out_path), records)
    log.info(
        f"parsed {len(records)} DEAM songs -> {out_path} "
        f"({n_unknown_artist} had no matching metadata row for their artist)"
    )
    return out_path


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_fetch = sub.add_parser("fetch")
    p_fetch.add_argument("--config", required=True)
    p_fetch.add_argument("--confirm", action="store_true")

    p_parse = sub.add_parser("parse-annotations")
    p_parse.add_argument("--config", required=True)

    args = parser.parse_args()
    cfg = load_config(args.config)

    if args.command == "fetch":
        fetch(cfg, args.confirm)
    elif args.command == "parse-annotations":
        parse_annotations(cfg)


if __name__ == "__main__":
    main()
