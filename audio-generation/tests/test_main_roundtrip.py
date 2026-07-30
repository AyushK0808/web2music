"""
Round-trip test for loop_point_ms and seam_discontinuity: confirms the
values D4 computes actually survive all the way through main.py's
/generate response, matching what the README documents (e.g.
loop_point_ms: 18400-style example) so Feature C's gapless player can
trust the field. This exercises the REAL D1/D2/D4 pipeline end-to-end;
only D3 (model generation) and D5 (cache I/O) are mocked, since those
need a real GPU/model and a real DB respectively.
"""
import io
import sys

import numpy as np
import pytest
import soundfile as sf


def _make_wav_bytes(duration_s=6, sr=32000):
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    audio = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    buf.seek(0)
    return buf.read()


@pytest.fixture
def main_client(call_log, monkeypatch):
    """
    Builds a FastAPI TestClient against the real main.py app, with
    generate_audio (D3) and the cache backend (D5) mocked out. D1, D2, and
    D4 run for real, so this test actually proves the round-trip through
    the real validation/prompt/loop-detection code, not just the mocks.
    """
    monkeypatch.setenv("IS_PROD", "false")
    for mod in ("main", "d3_generate", "d5_cache_local", "d5_cache"):
        sys.modules.pop(mod, None)

    import main as main_module

    async def fake_generate_audio(prompt, duration_seconds=28):
        return _make_wav_bytes(duration_s=6), 42

    monkeypatch.setattr(main_module, "generate_audio", fake_generate_audio)

    async def fake_prewarm_cache(*args, **kwargs):
        return None  # skip the real 45-combo grid -- this test only cares about /generate

    monkeypatch.setattr(main_module, "prewarm_cache", fake_prewarm_cache)

    fake_db = {}

    def fake_check_cache(cache_key):
        return fake_db.get(cache_key)

    def fake_save_to_cache(cache_key, mp3_bytes, profile, loop_point_ms, gen_time_ms, prompt):
        # Mirrors the REAL DB schema (docker/init.sql) exactly -- only these
        # columns exist, matching what d5_cache.py/d5_cache_local.py
        # actually persist. Anything else main.py's miss-path metadata
        # returns (valence, intensity, duration_seconds, seam_discontinuity,
        # prompt_source, generation_seed) is intentionally absent here too,
        # so this test reflects production, not a more generous mock.
        url = f"fake://{cache_key}"
        fake_db[cache_key] = {
            "cache_key": cache_key,
            "audio_url": url,
            "mood": profile["mood"],
            "bpm": profile["bpm"],
            "key": profile["key"],
            "energy": profile["energy"],
            "style": profile.get("style"),
            "loop_point_ms": loop_point_ms,
            "generation_time_ms": gen_time_ms,
            "prompt_used": prompt,
        }
        return url

    monkeypatch.setattr(main_module, "check_cache", fake_check_cache)
    monkeypatch.setattr(main_module, "save_to_cache", fake_save_to_cache)

    from fastapi.testclient import TestClient
    with TestClient(main_module.app) as client:
        yield client


def test_loop_point_ms_survives_the_generate_response(main_client):
    response = main_client.post("/generate", json={
        "mood": "calm", "bpm": 90, "key": "C major",
        "energy": 0.5, "style": "ambient", "duration_seconds": 6,
    })

    assert response.status_code == 200
    body = response.json()

    assert "metadata" in body
    assert "loop_point_ms" in body["metadata"]
    assert isinstance(body["metadata"]["loop_point_ms"], int)
    assert body["metadata"]["loop_point_ms"] > 0

    # seam_discontinuity should have made the same trip
    assert "seam_discontinuity" in body["metadata"]
    assert "energy_delta_db" in body["metadata"]["seam_discontinuity"]

    assert body["cache"] == "miss"
    assert body["metadata"]["is_fallback"] is False


def test_cache_hit_still_returns_the_same_loop_point_ms(main_client):
    payload = {
        "mood": "calm", "bpm": 90, "key": "C major",
        "energy": 0.5, "style": "ambient", "duration_seconds": 6,
    }

    first = main_client.post("/generate", json=payload).json()
    second = main_client.post("/generate", json=payload).json()

    # cache-hit responses return the cached row's metadata directly (see
    # main.py's `if cached:` branch) -- assert the cached row itself carries
    # the same loop_point_ms that was originally computed and saved
    assert second["cache"] == "hit"
    assert second["metadata"]["loop_point_ms"] == first["metadata"]["loop_point_ms"]


