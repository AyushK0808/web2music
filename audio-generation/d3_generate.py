import asyncio
import itertools
import time
import numpy as np
import io
import torch
import soundfile as sf
from transformers import pipeline

if torch.cuda.is_available():
    device = 0
    device_name = torch.cuda.get_device_name(0)
elif torch.backends.mps.is_available():
    device = "mps"
    device_name = "MPS (Apple Silicon)"
else:
    device = -1
    device_name = "CPU"
print(f"Using device: {device_name}")

print("Loading MusicGen model... (first time takes 1-2 mins)")
synthesiser = pipeline(
    "text-to-audio",
    "facebook/musicgen-small",
    device=device,
    # float16 only on CUDA -- MPS has known float16 correctness gaps in some
    # torch/transformers version combos, float32 is the safe default there
    torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32
)

if torch.cuda.is_available():
    synthesiser.model = torch.compile(synthesiser.model)
    print("Model compiled with torch.compile ✅")
else:
    print("Skipping torch.compile (CUDA-only benefit)")

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
    # `loop` is the event loop the future belongs to. _run_batch resolves
    # these futures from a worker thread (asyncio.to_thread), and an
    # asyncio.Future is NOT thread-safe -- it must be completed on its own
    # loop. Carrying the loop per item is what makes that possible; see
    # _resolve_threadsafe below for why touching the future directly hangs.
    __slots__ = ("prompt", "max_tokens", "seed", "future", "priority", "loop")

    def __init__(self, prompt, max_tokens, seed, future, priority, loop):
        self.prompt = prompt
        self.max_tokens = max_tokens
        self.seed = seed
        self.future = future
        self.priority = priority
        self.loop = loop


def _resolve_threadsafe(item, *, result=None, exception=None):
    """
    Completes one batch item's future from _run_batch's worker thread.

    Calling future.set_result() directly across threads looks like it works
    and mostly does, which is what made this so hard to see: set_result
    schedules the awaiting task's callback with loop.call_soon(), and
    call_soon does not wake a loop that is already blocked in select().
    Whenever some *other* pending event happened to wake the loop shortly
    after, the callback got picked up and everything looked fine -- so the
    bug only bit when a batch was the last outstanding work on the loop,
    which is precisely the tail of a prewarm grid. The loop then slept
    forever with the result sitting in _ready: a hang at 0% CPU, not a
    crash. call_soon_threadsafe writes to the loop's self-pipe and actually
    wakes it.

    The done() check has to happen on the loop thread too -- checking it
    here and setting it there would just be a smaller version of the same
    race.
    """
    def _apply():
        if item.future.done():
            return
        if exception is not None:
            item.future.set_exception(exception)
        else:
            item.future.set_result(result)

    try:
        item.loop.call_soon_threadsafe(_apply)
    except RuntimeError:
        # Loop already closed (test teardown, or shutdown mid-batch). The
        # awaiting caller is gone with it, so there is nothing to resolve
        # and nothing to report -- dropping this is the correct outcome.
        pass


# PRIORITY LEVELS -- lower number = served first.
# Real /generate requests (a page a user is actually looking at) must never
# sit behind the startup pre-warm grid, which can be dozens of full MusicGen
# generations deep. asyncio.PriorityQueue pops the lowest-priority-number
# item available *at the moment .get() is called* -- so even if 40 low-
# priority pre-warm items were enqueued first, a high-priority item queued
# afterwards jumps in front of all of them for the next batch. This was the
# root cause behind "I see the [D2] Prompt log but then nothing happens" --
# the request wasn't hung, it was stuck behind the pre-warm backlog on a
# plain FIFO queue.
PRIORITY_REALTIME = 0   # main.py's /generate -- an actual user is waiting
PRIORITY_PREWARM  = 10  # prewarm.py's startup cache-warming grid

_queue = None
_worker_task = None
_seq_counter = itertools.count()  # tie-breaker so same-priority items stay FIFO
                                   # and PriorityQueue never has to compare
                                   # _BatchItem objects directly (they aren't
                                   # orderable).


def _ensure_worker():
    """Lazily starts the batching background task on the running event loop.
    Deferred (rather than started at import time) because there's no running
    loop yet when this module is first imported by main.py."""
    global _queue, _worker_task
    if _queue is None:
        _queue = asyncio.PriorityQueue()
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_batch_worker())
        print("[D3] Batch worker started")


async def _batch_worker():
    """
    Continuously pulls queued generate_audio() calls (highest priority --
    i.e. lowest priority number -- first) and groups whatever arrives within
    BATCH_WINDOW_MS (up to MAX_BATCH_SIZE) into a single MusicGen forward
    pass, instead of one model call per request.
    """
    while True:
        _, _, item = await _queue.get()
        batch = [item]
        deadline = time.monotonic() + BATCH_WINDOW_MS / 1000
        while len(batch) < MAX_BATCH_SIZE:
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                break
            try:
                _, _, nxt = await asyncio.wait_for(_queue.get(), timeout=timeout)
                batch.append(nxt)
            except asyncio.TimeoutError:
                break

        remaining = _queue.qsize()
        print(f"[D3] Dispatching batch of {len(batch)} "
              f"(priorities={[b.priority for b in batch]}, {remaining} still queued)")
        await asyncio.to_thread(_run_batch, batch)


