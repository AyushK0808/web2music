import hashlib
import io
import json
import os
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import pyloudnorm as pyln
import imageio_ffmpeg
from pydub import AudioSegment
from pydub.silence import detect_leading_silence

# pydub shells out to ffmpeg to encode Ogg/Opus. Point it at the binary
# bundled with imageio-ffmpeg by default so we don't depend on ffmpeg being
# installed / on PATH -- but allow FFMPEG_BINARY to override, since
# imageio-ffmpeg's bundled static binary is not guaranteed to carry libopus
# on every platform, and a Docker image installing its own ffmpeg (with
# libopus confirmed) needs a way to actually use it instead.
AudioSegment.converter = os.getenv("FFMPEG_BINARY") or imageio_ffmpeg.get_ffmpeg_exe()

HOP_LENGTH = 512
CHROMA_WINDOW = 10          # chroma frames compared against the track start (~same as before)
MIN_LOOP_SECONDS = 3.0      # never propose a loop point earlier than this
BEATS_PER_BAR = 4           # assume 4/4; librosa doesn't give true downbeats
CROSSFADE_MS = 250          # length of the equal-power crossfade at the loop seam.
                            # Was 50ms; the crossfade-window sweep in the paper
                            # (Table crossfade-sweep, sec:res-loop) showed 250ms
                            # strictly better than 50ms on both measured seam
                            # energy (3.46 -> 2.94 dB) and spectral centroid
                            # discontinuity (577 -> 125 Hz), with 500ms giving a
                            # smaller further energy gain but a worse centroid
                            # number -- consistent with a wider window starting
                            # to re-admit a second musical event into the blend.

# MP3 pads audio to fixed-size encoder frames (LAME adds ~576 samples of
# priming silence at the start plus padding to fill the last frame), which
# is audible as a click/gap on every loop repeat even with a perfect cut --
# the crossfade above smooths the CONTENT of the seam, but the container
# format itself was still reintroducing a gap underneath it. Ogg/Opus is
# genuinely gapless: the container carries pre-skip/granule-position
# metadata that a real decoder (ffmpeg, browser Web Audio, Chrome's native
# <audio>/Opus support -- relevant since Feature C is a Chrome extension)
# uses to trim the priming/padding samples automatically. Also comes out
# smaller than MP3 at the same bitrate. Note: libopus only supports a fixed
# set of sample rates and will internally resample to 48000 Hz regardless
# of the source rate -- harmless here since loop_point_ms is a millisecond
# timestamp, not sample-rate dependent.
EXPORT_FORMAT = "ogg"
EXPORT_CODEC = "libopus"
EXPORT_BITRATE = "128k"

# ── C-09: retain the evidence the loop question needs ───────────────────────
# audio-cache/ stores clips *after* the loop cut, so the audio the detector
# actually looked at is gone by the time anyone asks a question about it. That
# is why "is the median clip retaining 50.3% of its requested duration a
# detector artefact or correct behaviour on non-self-similar audio?" was
# undecidable from stored data: the obvious mechanism could be tested on only
# the three longest surviving clips, and it failed to confirm.
#
# RETAIN_PRETRIM_EVERY=N persists, for one in every N generations, the audio as
# the detector saw it plus the full similarity curve it took its argmax over.
# Off by default (0). Turning it on costs disk, not latency — the write happens
# after the clip has been produced and never blocks the response.
RETAIN_PRETRIM_EVERY = int(os.getenv("RETAIN_PRETRIM_EVERY", "0") or 0)
RETAIN_PRETRIM_DIR = Path(os.getenv("RETAIN_PRETRIM_DIR", "pretrim-samples"))
_retain_counter = 0


def _should_retain() -> bool:
    """Deterministic 1-in-N sampling. A counter rather than a random draw so a
    replication with the same request sequence retains the same requests."""
    global _retain_counter
    if RETAIN_PRETRIM_EVERY <= 0:
        return False
    _retain_counter += 1
    return _retain_counter % RETAIN_PRETRIM_EVERY == 1 % RETAIN_PRETRIM_EVERY


