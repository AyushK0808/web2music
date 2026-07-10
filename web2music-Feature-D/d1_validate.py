def validate_profile(profile: dict) -> dict:
    defaults = {
        "mood": "calm",
        "energy": 0.5,
        "bpm": 80,
        "key": "C major",
        "style": "ambient",
        "content_category": "general"
    }
    for field, default in defaults.items():
        if field not in profile:
            profile[field] = default
    
    profile["bpm"] = int(profile["bpm"])
    profile["energy"] = float(profile["energy"])
    profile["energy"] = max(0.0, min(1.0, profile["energy"]))
    return profile