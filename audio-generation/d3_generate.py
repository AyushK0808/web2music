import numpy as np
import io
import soundfile as sf
import torch
from transformers import pipeline

# Automatically use GPU if available, otherwise CPU
device = 0 if torch.cuda.is_available() else -1
device_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
print(f"Using device: {device_name}")

print("Loading MusicGen model... (first time takes 1-2 mins)")
synthesiser = pipeline(
    "text-to-audio",
    "facebook/musicgen-small",
    device=device,
    torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32
)
print("Model loaded!")

def generate_audio(prompt: str, max_tokens: int = 1400) -> bytes:
    print(f"Generating audio for prompt: {prompt}")
    
    # Seed for reproducibility
    seed = 42
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed(seed)
    print(f"Using seed: {seed}")

    music = synthesiser(
        prompt,
        forward_params={
            "do_sample": True,
            "max_new_tokens": max_tokens,
            "min_new_tokens": max_tokens,
        }
    )

    audio_data = music["audio"]
    sample_rate = music["sampling_rate"]

    # Log actual duration for debugging
    duration = audio_data.shape[-1] / sample_rate
    print(f"Raw generated duration: {duration:.2f}s")

    if audio_data.ndim > 1:
        audio_data = audio_data[0]

    out_buffer = io.BytesIO()
    sf.write(out_buffer, audio_data, sample_rate, format='WAV')
    out_buffer.seek(0)

    print("Audio generated successfully!")
    return out_buffer.read()