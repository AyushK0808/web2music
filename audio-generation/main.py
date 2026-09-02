import os
import sys
import time
import asyncio
import traceback

# Every diagnostic in Feature D is a print(), and Python BLOCK-buffers stdout
# whenever it isn't a tty -- so `uvicorn main:app > featured.log` (the README's
# native path) holds ~8KB of [MAIN]/[D5]/[PREWARM] lines in memory and flushes
# them only at exit. uvicorn's own INFO lines go through logging to stderr and
# appear immediately, which makes the log look complete while every line that
# would explain a cache failure is invisible until the server is killed.
#
# The Dockerfile already sets PYTHONUNBUFFERED=1, so containers never showed
# this; only the native path did. Line-buffering here fixes both entry points
# at once, for every module's prints, without touching each call site.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from d1_validate import validate_profile
from d2_prompt import build_prompt
from d3_generate import generate_audio, GenerationError
from d4_process import process_audio
from models import HandoffPayload
from prewarm import prewarm_cache

IS_PROD = os.getenv("IS_PROD", "false").lower() in ("1", "true", "yes")
LOCAL_SERVER_URL = os.getenv("LOCAL_SERVER_URL", "http://127.0.0.1:8000")

if IS_PROD:
    from d5_cache import make_cache_key, check_cache, save_to_cache
    # Prod fallback reads from the fallback_clips Supabase table instead of
    # local disk -- see fallback_prod.py. Keeps a fresh/scaled-to-zero pod
    # from depending on anything baked into its own filesystem.
    from fallback_prod import get_fallback_clip
else:
    from d5_cache_local import make_cache_key, check_cache, save_to_cache, AUDIO_CACHE_DIR, ensure_schema
    from fallback import get_fallback_clip, FALLBACK_DIR

from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[MAIN] Starting Feature D -- IS_PROD={IS_PROD}, "
          f"cache backend={'supabase (d5_cache)' if IS_PROD else 'local postgres (d5_cache_local)'}")

    if not IS_PROD:
        # Awaited, not fire-and-forget: prewarm and every /generate below
        # write through save_to_cache, and a dev DB whose volume predates a
        # column silently fails all of them (see ensure_schema's docstring).
        # Cheap -- CREATE/ALTER ... IF NOT EXISTS on an up-to-date DB is a
        # handful of no-ops. A failure here is logged and tolerated: the
        # cache is an optimisation, and D still generates and serves audio
        # with a dead DB, exactly as the check_cache/save_to_cache handlers
        # below already assume.
        try:
            await asyncio.to_thread(ensure_schema)
        except Exception as e:
            print(f"[MAIN] ensure_schema failed ({type(e).__name__}: {e}) -- "
                  f"continuing, but expect every cache write to fail and every "
                  f"response to degrade to a fallback clip. Is the db container up?")

    # Fire-and-forget: don't await this, or the server won't start accepting
    # real requests until the entire pre-warm grid finishes generating.
    # The task is held on app.state so it isn't garbage-collected mid-run --
    # asyncio only keeps a weak reference to tasks created via create_task,
    # so an unreferenced task can silently vanish before it completes.
    app.state.prewarm_task = asyncio.create_task(
        prewarm_cache(make_cache_key, check_cache, save_to_cache)
    )
    yield


app = FastAPI(lifespan=lifespan)

# Extension pages with <all_urls> host permission bypass CORS entirely, so
# this isn't load-bearing for the extension itself -- but it's needed for the
# hosted-prod path (a page origin without host_permissions) and makes
# Swagger/curl testing from a browser possible without a proxy.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
@app.get("/health")
async def health():
    return {"status": "ok", "is_prod": IS_PROD}
if not IS_PROD:
    from fastapi.staticfiles import StaticFiles
    app.mount("/audio-cache", StaticFiles(directory=AUDIO_CACHE_DIR), name="audio-cache")
    # Fallback clips are static, mood-keyed assets generated once by
    # generate_fallbacks.py -- served the same way as the cache dir above,
    # not through make_cache_key/save_to_cache (see fallback.py's docstring
    # for why that distinction matters).
    app.mount("/fallback-clips", StaticFiles(directory=FALLBACK_DIR), name="fallback-clips")


