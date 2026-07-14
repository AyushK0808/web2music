import hashlib, json, os
from supabase import create_client
from dotenv import load_dotenv
load_dotenv()

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))

def make_cache_key(profile: dict) -> str:
    bpm = profile["bpm"]
    canonical = {
        "mood":        profile["mood"],
        "bpm_bucket":  "low" if bpm < 76 else "mid" if bpm < 101 else "high",
        "energy_tier": round(float(profile["energy"]), 1),
        "style":       profile["style"],
        "key":         profile["key"],  # ← added
    }
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True).encode()
    ).hexdigest()

def check_cache(cache_key: str):
    result = supabase.table("audio_cache").select("*").eq("cache_key", cache_key).execute()
    if result.data:
        return result.data[0]
    return None

def save_to_cache(cache_key, mp3_bytes, profile, loop_point_ms, generation_time_ms, prompt_used):
    filename = f"{cache_key}.mp3"
    supabase.storage.from_("audio-cache").upload(
        filename, mp3_bytes, {"content-type": "audio/mpeg"}
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