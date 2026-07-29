from models import HandoffPayload, MusicProfile

def validate_profile(payload: HandoffPayload) -> tuple:
    """
    Unwraps Sneha's Handoff 2 structure or flat dict.
    Returns (profile dict, prompt_from_b string or None)
    """
    prompt_from_b = payload.prompt

    if payload.profile is not None:
        # B's dedicated flat, snake_case profile (fix-17) -- preferred over
        # musicProfile below, which is nested camelCase and was never
        # actually shaped for D (its atmosphereTags/listeningContext/
        # timeOfDay/sensitiveOverride keys don't match MusicProfile's
        # snake_case field names, so reading it silently defaults all four).
        p = payload.profile
        profile = MusicProfile(
            mood=              p.get("mood")              or "calm",
            bpm=               int(float(p["bpm"]))        if p.get("bpm") is not None else 80,
            key=               p.get("key")               or "C major",
            energy=            p.get("energy")            if p.get("energy") is not None else 0.5,
            style=             p.get("style")              or "ambient",
            content_category=  p.get("content_category")  or "general",
            valence=           p.get("valence")           if p.get("valence") is not None else 0.0,
            # B's profile sends "arousal" on the continuous V-A axis; X1 gave
            # MusicProfile a first-class arousal field, so it maps straight
            # across rather than being folded into intensity. intensity stays
            # its own axis and defaults independently when B omits it.
            arousal=           p.get("arousal")            if p.get("arousal") is not None else 0.5,
            intensity=         p.get("intensity")          if p.get("intensity") is not None else 0.5,
            reverb=            p.get("reverb")             if p.get("reverb") is not None else 0.5,
            ambience=          p.get("ambience")           if p.get("ambience") is not None else 0.5,
            timbre=            p.get("timbre")             or "warm",
            instruments=       p.get("instruments")        or [],
            dynamics=          p.get("dynamics")           or "steady",
            atmosphere_tags=   p.get("atmosphere_tags")    or "",
            listening_context= p.get("listening_context")  or "",
            time_of_day=       p.get("time_of_day")        or "day",
            sensitive_override=p.get("sensitive_override") or False,
            duration_seconds=  p.get("duration_seconds")   if p.get("duration_seconds") is not None else 28,
        ).model_dump()
    elif payload.musicProfile is not None:
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
            arousal=           payload.arousal          if payload.arousal   is not None else 0.5,
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
            duration_seconds=  payload.duration_seconds if payload.duration_seconds is not None else 28,
        ).model_dump()

    return profile, prompt_from_b