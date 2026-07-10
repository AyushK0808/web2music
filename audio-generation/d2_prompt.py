def build_prompt(profile: dict) -> str:
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
        "calm": "soft piano and ambient pads",
        "tense": "strings and low drones",
        "energetic": "synth and light percussion",
        "melancholic": "piano and cello",
        "positive": "acoustic guitar and light keys",
        "neutral": "ambient synth pads"
    }.get(mood, "ambient pads")

    prompt = (
        f"{mood} {style} music, {bpm} bpm, {key}, "
        f"{energy_word}, {instruments}, "
        f"no vocals, loopable, suitable for background listening, "
        f"high quality, atmospheric"
    )
    return prompt