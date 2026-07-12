import numpy as np
import io
import time
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

MAX_RETRIES = 3
RETRY_DELAY = 2  # seconds, doubles each retry

def generate_audio(prompt: str, max_tokens: int = 1400) -> bytes:
    """
    Generate audio from prompt using MusicGen.
    Retries up to MAX_RETRIES times with exponential backoff.
    Raises GenerationError if all retries fail.
    """
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            print(f"[D3] Generation attempt {attempt}/{MAX_RETRIES}")
            print(f"[D3] Prompt: {prompt}")

            # Seed for reproducibility
            seed = 42
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed(seed)

            music = synthesiser(
                prompt,
                forward_params={
                    "do_sample":      True,
                    "max_new_tokens": max_tokens,
                    "min_new_tokens": max_tokens,
                }
            )

            audio_data  = music["audio"]
            sample_rate = music["sampling_rate"]

            # Log actual duration
            duration = audio_data.shape[-1] / sample_rate
            print(f"[D3] Raw generated duration: {duration:.2f}s")

            # Validate — reject suspiciously short clips
            if duration < 5.0:
                raise ValueError(f"Generated clip too short: {duration:.2f}s (expected ~28s)")

            if audio_data.ndim > 1:
                audio_data = audio_data[0]

            out_buffer = io.BytesIO()
            sf.write(out_buffer, audio_data, sample_rate, format='WAV')
            out_buffer.seek(0)

            print(f"[D3] Audio generated successfully on attempt {attempt}!")
            return out_buffer.read()

        except Exception as e:
            last_error = e
            print(f"[D3] Attempt {attempt} failed: {e}")

            if attempt < MAX_RETRIES:
                wait = RETRY_DELAY * (2 ** (attempt - 1))  # 2s, 4s, 8s
                print(f"[D3] Retrying in {wait}s...")
                time.sleep(wait)

    # All retries failed
    raise GenerationError(f"All {MAX_RETRIES} generation attempts failed. Last error: {last_error}")


class GenerationError(Exception):
    """Raised when all generation retries are exhausted."""
    pass