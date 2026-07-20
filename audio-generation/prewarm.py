import asyncio

from models import MusicProfile
from d2_prompt import build_prompt
from d3_generate import generate_audio, GenerationError
from d4_process import process_audio

# Kept intentionally small -- this is meant to warm the most commonly hit
# combinations, not exhaustively cover every mood/style/bpm permutation
# (11 moods x N styles x 3 bpm buckets grows fast, and each miss costs a
# full MusicGen generation). Trim/expand these lists to match whatever your
# actual traffic looks like.
PREWARM_MOODS = ["calm", "energetic", "focused", "joyful", "sad"]
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
    combos = []
    for mood in PREWARM_MOODS:
        for style in PREWARM_STYLES:
            for bpm in PREWARM_BPMS.values():
                combos.append((mood, style, bpm))

    to_generate = []
    for mood, style, bpm in combos:
        profile = MusicProfile(
            mood=mood, style=style, bpm=bpm,
            duration_seconds=PREWARM_DURATION_SECONDS
        ).model_dump()
        cache_key = make_cache_key(profile)
        if check_cache(cache_key) is None:
            to_generate.append(profile)

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
                audio_bytes, _seed = await generate_audio(prompt, profile["duration_seconds"])
                mp3_bytes, loop_point_ms = await asyncio.to_thread(process_audio, audio_bytes)
                save_to_cache(cache_key, mp3_bytes, profile, loop_point_ms, 0, prompt)
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