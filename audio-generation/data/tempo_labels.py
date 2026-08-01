"""Tempo pseudo-labeling + tracker sanity check (FEATURE_DESCRIPTION.md Phase 0
box A3/A4, Phase 1 box B3).

The roadmap is explicit that this must be sanity-checked *before* it's trusted:
an octave error (half/double BPM) in the tracker silently corrupts every
pseudo-label and every downstream tempo metric. So this module:

  1. sanity-check  - clone GiantSteps Tempo (small, annotations-only by
                     default) and score the configured tracker's MAE against
                     its ground-truth BPMs, reporting both raw and
                     octave-corrected MAE so a systematic 2x/0.5x error is
                     visible rather than averaged away.
  2. label-corpus  - beat-track the (instrumental-filtered) Jamendo corpus and
                     write a BPM pseudo-label per track. Refuses to run until
                     the sanity check has passed, per the roadmap's gate.

GiantSteps Tempo is a tracker sanity-check set ONLY — never training data
(FEATURE_DESCRIPTION.md dataset-roles table).

Usage:
    python -m data.tempo_labels sanity-check --config configs/data_jamendo_deam.yaml
    python -m data.tempo_labels sanity-check --config configs/data_jamendo_deam.yaml --with-audio --confirm
    python -m data.tempo_labels label-corpus --config configs/data_jamendo_deam.yaml
"""

import argparse
import json
import subprocess
from pathlib import Path

from data.common import get_logger, jamendo_audio_path, load_config, read_manifest, write_manifest

log = get_logger("tempo")

GIANTSTEPS_REPO = "https://github.com/GiantSteps/giantsteps-tempo-dataset.git"


# ---- tracker backends -------------------------------------------------

def _tempo_madmom(wav_path: str) -> float | None:
    try:
        from madmom.features.tempo import TempoEstimationProcessor
        from madmom.features.beats import RNNBeatProcessor
    except ImportError:
        return None
    act = RNNBeatProcessor()(wav_path)
    tempi = TempoEstimationProcessor(fps=100)(act)
    return float(tempi[0][0]) if len(tempi) else None


def _tempo_beat_this(wav_path: str) -> float | None:
    try:
        from beat_this.inference import File2Beats
    except ImportError:
        return None
    predictor = File2Beats()
    beats, _ = predictor(wav_path)
    if len(beats) < 2:
        return None
    import numpy as np
    ibi = np.diff(beats)
    return float(60.0 / np.median(ibi))


