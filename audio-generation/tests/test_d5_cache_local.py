"""
Regression test for the gapless-export filename/content-type fix in
d5_cache_local.py: after switching D4's export from MP3 to Ogg/Opus, the
cache backend's save_to_cache() must write .ogg files, not stale .mp3
ones (which would mismatch the actual audio format on disk).
"""
import os
import sys
from unittest import mock

import pytest


@pytest.fixture
def cache_local_module(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_SERVER_URL", "http://127.0.0.1:8000")
    sys.modules.pop("d5_cache_local", None)

    # Point AUDIO_CACHE_DIR at a temp dir instead of the real audio-cache/
    # folder, and mock the DB connection entirely -- this test only cares
    # about the file that gets written to disk and the URL that's built,
    # not real Postgres.
    import d5_cache_local as mod
    monkeypatch.setattr(mod, "AUDIO_CACHE_DIR", str(tmp_path))

    fake_cursor = mock.MagicMock()
    fake_conn = mock.MagicMock()
    fake_conn.cursor.return_value.__enter__.return_value = fake_cursor
    monkeypatch.setattr(mod, "_connect", lambda: fake_conn)

    return mod, tmp_path


def test_save_to_cache_writes_ogg_extension_not_mp3(cache_local_module):
    mod, tmp_path = cache_local_module

    fake_clip_bytes = b"OggS" + b"\x00" * 100  # fake ogg-ish payload, content doesn't matter here
    profile = {"mood": "calm", "bpm": 90, "key": "C major", "energy": 0.5, "style": "ambient"}

    audio_url = mod.save_to_cache(
        "testkey123", fake_clip_bytes, profile, loop_point_ms=5000,
        generation_time_ms=1000, prompt_used="test prompt",
        seam_discontinuity=None, prompt_source="test", generation_seed=42
    )

    assert audio_url.endswith("testkey123.ogg"), f"expected .ogg URL, got {audio_url}"
    assert not audio_url.endswith(".mp3")

    written_files = os.listdir(tmp_path)
    assert "testkey123.ogg" in written_files
    assert "testkey123.mp3" not in written_files

    with open(os.path.join(tmp_path, "testkey123.ogg"), "rb") as f:
        assert f.read() == fake_clip_bytes


def test_cache_key_changes_when_export_codec_changes(cache_local_module, monkeypatch):
    """
    Regression test: make_cache_key() previously had no codec/version
    component, so already-cached entries from the old MP3 pipeline would
    keep matching (and serving stale MP3 audio with the audible click)
    forever after the Ogg/Opus switch, since there's no TTL/eviction
    anywhere in the schema. The key must change when EXPORT_CODEC changes,
    so old entries naturally miss and regenerate instead of silently
    persisting under an identical key.
    """
    mod, _ = cache_local_module
    profile = {
        "mood": "calm", "bpm": 90, "key": "C major", "energy": 0.5,
        "style": "ambient", "valence": 0.0, "duration_seconds": 28,
    }

    key_with_opus = mod.make_cache_key(profile)

    monkeypatch.setattr(mod, "EXPORT_CODEC", "libmp3lame")
    key_with_mp3 = mod.make_cache_key(profile)

    assert key_with_opus != key_with_mp3, (
        "cache key didn't change when the export codec changed -- old "
        "MP3-era cache entries would keep matching indefinitely"
    )


def test_cache_key_stable_for_identical_profile_and_codec(cache_local_module):
    """Sanity check alongside the above: the key must still be stable/
    deterministic for the same profile+codec, or caching breaks entirely."""
    mod, _ = cache_local_module
    profile = {
        "mood": "calm", "bpm": 90, "key": "C major", "energy": 0.5,
        "style": "ambient", "valence": 0.0, "duration_seconds": 28,
    }
    assert mod.make_cache_key(profile) == mod.make_cache_key(profile)