-- Mirrors the `audio_cache` table Feature D expects to exist in Supabase
-- (see README.md "Prerequisites"), so d5_cache.py and d5_cache_local.py can
-- share the same query shape.
--
-- IMPORTANT: Postgres only runs /docker-entrypoint-initdb.d scripts when the
-- data directory is EMPTY. A dev whose db-data volume was created before a
-- column was added here never gets that column -- editing this file does
-- nothing to an existing volume. That is exactly how the live dev DB ended up
-- stuck on the original 12-column table while d5_cache_local.py had grown to
-- INSERT 17: every cache write failed with `column "valence" of relation
-- "audio_cache" does not exist`, so /generate degraded to a fallback clip on
-- every single request and the cache could never warm.
--
-- Hence the ALTER ... ADD COLUMN IF NOT EXISTS block below: this file is
-- idempotent, so it is also a migration, and can be re-applied to an existing
-- database by hand:
--
--     docker exec -i web2music-db psql -U postgres -d audio_cache < docker/init.sql
--
-- d5_cache_local.ensure_schema() applies the same statements automatically on
-- Feature D startup, which is what keeps a stale volume from silently
-- reintroducing this bug. Keep the two in sync -- tests/test_schema_sync.py
-- fails the build if they drift.
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

-- Every nullable column, not just the ones added most recently -- an older
-- volume can be missing any of them, and ADD COLUMN IF NOT EXISTS on a column
-- that already exists is a no-op.
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS mood TEXT;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS bpm INTEGER;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS key TEXT;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS energy REAL;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS style TEXT;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS valence REAL;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS arousal REAL;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS intensity REAL;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS loop_point_ms INTEGER;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS seam_discontinuity JSONB;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS generation_time_ms INTEGER;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS prompt_used TEXT;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS prompt_source TEXT;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS generation_seed INTEGER;
ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