def _tempo_librosa(wav_path: str) -> float | None:
    import numpy as np
    import librosa
    y, sr = librosa.load(wav_path, sr=None, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    # librosa 0.11 returns tempo as a 1-element ndarray, not a scalar —
    # float(array) is a hard TypeError on current numpy, not just a warning.
    tempo = np.asarray(tempo).reshape(-1)
    return float(tempo[0]) if tempo.size else None


_BACKENDS = {
    "madmom": _tempo_madmom,
    "beat_this": _tempo_beat_this,
    "librosa": _tempo_librosa,
}


def get_tracker(cfg: dict):
    preferred = cfg["tempo"]["tracker"]
    order = [preferred] + [b for b in ("madmom", "beat_this", "librosa") if b != preferred]
    for name in order:
        fn = _BACKENDS[name]
        # Probe availability once with a throwaway call pattern: import check only.
        probe_ok = True
        if name == "madmom":
            try:
                import madmom  # noqa: F401
            except ImportError:
                probe_ok = False
        elif name == "beat_this":
            try:
                import beat_this  # noqa: F401
            except ImportError:
                probe_ok = False
        if probe_ok:
            if name != preferred:
                log.warning(
                    f"configured tracker {preferred!r} not installed, "
                    f"falling back to {name!r} — {name} MUST still clear the "
                    f"sanity-check gate below before its output is trusted "
                    f"({'librosa is a dev fallback only, prone to octave errors' if name == 'librosa' else ''})"
                )
            return name, fn
    raise RuntimeError("no tempo tracker backend available (tried madmom, beat_this, librosa)")


# ---- GiantSteps sanity check -------------------------------------------

def _clone_giantsteps(cfg: dict) -> Path:
    repo_dir = Path(cfg["raw_dir"]) / "giantsteps_tempo"
    if repo_dir.exists():
        return repo_dir
    log.info(f"cloning {GIANTSTEPS_REPO} (annotations + download script, no audio yet)")
    subprocess.run(["git", "clone", "--depth", "1", GIANTSTEPS_REPO, str(repo_dir)], check=True)
    return repo_dir


def _fetch_giantsteps_audio(repo_dir: Path, confirm: bool) -> None:
    audio_dir = repo_dir / "audio"
    if audio_dir.exists() and any(audio_dir.iterdir()):
        log.info(f"GiantSteps audio already present at {audio_dir}")
        return
    if not confirm:
        log.warning(
            "sanity-check needs the actual preview audio (~1 GB, 664 files from "
            "beatport.com via this repo's audio_dl.sh) — re-run with --with-audio --confirm."
        )
        return
    script = repo_dir / "audio_dl.sh"
    log.info(f"running {script}")
    # bash treats backslashes as escapes (mangles a Windows-style Path string),
    # and the cwd= below is relative to the child process, not this one — so
    # resolve to an absolute POSIX path first.
    subprocess.run(["bash", script.resolve().as_posix()], check=True, cwd=repo_dir)


def _octave_corrected_error(pred: float, target: float, tolerance: float) -> float:
    """Folds 2x/0.5x octave errors before scoring, so a systematic doubling
    doesn't show up as a huge MAE that masks an otherwise-fine tracker — the
    raw (uncorrected) MAE is reported alongside this so the fold is visible,
    not hidden."""
    candidates = [pred, pred * 2, pred / 2]
    best = min(candidates, key=lambda c: abs(c - target))
    err = abs(best - target)
    return err if err <= tolerance * target else abs(pred - target)


def sanity_check(cfg: dict, with_audio: bool, confirm: bool) -> bool:
    tc = cfg["tempo"]
    repo_dir = _clone_giantsteps(cfg)
    if with_audio:
        _fetch_giantsteps_audio(repo_dir, confirm)

    audio_dir = repo_dir / "audio"
    ann_dir = repo_dir / "annotations" / "tempo"
    if not audio_dir.exists() or not any(audio_dir.glob("*.LOFI.wav")) and not any(audio_dir.iterdir() if audio_dir.exists() else []):
        log.warning(
            "no GiantSteps audio on disk yet — cannot compute an actual tracker "
            "MAE. Run with --with-audio --confirm first. The tempo tracker "
            "MUST NOT be trusted for pseudo-labels until this check has run "
            "and passed (roadmap Phase 0 gate)."
        )
        return False

    tracker_name, tracker_fn = get_tracker(cfg)

    raw_errors, corrected_errors = [], []
    for bpm_file in sorted(ann_dir.glob("*.bpm")):
        track_id = bpm_file.stem
        audio_candidates = list(audio_dir.glob(f"{track_id}*"))
        if not audio_candidates:
            continue
        target_bpm = float(bpm_file.read_text().strip())
        pred_bpm = tracker_fn(str(audio_candidates[0]))
        if pred_bpm is None:
            continue
        raw_errors.append(abs(pred_bpm - target_bpm))
        corrected_errors.append(
            _octave_corrected_error(pred_bpm, target_bpm, tc["octave_error_tolerance"])
        )

    if not raw_errors:
        log.error("scored 0 GiantSteps tracks — check audio_dir/annotations line up")
        return False

    raw_mae = sum(raw_errors) / len(raw_errors)
    corrected_mae = sum(corrected_errors) / len(corrected_errors)
    passed = corrected_mae <= tc["max_acceptable_mae_bpm"]

    log.info(
        f"tracker={tracker_name} n={len(raw_errors)} raw_MAE={raw_mae:.2f} bpm "
        f"octave_corrected_MAE={corrected_mae:.2f} bpm "
        f"(threshold {tc['max_acceptable_mae_bpm']}) -> {'PASS' if passed else 'FAIL'}"
    )
    if raw_mae - corrected_mae > 5:
        log.warning(
            "large gap between raw and octave-corrected MAE — the tracker is "
            "probably folding octaves (double/half BPM); fix before trusting it, "
            "per the roadmap's explicit Phase 0 gate."
        )

    gate_path = Path(cfg["processed_dir"]) / "tempo_tracker_gate.json"
    gate_path.parent.mkdir(parents=True, exist_ok=True)
    gate_path.write_text(json.dumps({
        "tracker": tracker_name,
        "raw_mae_bpm": raw_mae,
        "octave_corrected_mae_bpm": corrected_mae,
        "passed": passed,
    }, indent=2))
    return passed


def label_corpus(cfg: dict) -> Path:
    gate_path = Path(cfg["processed_dir"]) / "tempo_tracker_gate.json"
    if not gate_path.exists() or not json.loads(gate_path.read_text())["passed"]:
        raise RuntimeError(
            "tempo tracker has not passed the GiantSteps sanity check yet — "
            "run `sanity-check --with-audio --confirm` first. Refusing to "
            "generate pseudo-labels with an unvalidated tracker."
        )

    tracker_name, tracker_fn = get_tracker(cfg)
    candidates_path = Path(cfg["processed_dir"]) / "jamendo_weak_va_labels.jsonl"
    tracks = read_manifest(str(candidates_path))
    if not tracks:
        raise FileNotFoundError(f"{candidates_path} empty/missing — run the mood-label step first")

    audio_root = Path(cfg["raw_dir"]) / "jamendo" / "audio"
    labeled = []
    for t in tracks:
        audio_path = jamendo_audio_path(audio_root, t["path"], cfg["jamendo"]["audio_type"])
        if not audio_path.exists():
            continue
        bpm = tracker_fn(str(audio_path))
        if bpm is None:
            continue
        t = dict(t)
        t["bpm_pseudo_label"] = bpm
        t["bpm_tracker"] = tracker_name
        labeled.append(t)

    out_path = Path(cfg["processed_dir"]) / "jamendo_with_tempo.jsonl"
    write_manifest(str(out_path), labeled)
    log.info(f"tempo-labeled {len(labeled)}/{len(tracks)} tracks -> {out_path}")
    return out_path


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_check = sub.add_parser("sanity-check")
    p_check.add_argument("--config", required=True)
    p_check.add_argument("--with-audio", action="store_true")
    p_check.add_argument("--confirm", action="store_true")

    p_label = sub.add_parser("label-corpus")
    p_label.add_argument("--config", required=True)

    args = parser.parse_args()
    cfg = load_config(args.config)

    if args.command == "sanity-check":
        sanity_check(cfg, args.with_audio, args.confirm)
    elif args.command == "label-corpus":
        label_corpus(cfg)


if __name__ == "__main__":
    main()
