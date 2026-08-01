"""MTG-Jamendo mood/theme acquisition (FEATURE_DESCRIPTION.md Phase 1, box B0-B1).

Two separate steps, because they have very different costs:

  metadata  - fetch autotagging_moodtheme.tsv (~a few MB) straight from GitHub.
              Safe to run any time.
  audio     - clone MTG/mtg-jamendo-dataset and run its own download.py to pull
              the actual audio (~46 GB for `audio-low`, ~500 GB for `audio`).
              Gated behind --confirm since it's a large, slow, bandwidth-heavy
              download onto the user's disk.

Then `filter-instrumental` applies the tag + VAD filter (no Demucs separation,
per the roadmap) to produce the manifest that later stages consume.

Usage:
    python -m data.download_jamendo metadata --config configs/data_jamendo_deam.yaml
    python -m data.download_jamendo audio --config configs/data_jamendo_deam.yaml --confirm
    python -m data.download_jamendo filter-instrumental --config configs/data_jamendo_deam.yaml
"""

import argparse
import json
import subprocess
import sys
import tarfile
import time
import wave
from pathlib import Path

import requests

from data.common import get_logger, load_config, read_jamendo_tsv, write_manifest

log = get_logger("jamendo")

RAW_TSV_URL = (
    "https://raw.githubusercontent.com/MTG/mtg-jamendo-dataset/master/{path}"
)


def fetch_metadata(cfg: dict) -> Path:
    raw_dir = Path(cfg["raw_dir"]) / "jamendo"
    raw_dir.mkdir(parents=True, exist_ok=True)
    tsv_path = raw_dir / "autotagging_moodtheme.tsv"

    if tsv_path.exists():
        log.info(f"metadata already present at {tsv_path}, skipping fetch")
        return tsv_path

    url = RAW_TSV_URL.format(path=cfg["jamendo"]["metadata_tsv"])
    log.info(f"fetching {url}")
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    tsv_path.write_bytes(resp.content)
    log.info(f"wrote {tsv_path} ({len(resp.content) / 1e6:.1f} MB)")
    return tsv_path


def fetch_instrument_tags(cfg: dict) -> Path:
    """The moodtheme TSV only carries mood/theme tags per track (verified: its
    TAGS column never contains a genre/instrument tag) — instrument tags for
    the same tracks live in a separate file, fetched the same lightweight way
    as the moodtheme metadata rather than requiring the full repo clone."""
    raw_dir = Path(cfg["raw_dir"]) / "jamendo"
    raw_dir.mkdir(parents=True, exist_ok=True)
    out_path = raw_dir / "autotagging_instrument.tsv"

    if out_path.exists():
        log.info(f"instrument tags already present at {out_path}, skipping fetch")
        return out_path

    url = RAW_TSV_URL.format(path=cfg["jamendo"]["instrument_tsv"])
    log.info(f"fetching {url}")
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    out_path.write_bytes(resp.content)
    log.info(f"wrote {out_path} ({len(resp.content) / 1e6:.1f} MB)")
    return out_path


def _clone_repo(cfg: dict) -> Path:
    raw_dir = Path(cfg["raw_dir"]) / "jamendo"
    repo_dir = raw_dir / "mtg-jamendo-dataset"
    if repo_dir.exists():
        log.info(f"repo already cloned at {repo_dir}")
        return repo_dir
    log.info(f"cloning {cfg['jamendo']['repo_url']} (shallow)")
    subprocess.run(
        ["git", "clone", "--depth", "1", cfg["jamendo"]["repo_url"], str(repo_dir)],
        check=True,
    )
    return repo_dir