def test_cache_hit_response_has_same_metadata_shape_as_miss(main_client):
    """
    Regression test for the full bug class, not just seam_discontinuity:
    several fields (valence, intensity, duration_seconds,
    seam_discontinuity, prompt_source, generation_seed) exist in the
    miss-path metadata but aren't columns in the cache DB (see
    docker/init.sql) -- a naive `"metadata": cached` on cache hits let ALL
    of these silently vanish, not just one. Any consumer doing
    metadata["valence"] or metadata["generation_seed"] would KeyError on
    every cache hit -- the MORE common path once the cache warms up.

    This asserts: (1) hit and miss responses have identical metadata key
    sets, and (2) fields that genuinely persist to the DB (mood, bpm, key,
    energy, loop_point_ms, prompt_used) carry the same value on both.
    """
    payload = {
        "mood": "sad", "bpm": 70, "key": "A minor",
        "energy": 0.3, "style": "acoustic", "duration_seconds": 6,
    }

    first = main_client.post("/generate", json=payload).json()
    assert first["cache"] == "miss"

    second = main_client.post("/generate", json=payload).json()
    assert second["cache"] == "hit"

    miss_keys = set(first["metadata"].keys())
    hit_keys = set(second["metadata"].keys())
    assert hit_keys == miss_keys, (
        f"cache-hit metadata is missing keys the miss-path returns: "
        f"{miss_keys - hit_keys}"
    )

    # Genuinely persisted fields (see docker/init.sql) must match exactly
    for field in ("mood", "bpm", "key", "energy", "loop_point_ms", "prompt_used"):
        assert second["metadata"][field] == first["metadata"][field], field

    # Fields NOT persisted to the DB come back null on cache-hit, not
    # missing -- present-but-null is the whole point of the fix
    for field in ("valence", "intensity", "duration_seconds",
                  "seam_discontinuity", "prompt_source", "generation_seed"):
        assert field in second["metadata"], f"{field} went missing on cache hit"
        assert second["metadata"][field] is None, (
            f"{field} isn't persisted to the DB, expected null on cache hit"
        )


def test_d4_encode_failure_falls_back_instead_of_hard_500(main_client, monkeypatch):
    """
    Regression test: D4's export codec switch (MP3 -> Ogg/Opus) introduced
    a new failure mode -- if the deploy host's ffmpeg build lacks libopus,
    process_audio() raises and used to propagate straight out of
    asyncio.to_thread as an unhandled 500, unlike D3's generation failures
    which already degrade to a fallback clip. Simulates a D4 failure
    (any exception -- codec, corrupt audio, whatever) and asserts the
    request still returns 200 with a fallback clip when one is available.
    """
    import main as main_module

    def broken_process_audio(audio_bytes):
        raise RuntimeError("Encoder not found for codec 'libopus'")

    monkeypatch.setattr(main_module, "process_audio", broken_process_audio)

    def fake_get_fallback_clip(mood):
        return b"fake fallback mp3 bytes"

    monkeypatch.setattr(main_module, "get_fallback_clip", fake_get_fallback_clip)

    response = main_client.post("/generate", json={
        "mood": "calm", "bpm": 90, "key": "C major",
        "energy": 0.5, "style": "ambient", "duration_seconds": 6,
    })

    assert response.status_code == 200, (
        f"D4 failure should degrade to a fallback clip, not a hard 500 "
        f"(got {response.status_code}: {response.text})"
    )
    body = response.json()
    assert body["fallback"] is True
    assert body["metadata"]["is_fallback"] is True
    assert body["audio_url"] is None


def test_d4_encode_failure_with_no_fallback_clips_returns_503_not_500(main_client, monkeypatch):
    """
    Same D4 failure, but with no fallback clip available either (matches
    production today -- fallback_clips/ is empty). Must return a clean 503
    with an explanatory detail, not an unhandled 500 with a stack trace.
    """
    import main as main_module

    def broken_process_audio(audio_bytes):
        raise RuntimeError("Encoder not found for codec 'libopus'")

    monkeypatch.setattr(main_module, "process_audio", broken_process_audio)

    def no_fallback_clip(mood):
        return None

    monkeypatch.setattr(main_module, "get_fallback_clip", no_fallback_clip)

    response = main_client.post("/generate", json={
        "mood": "calm", "bpm": 90, "key": "C major",
        "energy": 0.5, "style": "ambient", "duration_seconds": 6,
    })

    assert response.status_code == 503
    assert "fallback" in response.json()["detail"].lower()


