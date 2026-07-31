"""
Run this script ONCE to pre-generate fallback clips for all 11 moods.
These are used when live generation fails.

Usage:
    python generate_fallbacks.py

In prod (IS_PROD=true), also uploads each clip to the Supabase "fallback-clips"
storage bucket and upserts its metadata into the "fallback_clips" table, so
both main.py's public-URL lookup and fallback_prod.py's table read resolve
to something real.
The bucket and table must already exist (create the bucket in the Supabase
dashboard with public read; create the table via the SQL editor).

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


def _upload_to_supabase(mood: str, filename: str, clip_bytes: bytes,
                         prompt, seed, loop_point_ms, seam_discontinuity):
    """
    Prod-only. Uploads the audio object to the fallback-clips bucket AND
    upserts the matching metadata row into the fallback_clips table --
    fallback_prod.py's get_fallback_clip() reads audio_url + metadata from
    that table, not from the bucket or a local sidecar, so both writes are
    required for prod fallback to actually work.
    Imported lazily so dev runs never need Supabase env vars configured.
    """
    from d5_cache import supabase
    try:
        supabase.storage.from_("fallback-clips").upload(
            filename, clip_bytes,
            {"content-type": "audio/ogg", "x-upsert": "true"},
        )
        audio_url = supabase.storage.from_("fallback-clips").get_public_url(filename)
        supabase.table("fallback_clips").upsert({
            "mood":               mood,
            "audio_url":          audio_url,
            "loop_point_ms":      loop_point_ms,
            "seam_discontinuity": seam_discontinuity,
            "prompt_used":        prompt,
            "generation_seed":    seed,
        }).execute()
        print(f"[UPLOAD] {filename} -> bucket + fallback_clips row")
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
        prompt = seed = loop_point_ms = seam_discontinuity = None

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
                # live in Supabase storage -- the table gets its own copy
                # of this same metadata below.
                with open(sidecar_path, "w") as f:
                    json.dump({
                        "loop_point_ms":      loop_point_ms,
                        "seam_discontinuity": seam_discontinuity,
                        "prompt_used":        prompt,
                        "generation_seed":    seed,
                    }, f, indent=2)

                print(f"[DONE] Saved {filename} (loop point: {loop_point_ms}ms, seed: {seed})")

            elif os.path.exists(sidecar_path):
                # Clip already exists locally from a prior run, so
                # _generate_one() never ran this time -- reuse its sidecar
                # so a re-run (e.g. IS_PROD=true after clips were already
                # generated in dev) can still upsert accurate metadata to
                # the table instead of uploading with everything null.
                with open(sidecar_path) as f:
                    sidecar = json.load(f)
                prompt             = sidecar.get("prompt_used")
                seed               = sidecar.get("generation_seed")
                loop_point_ms      = sidecar.get("loop_point_ms")
                seam_discontinuity = sidecar.get("seam_discontinuity")
            else:
                print(f"[WARN] {filename} exists but has no sidecar -- "
                      f"table row will have null metadata for {mood}")

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
            _upload_to_supabase(mood, filename, clip_bytes, prompt, seed, loop_point_ms, seam_discontinuity)

    print(f"\nDone! Fallback clips saved to {FALLBACK_DIR}")
    print(f"Available: {os.listdir(FALLBACK_DIR)}")


if __name__ == "__main__":
    asyncio.run(generate_all_fallbacks())