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
        # Coarse 3-way bucket is intentional, not an oversight: bpm is
        # already baked into the generated prompt text (see d2_prompt.py),
        # so two requests in the same bucket still produce different audio
        # the first time each is generated -- this bucket only controls
        # whether a LATER request with a nearby bpm reuses that cached clip
        # instead of regenerating. MusicGen doesn't hit an exact target bpm
        # deterministically anyway, so collapsing e.g. 77 vs 99 into one
        # bucket trades a small amount of perceptual precision for a real
        # reduction in generation cost. Revisit with real hit-rate data
        # before narrowing this.
        "bpm_bucket":      "low" if bpm < 76 else "mid" if bpm < 101 else "high",
        "energy_tier":     round(float(profile["energy"]), 1),
        "style":           profile["style"],
        "key":             profile["key"],
        "valence_tier":    round(float(profile.get("valence", 0.0)), 1),
        "arousal_tier":    round(float(profile.get("arousal", 0.5)), 1),
        # Symmetric 2s-tolerance bucket: 27 & 28 -> 28, 29 & 30 -> 30, etc.
        # Replaces the previous floor-based (duration // 2) * 2 bucketing,
        # which was asymmetric (28 & 29 grouped together, but 27 & 28 --
        # only 1s apart -- were not) despite the old comment claiming a "2s
        # tolerance." This reshuffles which existing cache entries collide
        # with each other going forward -- old cached rows aren't
        # invalidated, they just may stop matching new requests that used
        # to land in their bucket.
        "duration_bucket": round(duration / 2) * 2,
        "codec":           EXPORT_CODEC,
        # Note: seed is intentionally excluded from the cache key.
        # # Including it would mean each retry attempt (seed 43, 44, 45)
        # # generates a separate cache entry, defeating the purpose of caching.
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
    # x-upsert lets a retry overwrite a prior partial/orphaned upload
    # instead of 409ing -- without this, any combo whose earlier attempt
    # uploaded the audio file but failed before the DB insert completed
    # (e.g. a transient network error mid-save) gets permanently stuck:
    # every retry re-uploads the same filename and 409s forever, even
    # though the actual audio + metadata were never fully saved.
    supabase.storage.from_("audio-cache").upload(
        filename, clip_bytes, {"content-type": "audio/ogg", "x-upsert": "true"}
    )
    audio_url = supabase.storage.from_("audio-cache").get_public_url(filename)
    supabase.table("audio_cache").upsert({
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