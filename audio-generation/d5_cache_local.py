import hashlib, json, os
import psycopg2
import psycopg2.extras
import psycopg2.pool
from contextlib import contextmanager
from dotenv import load_dotenv
from d4_process import EXPORT_CODEC
load_dotenv()

AUDIO_CACHE_DIR = os.path.join(os.path.dirname(__file__), "audio-cache")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

LOCAL_DB_URL = os.getenv("LOCAL_DB_URL", "postgresql://postgres:postgres@localhost:5432/audio_cache")
LOCAL_SERVER_URL = os.getenv("LOCAL_SERVER_URL", "http://127.0.0.1:8000")

def _connect():
    return psycopg2.connect(LOCAL_DB_URL)

# check_cache/save_to_cache each opened a brand-new psycopg2.connect() and
# closed it immediately after a single query -- this is item 5.2, the
# unexplained ~2s p50 on every cache-hit response (Table III). A fresh TCP
# connection plus Postgres's own auth handshake is the standard cause of
# exactly this symptom: cache_key has a UNIQUE constraint, which Postgres
# auto-indexes, so the SELECT itself was never the bottleneck. On plain
# localhost loopback a fresh connect() only costs ~10ms (verified locally),
# nowhere near 2082ms -- the gap is almost certainly Docker Desktop's
# container-to-container networking overhead on the Windows/WSL2 host this
# was measured on (documented to add significant per-connection latency),
# which this fix sidesteps entirely by paying that cost once at pool
# creation rather than on every request, regardless of its exact size on any
# given host. ThreadedConnectionPool specifically because check_cache and
# save_to_cache run via asyncio.to_thread (main.py), so concurrent requests
# can call in from different threads at once; a single shared connection
# would not be safe there.
_pool = None

def _get_pool():
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(minconn=1, maxconn=10, dsn=LOCAL_DB_URL)
    return _pool

@contextmanager
def _pooled_connection():
    pool = _get_pool()
    conn = pool.getconn()
    try:
        yield conn
    finally:
        # Always returned, even on error -- a leaked connection would
        # eventually exhaust maxconn and turn every request into a cache
        # miss the same way the original schema-drift bug did (see
        # ensure_schema's docstring), just later and harder to notice.
        pool.putconn(conn)

# Every nullable column save_to_cache() writes, as (name, type). Kept in the
# same order as ../docker/init.sql's CREATE TABLE; tests/test_schema_sync.py
# fails if the two drift apart or if save_to_cache's INSERT names a column
# that isn't here.
SCHEMA_COLUMNS = [
    ("mood",               "TEXT"),
    ("bpm",                "INTEGER"),
    ("key",                "TEXT"),
    ("energy",             "REAL"),
    ("style",              "TEXT"),
    ("valence",            "REAL"),
    ("arousal",            "REAL"),
    ("intensity",          "REAL"),
    ("duration_seconds",   "INTEGER"),
    ("loop_point_ms",      "INTEGER"),
    ("seam_discontinuity", "JSONB"),
    ("generation_time_ms", "INTEGER"),
    ("prompt_used",        "TEXT"),
    ("prompt_source",      "TEXT"),
    ("generation_seed",    "INTEGER"),
    ("created_at",         "TIMESTAMPTZ DEFAULT now()"),
]


def ensure_schema():
    """
    Bring the local dev database up to the schema this module INSERTs into,
    creating the table if it's absent and adding any columns a stale volume
    is missing.

    This exists because ../docker/init.sql is NOT a migration path: Postgres
    runs /docker-entrypoint-initdb.d scripts only when the data directory is
    empty, so a db-data volume created before a column was added never gains
    it no matter how many times the stack is restarted. That is precisely what
    broke caching -- the live volume was initialised from a 12-column init.sql
    while save_to_cache() had grown to INSERT 17, so every write died on
    `column "valence" of relation "audio_cache" does not exist`, main.py
    caught it, and /generate returned a fallback clip every single time. The
    cache could never warm, so it happened on every request forever.

    Dev-only by construction: it lives in d5_cache_local (the psycopg2/local
    backend), never in d5_cache (the Supabase/prod backend), where schema
    changes belong in a reviewed migration rather than in application startup.
    """
    statements = ["""
        CREATE TABLE IF NOT EXISTS audio_cache (
            id SERIAL PRIMARY KEY,
            cache_key TEXT UNIQUE NOT NULL,
            audio_url TEXT NOT NULL
        )
    """]
    statements += [
        f"ALTER TABLE audio_cache ADD COLUMN IF NOT EXISTS {name} {type_}"
        for name, type_ in SCHEMA_COLUMNS
    ]

    conn = _connect()
    try:
        with conn.cursor() as cur:
            before = _column_names(cur)
            for statement in statements:
                cur.execute(statement)
            after = _column_names(cur)
        conn.commit()
    finally:
        conn.close()

    added = [c for c in after if c not in before]
    if not before:
        print(f"[D5] ensure_schema: created audio_cache ({len(after)} columns)")
    elif added:
        # Worth shouting about: this is the repair for a stale volume, and
        # seeing it on every boot would mean the commit isn't sticking.
        print(f"[D5] ensure_schema: added {len(added)} missing column(s) to audio_cache: {', '.join(added)}")
    else:
        print(f"[D5] ensure_schema: audio_cache up to date ({len(after)} columns)")


