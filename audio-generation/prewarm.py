import asyncio

from models import MusicProfile
from d2_prompt import build_prompt
from d3_generate import generate_audio, GenerationError, PRIORITY_PREWARM
from d4_process import process_audio

# All 11 moods are covered (X4 integration plan) so no mood is a guaranteed
# cold miss on CPU -- but this makes the grid 11 x 3 x 3 = 99 combos, each a
# full MusicGen generation (~15-95s on CPU). That's real startup latency in
# production and real runtime in tests/test_prewarm.py (~3min for that file
# alone, since it calls prewarm_cache with mocked generation but the same
# combo count). Trim PREWARM_STYLES/PREWARM_BPMS first if this needs to
# shrink -- moods should stay complete.
PREWARM_MOODS = [
    "calm", "energetic", "focused", "joyful", "sad",
    "dark", "nostalgic", "curious", "tense", "uplifting", "neutral",
]
PREWARM_STYLES = ["ambient", "electronic", "acoustic"]
# One representative bpm per bucket, matching the bucket boundaries in
# d5_cache.py's make_cache_key() (low < 76, mid < 101, high >= 101) -- the
# cache key only cares about which bucket a bpm falls into, so warming one
# value per bucket warms the whole bucket.
PREWARM_BPMS = {"low": 60, "mid": 90, "high": 120}
# Representative duration -- matches MusicProfile's default and d5_cache's
# duration_bucket (2s tolerance), so this warms the default-duration case.
PREWARM_DURATION_SECONDS = 28

# Caps how many pre-warm generations run at once, independent of D3's own
# batch size -- keeps this from starving real user traffic hitting
# /generate at the same time as startup pre-warming.
PREWARM_CONCURRENCY = 4

async def prewarm_cache(make_cache_key, check_cache, save_to_cache):
    """
    Fires off missing (mood, style, bpm-bucket) combinations from the
    PREWARM_* grid so they're cached before real traffic needs them.
    Concurrent calls to generate_audio() here get coalesced into shared
    MusicGen batches automatically by d3_generate.py's batch worker -- this
    function doesn't need to do any batching itself, just fire requests
    concurrently and let D3 handle it.
    Runs as a background task; failures are logged, not raised, so a single
    bad combo can't block startup or take down the rest of the grid.
    """
    print(f"[PREWARM] Starting -- scanning cache for {len(PREWARM_MOODS) * len(PREWARM_STYLES) * len(PREWARM_BPMS)} combo(s) "
          f"(runs in the background at low priority; real /generate requests always jump the queue)...")
    combos = []
    for mood in PREWARM_MOODS:
        for style in PREWARM_STYLES:
            for bpm in PREWARM_BPMS.values():
                combos.append((mood, style, bpm))

    profiles = [
        MusicProfile(
            mood=mood, style=style, bpm=bpm,
            duration_seconds=PREWARM_DURATION_SECONDS
        ).model_dump()
        for mood, style, bpm in combos
    ]

    # check_cache() is a blocking network/DB call (Supabase REST or
    # psycopg2) -- running 45 of them directly on the event loop would
    # block it for the full duration of 45 sequential round trips before
    # any real request could be served. Fire them concurrently off-thread
    # instead.
    scan_semaphore = asyncio.Semaphore(PREWARM_CONCURRENCY)

    async def _is_cached(profile):
        async with scan_semaphore:
            cache_key = make_cache_key(profile)
            cached = await asyncio.to_thread(check_cache, cache_key)
            return cached is not None

    cached_flags = await asyncio.gather(*(_is_cached(p) for p in profiles))
    to_generate = [p for p, is_cached in zip(profiles, cached_flags) if not is_cached]

    if not to_generate:
        print("[PREWARM] Cache already warm for the full grid, nothing to do.")
        return

    print(f"[PREWARM] {len(to_generate)}/{len(combos)} combo(s) missing -- warming cache in background...")

    semaphore = asyncio.Semaphore(PREWARM_CONCURRENCY)

    async def _warm_one(profile):
        async with semaphore:
            label = f"{profile['mood']}/{profile['style']}/{profile['bpm']}bpm"
            try:
                cache_key = make_cache_key(profile)
                prompt = build_prompt(profile)
                # PRIORITY_PREWARM: this used to share the same FIFO queue as
                # real /generate requests, so a request that landed while the
                # 45-combo prewarm grid was still running could sit behind
                # dozens of full MusicGen generations before ever starting --
                # looking exactly like a hang ("prompt logged, then nothing").
                # Tagging it low-priority means any real request jumps ahead
                # of whatever's left in this grid.
                audio_bytes, seed = await generate_audio(
                    prompt, profile["duration_seconds"], priority=PRIORITY_PREWARM
                )
                clip_bytes, loop_point_ms, seam_discontinuity = await asyncio.to_thread(process_audio, audio_bytes)
                await asyncio.to_thread(
                    save_to_cache, cache_key, clip_bytes, profile, loop_point_ms, 0, prompt,
                    seam_discontinuity, "prewarm", seed
                )
                print(f"[PREWARM] Cached {label}")
                return True
            except GenerationError as e:
                print(f"[PREWARM] Generation failed for {label}: {e}")
                return False
            except Exception as e:
                print(f"[PREWARM] Unexpected error for {label}: {e}")
                return False

    results = await asyncio.gather(*(_warm_one(p) for p in to_generate))
    ok = sum(1 for r in results if r)
    print(f"[PREWARM] Done -- {ok}/{len(to_generate)} combo(s) cached.")