def _retain_pretrim(audio: AudioSegment, similarities: np.ndarray, sr: int,
                    loop_point_ms: int, diagnostics: dict) -> str | None:
    """Write the pre-cut audio and the detector's own working out.

    The similarity curve is the point. Without it the only reconstructable
    question is "where did it cut"; with it the question becomes "what did the
    curve look like, and was the argmax defensible" — which is the one §6.6
    currently has to hedge on.
    """
    try:
        RETAIN_PRETRIM_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%S")
        digest = hashlib.sha256(audio.raw_data[:65536]).hexdigest()[:12]
        stem = RETAIN_PRETRIM_DIR / f"{stamp}-{digest}"

        buf = io.BytesIO()
        audio.export(buf, format=EXPORT_FORMAT, codec=EXPORT_CODEC, bitrate=EXPORT_BITRATE)
        stem.with_suffix(".source.ogg").write_bytes(buf.getvalue())

        finite = similarities[np.isfinite(similarities)]
        meta = {
            "captured_at": stamp,
            "source_duration_ms": len(audio),
            "loop_point_ms": loop_point_ms,
            "retention_of_source": loop_point_ms / len(audio) if len(audio) else None,
            "sample_rate": sr,
            "hop_length": HOP_LENGTH,
            "chroma_window": CHROMA_WINDOW,
            "min_loop_seconds": MIN_LOOP_SECONDS,
            # Full curve, so the decay hypothesis can be tested properly on a
            # real sample instead of on three surviving clips.
            "similarity_curve": [round(float(v), 5) for v in similarities],
            "similarity_stats": {
                "n": int(finite.size),
                "max": float(finite.max()) if finite.size else None,
                "argmax_frame": int(np.argmax(similarities)) if similarities.size else None,
                "mean": float(finite.mean()) if finite.size else None,
            },
            **diagnostics,
        }
        stem.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
        return str(stem)
    except Exception as e:  # never let diagnostics break a generation
        print(f"[D4] pre-trim retention failed (non-fatal): {e}")
        return None


def process_audio(audio_bytes: bytes):
    audio_buffer = io.BytesIO(audio_bytes)
    data, rate = sf.read(audio_buffer)
    meter = pyln.Meter(rate)
    loudness = meter.integrated_loudness(data)
    normalized_data = pyln.normalize.loudness(data, loudness, -18.0)

    out_buffer = io.BytesIO()
    sf.write(out_buffer, normalized_data, rate, format='WAV')
    out_buffer.seek(0)

    audio = AudioSegment.from_wav(out_buffer)

    if audio.channels > 1:
        # get_array_of_samples() returns interleaved L,R,L,R,... samples for
        # multi-channel audio. _detect_loop_point_ms treats that flat array
        # as mono, which silently doubles the apparent duration and corrupts
        # every frame-to-time conversion downstream (confirmed: a 20s
        # stereo clip was seen producing loop points past 30s). Dormant
        # today since musicgen-small is mono-only -- fail loud here instead
        # of shipping wrong loop points if a stereo checkpoint is ever used.
        raise ValueError(
            f"process_audio only supports mono audio (got {audio.channels} channels). "
            "Stereo support requires fixing the interleaved-sample handling in "
            "_detect_loop_point_ms and _crossfade_loop before this guard can be removed."
        )

    def trim_silence(audio, silence_thresh=-50):
        start = detect_leading_silence(audio, silence_threshold=silence_thresh)
        end = detect_leading_silence(audio.reverse(), silence_threshold=silence_thresh)
        return audio[start: len(audio) - end]

    audio = trim_silence(audio)

    audio_array = np.array(audio.get_array_of_samples()).astype(np.float32)
    audio_array /= np.iinfo(audio.array_type).max
    sr = audio.frame_rate

    retain = _should_retain()
    diagnostics: dict | None = {} if retain else None
    loop_point_ms = _detect_loop_point_ms(audio_array, sr, len(audio), diagnostics)
    print(f"Loop point detected at {loop_point_ms}ms")

    if retain:
        similarities = diagnostics.pop("similarities", np.array([]))
        saved = _retain_pretrim(audio, similarities, sr, loop_point_ms, diagnostics)
        if saved:
            print(f"[D4] retained pre-trim sample at {saved}.* (C-09)")

    pre_crossfade_clip = audio[:loop_point_ms]
    seam_discontinuity = _seam_discontinuity(pre_crossfade_clip, crossfade_ms=CROSSFADE_MS)

    audio_loopable = _crossfade_loop(pre_crossfade_clip, crossfade_ms=CROSSFADE_MS)

    clip_buffer = io.BytesIO()
    audio_loopable.export(
        clip_buffer, format=EXPORT_FORMAT, codec=EXPORT_CODEC, bitrate=EXPORT_BITRATE
    )
    clip_buffer.seek(0)

    return clip_buffer.read(), loop_point_ms, seam_discontinuity


