import os
import time
from fastapi import FastAPI
from d1_validate import validate_profile
from d2_prompt import build_prompt
from d3_generate import generate_audio
from d4_process import process_audio

# Prod (Supabase-backed) cache vs. local dev cache (Docker Postgres + files on
# disk). Defaults to dev so the server runs out of the box against `docker
# compose up` in audio-generation/docker/ without needing a Supabase account.
IS_PROD = os.getenv("IS_PROD", "false").lower() in ("1", "true", "yes")

if IS_PROD:
    from d5_cache import make_cache_key, check_cache, save_to_cache
else:
    from d5_cache_local import make_cache_key, check_cache, save_to_cache, AUDIO_CACHE_DIR

app = FastAPI()

if not IS_PROD:
    from fastapi.staticfiles import StaticFiles
    app.mount("/audio-cache", StaticFiles(directory=AUDIO_CACHE_DIR), name="audio-cache")

@app.post("/generate")
async def generate(profile: dict):
    timings = {}

    t0 = time.time()
    profile = validate_profile(profile)
    timings["d1_validate_ms"] = int((time.time() - t0) * 1000)

    t1 = time.time()
    cache_key = make_cache_key(profile)
    cached = check_cache(cache_key)
    timings["d5_cache_check_ms"] = int((time.time() - t1) * 1000)

    if cached:
        return {"audio_url": cached["audio_url"], "metadata": cached, "cache": "hit", "timings": timings}

    t2 = time.time()
    prompt = build_prompt(profile)
    timings["d2_prompt_ms"] = int((time.time() - t2) * 1000)
    print(f"Prompt: {prompt}")

    t3 = time.time()
    audio_bytes = generate_audio(prompt)
    timings["d3_generate_ms"] = int((time.time() - t3) * 1000)

    t4 = time.time()
    mp3_bytes, loop_point_ms = process_audio(audio_bytes)
    timings["d4_process_ms"] = int((time.time() - t4) * 1000)

    t5 = time.time()
    total_gen_ms = int((time.time() - t0) * 1000)
    audio_url = save_to_cache(cache_key, mp3_bytes, profile, loop_point_ms, total_gen_ms, prompt)
    timings["d5_save_ms"] = int((time.time() - t5) * 1000)

    return {
        "audio_url": audio_url,
        "metadata": {
            "cache_key": cache_key,
            "mood": profile["mood"],
            "bpm": profile["bpm"],
            "key": profile["key"],
            "energy": profile["energy"],
            "loop_point_ms": loop_point_ms,
            "prompt_used": prompt,
            "loopable": True
        },
        "cache": "miss",
        "timings": timings
    }