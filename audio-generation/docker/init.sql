-- Mirrors the `audio_cache` table Feature D expects to exist in Supabase
-- (see README.md "Prerequisites"), so d5_cache.py and d5_cache_local.py can
-- share the same query shape.
CREATE TABLE IF NOT EXISTS audio_cache (
    id SERIAL PRIMARY KEY,
    cache_key TEXT UNIQUE NOT NULL,
    audio_url TEXT NOT NULL,
    mood TEXT,
    bpm INTEGER,
    key TEXT,
    energy REAL,
    style TEXT,
    valence REAL,
    arousal REAL,
    intensity REAL,
    duration_seconds INTEGER,
    loop_point_ms INTEGER,
    seam_discontinuity JSONB,
    generation_time_ms INTEGER,
    prompt_used TEXT,
    prompt_source TEXT,
    generation_seed INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
);