async def _fallback_response(profile: dict, timings: dict) -> JSONResponse:
    """
    Shared fallback path for both D3 (generation) and D4 (post-processing /
    encode) failures. From the caller's perspective "no clip was produced"
    is the same outcome regardless of which stage failed -- D4 in
    particular can now fail on a codec-availability issue (see the Ogg/Opus
    switch) that libmp3lame never could, so it needs the same safety net
    D3 already had rather than propagating into an unhandled 500.

    Dev reads the fallback clip from local disk (fallback.py), prod reads
    it from the fallback_clips Supabase table (fallback_prod.py) -- both
    return (audio_source, metadata, filename), where audio_source is raw
    bytes in dev and a ready-to-use public URL in prod.
    """
    result = await asyncio.to_thread(get_fallback_clip, profile["mood"])

    if result is None:
        raise HTTPException(
            status_code=503,
            detail="Audio generation failed and no fallback clips are available. Please try again later."
        )

    audio_source, metadata, filename = result

    if IS_PROD:
        audio_url = audio_source  # fallback_prod.py already returns a public URL
    else:
        audio_url = f"{LOCAL_SERVER_URL}/fallback-clips/{filename}"

    print(f"[MAIN] Returning fallback clip: {filename}")
    return JSONResponse(
        status_code=200,
        content={
            "audio_url": audio_url,
            "metadata": {
                "mood":               profile["mood"],
                "bpm":                profile["bpm"],
                "key":                profile["key"],
                "energy":             profile["energy"],
                "loop_point_ms":      metadata.get("loop_point_ms"),
                "seam_discontinuity": metadata.get("seam_discontinuity"),
                "prompt_used":        metadata.get("prompt_used"),
                "generation_seed":    metadata.get("generation_seed"),
                "prompt_source":      "fallback_clip",
                "is_fallback":        True,
                "loopable":           True
            },
            "cache":    "miss",
            "fallback": True,
            "timings":  timings
        }
    )


@app.get("/health")
async def health():
    """
    Liveness check for the D-side ablation scripts (_dcommon.health(), used by
    d1_prompt_ablation.py and d3_clip_length.py). Nothing in the request path
    checks the model or the cache DB -- if uvicorn is up this returns 200. That
    matches what the callers actually gate on: "is there a server to send
    /generate requests to", not "is generation currently healthy". A prewarm
    still in progress, or a dead cache DB (see lifespan()'s ensure_schema
    handling), are not failures here.
    """
    return {"status": "ok"}


@app.get("/fallback/{mood}")
async def fallback(mood: str):
    """
    Instant, no-generation fallback clip for a mood -- reuses the exact same
    get_fallback_clip lookup and response shape as the /generate error paths
    (_fallback_response), just without a preceding /generate attempt. This is
    what the extension calls immediately on a mood transition so something
    audible starts sub-second, while /generate runs in parallel and the
    playback layer crossfades in once it resolves (see ui/ Phase 5).
    """
    result = await asyncio.to_thread(get_fallback_clip, mood)
    if result is None:
        raise HTTPException(
            status_code=503,
            detail="No fallback clips available. Run generate_fallbacks.py first."
        )

    audio_source, metadata, filename = result

    if IS_PROD:
        audio_url = audio_source
    else:
        audio_url = f"{LOCAL_SERVER_URL}/fallback-clips/{filename}"

    return {
        "audio_url": audio_url,
        "metadata": {
            "mood":               mood,
            "loop_point_ms":      metadata.get("loop_point_ms"),
            "seam_discontinuity": metadata.get("seam_discontinuity"),
            "generation_seed":    metadata.get("generation_seed"),
            "prompt_source":      "fallback_clip",
            "is_fallback":        True,
            "loopable":           True,
        },
    }


