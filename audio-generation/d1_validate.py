def validate_profile(payload: dict) -> tuple:
    # Unwrap Sneha's Handoff 2 structure
    if "musicProfile" in payload:
        profile = payload["musicProfile"]
        prompt_from_b = payload.get("prompt", None)
    else:
        profile = payload
        prompt_from_b = None

    defaults = {
        "mood":               "calm",
        "energy":             0.5,
        "bpm":                80,
        "key":                "C major",
        "style":              "ambient",
        "content_category":   "general",
        "valence":            0.0,
        "intensity":          0.5,
        "reverb":             0.5,
        "ambience":           0.5,
        "timbre":             "warm",
        "instruments":        [],
        "dynamics":           "steady",
        "atmosphere_tags":    "",
        "listening_context":  "",
        "time_of_day":        "day",
        "sensitive_override": False,
    }

    for field, default in defaults.items():
        if field not in profile:
            profile[field] = default

    profile["bpm"]       = int(float(profile["bpm"]))
    profile["energy"]    = max(0.0, min(1.0, float(profile["energy"])))
    profile["valence"]   = max(-1.0, min(1.0, float(profile["valence"])))
    profile["intensity"] = max(0.0, min(1.0, float(profile["intensity"])))
    profile["reverb"]    = max(0.0, min(1.0, float(profile["reverb"])))
    profile["ambience"]  = max(0.0, min(1.0, float(profile["ambience"])))

    valid_moods = {
        "calm", "focused", "joyful", "energetic", "sad",
        "dark", "nostalgic", "curious", "tense", "uplifting", "neutral"
    }
    if profile["mood"] not in valid_moods:
        print(f"[D1] Unknown mood '{profile['mood']}' — falling back to 'neutral'")
        profile["mood"] = "neutral"

    return profile, prompt_from_b