def download_audio(cfg: dict, confirm: bool) -> None:
    jc = cfg["jamendo"]
    approx_gb = 46 if jc["audio_type"] == "audio-low" else 500
    if not confirm:
        log.warning(
            f"this pulls the full mood/theme subset (~{approx_gb} GB, "
            f"type={jc['audio_type']!r}, mirror={jc['mirror']!r}) — "
            f"re-run with --confirm once you're ready to commit the bandwidth/disk."
        )
        return

    repo_dir = _clone_repo(cfg).resolve()
    out_dir = (Path(cfg["raw_dir"]) / "jamendo" / "audio").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # cwd=repo_dir below is relative to the *child* process, so every path
    # handed to the child must already be absolute (a relative path built
    # against our own cwd would otherwise get re-resolved against repo_dir
    # and double up) — same class of bug fixed in tempo_labels.py.
    cmd = [
        sys.executable,
        str(repo_dir / cfg["jamendo"]["download_script"]),
        "--dataset", jc["dataset"],
        "--type", jc["audio_type"],
        "--from", jc["mirror"],
        "--unpack",
        "--remove",
        str(out_dir),
    ]
    log.info(f"running: {' '.join(cmd)}")

    # ~46 GB over many shards is long enough that a mid-transfer connection
    # reset (observed against this mirror) shouldn't be fatal — download.py
    # verifies each shard's checksum before moving on, so a retry skips
    # whatever already landed intact and only re-pulls the shard that dropped.
    # Observed in practice: this machine sleeping mid-download exhausted the
    # original 8-attempt budget outright — raised the ceiling since the
    # per-shard work is idempotent either way and there's no real downside to
    # trying longer other than wall-clock time we're not blocking on anyway.
    max_retries = 30
    for attempt in range(1, max_retries + 1):
        result = subprocess.run(cmd, cwd=repo_dir)
        if result.returncode == 0:
            return
        log.warning(
            f"download.py attempt {attempt}/{max_retries} exited {result.returncode} "
            f"(likely a dropped connection) — retrying, already-verified shards are skipped"
        )
        if attempt == max_retries:
            result.check_returncode()
        time.sleep(min(2 ** attempt, 60))


def extract_downloaded_shards(cfg: dict) -> None:
    """The upstream download.py only unpacks tars AFTER every shard in the
    whole ~46 GB dataset has finished downloading (its unpack loop runs after
    the full download loop completes, unconditionally on ALL shards) — so
    nothing gets extracted until the entire thing is done. That means
    pretokenize (and anything else reading individual mp3s) sees zero files
    for the whole multi-hour download window. Extract independently: any
    *.tar sitting in the audio dir (the in-progress download uses a randomly
    suffixed temp filename via tempfile.NamedTemporaryFile, so a plain *.tar
    glob only ever matches shards that finished downloading) is safe to
    unpack now, incrementally, without waiting for the rest.

    Deliberately does NOT delete the tar afterwards: download.py's own retry
    loop checks `os.path.exists(output)` to decide whether to re-download a
    shard, and its final unpack pass (once the whole dataset finishes)
    expects every shard's tar to still be there. Removing it here would make
    a later retry re-download an already-extracted shard, or make the
    upstream script crash trying to open a tar we deleted out from under it.
    Costs some duplicate disk (tar + extracted mp3s coexist) until
    download.py finishes and does its own --remove cleanup — fine, there's
    plenty of headroom for one dataset's worth of duplication.

    Since the tar itself can't be touched as a "done" marker, a separate
    marker file tracks which shards have already been extracted — otherwise
    every call re-extracts every shard ever downloaded, which got
    (measured) slow once ~30 shards had piled up."""
    audio_dir = Path(cfg["raw_dir"]) / "jamendo" / "audio"
    marker_path = Path(cfg["processed_dir"]) / "jamendo_extracted_shards.json"
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    done = set(json.loads(marker_path.read_text())) if marker_path.exists() else set()

    tars = sorted(audio_dir.glob("*.tar"))
    todo = [t for t in tars if t.name not in done]
    if not todo:
        log.info(f"no new shards to extract ({len(done)} already done)")
        return

    n_extracted, n_skipped_bad = 0, 0
    for tar_path in todo:
        try:
            with tarfile.open(tar_path) as tf:
                tf.extractall(path=audio_dir)
        except tarfile.TarError as e:
            # Could be a shard still mid-flush to disk despite the temp-file
            # naming, or a genuinely corrupt download — leave it for
            # download.py's own checksum retry rather than guessing which.
            log.warning(f"{tar_path.name}: failed to extract ({e}), leaving in place")
            n_skipped_bad += 1
            continue
        done.add(tar_path.name)
        n_extracted += 1

    marker_path.write_text(json.dumps(sorted(done)))
    n_mp3 = sum(1 for _ in audio_dir.rglob("*.mp3"))
    log.info(
        f"extracted {n_extracted} new shard(s) ({n_skipped_bad} left for later, "
        f"{len(done)} total done), {n_mp3} mp3 files now on disk"
    )