@app.post("/generate")
async def generate(payload: HandoffPayload):
    timings = {}

    # D1 — Validate & unwrap Sneha's Handoff 2 payload
    t0 = time.time()
    print(f"[MAIN] POST /generate received (isSilent={payload.isSilent})")
    try:
        profile, prompt_from_b = validate_profile(payload)
    except Exception as e:
        # MusicProfile's range validators (bpm 20-200, energy/valence/etc.
        # 0-1 or -1-1, duration_seconds 5-30) and the int(float(bpm)) cast
        # can both raise on malformed input. Not reachable through the real
        # pipeline today -- Feature B already clamps everything before
        # sending -- but it's a real gap on the documented flat-dict Swagger
        # path, and this is the one call site the D3/D4/cache fallback audit
        # didn't reach. Degrade to a fallback clip with safe defaults rather
        # than hard-500ing, same as every other failure mode in this file.
        print(f"[MAIN] validate_profile failed on malformed input: {e}")
        safe_defaults = {"mood": "neutral", "bpm": 80, "key": "C major", "energy": 0.5}
        return await _fallback_response(safe_defaults, {"d1_validate_ms": int((time.time() - t0) * 1000)})
    timings["d1_validate_ms"] = int((time.time() - t0) * 1000)

    # Sensitive-content silence (fix 16): B signals "go quiet" via isSilent
    # on the Handoff-2 envelope and/or sensitive_override on the profile.
    # The ui/ extension already short-circuits before ever calling
    # /generate for this case (background.entry.js's handleHandoff2), but
    # that check living only in the caller meant a direct/Swagger/future
    # caller that forwards B's payload unfiltered got ordinary music for a
    # crisis page -- D had no defense of its own. Generating audio nobody
    # will hear is also pure waste, so this skips D2/D3/D4/D5 entirely.
    if payload.isSilent or profile.get("sensitive_override"):
        print("[D1] Silence signal detected (isSilent/sensitive_override) -- skipping generation")
        return {
            "audio_url": None,
            "metadata": {
                "mood":            "silence",
                "is_silent":       True,
                "sensitive_override": True,
                "is_fallback":     False,
                "loopable":        False,
            },
            "cache":   "skip",
            "timings": timings,
        }

    print(f"[MAIN] Profile: mood={profile['mood']} style={profile.get('style')} bpm={profile['bpm']} "
          f"key={profile['key']} energy={profile['energy']} duration={profile.get('duration_seconds')}s"
          + (" nonce=<set>" if profile.get("nonce") else "")
          + f" seed_override={profile.get('seed_override')}")

    # Cache check
    t1 = time.time()
    cache_key = make_cache_key(profile)
    try:
        cached = await asyncio.to_thread(check_cache, cache_key)
    except Exception as e:
        # A broken cache lookup (Supabase/DB down, network blip) shouldn't
        # block generation entirely -- degrade to a cache miss and generate
        # fresh instead of failing the request over an unrelated subsystem.
        print(f"[MAIN] check_cache failed, treating as cache miss ({type(e).__name__}): {e}")
        cached = None
    timings["d5_cache_check_ms"] = int((time.time() - t1) * 1000)

    if cached:
        print(f"[MAIN] /generate complete (cache=hit) mood={cached.get('mood')} url={cached['audio_url']} timings={timings}")
        # Not every field in the miss-path metadata below is persisted to
        # the cache DB (see the column list in ../docker/init.sql) -- only
        # cache_key/mood/bpm/key/energy/style/loop_point_ms/prompt_used
        # actually round-trip. Rather than spreading `cached` directly and
        # letting whichever fields didn't make the DB schema silently
        # vanish from the response (the seam_discontinuity bug from
        # review), every key the miss-path can return is explicitly
        # declared here too, so hit and miss responses always have the
        # same shape -- unpersisted fields come back as null instead of
        # missing outright.
        return {
            "audio_url": cached["audio_url"],
            "metadata": {
                "cache_key":          cached.get("cache_key", cache_key),
                "mood":               cached.get("mood"),
                "bpm":                cached.get("bpm"),
                "key":                cached.get("key"),
                "energy":             cached.get("energy"),
                "valence":            cached.get("valence"),
                "arousal":            cached.get("arousal"),
                "intensity":          cached.get("intensity"),
                "duration_seconds":   cached.get("duration_seconds"),
                "loop_point_ms":      cached.get("loop_point_ms"),
                "seam_discontinuity": cached.get("seam_discontinuity"),
                "prompt_used":        cached.get("prompt_used"),
                "prompt_source":      cached.get("prompt_source"),
                "generation_seed":    cached.get("generation_seed"),
                "is_fallback":        False,
                "loopable":           True,
            },
            "cache":     "hit",
            "timings":   timings
        }

    # D2 — Use Sneha's prompt if available, else build our own
    t2 = time.time()
    prompt = build_prompt(profile, prompt_from_b, force=payload.force_prompt)
    timings["d2_prompt_ms"] = int((time.time() - t2) * 1000)
    print(f"[D2] Prompt source: {'Feature B' if prompt_from_b else 'D2 fallback'}")
    print(f"[D2] Prompt: {prompt}")

    # D3 — Generate audio with retry logic
    t3 = time.time()
    generation_seed = None
    try:
        audio_bytes, generation_seed = await generate_audio(
            prompt, profile["duration_seconds"], seed_override=profile.get("seed_override")
        )
    except GenerationError as e:
        print(f"[MAIN] Generation failed after all retries: {e}")
        print(f"[MAIN] Attempting fallback clip for mood: {profile['mood']}")
        return await _fallback_response(profile, timings)

    timings["d3_generate_ms"] = int((time.time() - t3) * 1000)
    print(f"[D3] Generated {len(audio_bytes)} bytes in {timings['d3_generate_ms']}ms (seed={generation_seed})")

    # D4 — Post-process
    t4 = time.time()
    try:
        clip_bytes, loop_point_ms, seam_discontinuity = await asyncio.to_thread(process_audio, audio_bytes)
    except Exception as e:
        print(f"[MAIN] D4 post-processing failed: {e}")
        print(f"[MAIN] Attempting fallback clip for mood: {profile['mood']}")
        return await _fallback_response(profile, timings)
    timings["d4_process_ms"] = int((time.time() - t4) * 1000)
    print(f"[D4] Post-processed to {len(clip_bytes)} bytes in {timings['d4_process_ms']}ms "
          f"(loop_point={loop_point_ms}ms, seam={seam_discontinuity})")

    # D5 — Cache & return
    t5 = time.time()
    total_gen_ms = int((time.time() - t0) * 1000)
    try:
        audio_url = await asyncio.to_thread(
            save_to_cache, cache_key, clip_bytes, profile,
            loop_point_ms, total_gen_ms, prompt,
            seam_discontinuity, "feature_b" if prompt_from_b else "d2_fallback", generation_seed
        )
    except Exception as e:
        # We already have a good, correctly-generated clip at this point --
        # only the storage/DB write failed. The API only ever returns a
        # URL (never raw bytes), so there's no way to hand the client a
        # working result without a successful save; treat this the same
        # as a generation/encode failure rather than a bare 500.
        #
        # Full traceback, not just str(e): this handler throws away a clip
        # that cost 15-95s of CPU to make, and the one-line form hid a plain
        # schema mismatch behind an endless stream of "returning fallback"
        # for weeks. If this fires, the next thing anyone needs is the frame
        # it came from.
        print(f"[MAIN] save_to_cache failed ({type(e).__name__}): {e}")
        traceback.print_exc()
        print(f"[MAIN] Discarding a good {len(clip_bytes)}-byte clip and attempting fallback for mood: {profile['mood']}")
        return await _fallback_response(profile, timings)
    timings["d5_save_ms"] = int((time.time() - t5) * 1000)
    print(f"[MAIN] /generate complete (cache=miss) mood={profile['mood']} url={audio_url} timings={timings}")

    return {
        "audio_url": audio_url,
        "metadata": {
            "cache_key":        cache_key,
            "mood":             profile["mood"],
            "bpm":              profile["bpm"],
            "key":              profile["key"],
            "energy":           profile["energy"],
            "valence":          profile["valence"],
            "arousal":          profile["arousal"],
            "intensity":        profile["intensity"],
            "duration_seconds": profile["duration_seconds"],
            "loop_point_ms":      loop_point_ms,
            "seam_discontinuity": seam_discontinuity,
            "prompt_used":        prompt,
            "prompt_source":      "feature_b" if prompt_from_b else "d2_fallback",
            "generation_seed":    generation_seed,
            "is_fallback":        False,
            "loopable":           True
        },
        "cache":   "miss",
        "timings": timings
    }