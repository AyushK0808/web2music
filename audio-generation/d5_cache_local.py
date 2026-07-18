import hashlib, json, os
import psycopg2
from dotenv import load_dotenv
load_dotenv()

AUDIO_CACHE_DIR = os.path.join(os.path.dirname(__file__), "audio-cache")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

LOCAL_DB_URL = os.getenv("LOCAL_DB_URL", "postgresql://postgres:postgres@localhost:5432/audio_cache")
LOCAL_SERVER_URL = os.getenv("LOCAL_SERVER_URL", "http://127.0.0.1:8000")

def _connect():
    return psycopg2.connect(LOCAL_DB_URL)

def make_cache_key(profile: dict) -> str:
    bpm = profile["bpm"]
    duration = profile.get("duration_seconds", 28)
    canonical = {
        "mood":            profile["mood"],
        "bpm_bucket":      "low" if bpm < 76 else "mid" if bpm < 101 else "high",
        "energy_tier":     round(float(profile["energy"]), 1),
        "style":           profile["style"],
        "key":             profile["key"],
        "valence_tier":    round(float(profile.get("valence", 0.0)), 1),
        "duration_bucket": (duration // 2) * 2,  # 2s tolerance: 27,28→28  29,30→30
         # Note: seed is intentionally excluded from the cache key.
        # Including it would mean each retry attempt (seed 43, 44, 45)
        # generates a separate cache entry, defeating the purpose of caching.
    }
    return hashlib.sha256(
        json.dumps(canonical, sort_keys=True).encode()
    ).hexdigest()

def check_cache(cache_key: str):
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM audio_cache WHERE cache_key = %s", (cache_key,))
            row = cur.fetchone()
            if not row:
                return None
            columns = [desc[0] for desc in cur.description]
            return dict(zip(columns, row))
    finally:
        conn.close()

def save_to_cache(cache_key, mp3_bytes, profile, loop_point_ms, generation_time_ms, prompt_used):
    filename = f"{cache_key}.mp3"
    with open(os.path.join(AUDIO_CACHE_DIR, filename), "wb") as f:
        f.write(mp3_bytes)

    audio_url = f"{LOCAL_SERVER_URL}/audio-cache/{filename}"

    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO audio_cache
                    (cache_key, audio_url, mood, bpm, key, energy, style, loop_point_ms, generation_time_ms, prompt_used)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (cache_key) DO NOTHING
                """,
                (
                    cache_key, audio_url, profile["mood"], profile["bpm"], profile["key"],
                    profile["energy"], profile["style"], loop_point_ms, generation_time_ms, prompt_used,
                ),
            )
        conn.commit()
    finally:
        conn.close()

    return audio_url 