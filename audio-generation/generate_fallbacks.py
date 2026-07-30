"""
Run this script ONCE to pre-generate fallback clips for all 11 moods.
These are used when live generation fails.

Usage:
    python generate_fallbacks.py

In prod (IS_PROD=true), also uploads each clip to the Supabase "fallback-clips"
storage bucket so main.py's public-URL lookup resolves to something real.
The bucket must already exist (create it in the Supabase dashboard, public read).

Now unblocked — X2 (loop detection) is merged so clips will loop properly.
"""

import os
import sys
import json
import asyncio
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(__file__))

from d2_prompt import build_prompt
from d3_generate import generate_audio, GenerationError
from d4_process import process_audio
load_dotenv()

IS_PROD = os.getenv("IS_PROD", "false").lower() in ("1", "true", "yes")

FALLBACK_DIR = os.path.join(os.path.dirname(__file__), "fallback_clips")

FALLBACK_PROFILES = {
    "calm":      {"mood": "calm",      "bpm": 65,  "key": "C major", "energy": 0.2, "style": "ambient"},
    "focused":   {"mood": "focused",   "bpm": 88,  "key": "D minor", "energy": 0.4, "style": "lo-fi study"},
    "joyful":    {"mood": "joyful",    "bpm": 118, "key": "G major", "energy": 0.7, "style": "indie pop"},
    "energetic": {"mood": "energetic", "bpm": 140, "key": "E minor", "energy": 0.9, "style": "electronic"},
    "sad":       {"mood": "sad",       "bpm": 55,  "key": "D minor", "energy": 0.2, "style": "cinematic"},
    "dark":      {"mood": "dark",      "bpm": 75,  "key": "C minor", "energy": 0.5, "style": "cinematic dark"},
    "nostalgic": {"mood": "nostalgic", "bpm": 80,  "key": "F major", "energy": 0.3, "style": "vintage"},
    "curious":   {"mood": "curious",   "bpm": 95,  "key": "E minor", "energy": 0.5, "style": "documentary"},
    "tense":     {"mood": "tense",     "bpm": 110, "key": "B minor", "energy": 0.7, "style": "thriller"},
    "uplifting": {"mood": "uplifting", "bpm": 95,  "key": "C major", "energy": 0.6, "style": "inspirational"},
    "neutral":   {"mood": "neutral",   "bpm": 80,  "key": "C major", "energy": 0.3, "style": "ambient"},
}


async def _generate_one(profile: dict):
    """
    generate_audio() is a real coroutine now (PR #12's batching worker) --
    it must be awaited, not called bare, and it needs a running event loop
    for its internal queue/worker task. process_audio() now returns a
    3-tuple (clip_bytes, loop_point_ms, seam_discontinuity), not 2, since
    the seam-discontinuity diagnostic was added alongside the crossfade fix.
    """
    prompt = build_prompt(profile)
    audio_bytes, seed = await generate_audio(prompt, duration_seconds=15)
    clip_bytes, loop_point_ms, seam_discontinuity = await asyncio.to_thread(
        process_audio, audio_bytes
    )
    return prompt, seed, clip_bytes, loop_point_ms, seam_discontinuity


def _upload_to_supabase(filename: str, clip_bytes: bytes):
    """
    Prod-only. Fallback clips live at a fixed path in a dedicated
    "fallback-clips" bucket -- never written through save_to_cache, since
    that keys uploads by a specific request's cache_key and would
    permanently poison that combo's cache with the generic clip.
    Imported lazily so dev runs never need Supabase env vars configured.
    """
    from d5_cache import supabase
    try:
        supabase.storage.from_("fallback-clips").upload(
            filename, clip_bytes,
            {"content-type": "audio/ogg", "x-upsert": "true"},
        )
        print(f"[UPLOAD] {filename} -> supabase fallback-clips bucket")
    except Exception as e:
        print(f"[ERROR] Supabase upload failed for {filename}: {e}")


async def generate_all_fallbacks():
    os.makedirs(FALLBACK_DIR, exist_ok=True)
    existing = os.listdir(FALLBACK_DIR)

    for mood, profile in FALLBACK_PROFILES.items():
        filename = f"{mood}.ogg"
        sidecar_filename = f"{mood}.json"
        output_path = os.path.join(FALLBACK_DIR, filename)
        sidecar_path = os.path.join(FALLBACK_DIR, sidecar_filename)

        already_local = filename in existing
        if already_local:
            print(f"[SKIP] {filename} already exists locally")

        clip_bytes = None
        try:
            if not already_local:
                print(f"\n[GENERATING] {mood} fallback clip...")
                prompt, seed, clip_bytes, loop_point_ms, seam_discontinuity = await _generate_one(profile)

                with open(output_path, "wb") as f:
                    f.write(clip_bytes)

                # Sidecar carries this clip's real metadata so the
                # /generate fallback response can report accurate
                # loop_point_ms / seam_discontinuity / prompt_used /
                # generation_seed instead of nulling them out -- they were
                # computed once, here, and don't need to be recomputed per
                # request. Read back from local disk regardless of
                # IS_PROD, since only the .ogg (not the sidecar) needs to
                # live in Supabase.
                with open(sidecar_path, "w") as f:
                    json.dump({
                        "loop_point_ms":      loop_point_ms,
                        "seam_discontinuity": seam_discontinuity,
                        "prompt_used":        prompt,
                        "generation_seed":    seed,
                    }, f, indent=2)

                print(f"[DONE] Saved {filename} (loop point: {loop_point_ms}ms, seed: {seed})")

        except GenerationError as e:
            print(f"[ERROR] Generation failed for {mood}: {e}")
            continue
        except Exception as e:
            print(f"[ERROR] Failed to generate {mood}: {e}")
            continue

        if IS_PROD:
            if clip_bytes is None:
                with open(output_path, "rb") as f:
                    clip_bytes = f.read()
            _upload_to_supabase(filename, clip_bytes)

    print(f"\nDone! Fallback clips saved to {FALLBACK_DIR}")
    print(f"Available: {os.listdir(FALLBACK_DIR)}")


if __name__ == "__main__":
    asyncio.run(generate_all_fallbacks())