def _combine_seeds(seeds: list) -> int:
    """
    Deterministically folds every item's requested seed into a single batch
    seed. Single-item batches (the common case -- batching only kicks in
    under real concurrent load) return that item's seed unchanged, so
    today's normal single-request behavior is untouched. Multi-item batches
    get a seed that depends on the full set of seeds in the batch, so the
    same batch composition always reproduces the same output -- and, unlike
    before, the seed reported back to each caller now matches what was
    actually used, instead of every non-first item getting back a seed
    number that had no effect on its own generation.
    """
    if len(seeds) == 1:
        return seeds[0]
    combined = 0
    for s in seeds:
        combined = (combined * 1_000_003 + s) % (2**31 - 1)
    return combined


def _run_batch(batch):
    """Runs synchronously in a worker thread (via asyncio.to_thread) since
    the actual model call is blocking. Resolves each item's future with its
    own result/exception so callers awaiting generate_audio() get the right
    clip back, even though the model ran them together."""
    prompts = [b.prompt for b in batch]
    # A single batched forward pass needs one decode length for the whole
    # batch -- use the longest of what was individually requested so nobody
    # gets cut short mid-generation. Each item gets trimmed back to its own
    # requested duration after generation, in the per-item loop below.
    max_tokens = max(b.max_tokens for b in batch)

    try:
        # Batched sampling shares one RNG stream across the whole batch --
        # HF's generate() only accepts one global seed/generator per call,
        # not one per batch row, so genuinely independent per-clip seeds
        # within a single forward pass aren't achievable here. What we CAN
        # fix: fold every item's seed into the batch seed (not just
        # batch[0]'s), and report that same real seed back to every item,
        # so the returned generation_seed is always accurate instead of
        # silently wrong for every item after the first.
        batch_seed = _combine_seeds([b.seed for b in batch])
        torch.manual_seed(batch_seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(batch_seed)

        print(f"[D3] Running batch of {len(batch)} prompt(s), max_tokens={max_tokens}, batch_seed={batch_seed}")
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

                if audio_data.ndim > 1:
                    audio_data = audio_data[0]

                # Batched generation decodes every item in the batch out to
                # the same (longest-requested) token length. Trim this
                # item's clip back down to what THIS caller actually asked
                # for, so duration_seconds is honored per-request rather
                # than silently returning the longest duration in the batch
                # to everyone in it.
                target_samples = int(sample_rate * (item.max_tokens / TOKENS_PER_SEC))
                target_samples = min(target_samples, audio_data.shape[-1])
                audio_data = audio_data[:target_samples]

                duration = audio_data.shape[-1] / sample_rate
                print(f"[D3] Raw generated duration: {duration:.2f}s (trimmed to this item's requested length)")
                if duration < 5.0:
                    raise ValueError(f"Generated clip too short: {duration:.2f}s")

                out_buffer = io.BytesIO()
                sf.write(out_buffer, audio_data, sample_rate, format='WAV')
                out_buffer.seek(0)

                _resolve_threadsafe(item, result=(out_buffer.read(), batch_seed))
            except Exception as e:
                _resolve_threadsafe(item, exception=e)

    except Exception as e:
        # Whole batch failed (e.g. OOM, model error) -- every item in it
        # fails the same way; generate_audio()'s retry loop will re-queue
        # each one individually on the next attempt.
        for item in batch:
            _resolve_threadsafe(item, exception=e)


async def generate_audio(
    prompt: str,
    duration_seconds: int = 28,
    priority: int = PRIORITY_REALTIME,
) -> tuple:
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

    priority: PRIORITY_REALTIME (default) for an actual user request,
    PRIORITY_PREWARM for prewarm.py's startup grid. Lower number = served
    first regardless of queue order -- see the PRIORITY_* comment above.

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
    label = "realtime" if priority <= PRIORITY_REALTIME else "prewarm"

    for attempt in range(1, MAX_RETRIES + 1):
        seed = 42 + attempt
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        ahead = _queue.qsize()
        await _queue.put((priority, next(_seq_counter), _BatchItem(prompt, max_tokens, seed, future, priority, loop)))

        try:
            print(f"[D3] [{label}] Generation attempt {attempt}/{MAX_RETRIES} with seed {seed} "
                  f"-- queued for batch (priority={priority}, {ahead} item(s) already queued)")
            print(f"[D3] [{label}] Target duration: {duration_seconds}s ({max_tokens} tokens)")
            print(f"[D3] [{label}] Prompt: {prompt}")
            result = await future
            print(f"[D3] [{label}] Audio generated successfully on attempt {attempt}!")
            return result
        except Exception as e:
            last_error = e
            print(f"[D3] [{label}] Attempt {attempt} failed: {e}")

            if attempt < MAX_RETRIES:
                wait = RETRY_DELAY * (2 ** (attempt - 1))
                print(f"[D3] [{label}] Retrying in {wait}s...")
                await asyncio.sleep(wait)

    raise GenerationError(
        f"All {MAX_RETRIES} generation attempts failed. Last error: {last_error}"
    )