import os
import json

# Maps each mood to the best matching fallback clip filename.
# Falls back to neutral.ogg if nothing matches.
#
# .ogg, not .mp3 -- D4 switched export to Ogg/Opus (see d4_process.py's
# EXPORT_FORMAT/EXPORT_CODEC) for genuinely gapless looping, and fallback
# clips are produced by the same process_audio() pipeline, so they come out
# in the same container format. Anything still named *.mp3 here is a
# leftover from before that switch and won't exist on disk.
MOOD_TO_FALLBACK = {
    "calm":      "calm.ogg",
    "focused":   "focused.ogg",
    "joyful":    "joyful.ogg",
    "energetic": "energetic.ogg",
    "sad":       "sad.ogg",
    "dark":      "dark.ogg",
    "nostalgic": "nostalgic.ogg",
    "curious":   "curious.ogg",
    "tense":     "tense.ogg",
    "uplifting": "uplifting.ogg",
    "neutral":   "neutral.ogg",
}

# If a specific mood clip doesn't exist, fall back to these in order.
FALLBACK_CHAIN = ["neutral.ogg", "calm.ogg", "focused.ogg"]

FALLBACK_DIR = os.path.join(os.path.dirname(__file__), "fallback_clips")
# main.py mounts this dir with StaticFiles in dev -- that mount call raises
# at startup if the directory doesn't exist yet, which it won't on a fresh
# checkout before generate_fallbacks.py has ever been run. Create it eagerly
# (same pattern as d5_cache_local.py's AUDIO_CACHE_DIR) so app startup never
# depends on ordering.
os.makedirs(FALLBACK_DIR, exist_ok=True)


def get_fallback_clip(mood: str):
    """
    Returns (clip_bytes, metadata, filename) for the best matching fallback
    clip, or None if no fallback clips exist at all.

    `metadata` is read from that clip's JSON sidecar (written once by
    generate_fallbacks.py at generation time) and contains whatever D3/D4
    actually produced for that clip: loop_point_ms, seam_discontinuity,
    prompt_used, generation_seed. Returned as {} if the sidecar is missing
    (e.g. an old clip generated before this existed) rather than failing
    the whole fallback path over missing metadata.
    """
    preferred = MOOD_TO_FALLBACK.get(mood, "neutral.ogg")

    # De-dupe while preserving order -- if `preferred` is already
    # "neutral.ogg" (unknown mood), don't check it twice.
    candidates = []
    for filename in [preferred] + FALLBACK_CHAIN:
        if filename not in candidates:
            candidates.append(filename)

    for filename in candidates:
        path = os.path.join(FALLBACK_DIR, filename)
        if os.path.exists(path):
            print(f"[FALLBACK] Using fallback clip: {filename} for mood: {mood}")
            with open(path, "rb") as f:
                clip_bytes = f.read()
            metadata = _load_sidecar(filename)
            return clip_bytes, metadata, filename

    print("[FALLBACK] No fallback clips found in fallback_clips/ folder!")
    return None


def _load_sidecar(filename: str) -> dict:
    """Reads the <mood>.json sidecar next to <mood>.ogg, if present."""
    sidecar_path = os.path.join(FALLBACK_DIR, os.path.splitext(filename)[0] + ".json")
    if os.path.exists(sidecar_path):
        try:
            with open(sidecar_path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[FALLBACK] Failed to read sidecar {sidecar_path}: {e}")
    return {}


def list_fallback_clips() -> list[str]:
    """Returns list of available fallback clip filenames (.ogg only, sidecars excluded)."""
    if not os.path.exists(FALLBACK_DIR):
        return []
    return [f for f in os.listdir(FALLBACK_DIR) if f.endswith(".ogg")]