def _seam_discontinuity(audio: AudioSegment, crossfade_ms: int = CROSSFADE_MS) -> dict:
    """
    Measures how large a jump exists at the loop seam BEFORE crossfading is
    applied -- i.e. what a naive cut (or the old fade_out) would have
    produced audibly. Compares a short window at the very end of the clip
    against a short window at the very start, in both energy (RMS, dB) and
    timbre (spectral centroid). This is diagnostic/logging only: it does not
    change what gets exported, just quantifies how much work the crossfade
    is doing on this particular clip.
    """
    window_ms = min(crossfade_ms, len(audio) // 2)
    if window_ms <= 0:
        return {"energy_delta_db": 0.0, "spectral_centroid_delta_hz": None}

    tail = audio[-window_ms:]
    head = audio[:window_ms]

    tail_samples = np.array(tail.get_array_of_samples()).astype(np.float32)
    head_samples = np.array(head.get_array_of_samples()).astype(np.float32)

    max_val = float(np.iinfo(tail.array_type).max)
    tail_norm = tail_samples / max_val
    head_norm = head_samples / max_val

    tail_rms = float(np.sqrt(np.mean(tail_norm ** 2)) + 1e-12)
    head_rms = float(np.sqrt(np.mean(head_norm ** 2)) + 1e-12)
    energy_delta_db = round(float(20 * np.log10(tail_rms / head_rms)), 2)

    sr = tail.frame_rate
    try:
        # librosa's default n_fft=2048 assumes a signal at least that long;
        # the crossfade window here is typically far shorter (e.g. 1600
        # samples for the default 50ms at 32kHz), which fired a UserWarning
        # on every single call ("n_fft=2048 is too large for input signal
        # of length=1600") without actually failing -- librosa just
        # zero-pads, silently degrading the estimate. Size n_fft to the
        # actual window instead, rounded down to a power of 2 for a real
        # FFT rather than a padded one.
        n_fft = 1 << int(np.floor(np.log2(max(2, min(2048, len(tail_norm))))))
        tail_centroid = float(librosa.feature.spectral_centroid(y=tail_norm, sr=sr, n_fft=n_fft, hop_length=n_fft).mean())
        head_centroid = float(librosa.feature.spectral_centroid(y=head_norm, sr=sr, n_fft=n_fft, hop_length=n_fft).mean())
        spectral_centroid_delta_hz = round(abs(tail_centroid - head_centroid), 1)
    except Exception:
        # Spectral centroid needs enough samples for at least one FFT frame;
        # degrade gracefully on very short crossfade windows rather than
        # failing the whole request over a diagnostic metric.
        spectral_centroid_delta_hz = None

    return {
        "energy_delta_db": energy_delta_db,
        "spectral_centroid_delta_hz": spectral_centroid_delta_hz,
    }


def _detect_loop_point_ms(audio_array: np.ndarray, sr: int, audio_len_ms: int,
                          diagnostics: dict | None = None) -> int:
    """
    Find the best point to cut a seamless loop: correlate a reference window
    at the start of the track against every later window (vectorized), then
    snap the best match onto the nearest bar boundary so the loop lands on a
    musical phrase instead of mid-beat.

    `diagnostics`, when passed, is filled in place with the intermediate values
    (C-09) — the similarity curve, the raw argmax before bar snapping, the beat
    grid. Returning them instead would change a signature four tests depend on,
    and the caller that wants them is a sampling path, not the hot path.
    """
    chroma = librosa.feature.chroma_cqt(y=audio_array, sr=sr, hop_length=HOP_LENGTH)
    n_frames = chroma.shape[1]

    if n_frames <= CHROMA_WINDOW:
        if diagnostics is not None:
            diagnostics.update(outcome="too-short-for-search", n_frames=int(n_frames))
        return audio_len_ms  # too short to search meaningfully, loop the whole clip

    similarities = _vectorized_chroma_similarity(chroma, CHROMA_WINDOW)
    if diagnostics is not None:
        diagnostics["similarities"] = similarities

    # Don't let the search consider anything before MIN_LOOP_SECONDS in —
    # otherwise a few hundred ms of near-identical attack/silence at the very
    # start wins argmax and produces a useless sub-second "loop".
    min_loop_frames = librosa.time_to_frames(MIN_LOOP_SECONDS, sr=sr, hop_length=HOP_LENGTH)
    if min_loop_frames < n_frames:
        similarities[:min_loop_frames] = -np.inf
    else:
        # track is shorter than the minimum loop length entirely
        return audio_len_ms

    if not np.isfinite(similarities).any():
        return audio_len_ms

    best_frame = int(np.argmax(similarities))
    best_time_ms = librosa.frames_to_time(best_frame, sr=sr, hop_length=HOP_LENGTH) * 1000

    tempo, beat_frames = librosa.beat.beat_track(y=audio_array, sr=sr, hop_length=HOP_LENGTH)
    beat_times_ms = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH) * 1000

    bar_times_ms = _bar_boundaries_ms(beat_times_ms)
    candidates = bar_times_ms if len(bar_times_ms) > 0 else beat_times_ms
    candidates = candidates[candidates >= MIN_LOOP_SECONDS * 1000]

    if len(candidates) > 0:
        loop_point_ms = candidates[int(np.argmin(np.abs(candidates - best_time_ms)))]
    else:
        loop_point_ms = best_time_ms

    if diagnostics is not None:
        diagnostics.update(
            outcome="searched",
            n_frames=int(n_frames),
            best_frame=best_frame,
            best_similarity=float(similarities[best_frame]),
            argmax_time_ms=float(best_time_ms),
            snapped_to_ms=float(loop_point_ms),
            snap_shift_ms=float(loop_point_ms - best_time_ms),
            tempo_bpm=float(np.atleast_1d(tempo)[0]) if tempo is not None else None,
            n_beats=int(len(beat_times_ms)),
            n_bar_candidates=int(len(candidates)),
        )

    return int(loop_point_ms)


