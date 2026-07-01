import numpy as np
import io
import soundfile as sf
from transformers import pipeline

print("Loading MusicGen model... (first time takes 1-2 mins)")
synthesiser = pipeline("text-to-audio", "facebook/musicgen-small")
print("Model loaded!")

def generate_audio(prompt: str, max_tokens: int = 256) -> bytes:  
    print(f"Generating audio for prompt: {prompt}")
    music = synthesiser(prompt, forward_params={"do_sample": True, "max_new_tokens": max_tokens})
    
    audio_data = music["audio"]
    sample_rate = music["sampling_rate"]

    if audio_data.ndim > 1:
        audio_data = audio_data[0]

    out_buffer = io.BytesIO()
    sf.write(out_buffer, audio_data, sample_rate, format='WAV')
    out_buffer.seek(0)
    
    print("Audio generated successfully!")
    return out_buffer.read()