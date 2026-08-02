import hashlib, json, os
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from d4_process import EXPORT_CODEC
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

def save_to_cache(cache_key, clip_bytes, profile, loop_point_ms, generation_time_ms,
                   prompt_used, seam_discontinuity, prompt_source, generation_seed):
    filename = f"{cache_key}.ogg"
    with open(os.path.join(AUDIO_CACHE_DIR, filename), "wb") as f:
        f.write(clip_bytes)

    audio_url = f"{LOCAL_SERVER_URL}/audio-cache/{filename}"

    conn = _connect()
    try:
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
        conn.commit()
    finally:
        conn.close()

    return audio_url