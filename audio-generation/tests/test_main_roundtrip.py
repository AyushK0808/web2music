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
        url = f"fake://{cache_key}"
        fake_db[cache_key] = {"audio_url": url, "loop_point_ms": loop_point_ms}
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
