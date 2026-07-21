import asyncio
import threading
import pytest


@pytest.fixture
def fake_cache():
    """A fake cache backend mimicking d5_cache.py's interface, plus
    instrumentation to prove check_cache/save_to_cache run off the main
    event-loop thread (i.e. actually wrapped in asyncio.to_thread)."""
    db = {}
    call_threads = {"check_cache": set(), "save_to_cache": set()}

    def make_cache_key(profile):
        return f"{profile['mood']}|{profile['style']}|{profile['bpm']}|{profile['duration_seconds']}"

    def check_cache(cache_key):
        call_threads["check_cache"].add(threading.current_thread())
        return db.get(cache_key)

    def save_to_cache(cache_key, mp3_bytes, profile, loop_point_ms, gen_time_ms, prompt):
        call_threads["save_to_cache"].add(threading.current_thread())
        db[cache_key] = {"audio_url": f"fake://{cache_key}"}
        return db[cache_key]["audio_url"]

    return {
        "db": db,
        "make_cache_key": make_cache_key,
        "check_cache": check_cache,
        "save_to_cache": save_to_cache,
        "call_threads": call_threads,
    }


@pytest.mark.asyncio
async def test_fresh_grid_generates_everything(call_log, fake_cache):
    import prewarm
    expected = len(prewarm.PREWARM_MOODS) * len(prewarm.PREWARM_STYLES) * len(prewarm.PREWARM_BPMS)

    await prewarm.prewarm_cache(
        fake_cache["make_cache_key"], fake_cache["check_cache"], fake_cache["save_to_cache"]
    )

    assert len(fake_cache["db"]) == expected
    assert sum(call_log) == expected
    import d3_generate as d3
    assert all(size <= d3.MAX_BATCH_SIZE for size in call_log)


@pytest.mark.asyncio
async def test_warm_cache_generates_nothing(call_log, fake_cache):
    import prewarm
    # first pass warms everything
    await prewarm.prewarm_cache(
        fake_cache["make_cache_key"], fake_cache["check_cache"], fake_cache["save_to_cache"]
    )
    call_log.clear()

    # second pass on an already-warm cache should fire zero generations
    await prewarm.prewarm_cache(
        fake_cache["make_cache_key"], fake_cache["check_cache"], fake_cache["save_to_cache"]
    )
    assert len(call_log) == 0


@pytest.mark.asyncio
async def test_partial_cache_only_fills_the_gap(call_log, fake_cache):
    import prewarm
    from models import MusicProfile

    combos = [
        (m, s, b)
        for m in prewarm.PREWARM_MOODS
        for s in prewarm.PREWARM_STYLES
        for b in prewarm.PREWARM_BPMS.values()
    ]
    expected = len(combos)

    # pre-seed the first 5 combos as already cached
    for mood, style, bpm in combos[:5]:
        profile = MusicProfile(mood=mood, style=style, bpm=bpm, duration_seconds=prewarm.PREWARM_DURATION_SECONDS).model_dump()
        key = fake_cache["make_cache_key"](profile)
        fake_cache["db"][key] = {"audio_url": "already-warm"}

    await prewarm.prewarm_cache(
        fake_cache["make_cache_key"], fake_cache["check_cache"], fake_cache["save_to_cache"]
    )

    assert len(fake_cache["db"]) == expected
    assert sum(call_log) == expected - 5


@pytest.mark.asyncio
async def test_cache_io_runs_off_the_event_loop_thread(call_log, fake_cache):
    """
    Regression test: check_cache/save_to_cache are blocking calls (Supabase
    REST or psycopg2). They must run via asyncio.to_thread, not directly on
    the event loop, or a slow/hanging call blocks the whole server.
    """
    import prewarm

    main_thread = threading.current_thread()

    await prewarm.prewarm_cache(
        fake_cache["make_cache_key"], fake_cache["check_cache"], fake_cache["save_to_cache"]
    )

    check_threads = fake_cache["call_threads"]["check_cache"]
    save_threads = fake_cache["call_threads"]["save_to_cache"]

    assert len(check_threads) > 0, "check_cache was never called"
    assert len(save_threads) > 0, "save_to_cache was never called"
    assert main_thread not in check_threads, "check_cache ran on the event-loop thread (blocking!)"
    assert main_thread not in save_threads, "save_to_cache ran on the event-loop thread (blocking!)"