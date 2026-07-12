import os
import random

# Maps each mood to the best matching fallback clip filename
# Falls back to neutral.mp3 if nothing matches
MOOD_TO_FALLBACK = {
    "calm":      "calm.mp3",
    "focused":   "focused.mp3",
    "joyful":    "joyful.mp3",
    "energetic": "energetic.mp3",
    "sad":       "sad.mp3",
    "dark":      "dark.mp3",
    "nostalgic": "nostalgic.mp3",
    "curious":   "curious.mp3",
    "tense":     "tense.mp3",
    "uplifting": "uplifting.mp3",
    "neutral":   "neutral.mp3",
}

# If a specific mood clip doesn't exist, fall back to these in order
FALLBACK_CHAIN = ["neutral.mp3", "calm.mp3", "focused.mp3"]

FALLBACK_DIR = os.path.join(os.path.dirname(__file__), "fallback_clips")


def get_fallback_clip(mood: str) -> bytes | None:
    """
    Returns bytes of the best matching fallback clip for the given mood.
    Returns None if no fallback clips exist at all.
    """
    # Try mood-specific clip first
    preferred = MOOD_TO_FALLBACK.get(mood, "neutral.mp3")
    candidates = [preferred] + FALLBACK_CHAIN

    for filename in candidates:
        path = os.path.join(FALLBACK_DIR, filename)
        if os.path.exists(path):
            print(f"[FALLBACK] Using fallback clip: {filename} for mood: {mood}")
            with open(path, "rb") as f:
                return f.read()

    print("[FALLBACK] No fallback clips found in fallback_clips/ folder!")
    return None


def list_fallback_clips() -> list[str]:
    """Returns list of available fallback clip filenames."""
    if not os.path.exists(FALLBACK_DIR):
        return []
    return [f for f in os.listdir(FALLBACK_DIR) if f.endswith(".mp3")]