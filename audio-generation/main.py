import os
import time
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from d1_validate import validate_profile
from d2_prompt import build_prompt
from d3_generate import generate_audio, GenerationError
from d4_process import process_audio
from fallback import get_fallback_clip
from models import HandoffPayload
from prewarm import prewarm_cache

IS_PROD = os.getenv("IS_PROD", "false").lower() in ("1", "true", "yes")
if IS_PROD:
    from d5_cache import make_cache_key, check_cache, save_to_cache
else:
    from d5_cache_local import make_cache_key, check_cache, save_to_cache, AUDIO_CACHE_DIR

from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fire-and-forget: don't await this, or the server won't start accepting
    # real requests until the entire pre-warm grid finishes generating.
    # The task is held on app.state so it isn't garbage-collected mid-run --
    # asyncio only keeps a weak reference to tasks created via create_task,
    # so an unreferenced task can silently vanish before it completes.
    app.state.prewarm_task = asyncio.create_task(
        prewarm_cache(make_cache_key, check_cache, save_to_cache)
    )
    yield


app = FastAPI(lifespan=lifespan)

if not IS_PROD:
    from fastapi.staticfiles import StaticFiles
    app.mount("/audio-cache", StaticFiles(directory=AUDIO_CACHE_DIR), name="audio-cache")

@app.post("/generate")
async def generate(payload: HandoffPayload):
    timings = {}

    # D1 — Validate & unwrap Sneha's Handoff 2 payload
    t0 = time.time()
    profile, prompt_from_b = validate_profile(payload)
    timings["d1_validate_ms"] = int((time.time() - t0) * 1000)

    # Cache check
    t1 = time.time()
    cache_key = make_cache_key(profile)
    cached = check_cache(cache_key)
    timings["d5_cache_check_ms"] = int((time.time() - t1) * 1000)

    if cached:
        # Not every field in the miss-path metadata below is persisted to
        # the cache DB (see the column list in docker/init.sql) -- only
        # cache_key/mood/bpm/key/energy/style/loop_point_ms/prompt_used
        # actually round-trip. Rather than spreading `cached` directly and
        # letting whichever fields didn't make the DB schema silently
        # vanish from the response (the seam_discontinuity bug from
        # review), every key the miss-path can return is explicitly
        # declared here too, so hit and miss responses always have the
        # same shape -- unpersisted fields come back as null instead of
        # missing outright. Full persistence (DB columns for valence,
        # intensity, duration_seconds, prompt_source, generation_seed) is
        # a bigger schema-migration change; flagged as a follow-up rather
        # than done here.
        return {
            "audio_url": cached["audio_url"],
            "metadata": {
                "cache_key":          cached.get("cache_key", cache_key),
                "mood":               cached.get("mood"),
                "bpm":                cached.get("bpm"),
                "key":                cached.get("key"),
                "energy":             cached.get("energy"),
                "valence":            cached.get("valence"),
                "intensity":          cached.get("intensity"),
                "duration_seconds":   cached.get("duration_seconds"),
                "loop_point_ms":      cached.get("loop_point_ms"),
                "seam_discontinuity": cached.get("seam_discontinuity"),
                "prompt_used":        cached.get("prompt_used"),
                "prompt_source":      cached.get("prompt_source"),
                "generation_seed":    cached.get("generation_seed"),
                "is_fallback":        False,
                "loopable":           True,
            },
            "cache":     "hit",
            "timings":   timings
        }

    # D2 — Use Sneha's prompt if available, else build our own
    t2 = time.time()
    prompt = build_prompt(profile, prompt_from_b)
    timings["d2_prompt_ms"] = int((time.time() - t2) * 1000)
    print(f"[D2] Prompt source: {'Feature B' if prompt_from_b else 'D2 fallback'}")
    print(f"[D2] Prompt: {prompt}")

    # D3 — Generate audio with retry logic
    t3 = time.time()
    generation_seed = None
    try:
        audio_bytes, generation_seed = await generate_audio(
            prompt, profile["duration_seconds"]
        )
    except GenerationError as e:
        print(f"[MAIN] Generation failed after all retries: {e}")
        print(f"[MAIN] Attempting fallback clip for mood: {profile['mood']}")

        fallback_bytes = await asyncio.to_thread(get_fallback_clip, profile["mood"])

        if fallback_bytes is None:
            raise HTTPException(
                status_code=503,
                detail="Audio generation failed and no fallback clips are available. Please try again later."
            )

        print("[MAIN] Returning fallback clip")
        return JSONResponse(
            status_code=200,
            content={
                "audio_url": None,
                "metadata": {
                    "mood":        profile["mood"],
                    "bpm":         profile["bpm"],
                    "key":         profile["key"],
                    "energy":      profile["energy"],
                    "is_fallback": True,
                    "loopable":    True
                },
                "cache":    "miss",
                "fallback": True,
                "timings":  timings
            }
        )

    timings["d3_generate_ms"] = int((time.time() - t3) * 1000)

    # D4 — Post-process
    t4 = time.time()
    mp3_bytes, loop_point_ms, seam_discontinuity = await asyncio.to_thread(process_audio, audio_bytes)
    timings["d4_process_ms"] = int((time.time() - t4) * 1000)

    # D5 — Cache & return
    t5 = time.time()
    total_gen_ms = int((time.time() - t0) * 1000)
    audio_url = save_to_cache(
        cache_key, mp3_bytes, profile,
        loop_point_ms, total_gen_ms, prompt
    )
    timings["d5_save_ms"] = int((time.time() - t5) * 1000)

    return {
        "audio_url": audio_url,
        "metadata": {
            "cache_key":        cache_key,
            "mood":             profile["mood"],
            "bpm":              profile["bpm"],
            "key":              profile["key"],
            "energy":           profile["energy"],
            "valence":          profile["valence"],
            "intensity":        profile["intensity"],
            "duration_seconds": profile["duration_seconds"],
            "loop_point_ms":      loop_point_ms,
            "seam_discontinuity": seam_discontinuity,
            "prompt_used":        prompt,
            "prompt_source":      "feature_b" if prompt_from_b else "d2_fallback",
            "generation_seed":    generation_seed,
            "is_fallback":        False,
            "loopable":           True
        },
        "cache":   "miss",
        "timings": timings
    }