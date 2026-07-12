from fastapi import FastAPI
from d1_validate import validate_profile
from d2_prompt import build_prompt
from d3_generate import generate_audio
from d4_process import process_audio
from d5_cache import make_cache_key, check_cache, save_to_cache
import time

app = FastAPI()

@app.post("/generate")
async def generate(payload: dict):
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
        return {
            "audio_url": cached["audio_url"],
            "metadata": cached,
            "cache": "hit",
            "timings": timings
        }

    # D2 — Use Sneha's prompt if available, else build our own
    t2 = time.time()
    prompt = build_prompt(profile, prompt_from_b)
    timings["d2_prompt_ms"] = int((time.time() - t2) * 1000)
    print(f"[D2] Prompt source: {'Feature B' if prompt_from_b else 'D2 fallback'}")
    print(f"[D2] Prompt: {prompt}")

    # D3 — Generate audio
    t3 = time.time()
    audio_bytes = generate_audio(prompt)
    timings["d3_generate_ms"] = int((time.time() - t3) * 1000)

    # D4 — Post-process
    t4 = time.time()
    mp3_bytes, loop_point_ms = process_audio(audio_bytes)
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
            "cache_key":      cache_key,
            "mood":           profile["mood"],
            "bpm":            profile["bpm"],
            "key":            profile["key"],
            "energy":         profile["energy"],
            "valence":        profile["valence"],
            "intensity":      profile["intensity"],
            "loop_point_ms":  loop_point_ms,
            "prompt_used":    prompt,
            "prompt_source":  "feature_b" if prompt_from_b else "d2_fallback",
            "loopable":       True
        },
        "cache": "miss",
        "timings": timings
    }