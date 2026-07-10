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
    loop_point_ms INTEGER,
    generation_time_ms INTEGER,
    prompt_used TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