def _voiced_ratio(wav_path: Path, cfg: dict) -> float:
    """Fraction of frames webrtcvad flags as voiced. Used as the vocal-activity
    check called for in the roadmap (tag alone is not trustworthy)."""
    import webrtcvad

    vad_cfg = cfg["jamendo"]["vad_check"]
    vad = webrtcvad.Vad(vad_cfg["aggressiveness"])

    with wave.open(str(wav_path), "rb") as wf:
        sample_rate = wf.getframerate()
        if sample_rate not in (8000, 16000, 32000, 48000):
            # webrtcvad only accepts these rates; caller must resample first.
            raise ValueError(f"{wav_path} has unsupported rate {sample_rate} for VAD")
        frame_ms = vad_cfg["frame_ms"]
        frame_len = int(sample_rate * frame_ms / 1000) * 2  # 16-bit mono
        pcm = wf.readframes(wf.getnframes())

    n_frames = 0
    n_voiced = 0
    for i in range(0, len(pcm) - frame_len, frame_len):
        frame = pcm[i:i + frame_len]
        n_frames += 1
        if vad.is_speech(frame, sample_rate):
            n_voiced += 1
    return (n_voiced / n_frames) if n_frames else 0.0


def filter_instrumental(cfg: dict) -> Path:
    """Tag-based candidate filter: keeps tracks NOT tagged `instrument---voice`.
    MTG-Jamendo has no direct "instrumental" tag (checked the actual taxonomy —
    see configs/data_jamendo_deam.yaml's comment), and only ~57% of moodtheme
    tracks carry any instrument annotation at all, so a missing tag means
    "unknown", not "confirmed instrumental". This pass is deliberately
    permissive; the VAD check (run later, once audio is resampled to a
    VAD-supported rate) is the actual load-bearing filter, per
    FEATURE_DESCRIPTION.md."""
    tsv_path = Path(cfg["raw_dir"]) / "jamendo" / "autotagging_moodtheme.tsv"
    if not tsv_path.exists():
        raise FileNotFoundError(f"{tsv_path} missing — run `metadata` first")

    instrument_tsv_path = fetch_instrument_tags(cfg)
    instrument_tags_by_track: dict[str, set] = {}
    for r in read_jamendo_tsv(str(instrument_tsv_path)):
        instrument_tags_by_track[r["TRACK_ID"]] = set(r["TAGS"])

    vocal_tag = cfg["jamendo"]["vocal_tag"]
    records = read_jamendo_tsv(str(tsv_path))

    kept = []
    n_confirmed_no_voice_tag = 0
    n_unknown = 0
    for r in records:
        track_id = r["TRACK_ID"]
        instr_tags = instrument_tags_by_track.get(track_id)
        if instr_tags is not None and vocal_tag in instr_tags:
            continue  # explicitly tagged as having vocals — drop
        if instr_tags is not None:
            n_confirmed_no_voice_tag += 1
        else:
            n_unknown += 1  # no instrument annotation either way

        tags = set(r["TAGS"]) | (instr_tags or set())
        kept.append({
            "track_id": track_id,
            "artist_id": r["ARTIST_ID"],
            "album_id": r.get("ALBUM_ID"),
            "path": r["PATH"],
            "duration": float(r.get("DURATION", 0) or 0),
            "tags": sorted(tags),
            "had_instrument_annotation": instr_tags is not None,
            "vad_checked": False,
        })

    out_path = Path(cfg["processed_dir"]) / "jamendo_instrumental_candidates.jsonl"
    write_manifest(str(out_path), kept)
    log.info(
        f"{len(kept)}/{len(records)} tracks kept (not tagged {vocal_tag!r}) -> {out_path} "
        f"[{n_confirmed_no_voice_tag} had an instrument annotation confirming no voice tag, "
        f"{n_unknown} had no instrument annotation at all — unverified until the VAD check runs]"
    )
    return out_path


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_meta = sub.add_parser("metadata")
    p_meta.add_argument("--config", required=True)

    p_audio = sub.add_parser("audio")
    p_audio.add_argument("--config", required=True)
    p_audio.add_argument("--confirm", action="store_true")

    p_filter = sub.add_parser("filter-instrumental")
    p_filter.add_argument("--config", required=True)

    p_extract = sub.add_parser("extract")
    p_extract.add_argument("--config", required=True)

    args = parser.parse_args()
    cfg = load_config(args.config)

    if args.command == "metadata":
        fetch_metadata(cfg)
    elif args.command == "audio":
        download_audio(cfg, args.confirm)
    elif args.command == "filter-instrumental":
        filter_instrumental(cfg)
    elif args.command == "extract":
        extract_downloaded_shards(cfg)


if __name__ == "__main__":
    main()