def test_check_cache_failure_degrades_to_cache_miss_not_500(main_client, monkeypatch):
    """
    Regression test found during the same audit as the D4 fallback fix:
    check_cache() was a blocking DB/Supabase call running directly on the
    event loop with no error handling at all -- not even the D3/D4 pattern
    of "fail then fall back", just a bare unhandled exception. A broken
    cache lookup (DB down, network blip) shouldn't block generation
    entirely; it should degrade to a cache miss and generate fresh.
    """
    import main as main_module

    def broken_check_cache(cache_key):
        raise ConnectionError("could not connect to cache backend")

    monkeypatch.setattr(main_module, "check_cache", broken_check_cache)

    response = main_client.post("/generate", json={
        "mood": "focused", "bpm": 100, "key": "D major",
        "energy": 0.6, "style": "electronic", "duration_seconds": 6,
    })

    assert response.status_code == 200, (
        f"a broken cache lookup should degrade to a cache miss and still "
        f"generate, not fail the request (got {response.status_code}: {response.text})"
    )
    assert response.json()["cache"] == "miss"


def test_save_to_cache_failure_falls_back_instead_of_hard_500(main_client, monkeypatch):
    """
    Regression test found in the same audit: save_to_cache() -- the worst
    spot for this bug, since it runs AFTER a successful generation -- was
    also blocking and unhandled. A storage/DB write failure at this point
    would throw away an already-correctly-generated clip with a bare 500.
    Since the API only ever returns a URL (never raw bytes), there's no
    way to hand back a working result without a successful save, so this
    degrades through the same fallback path as a generation/encode failure.
    """
    import main as main_module

    def broken_save_to_cache(cache_key, clip_bytes, profile, loop_point_ms, gen_time_ms, prompt):
        raise ConnectionError("could not reach storage backend")

    monkeypatch.setattr(main_module, "save_to_cache", broken_save_to_cache)

    def fake_get_fallback_clip(mood):
        return b"fake fallback mp3 bytes"

    monkeypatch.setattr(main_module, "get_fallback_clip", fake_get_fallback_clip)

    response = main_client.post("/generate", json={
        "mood": "joyful", "bpm": 110, "key": "G major",
        "energy": 0.7, "style": "acoustic", "duration_seconds": 6,
    })

    assert response.status_code == 200, (
        f"a save_to_cache failure should degrade to a fallback clip, not a "
        f"hard 500 (got {response.status_code}: {response.text})"
    )
    body = response.json()
    assert body["fallback"] is True
    assert body["metadata"]["is_fallback"] is True


def test_malformed_profile_bpm_falls_back_instead_of_hard_500(main_client, monkeypatch):
    """
    Regression test: validate_profile() was the one call site the D3/D4/
    cache-check/cache-save fallback audit didn't reach. Since `profile` is
    typed as a raw `Optional[dict]` on HandoffPayload (so its own field
    contract with Feature D can differ from MusicProfile's), FastAPI's own
    Pydantic validation doesn't catch malformed values inside it --
    d1_validate.py's int(float(p["bpm"])) raises ValueError on a
    non-numeric bpm, and MusicProfile's range validators (bpm 20-200,
    energy/valence 0-1/-1-1, etc.) can also raise. Not reachable through
    the real pipeline today (Feature B already clamps), but a real gap on
    the documented flat-dict/profile Swagger path -- and inconsistent with
    this PR's own point of eliminating hard-500s everywhere else.
    """
    import main as main_module

    def fake_get_fallback_clip(mood):
        return b"fake fallback mp3 bytes"

    monkeypatch.setattr(main_module, "get_fallback_clip", fake_get_fallback_clip)

    response = main_client.post("/generate", json={
        "profile": {
            "mood": "calm", "bpm": "not-a-number", "key": "C major",
            "energy": 0.5, "style": "ambient",
        }
    })

    assert response.status_code == 200, (
        f"malformed profile input should degrade to a fallback clip, not a "
        f"hard 500 (got {response.status_code}: {response.text})"
    )
    body = response.json()
    assert body["fallback"] is True
    assert body["metadata"]["is_fallback"] is True