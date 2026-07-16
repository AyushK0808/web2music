import librosa
import numpy as np
import soundfile as sf
import pyloudnorm as pyln
import imageio_ffmpeg
from pydub import AudioSegment
from pydub.silence import detect_leading_silence
import io

# pydub shells out to ffmpeg to encode MP3. Point it at the binary bundled with
# imageio-ffmpeg so we don't depend on ffmpeg being installed / on PATH.
AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()

HOP_LENGTH = 512
CHROMA_WINDOW = 10          # chroma frames compared against the track start (~same as before)
MIN_LOOP_SECONDS = 3.0      # never propose a loop point earlier than this
BEATS_PER_BAR = 4           # assume 4/4; librosa doesn't give true downbeats
CROSSFADE_MS = 50           # length of the equal-power crossfade at the loop seam


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

    def trim_silence(audio, silence_thresh=-50):
        start = detect_leading_silence(audio, silence_threshold=silence_thresh)
        end = detect_leading_silence(audio.reverse(), silence_threshold=silence_thresh)
        return audio[start: len(audio) - end]

    audio = trim_silence(audio)

    audio_array = np.array(audio.get_array_of_samples()).astype(np.float32)
    audio_array /= np.iinfo(audio.array_type).max
    sr = audio.frame_rate

    loop_point_ms = _detect_loop_point_ms(audio_array, sr, len(audio))
    print(f"Loop point detected at {loop_point_ms}ms")

    if loop_point_ms < 1000:
        loop_point_ms = len(audio)

    audio_loopable = _crossfade_loop(audio[:loop_point_ms], crossfade_ms=CROSSFADE_MS)

    mp3_buffer = io.BytesIO()
    audio_loopable.export(mp3_buffer, format="mp3", bitrate="128k")
    mp3_buffer.seek(0)

    return mp3_buffer.read(), loop_point_ms


def _detect_loop_point_ms(audio_array: np.ndarray, sr: int, audio_len_ms: int) -> int:
    """
    Find the best point to cut a seamless loop: correlate a reference window
    at the start of the track against every later window (vectorized), then
    snap the best match onto the nearest bar boundary so the loop lands on a
    musical phrase instead of mid-beat.
    """
    chroma = librosa.feature.chroma_cqt(y=audio_array, sr=sr, hop_length=HOP_LENGTH)
    n_frames = chroma.shape[1]

    if n_frames <= CHROMA_WINDOW:
        return audio_len_ms  # too short to search meaningfully, loop the whole clip

    similarities = _vectorized_chroma_similarity(chroma, CHROMA_WINDOW)

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