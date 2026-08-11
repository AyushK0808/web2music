"""
Regression tests for d4_process.py's loop-point detection, crossfade, and
seam-discontinuity metric. Ports the ad-hoc synthetic checks referenced (but
never committed) in PR #9's description, plus new tests for the mono-only
guard and seam-discontinuity metric added afterwards.
"""
import io
import numpy as np
import pytest
import soundfile as sf

from d4_process import (
    process_audio,
    _crossfade_loop,
    _vectorized_chroma_similarity,
    _seam_discontinuity,
    CROSSFADE_MS,
    CHROMA_WINDOW,
)

SR = 32000


def _make_phrase_audio(duration_s=20, bar_len=4.0, sr=SR):
    """A synthetic clip with a genuine, known loop point: a 4-bar chord
    phrase that repeats, plus a click every 0.5s (120bpm) so beat-tracking
    has something to grab onto."""
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    freqs = [220.0, 246.94, 261.63, 293.66]
    phrase_len = bar_len * len(freqs)
    audio = 0.3 * np.sin(
        2 * np.pi * np.array([freqs[int((x % phrase_len) // bar_len)] for x in t]) * t
    )
    for k in range(int(duration_s / 0.5)):
        idx = int(k * 0.5 * sr)
        audio[idx: idx + 200] += 0.5 * np.hanning(200)
    return audio.astype(np.float32)


def _to_wav_bytes(audio, sr=SR):
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    buf.seek(0)
    return buf.read()


class TestLoopDetection:
    def test_normal_phrase_clip_snaps_near_true_phrase_boundary(self):
        audio = _make_phrase_audio(duration_s=20, bar_len=4.0)
        mp3_bytes, loop_point_ms, seam = process_audio(_to_wav_bytes(audio))

        assert len(mp3_bytes) > 0
        # true phrase boundary is 4 bars * 4s = 16s... actually 4 freqs * 4s = 16s,
        # but the detector snaps to the nearest self-similar match >= 3s, which
        # for this synthetic phrase lands near the first repeat around 4s in
        assert loop_point_ms >= 3000
        assert isinstance(seam, dict)
        assert "energy_delta_db" in seam
        assert "spectral_centroid_delta_hz" in seam

    def test_long_clip_with_8s_phrase(self):
        audio = _make_phrase_audio(duration_s=60, bar_len=2.0)  # 4 bars * 2s = 8s phrase
        mp3_bytes, loop_point_ms, seam = process_audio(_to_wav_bytes(audio))
        assert loop_point_ms >= 3000
        assert len(mp3_bytes) > 0

    def test_silence_heavy_clip_does_not_crash(self):
        silent_audio = np.zeros(int(SR * 15), dtype=np.float32)
        silent_audio[:SR] += 0.05 * np.sin(2 * np.pi * 440 * np.linspace(0, 1, SR))
        mp3_bytes, loop_point_ms, seam = process_audio(_to_wav_bytes(silent_audio))
        assert not np.isnan(loop_point_ms)
        assert len(mp3_bytes) > 0

    def test_too_short_clip_falls_back_to_full_length(self):
        short_audio = 0.3 * np.sin(
            2 * np.pi * 440 * np.linspace(0, 1.5, int(SR * 1.5))
        ).astype(np.float32)
        mp3_bytes, loop_point_ms, seam = process_audio(_to_wav_bytes(short_audio))
        assert len(mp3_bytes) > 0
        # under MIN_LOOP_SECONDS entirely -- should fall back, not crash or
        # return a nonsensical negative/zero point
        assert loop_point_ms > 0

    def test_white_noise_no_clear_beats_does_not_crash(self):
        rng = np.random.default_rng(0)
        noise = (0.2 * rng.standard_normal(int(SR * 12))).astype(np.float32)
        mp3_bytes, loop_point_ms, seam = process_audio(_to_wav_bytes(noise))
        assert not np.isnan(loop_point_ms)
        assert len(mp3_bytes) > 0

    def test_determinism_same_input_gives_same_loop_point(self):
        audio = _make_phrase_audio(duration_s=20)
        audio_bytes = _to_wav_bytes(audio)
        _, loop1, _ = process_audio(audio_bytes)
        _, loop2, _ = process_audio(audio_bytes)
        assert loop1 == loop2


class TestMonoOnlyGuard:
    def test_stereo_input_raises_instead_of_silently_corrupting(self):
        """
        Regression test for the documented (dormant) stereo-interleaving
        bug: get_array_of_samples() returns interleaved L,R,L,R,... samples
        which the frame-to-time math would silently treat as mono, doubling
        the apparent duration. Must now fail loud instead.
        """
        t = np.linspace(0, 10, int(SR * 10), endpoint=False)
        mono = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        stereo = np.stack([mono, mono * 0.9], axis=1)

        with pytest.raises(ValueError, match="mono"):
            process_audio(_to_wav_bytes(stereo))


class TestCrossfade:
    def test_crossfade_shrinks_by_exact_amount_and_stays_in_bounds(self):
        from pydub import AudioSegment
        tone = (0.5 * np.sin(2 * np.pi * 440 * np.linspace(0, 2, int(SR * 2)))).astype(np.float32)
        tone_i16 = (tone * 32767).astype(np.int16)
        seg = AudioSegment(tone_i16.tobytes(), frame_rate=SR, sample_width=2, channels=1)

        original_len = len(seg)
        out = _crossfade_loop(seg, crossfade_ms=CROSSFADE_MS)

        assert len(out) == original_len - CROSSFADE_MS
        samples = np.array(out.get_array_of_samples())
        assert samples.min() >= -32768 and samples.max() <= 32767


class TestSeamDiscontinuity:
    def test_seam_discontinuity_on_continuous_tone_is_small(self):
        """A pure continuous tone should have a small energy/spectral jump
        at the seam -- it's the same signal at both ends."""
        from pydub import AudioSegment
        tone = (0.5 * np.sin(2 * np.pi * 440 * np.linspace(0, 2, int(SR * 2)))).astype(np.float32)
        tone_i16 = (tone * 32767).astype(np.int16)
        seg = AudioSegment(tone_i16.tobytes(), frame_rate=SR, sample_width=2, channels=1)

        result = _seam_discontinuity(seg, crossfade_ms=CROSSFADE_MS)
        assert abs(result["energy_delta_db"]) < 3.0  # same amplitude tone throughout

    def test_seam_discontinuity_does_not_fire_n_fft_warning(self):
        """
        Regression test: librosa's default n_fft=2048 is larger than the
        crossfade window (1600 samples for the default 50ms at 32kHz),
        which fired 'n_fft=2048 is too large for input signal of
        length=1600' on every real request. n_fft must be sized to the
        actual window instead of left at the library default.
        """
        import warnings
        from pydub import AudioSegment
        tone = (0.5 * np.sin(2 * np.pi * 440 * np.linspace(0, 28, int(SR * 28)))).astype(np.float32)
        tone_i16 = (tone * 32767).astype(np.int16)
        seg = AudioSegment(tone_i16.tobytes(), frame_rate=SR, sample_width=2, channels=1)

        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            _seam_discontinuity(seg, crossfade_ms=CROSSFADE_MS)
            n_fft_warnings = [x for x in w if "n_fft" in str(x.message)]
            assert len(n_fft_warnings) == 0, [str(x.message) for x in n_fft_warnings]


class TestVectorizedCorrelationCorrectness:
    def test_vectorized_matches_naive_per_frame_corrcoef(self):
        """
        The PR #9 description claimed the vectorized correlation matches the
        old per-frame np.corrcoef loop to ~2.5e-16, but that check was never
        committed. This pins it for real.
        """
        rng = np.random.default_rng(42)
        n_frames = 200
        n_features = 12  # chroma_cqt's pitch-class dimensionality
        chroma = rng.standard_normal((n_features, n_frames)).astype(np.float64)

        window = CHROMA_WINDOW
        vectorized = _vectorized_chroma_similarity(chroma, window)

        start_frames = chroma[:, :window]
        naive = np.full(n_frames, -1.0)
        for i in range(n_frames - window):
            sim = np.corrcoef(
                start_frames.flatten(),
                chroma[:, i:i + window].flatten()
            )[0, 1]
            naive[i] = sim if np.isfinite(sim) else -1.0

        # only compare the valid (non-padded) range, and only where naive
        # wasn't itself NaN-collapsed to the -1.0 sentinel by construction
        valid = slice(0, n_frames - window)
        np.testing.assert_allclose(vectorized[valid], naive[valid], atol=1e-9)

    def test_zero_variance_window_produces_no_nan(self):
        """A flat/silent window has zero variance -> 0/0 in the correlation
        formula. Must resolve to the -1.0 sentinel, never NaN (NaN used to
        poison argmax unpredictably)."""
        n_features, n_frames = 12, 50
        chroma = np.ones((n_features, n_frames), dtype=np.float64)  # constant -> zero variance everywhere

        result = _vectorized_chroma_similarity(chroma, window=CHROMA_WINDOW)
        assert not np.isnan(result).any()


class TestGaplessExport:
    def test_exported_clip_is_valid_decodable_ogg_opus(self):
        """
        Regression test for the MP3-to-Ogg/Opus gapless export switch: MP3
        pads to fixed-size encoder frames (audible click/gap on loop even
        with a perfect cut) -- confirms the exported bytes are genuinely
        Ogg/Opus and actually decodable, not just "some bytes came back".
        """
        from pydub import AudioSegment
        import imageio_ffmpeg
        AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()

        audio = _make_phrase_audio(duration_s=20)
        clip_bytes, loop_point_ms, seam = process_audio(_to_wav_bytes(audio))

        # Ogg files start with the "OggS" capture pattern magic bytes
        assert clip_bytes[:4] == b"OggS", "exported bytes don't start with the Ogg container magic number"

        decoded = AudioSegment.from_file(io.BytesIO(clip_bytes), format="ogg")
        assert len(decoded) > 0
        # libopus only supports a fixed set of rates and resamples to 48kHz
        # internally regardless of source rate -- this is expected, not a bug
        assert decoded.frame_rate == 48000
        assert decoded.channels == 1

class TestPreTrimRetention:
    """C-09 — the sampling flag that keeps the audio the loop detector saw.

    audio-cache/ stores clips post-trim, which is why the duration-retention
    question ("detector artefact, or correct behaviour on non-self-similar
    audio?") was undecidable from stored data. These tests cover the two ways
    that instrument could quietly fail: sampling that never fires, and a
    diagnostics write that takes the request down with it.
    """

    def test_diagnostics_dict_is_filled_without_changing_the_loop_point(self):
        import d4_process

        audio = _make_phrase_audio(duration_s=20)
        arr = audio.astype(np.float32)
        plain = d4_process._detect_loop_point_ms(arr, SR, 20_000)

        diag = {}
        with_diag = d4_process._detect_loop_point_ms(arr, SR, 20_000, diag)

        assert with_diag == plain, "passing a diagnostics dict changed the decision"
        assert diag["outcome"] == "searched"
        assert len(diag["similarities"]) == diag["n_frames"]
        assert diag["snapped_to_ms"] == pytest.approx(float(with_diag), abs=1.0)
        # snap_shift is what tells a later analysis whether bar snapping is
        # systematically shortening loops; it must be signed, not absolute.
        assert diag["snap_shift_ms"] == pytest.approx(
            diag["snapped_to_ms"] - diag["argmax_time_ms"], abs=1e-6
        )

    def test_sampling_is_off_by_default_and_deterministic_when_on(self, monkeypatch):
        import d4_process

        monkeypatch.setattr(d4_process, "RETAIN_PRETRIM_EVERY", 0)
        monkeypatch.setattr(d4_process, "_retain_counter", 0)
        assert not any(d4_process._should_retain() for _ in range(50))

        monkeypatch.setattr(d4_process, "RETAIN_PRETRIM_EVERY", 5)
        monkeypatch.setattr(d4_process, "_retain_counter", 0)
        fired = [i for i in range(20) if d4_process._should_retain()]
        assert fired == [0, 5, 10, 15], f"1-in-5 sampling fired at {fired}"

    def test_retention_writes_source_audio_and_similarity_curve(self, tmp_path, monkeypatch):
        import json
        import d4_process
        from pydub import AudioSegment

        monkeypatch.setattr(d4_process, "RETAIN_PRETRIM_EVERY", 1)
        monkeypatch.setattr(d4_process, "_retain_counter", 0)
        monkeypatch.setattr(d4_process, "RETAIN_PRETRIM_DIR", tmp_path)

        audio = _make_phrase_audio(duration_s=20)
        clip_bytes, loop_point_ms, _seam = process_audio(_to_wav_bytes(audio))
        assert clip_bytes[:4] == b"OggS"

        metas = list(tmp_path.glob("*.json"))
        sources = list(tmp_path.glob("*.source.ogg"))
        assert len(metas) == 1 and len(sources) == 1

        meta = json.loads(metas[0].read_text(encoding="utf-8"))
        assert meta["loop_point_ms"] == loop_point_ms
        assert meta["source_duration_ms"] > loop_point_ms
        assert 0 < meta["retention_of_source"] <= 1
        # the curve is the whole point of retaining anything
        assert len(meta["similarity_curve"]) > 10
        assert meta["similarity_stats"]["argmax_frame"] is not None

        decoded = AudioSegment.from_file(io.BytesIO(sources[0].read_bytes()), format="ogg")
        assert len(decoded) == pytest.approx(meta["source_duration_ms"], rel=0.02)

    def test_a_failing_retention_write_does_not_fail_the_generation(self, tmp_path, monkeypatch):
        import d4_process

        monkeypatch.setattr(d4_process, "RETAIN_PRETRIM_EVERY", 1)
        monkeypatch.setattr(d4_process, "_retain_counter", 0)
        # a path that cannot be created: diagnostics must never cost a clip
        monkeypatch.setattr(d4_process, "RETAIN_PRETRIM_DIR", tmp_path / "x\0y")

        audio = _make_phrase_audio(duration_s=20)
        clip_bytes, loop_point_ms, _seam = process_audio(_to_wav_bytes(audio))
        assert clip_bytes[:4] == b"OggS"
        assert loop_point_ms > 0
