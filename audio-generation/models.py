from pydantic import BaseModel, Field, field_validator, ConfigDict
from typing import Optional

class MusicProfile(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    # Core fields
    mood:              str   = Field(default="calm",    description="Emotional tone of the music")
    bpm:               int   = Field(default=80,        description="Beats per minute", ge=20, le=200)
    key:               str   = Field(default="C major", description="Musical key e.g. C major, D minor")
    energy:            float = Field(default=0.5,       description="Energy level 0.0-1.0", ge=0.0, le=1.0)
    style:             str   = Field(default="ambient", description="Music style e.g. ambient, lo-fi, cinematic")
    content_category:  str   = Field(default="general", description="Webpage content category")

    # Extended fields from Sneha's Handoff 2
    valence:           float = Field(default=0.0,  description="Valence -1.0 to 1.0", ge=-1.0, le=1.0)
    arousal:           float = Field(default=0.5,  description="Arousal 0.0-1.0 (continuous V-A axis)", ge=0.0, le=1.0)
    intensity:         float = Field(default=0.5,  description="Intensity 0.0-1.0", ge=0.0, le=1.0)
    reverb:            float = Field(default=0.5,  description="Reverb amount 0.0-1.0", ge=0.0, le=1.0)
    ambience:          float = Field(default=0.5,  description="Ambience amount 0.0-1.0", ge=0.0, le=1.0)
    timbre:            str   = Field(default="warm",   description="Tonal quality e.g. warm, bright, dark")
    instruments:       list  = Field(default=[],       description="List of instruments")
    dynamics:          str   = Field(default="steady", description="Dynamic description")
    atmosphere_tags:   str   = Field(default="",       description="Atmosphere descriptors")
    listening_context: str   = Field(default="",       description="Context e.g. mid-morning study session")
    time_of_day:       str   = Field(default="day",    description="Time of day")
    sensitive_override: bool = Field(default=False,    description="True if sensitive content detected")

    # Duration parameter
    duration_seconds:  int   = Field(
        default=28,
        description="Target clip duration in seconds. Max 30 for musicgen-small.",
        ge=5,
        le=30
    )

    @field_validator("mood")
    @classmethod
    def validate_mood(cls, v):
        valid_moods = {
            "calm", "focused", "joyful", "energetic", "sad",
            "dark", "nostalgic", "curious", "tense", "uplifting", "neutral"
        }
        if v not in valid_moods:
            print(f"[D1] Unknown mood '{v}' — falling back to neutral")
            return "neutral"
        return v

    @field_validator("bpm", mode="before")
    @classmethod
    def coerce_bpm(cls, v):
        return int(float(v))


class HandoffPayload(BaseModel):
    """
    Accepts both:
    1. Sneha's Handoff 2 shape: { "musicProfile": {...}, "prompt": "..." }
    2. Flat dict for direct Swagger testing: { "mood": "calm", "bpm": 80, ... }
    """
    model_config = ConfigDict(populate_by_name=True)

    # Sneha's fix-17: B's dedicated flat, snake_case profile built
    # specifically for Feature D (see b4_promptEngineer.js's
    # toFeatureDProfile) -- this, not musicProfile, is what B intends D to
    # read. Kept as a raw dict rather than typed as MusicProfile so
    # validate_profile() can field-by-field default anything B omits.
    profile:      Optional[dict]         = None
    musicProfile: Optional[MusicProfile] = None
    prompt:       Optional[str]          = None

    # Flat dict fields — used when musicProfile is not present
    # Also accepts top-level arousal from B's real traffic
    mood:              Optional[str]   = None
    bpm:               Optional[float] = None
    key:               Optional[str]   = None
    energy:            Optional[float] = None
    style:             Optional[str]   = None
    content_category:  Optional[str]   = None
    valence:           Optional[float] = None
    arousal:           Optional[float] = None
    intensity:         Optional[float] = None
    reverb:            Optional[float] = None
    ambience:          Optional[float] = None
    timbre:            Optional[str]   = None
    instruments:       Optional[list]  = None
    dynamics:          Optional[str]   = None
    atmosphere_tags:   Optional[str]   = None
    listening_context: Optional[str]   = None
    time_of_day:       Optional[str]   = None
    sensitive_override: Optional[bool] = None
    duration_seconds:  Optional[int]   = None