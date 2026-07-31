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
        "arousal_tier":    round(float(profile.get("arousal", 0.5)), 1),
        # Pairs consecutive durations into fixed {even, even+1} buckets --
        # 28 & 29 -> 28, 30 & 31 -> 30. Deterministic, but NOT a sliding
        # 2s-tolerance window (e.g. 27 & 28 land in different buckets even
        # though they're 1s apart). Flagging here rather than "fixing"
        # silently since changing this reshuffles which existing cache
        # entries collide -- confirm the desired bucketing before changing.
        "duration_bucket": (duration // 2) * 2,
        "codec":           EXPORT_CODEC,
        # seed intentionally excluded -- see save_to_cache note below.
    }
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True).encode()
    ).hexdigest()

def check_cache(cache_key: str):
    result = supabase.table("audio_cache").select("*").eq("cache_key", cache_key).execute()
    if result.data:
        return result.data[0]
    return None

def save_to_cache(cache_key, clip_bytes, profile, loop_point_ms, generation_time_ms,
                   prompt_used, seam_discontinuity, prompt_source, generation_seed):
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
        "valence":            profile.get("valence"),
        "arousal":            profile.get("arousal"),
        "intensity":          profile.get("intensity"),
        "duration_seconds":   profile.get("duration_seconds"),
        "loop_point_ms":      loop_point_ms,
        "seam_discontinuity": seam_discontinuity,
        "generation_time_ms": generation_time_ms,
        "prompt_used":        prompt_used,
        "prompt_source":      prompt_source,
        "generation_seed":    generation_seed,
    }).execute()

    return audio_url