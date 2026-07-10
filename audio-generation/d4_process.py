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

    chroma = librosa.feature.chroma_cqt(y=audio_array, sr=sr)
    tempo, beat_frames = librosa.beat.beat_track(y=audio_array, sr=sr)
    beat_times_ms = librosa.frames_to_time(beat_frames, sr=sr) * 1000

    start_frames = chroma[:, :10]
    similarities = []
    for i in range(chroma.shape[1] - 10):
        sim = np.corrcoef(
            start_frames.flatten(),
            chroma[:, i:i+10].flatten()
        )[0, 1]
        similarities.append(sim)

    best_frame = int(np.argmax(similarities))
    best_time_ms = (best_frame / chroma.shape[1]) * len(audio)

    if len(beat_times_ms) > 0:
        loop_point_ms = min(beat_times_ms, key=lambda b: abs(b - best_time_ms))
    else:
        loop_point_ms = best_time_ms

    loop_point_ms = int(loop_point_ms)
    print(f"Loop point detected at {loop_point_ms}ms")

    if loop_point_ms < 1000:
        loop_point_ms = len(audio)
    
    audio_loopable = audio[:loop_point_ms]
    audio_loopable = audio_loopable.fade_out(50)

    mp3_buffer = io.BytesIO()
    audio_loopable.export(mp3_buffer, format="mp3", bitrate="128k")
    mp3_buffer.seek(0)

    return mp3_buffer.read(), loop_point_ms