import hashlib, json, os
from supabase import create_client
from dotenv import load_dotenv
from d4_process import EXPORT_CODEC
load_dotenv()

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))

def make_cache_key(profile: dict) -> str:
    bpm = profile["bpm"]
    duration = profile.get("duration_seconds", 28)
    canonical = {
        "mood":            profile["mood"],
        "bpm_bucket":      "low" if bpm < 76 else "mid" if bpm < 101 else "high",
        "energy_tier":     round(float(profile["energy"]), 1),
        "style":           profile["style"],
        "key":             profile["key"],
        "valence_tier":    round(float(profile.get("valence", 0.0)), 1),
        "duration_bucket": (duration // 2) * 2,  # 2s tolerance: 28,29→28  30,31→30
        # Versions the key by export codec so a switch (e.g. the MP3 -> Ogg/
        # Opus gapless-export change) naturally invalidates old entries
        # instead of silently serving the stale-format audio forever under
        # an identical key -- there's no TTL/eviction in the schema, so
        # without this, already-cached combos (prewarm.py's common grid
        # especially) would never regenerate on their own.
        "codec":           EXPORT_CODEC,
        # Note: seed is intentionally excluded from the cache key.
        # Including it would mean each retry attempt (seed 43, 44, 45)
        # generates a separate cache entry, defeating the purpose of caching.
    }
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True).encode()
    ).hexdigest()

def check_cache(cache_key: str):
    result = supabase.table("audio_cache").select("*").eq("cache_key", cache_key).execute()
    if result.data:
        return result.data[0]
    return None

def save_to_cache(cache_key, clip_bytes, profile, loop_point_ms, generation_time_ms, prompt_used):
    filename = f"{cache_key}.ogg"
    supabase.storage.from_("audio-cache").upload(
        filename, clip_bytes, {"content-type": "audio/ogg"}
    )
    audio_url = supabase.storage.from_("audio-cache").get_public_url(filename)

    supabase.table("audio_cache").insert({
        "cache_key":          cache_key,
        "audio_url":          audio_url,
        "mood":               profile["mood"],
        "bpm":                profile["bpm"],
        "key":                profile["key"],
        "energy":             profile["energy"],
        "style":              profile["style"],
        "loop_point_ms":      loop_point_ms,
        "generation_time_ms": generation_time_ms,
        "prompt_used":        prompt_used,
    }).execute()

    return audio_url