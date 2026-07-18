import numpy as np
import io
import time
import soundfile as sf
import torch
from transformers import pipeline

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

if torch.cuda.is_available():
    synthesiser.model = torch.compile(synthesiser.model)
    print("Model compiled with torch.compile ✅")
else:
    print("Skipping torch.compile (CPU — no benefit)")

print("Model loaded!")

MAX_RETRIES    = 3
RETRY_DELAY    = 2
TOKENS_PER_SEC = 50  # MusicGen audio codec runs at ~50 tokens/second

def generate_audio(prompt: str, duration_seconds: int = 28) -> tuple[bytes, int]:
    """
    Generate audio from prompt using MusicGen.
    Retries up to MAX_RETRIES times with exponential backoff.
    Returns (audio_bytes, seed_used) tuple.
    Raises GenerationError if all retries fail.

    duration_seconds: target clip length (5-30s).
    Token count = duration_seconds * TOKENS_PER_SEC (~50 tokens/sec).

    Note on guidance_scale (CFG):
    Lowering guidance_scale from default (3.0) to 1.0 would halve
    forward passes per step and reduce latency. However,
    guidance_scale is not supported as a parameter by
    TextToAudioPipeline in the current transformers version.
    Flagged for future optimisation when latency becomes a bottleneck.
    """
    max_tokens = duration_seconds * TOKENS_PER_SEC
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        seed = 42 + attempt
        try:
            print(f"[D3] Generation attempt {attempt}/{MAX_RETRIES} with seed {seed}")
            print(f"[D3] Target duration: {duration_seconds}s ({max_tokens} tokens)")
            print(f"[D3] Prompt: {prompt}")

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

            duration = audio_data.shape[-1] / sample_rate
            print(f"[D3] Raw generated duration: {duration:.2f}s")

            if duration < 5.0:
                raise ValueError(f"Generated clip too short: {duration:.2f}s")

            if audio_data.ndim > 1:
                audio_data = audio_data[0]

            out_buffer = io.BytesIO()
            sf.write(out_buffer, audio_data, sample_rate, format='WAV')
            out_buffer.seek(0)

            print(f"[D3] Audio generated successfully on attempt {attempt}!")
            return out_buffer.read(), seed

        except Exception as e:
            last_error = e
            print(f"[D3] Attempt {attempt} failed: {e}")

            if attempt < MAX_RETRIES:
                wait = RETRY_DELAY * (2 ** (attempt - 1))
                print(f"[D3] Retrying in {wait}s...")
                time.sleep(wait)

    raise GenerationError(
        f"All {MAX_RETRIES} generation attempts failed. Last error: {last_error}"
    )


class GenerationError(Exception):
    pass