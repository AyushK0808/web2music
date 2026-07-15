from models import HandoffPayload, MusicProfile

def validate_profile(payload: HandoffPayload) -> tuple:
    """
    Unwraps Sneha's Handoff 2 structure or flat dict.
    Returns (profile dict, prompt_from_b string or None)
    """
    prompt_from_b = payload.prompt

    if payload.musicProfile is not None:
        # Sneha's nested shape — already validated by Pydantic
        profile = payload.musicProfile.model_dump()
    else:
        # Flat dict shape — build MusicProfile from top-level fields
        profile = MusicProfile(
            mood=              payload.mood              or "calm",
            bpm=               int(float(payload.bpm))  if payload.bpm is not None else 80,
            key=               payload.key              or "C major",
            energy=            payload.energy           if payload.energy    is not None else 0.5,
            style=             payload.style            or "ambient",
            content_category=  payload.content_category or "general",
            valence=           payload.valence          if payload.valence   is not None else 0.0,
            intensity=         payload.intensity        if payload.intensity is not None else 0.5,
            reverb=            payload.reverb           if payload.reverb    is not None else 0.5,
            ambience=          payload.ambience         if payload.ambience  is not None else 0.5,
            timbre=            payload.timbre           or "warm",
            instruments=       payload.instruments      or [],
            dynamics=          payload.dynamics         or "steady",
            atmosphere_tags=   payload.atmosphere_tags  or "",
            listening_context= payload.listening_context or "",
            time_of_day=       payload.time_of_day      or "day",
            sensitive_override=payload.sensitive_override or False,
        ).model_dump()

    return profile, prompt_from_b