import asyncio
import pytest


@pytest.mark.asyncio
async def test_single_call_runs_as_batch_of_one(call_log):
    import d3_generate as d3
    audio_bytes, seed = await d3.generate_audio("solo prompt", duration_seconds=28)
    assert call_log == [1]
    assert len(audio_bytes) > 0


@pytest.mark.asyncio
async def test_concurrent_calls_coalesce_into_one_batch(call_log):
    import d3_generate as d3
    results = await asyncio.gather(
        d3.generate_audio("prompt A", duration_seconds=28),
        d3.generate_audio("prompt B", duration_seconds=28),
        d3.generate_audio("prompt C", duration_seconds=28),
        d3.generate_audio("prompt D", duration_seconds=28),
    )
    assert sum(call_log) == 4
    assert len(call_log) < 4, f"expected batching to reduce call count, got {call_log}"
    for audio_bytes, seed in results:
        assert len(audio_bytes) > 0


@pytest.mark.asyncio
async def test_ten_concurrent_calls_respect_max_batch_size(call_log):
    import d3_generate as d3
    results = await asyncio.gather(*[
        d3.generate_audio(f"prompt {i}", duration_seconds=28) for i in range(10)
    ])
    assert sum(call_log) == 10
    assert all(size <= d3.MAX_BATCH_SIZE for size in call_log), call_log


@pytest.mark.asyncio
async def test_mixed_durations_in_one_batch_are_trimmed_per_item(call_log):
    """
    Regression test: a batch containing both a short and a long duration
    request must return each caller their OWN requested duration, not the
    longest duration in the batch for everyone.
    """
    import d3_generate as d3
    import soundfile as sf
    import io

    short_result, long_result = await asyncio.gather(
        d3.generate_audio("short prompt", duration_seconds=10),
        d3.generate_audio("long prompt", duration_seconds=28),
    )
    # both requests should have landed in the same batch
    assert call_log == [2], f"expected both requests batched together, got {call_log}"

    short_bytes, _ = short_result
    long_bytes, _ = long_result

    short_data, short_sr = sf.read(io.BytesIO(short_bytes))
    long_data, long_sr = sf.read(io.BytesIO(long_bytes))

    short_duration = len(short_data) / short_sr
    long_duration = len(long_data) / long_sr

    # allow a small tolerance for WAV frame rounding
    assert abs(short_duration - 10) < 0.5, f"short request got {short_duration:.2f}s, expected ~10s"
    assert abs(long_duration - 28) < 0.5, f"long request got {long_duration:.2f}s, expected ~28s"
    assert short_duration < long_duration