def _column_names(cur):
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = 'audio_cache' "
        "ORDER BY ordinal_position"
    )
    return [row[0] for row in cur.fetchall()]

def make_cache_key(profile: dict) -> str:
    bpm = profile["bpm"]
    duration = profile.get("duration_seconds", 28)
    canonical = {
        "mood":            profile["mood"],
        # Coarse 3-way bucket is intentional, not an oversight: bpm is
        # already baked into the generated prompt text (see d2_prompt.py),
        # so two requests in the same bucket still produce different audio
        # the first time each is generated -- this bucket only controls
        # whether a LATER request with a nearby bpm reuses that cached clip
        # instead of regenerating. MusicGen doesn't hit an exact target bpm
        # deterministically anyway, so collapsing e.g. 77 vs 99 into one
        # bucket trades a small amount of perceptual precision for a real
        # reduction in generation cost. Revisit with real hit-rate data
        # before narrowing this.
        "bpm_bucket":      "low" if bpm < 76 else "mid" if bpm < 101 else "high",
        "energy_tier":     round(float(profile["energy"]), 1),
        "style":           profile["style"],
        "key":             profile["key"],
        "valence_tier":    round(float(profile.get("valence", 0.0)), 1),
        "arousal_tier":    round(float(profile.get("arousal", 0.5)), 1),
        # round() uses banker's rounding (rounds .5 to nearest even), which
        # broke the symmetric-pairing intent -- 27/28/29 all landed in one
        # bucket while 30 sat alone. (duration + 1) // 2 * 2 is round-half-up,
        # giving the actual symmetric pairing: 27&28 -> 28, 29&30 -> 30.
        "duration_bucket": (duration + 1) // 2 * 2,
        "codec":           EXPORT_CODEC,
    }
    # nonce: client-supplied cache-buster for the popup's "regenerate" control
    # (X4 integration plan, 6.1) -- present only on an explicit user request
    # for a different take on the same mood, so it deliberately misses the
    # cache and draws a new seed instead of replaying whatever's already cached.
    if profile.get("nonce"):
        canonical["nonce"] = profile["nonce"]
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True).encode()
    ).hexdigest()

def check_cache(cache_key: str):
    with _pooled_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM audio_cache WHERE cache_key = %s", (cache_key,))
            row = cur.fetchone()
            if not row:
                print(f"[D5] check_cache MISS key={cache_key[:12]}...")
                return None
            columns = [desc[0] for desc in cur.description]
            hit = dict(zip(columns, row))
            print(f"[D5] check_cache HIT  key={cache_key[:12]}... mood={hit.get('mood')} url={hit.get('audio_url')}")
            return hit

def save_to_cache(cache_key, clip_bytes, profile, loop_point_ms, generation_time_ms,
                   prompt_used, seam_discontinuity, prompt_source, generation_seed):
    filename = f"{cache_key}.ogg"
    path = os.path.join(AUDIO_CACHE_DIR, filename)
    with open(path, "wb") as f:
        f.write(clip_bytes)
    print(f"[D5] save_to_cache: wrote {len(clip_bytes)} bytes -> {path}")

    audio_url = f"{LOCAL_SERVER_URL}/audio-cache/{filename}"

    with _pooled_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO audio_cache
                    (cache_key, audio_url, mood, bpm, key, energy, style, valence, arousal,
                     intensity, duration_seconds, loop_point_ms, seam_discontinuity,
                     generation_time_ms, prompt_used, prompt_source, generation_seed)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (cache_key) DO NOTHING
                """,
                (
                    cache_key, audio_url, profile["mood"], profile["bpm"], profile["key"],
                    profile["energy"], profile["style"], profile.get("valence"), profile.get("arousal"),
                    profile.get("intensity"), profile.get("duration_seconds"), loop_point_ms,
                    psycopg2.extras.Json(seam_discontinuity) if seam_discontinuity is not None else None,
                    generation_time_ms, prompt_used, prompt_source, generation_seed,
                ),
            )
            # rowcount is 0 when ON CONFLICT DO NOTHING suppressed the insert
            # -- a concurrent request (or the prewarm grid) got there first.
            # That's benign, but it is NOT the same as "row written", and
            # without saying which it was, a silently-empty table looks
            # identical to a working one.
            inserted = cur.rowcount
        conn.commit()

    if inserted:
        print(f"[D5] save_to_cache: row committed key={cache_key[:12]}... mood={profile['mood']} "
              f"style={profile.get('style')} bpm={profile['bpm']} url={audio_url}")
    else:
        print(f"[D5] save_to_cache: key={cache_key[:12]}... already present (ON CONFLICT DO NOTHING) -- file rewritten, row left as-is")

    return audio_url
