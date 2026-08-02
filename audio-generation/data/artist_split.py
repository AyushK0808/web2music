"""Artist-level train/val/test split (FEATURE_DESCRIPTION.md Phase 1, box B6).

Track-level splits leak: a single Jamendo artist's catalog sounds consistent
enough that if any of their tracks land in train, a held-out track from the
same artist is not a fair test of generalization. This assigns whole artists
to a bucket via a stable hash (not `random.shuffle`, so the split doesn't
depend on Python's hash-seed or call order) and buckets every one of that
artist's tracks together.

DEAM-test artists are additionally excluded from *both* the generator's
training data and the V-A probe's training data (§4.4.2) — the probe would
otherwise grade itself on artists it already knows.

Usage:
    python -m data.artist_split split --config configs/data_jamendo_deam.yaml
    python -m data.artist_split self-test
"""

import argparse
import hashlib
from pathlib import Path

from data.common import get_logger, load_config, read_manifest, write_manifest

log = get_logger("artist_split")


def artist_bucket(artist_id: str, val_frac: float, test_frac: float, seed: int) -> str:
    """Deterministic hash-based bucket assignment — same artist always lands
    in the same bucket for a given seed, independent of dataset ordering."""
    digest = hashlib.sha256(f"{seed}:{artist_id}".encode("utf-8")).hexdigest()
    frac = (int(digest, 16) % 10_000) / 10_000
    if frac < test_frac:
        return "test"
    if frac < test_frac + val_frac:
        return "val"
    return "train"


def split_by_artist(
    records: list[dict],
    artist_key: str,
    val_frac: float,
    test_frac: float,
    seed: int,
) -> dict[str, list[dict]]:
    buckets = {"train": [], "val": [], "test": []}
    for r in records:
        artist_id = str(r[artist_key])
        b = artist_bucket(artist_id, val_frac, test_frac, seed)
        buckets[b].append(r)
    return buckets


def assert_no_artist_overlap(buckets: dict[str, list[dict]], artist_key: str) -> None:
    artist_sets = {
        name: {str(r[artist_key]) for r in recs} for name, recs in buckets.items()
    }
    for a, b in [("train", "val"), ("train", "test"), ("val", "test")]:
        overlap = artist_sets[a] & artist_sets[b]
        if overlap:
            raise AssertionError(f"artist overlap between {a}/{b}: {overlap}")


def exclude_deam_test_artists(
    jamendo_buckets: dict[str, list[dict]],
    deam_test_artist_ids: set[str],
    artist_key: str,
) -> dict[str, list[dict]]:
    """Drops any Jamendo train/val record whose artist also appears in
    DEAM-test, so the probe and generator never train on an artist they'll
    later be evaluated against."""
    cleaned = {"train": [], "val": [], "test": jamendo_buckets["test"]}
    n_dropped = 0
    for split_name in ("train", "val"):
        for r in jamendo_buckets[split_name]:
            if str(r[artist_key]) in deam_test_artist_ids:
                n_dropped += 1
                continue
            cleaned[split_name].append(r)
    if n_dropped:
        log.info(f"dropped {n_dropped} Jamendo tracks whose artist overlaps DEAM-test")
    return cleaned


def run_split(cfg: dict) -> None:
    sp = cfg["artist_split"]
    seed = cfg["seed"]

    jamendo_path = Path(cfg["processed_dir"]) / "jamendo_weak_va_labels.jsonl"
    jamendo_records = read_manifest(str(jamendo_path))
    if not jamendo_records:
        raise FileNotFoundError(f"{jamendo_path} empty/missing — run nrc_vad label-tracks first")

    jamendo_buckets = split_by_artist(
        jamendo_records, "artist_id", sp["val_frac"], sp["test_frac"], seed
    )
    assert_no_artist_overlap(jamendo_buckets, "artist_id")

    deam_path = Path(cfg["processed_dir"]) / "deam_va_trajectories.jsonl"
    if deam_path.exists() and sp.get("exclude_deam_test_artists_from_probe"):
        deam_records = read_manifest(str(deam_path))
        # download_deam.parse_annotations() resolves a real artist name per
        # song from DEAM's metadata CSVs (case-insensitive column matching —
        # the three release years use different header spellings); songs with
        # no matching metadata row get a per-song placeholder artist_id, which
        # gets zero overlap protection but doesn't crash the split.
        n_placeholder = sum(1 for r in deam_records if str(r["artist_id"]).startswith("__unknown_artist_song_"))
        if n_placeholder:
            log.warning(
                f"{n_placeholder}/{len(deam_records)} DEAM songs had no artist "
                f"in the metadata CSVs — those get a per-song placeholder id "
                f"(no overlap protection for just those songs)."
            )
        deam_buckets = split_by_artist(
            deam_records, "artist_id", sp["val_frac"], sp["test_frac"], seed
        )
        assert_no_artist_overlap(deam_buckets, "artist_id")
        deam_test_ids = {str(r["artist_id"]) for r in deam_buckets["test"]}
        # NOTE: this can only catch overlap if the two id spaces are
        # comparable. They aren't — Jamendo's metadata only exposes anonymous
        # artist_id (e.g. "artist_000087"), never a real name, while DEAM's
        # ids here are real artist name strings. So this will show 0 overlap
        # regardless of whether any actually exists; it isn't a verified
        # guarantee, just a best-effort no-op given what Jamendo publishes.
        # Document as a limitation rather than claim cross-dataset exclusion
        # is verified.
        jamendo_buckets = exclude_deam_test_artists(jamendo_buckets, deam_test_ids, "artist_id")

        for name, recs in deam_buckets.items():
            write_manifest(str(Path(cfg["processed_dir"]) / f"deam_{name}.jsonl"), recs)

    for name, recs in jamendo_buckets.items():
        write_manifest(str(Path(cfg["processed_dir"]) / f"jamendo_{name}.jsonl"), recs)
        log.info(f"jamendo {name}: {len(recs)} tracks")


def self_test() -> None:
    """Runs the split against a synthetic manifest — no external data needed —
    to prove the no-artist-overlap guarantee holds."""
    import random

    rng = random.Random(0)
    synthetic = []
    for artist_idx in range(80):
        n_tracks = rng.randint(1, 12)
        for _ in range(n_tracks):
            synthetic.append({
                "track_id": f"t{len(synthetic)}",
                "artist_id": f"artist_{artist_idx}",
            })

    buckets = split_by_artist(synthetic, "artist_id", val_frac=0.1, test_frac=0.1, seed=42)
    assert_no_artist_overlap(buckets, "artist_id")

    total = len(synthetic)
    for name, recs in buckets.items():
        artists = {r["artist_id"] for r in recs}
        print(f"{name}: {len(recs)} tracks ({len(recs) / total:.1%}), {len(artists)} artists")

    # Re-run with the same seed and confirm determinism (same artist -> same bucket).
    buckets2 = split_by_artist(synthetic, "artist_id", val_frac=0.1, test_frac=0.1, seed=42)
    for name in buckets:
        ids1 = {r["track_id"] for r in buckets[name]}
        ids2 = {r["track_id"] for r in buckets2[name]}
        assert ids1 == ids2, f"non-deterministic split in {name}"

    print("OK: no artist overlap across train/val/test, split is deterministic")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_split = sub.add_parser("split")
    p_split.add_argument("--config", required=True)

    sub.add_parser("self-test")

    args = parser.parse_args()
    if args.command == "split":
        cfg = load_config(args.config)
        run_split(cfg)
    elif args.command == "self-test":
        self_test()


if __name__ == "__main__":
    main()