def _vectorized_chroma_similarity(chroma: np.ndarray, window: int) -> np.ndarray:
    """
    Correlate the first `window` chroma frames against every sliding window
    of `window` frames in the track — all at once via matrix ops, instead of
    a Python loop calling np.corrcoef per frame.

    Returns an array of length chroma.shape[1] (padded with -1 past the last
    valid window index) so indices line up 1:1 with chroma frame indices.
    """
    n_frames = chroma.shape[1]
    n_windows = n_frames - window

    ref = chroma[:, :window].flatten()
    ref_centered = ref - ref.mean()
    ref_norm = np.linalg.norm(ref_centered)

    windows = np.lib.stride_tricks.sliding_window_view(chroma, window_shape=window, axis=1)
    windows = windows[:, :n_windows, :]                       # (n_features, n_windows, window)
    windows = np.moveaxis(windows, 1, 0).reshape(n_windows, -1)  # (n_windows, n_features*window)

    windows_centered = windows - windows.mean(axis=1, keepdims=True)
    windows_norm = np.linalg.norm(windows_centered, axis=1)

    numerator = windows_centered @ ref_centered
    denominator = windows_norm * ref_norm

    with np.errstate(divide='ignore', invalid='ignore'):
        similarities = numerator / denominator

    # Zero-variance windows (silence, flat tails) produce 0/0 -> NaN, which
    # used to poison np.argmax (NaN "wins" comparisons unpredictably). Force
    # them to lose instead.
    similarities = np.nan_to_num(similarities, nan=-1.0, posinf=-1.0, neginf=-1.0)

    padded = np.full(n_frames, -1.0)
    padded[:n_windows] = similarities
    return padded


def _bar_boundaries_ms(beat_times_ms: np.ndarray, beats_per_bar: int = BEATS_PER_BAR) -> np.ndarray:
    """
    Down-sample beat times to bar (downbeat) times. librosa's beat tracker
    doesn't expose true downbeats, so this approximates bars as every Nth
    detected beat, assuming a fixed time signature (default 4/4).
    """
    if len(beat_times_ms) == 0:
        return np.array([])
    return beat_times_ms[::beats_per_bar]


def _crossfade_loop(audio: AudioSegment, crossfade_ms: int = CROSSFADE_MS) -> AudioSegment:
    """
    Equal-power crossfade the tail of the clip into its own head, so the loop
    seam is inaudible. This replaces the old fade_out(50), which faded the
    end to silence — audible as a dip/click on every repeat, not a loop.

    The clip's head is replaced by head/tail blended together (equal-power
    sin/cos curves so perceived loudness stays constant through the seam);
    the raw tail is dropped since it's now folded into the new head. Net
    effect: output is `crossfade_ms` shorter, but plays back-to-back cleanly.
    """
    crossfade_ms = min(crossfade_ms, len(audio) // 2)
    if crossfade_ms <= 0:
        return audio

    head = audio[:crossfade_ms]
    tail = audio[-crossfade_ms:]
    body = audio[crossfade_ms:-crossfade_ms]

    channels = head.channels
    array_type = head.array_type

    head_samples = np.array(head.get_array_of_samples()).astype(np.float64)
    tail_samples = np.array(tail.get_array_of_samples()).astype(np.float64)

    if channels > 1:
        head_samples = head_samples.reshape(-1, channels)
        tail_samples = tail_samples.reshape(-1, channels)

    n = head_samples.shape[0]
    t = np.linspace(0, np.pi / 2, n)
    fade_in = np.sin(t)   # equal-power ramp up for the head
    fade_out = np.cos(t)  # equal-power ramp down for the tail

    if channels > 1:
        fade_in = fade_in[:, None]
        fade_out = fade_out[:, None]

    blended = tail_samples * fade_out + head_samples * fade_in
    int_info = np.iinfo(array_type)
    blended = np.clip(blended, int_info.min, int_info.max).astype(array_type).flatten()

    blended_head = head._spawn(blended.tobytes())

    return blended_head + body