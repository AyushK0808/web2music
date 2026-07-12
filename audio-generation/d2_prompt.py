def build_prompt(profile: dict, prompt_from_b: str = None) -> str:
    # Prefer Sneha's B4 engineered prompt — it's richer
    if prompt_from_b and len(prompt_from_b) > 20:
        return prompt_from_b

    # Fallback: build our own if B didn't send one (e.g. direct Swagger testing)
    mood = profile["mood"]
    bpm = profile["bpm"]
    key = profile["key"]
    energy = profile["energy"]
    style = profile["style"]

    if energy < 0.3:
        energy_word = "very low energy, minimal"
    elif energy < 0.6:
        energy_word = "moderate energy, flowing"
    else:
        energy_word = "high energy, dynamic"

    instruments = {
        "calm":      "soft piano and ambient pads",
        "focused":   "piano and minimalist synth",
        "joyful":    "acoustic guitar and bright keys",
        "energetic": "synth and driving percussion",
        "sad":       "solo piano and cello",
        "dark":      "orchestral strings and bass drones",
        "nostalgic": "vintage piano and light strings",
        "curious":   "marimba and electronic bells",
        "tense":     "strings tremolo and pulse synth",
        "uplifting": "piano and gentle synth pads",
        "neutral":   "ambient synth pads",
    }.get(mood, "ambient pads")

    return (
        f"{mood} {style} music, {bpm} bpm, {key}, "
        f"{energy_word}, {instruments}, "
        f"no vocals, loopable, suitable for background listening, "
        f"high quality, atmospheric"
    )