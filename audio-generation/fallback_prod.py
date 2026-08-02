import os
from supabase import create_client
from dotenv import load_dotenv
load_dotenv()

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def get_fallback_clip(mood: str):
    """
    Prod version of fallback.py's get_fallback_clip(). Reads from the
    fallback_clips table (audio_url + metadata together) instead of local
    disk/JSON sidecars. Returns (audio_url, metadata, filename), or None if
    no fallback clips exist at all.
    """
    result = supabase.table("fallback_clips").select("*").execute()
    rows = {row["mood"]: row for row in (result.data or [])}
    if not rows:
        print("[FALLBACK] No fallback clips found in fallback_clips table!")
        return None

    candidates = [mood, "neutral", "calm", "focused"]
    for m in candidates:
        if m in rows:
            row = rows[m]
            filename = f"{m}.ogg"
            print(f"[FALLBACK] Using fallback clip: {filename} for mood: {mood}")
            metadata = {
                "loop_point_ms": row.get("loop_point_ms"),
                "seam_discontinuity": row.get("seam_discontinuity"),
                "prompt_used": row.get("prompt_used"),
                "generation_seed": row.get("generation_seed"),
            }
            return row["audio_url"], metadata, filename

    print("[FALLBACK] No fallback clips found in fallback_clips table!")
    return None
