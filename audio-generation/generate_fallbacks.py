"""
Run this script ONCE to pre-generate fallback clips for all 11 moods.
These are used when live generation fails.

Usage:
    python generate_fallbacks.py

Now unblocked — X2 (loop detection) is merged so clips will loop properly.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from d2_prompt import build_prompt
from d3_generate import generate_audio
from d4_process import process_audio

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

def generate_all_fallbacks():
    os.makedirs(FALLBACK_DIR, exist_ok=True)
    existing = os.listdir(FALLBACK_DIR)

    for mood, profile in FALLBACK_PROFILES.items():
        filename = f"{mood}.mp3"
        output_path = os.path.join(FALLBACK_DIR, filename)

        if filename in existing:
            print(f"[SKIP] {filename} already exists")
            continue

        print(f"\n[GENERATING] {mood} fallback clip...")
        try:
            prompt = build_prompt(profile)
            audio_bytes, seed = generate_audio(prompt, duration_seconds=15)
            mp3_bytes, loop_point_ms = process_audio(audio_bytes)

            with open(output_path, "wb") as f:
                f.write(mp3_bytes)

            print(f"[DONE] Saved {filename} (loop point: {loop_point_ms}ms, seed: {seed})")

        except Exception as e:
            print(f"[ERROR] Failed to generate {mood}: {e}")

    print(f"\nDone! Fallback clips saved to {FALLBACK_DIR}")
    print(f"Available: {os.listdir(FALLBACK_DIR)}")

if __name__ == "__main__":
    generate_all_fallbacks()