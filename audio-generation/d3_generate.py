import asyncio
import time
import numpy as np
import io
import torch
import soundfile as sf
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

# MusicGen amortizes most of its per-call overhead across a batch, so a
# batch of 4 costs far less than 4x a batch of 1 -- this is the "near-free
# throughput" the batching gets us. MAX_BATCH_SIZE is a memory/latency
# tradeoff: bigger batches are more efficient per-clip but make everyone in
# the batch wait for the slowest slot and use more RAM/VRAM at once.
MAX_BATCH_SIZE = 4
# How long the worker waits for more concurrent requests to arrive before
# firing whatever it has. Keeps a single, isolated request from stalling.
BATCH_WINDOW_MS = 150


class GenerationError(Exception):
    pass


class _BatchItem:
    __slots__ = ("prompt", "max_tokens", "seed", "future")

    def __init__(self, prompt, max_tokens, seed, future):
        self.prompt = prompt
        self.max_tokens = max_tokens
        self.seed = seed
        self.future = future


_queue = None
_worker_task = None


def _ensure_worker():
    """Lazily starts the batching background task on the running event loop.
    Deferred (rather than started at import time) because there's no running
    loop yet when this module is first imported by main.py."""
    global _queue, _worker_task
    if _queue is None:
        _queue = asyncio.Queue()
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_batch_worker())


async def _batch_worker():
    """
    Continuously pulls queued generate_audio() calls and groups whatever
    arrives within BATCH_WINDOW_MS (up to MAX_BATCH_SIZE) into a single
    MusicGen forward pass, instead of one model call per request.
    """
    while True:
        item = await _queue.get()
        batch = [item]
        deadline = time.monotonic() + BATCH_WINDOW_MS / 1000
        while len(batch) < MAX_BATCH_SIZE:
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                break
            try:
                nxt = await asyncio.wait_for(_queue.get(), timeout=timeout)
                batch.append(nxt)
            except asyncio.TimeoutError:
                break

        await asyncio.to_thread(_run_batch, batch)


def _run_batch(batch):
    """Runs synchronously in a worker thread (via asyncio.to_thread) since
    the actual model call is blocking. Resolves each item's future with its
    own result/exception so callers awaiting generate_audio() get the right
    clip back, even though the model ran them together."""
    prompts = [b.prompt for b in batch]
    # A single batched forward pass needs one decode length for the whole
    # batch -- use the longest of what was individually requested so nobody
    # gets cut short; D4 can still trim per-clip afterwards.
    max_tokens = max(b.max_tokens for b in batch)

    try:
        # Batched sampling shares one RNG stream across the whole batch --
        # there's no way to give each item in a single forward pass its own
        # independent seed. Seeded with the first item's seed for
        # reproducibility of the *batch*, not of each individual clip.
        torch.manual_seed(batch[0].seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(batch[0].seed)

        print(f"[D3] Running batch of {len(batch)} prompt(s), max_tokens={max_tokens}")
        outputs = synthesiser(
            prompts,
            forward_params={
                "do_sample":      True,
                "max_new_tokens": max_tokens,
                "min_new_tokens": max_tokens,
            }
        )
        # pipeline returns a bare dict for a single string input, but a list
        # of dicts for a list input -- normalize so the zip below always works
        if isinstance(outputs, dict):
            outputs = [outputs]

        for item, out in zip(batch, outputs):
            try:
                audio_data = out["audio"]
                sample_rate = out["sampling_rate"]

                duration = audio_data.shape[-1] / sample_rate
                print(f"[D3] Raw generated duration: {duration:.2f}s")
                if duration < 5.0:
                    raise ValueError(f"Generated clip too short: {duration:.2f}s")

                if audio_data.ndim > 1:
                    audio_data = audio_data[0]

                out_buffer = io.BytesIO()
                sf.write(out_buffer, audio_data, sample_rate, format='WAV')
                out_buffer.seek(0)

                if not item.future.done():
                    item.future.set_result((out_buffer.read(), item.seed))
            except Exception as e:
                if not item.future.done():
                    item.future.set_exception(e)

    except Exception as e:
        # Whole batch failed (e.g. OOM, model error) -- every item in it
        # fails the same way; generate_audio()'s retry loop will re-queue
        # each one individually on the next attempt.
        for item in batch:
            if not item.future.done():
                item.future.set_exception(e)


async def generate_audio(prompt: str, duration_seconds: int = 28) -> tuple:
    """
    Generate audio from prompt using MusicGen. Concurrent calls to this
    function are automatically coalesced into shared batches by the
    background worker -- call sites just `await` it directly (it's a real
    async coroutine now, not a blocking function).
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
    _ensure_worker()
    max_tokens = duration_seconds * TOKENS_PER_SEC
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        seed = 42 + attempt
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        await _queue.put(_BatchItem(prompt, max_tokens, seed, future))

        try:
            print(f"[D3] Generation attempt {attempt}/{MAX_RETRIES} with seed {seed} -- queued for batch")
            print(f"[D3] Target duration: {duration_seconds}s ({max_tokens} tokens)")
            print(f"[D3] Prompt: {prompt}")
            result = await future
            print(f"[D3] Audio generated successfully on attempt {attempt}!")
            return result
        except Exception as e:
            last_error = e
            print(f"[D3] Attempt {attempt} failed: {e}")

            if attempt < MAX_RETRIES:
                wait = RETRY_DELAY * (2 ** (attempt - 1))
                print(f"[D3] Retrying in {wait}s...")
                await asyncio.sleep(wait)

    raise GenerationError(
        f"All {MAX_RETRIES} generation attempts failed. Last error: {last_error}"
    )