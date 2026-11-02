"""Shared plumbing for the D-side ablations (C-06, C-07).

Both scripts drive a *running* Feature D over HTTP for the same reason
``d4_latency.py`` does: the numbers that matter are the ones a caller
experiences, and calling ``process_audio()`` in a loop measures a system
nobody ships.

Both also need the objective quality metrics that ``d2_loop_test.py``
computes, so those live here rather than being copied into each script and
drifting apart.
"""

from __future__ import annotations

import io
import json
import os
import platform
import random
import shutil
import statistics
import subprocess
import time
import sys
import urllib.error
import urllib.request

# Windows consoles default to cp1252 and these scripts print em-dashes and
# arrows. Replace rather than crash: a mangled character in a progress line is
# a cosmetic problem, a UnicodeEncodeError two hours into a generation sweep is
# a lost run.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# ── HTTP, matching d4_latency.py's contract ────────────────────────────────

def request(url, payload=None, timeout=600):
    """One request → (wall_ms, parsed_body, error). Never raises."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method="POST" if data else "GET",
        headers={"Content-Type": "application/json"} if data else {},
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
        return (time.perf_counter() - started) * 1000, json.loads(body), None
    except urllib.error.HTTPError as e:
        return ((time.perf_counter() - started) * 1000, None,
                f"HTTP {e.code}: {e.read().decode(errors='replace')[:200]}")
    except Exception as e:
        return (time.perf_counter() - started) * 1000, None, f"{type(e).__name__}: {e}"


def fetch_audio(url, timeout=120):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.read(), None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def health(base_url):
    _ms, body, err = request(f"{base_url}/health", timeout=10)
    return body, err


# ── Objective quality, the same measurements d2_loop_test.py reports ───────

def analyse_clip(audio_bytes: bytes) -> dict:
    """Seam discontinuity (pre and post crossfade), loudness, duration.

    Imported lazily so a run that only wants latency does not pay librosa's
    import cost, and so this module stays importable in an environment without
    the audio stack (the --dry-run paths use it).
    """
    import numpy as np
    import pyloudnorm as pyln
    import soundfile as sf
    from pydub import AudioSegment

    from d4_process import _seam_discontinuity, CROSSFADE_MS

    seg = AudioSegment.from_file(io.BytesIO(audio_bytes))
    if seg.channels > 1:
        seg = seg.set_channels(1)

    # The delivered clip is already crossfaded, so this is the *post* value.
    post = _seam_discontinuity(seg, crossfade_ms=CROSSFADE_MS)

    samples = np.array(seg.get_array_of_samples()).astype(np.float32)
    samples /= np.iinfo(seg.array_type).max
    try:
        meter = pyln.Meter(seg.frame_rate)
        lufs = float(meter.integrated_loudness(samples))
    except Exception:
        lufs = None

    return {
        "duration_ms": len(seg),
        "sample_rate": seg.frame_rate,
        "post_energy_delta_db": post.get("energy_delta_db"),
        "post_spectral_centroid_delta_hz": post.get("spectral_centroid_delta_hz"),
        "lufs": lufs,
        "rms_dbfs": seg.dBFS,
    }


# ── Stats, matching d4_latency.py so numbers are comparable across scripts ──

def percentile(values, p):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    idx = max(0, min(len(vals) - 1, int(round((p / 100.0) * len(vals) + 0.5)) - 1))
    return vals[idx]


def summarise(values):
    clean = [v for v in values if v is not None]
    if not clean:
        return {"n": 0}
    return {
        "n": len(clean),
        "min": round(min(clean), 3),
        "p50": round(percentile(clean, 50), 3),
        "p95": round(percentile(clean, 95), 3),
        "max": round(max(clean), 3),
        "mean": round(statistics.fmean(clean), 3),
        "stdev": round(statistics.stdev(clean), 3) if len(clean) > 1 else 0.0,
    }


# ── C-5: fixed seed lists ──────────────────────────────────────────────────
# Seeds are part of the experimental design, not an implementation detail: the
# paper reports them, the paired tests pair on them, and a rerun must reproduce
# the same set. Lists are drawn once from a fixed generator so "20 seeds" is
# the same 20 numbers everywhere. Prefixes are nested (seeds(5) is the first 5
# of seeds(20)) so a smaller run is a subset of a larger one.
SEED_POOL_SEED = 20260611


def seeds(n: int) -> list:
    rng = random.Random(SEED_POOL_SEED)
    return [rng.randrange(1, 2**31 - 1) for _ in range(n)]


# ── E-4: hardware / software manifest, written into every result JSON ──────

def _cmd(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=15).stdout.strip() or None
    except Exception:
        return None


def hardware_manifest(base_url=None) -> dict:
    """GPU SKU, driver, CUDA, torch, precision and generator setting.

    Generator / precision / compile come from the running service's /health
    (so the record describes the process that was actually timed), everything
    else from this machine. Laptop-vs-desktop and the power plan cannot be
    detected reliably: they are read from W2M_FORM_FACTOR / W2M_POWER_PLAN so
    the operator states them once per session (E-5).
    """
    m = {
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpu": platform.processor() or None,
        "form_factor": os.getenv("W2M_FORM_FACTOR"),
        "power_plan": os.getenv("W2M_POWER_PLAN"),
        "nvidia_smi": None,
        "torch": None,
        "generator": None,
    }
    if shutil.which("nvidia-smi"):
        m["nvidia_smi"] = _cmd(["nvidia-smi", "--query-gpu=name,driver_version,memory.total",
                                "--format=csv,noheader"])
    try:
        import torch
        m["torch"] = {"version": torch.__version__, "cuda": torch.version.cuda,
                      "cuda_available": torch.cuda.is_available(),
                      "capability": list(torch.cuda.get_device_capability(0))
                      if torch.cuda.is_available() else None}
    except Exception:
        pass
    if base_url:
        body, _err = health(base_url)
        if body:
            m["generator"] = body.get("generator")
    return m


def bootstrap_ci(values, stat=statistics.median, n_boot=10000, alpha=0.05, seed=0):
    """Percentile bootstrap CI. Returns (point, lo, hi); (None,)*3 if empty."""
    vals = [v for v in values if v is not None]
    if not vals:
        return None, None, None
    rng = random.Random(seed)
    n = len(vals)
    boots = sorted(stat([vals[rng.randrange(n)] for _ in range(n)]) for _ in range(n_boot))
    lo = boots[int((alpha / 2) * n_boot)]
    hi = boots[min(n_boot - 1, int((1 - alpha / 2) * n_boot))]
    return stat(vals), lo, hi


MOOD_PROFILES = {
    "calm":      {"bpm": 65,  "key": "C major",  "energy": 0.25, "style": "ambient"},
    "focused":   {"bpm": 85,  "key": "A minor",  "energy": 0.45, "style": "minimal"},
    "joyful":    {"bpm": 110, "key": "G major",  "energy": 0.70, "style": "acoustic"},
    "energetic": {"bpm": 128, "key": "E major",  "energy": 0.90, "style": "electronic"},
    "sad":       {"bpm": 60,  "key": "D minor",  "energy": 0.20, "style": "cinematic"},
    "dark":      {"bpm": 70,  "key": "F minor",  "energy": 0.40, "style": "cinematic"},
    "nostalgic": {"bpm": 75,  "key": "Bb major", "energy": 0.35, "style": "lo-fi"},
    "curious":   {"bpm": 95,  "key": "D major",  "energy": 0.55, "style": "playful"},
    "tense":     {"bpm": 100, "key": "C minor",  "energy": 0.75, "style": "cinematic"},
    "uplifting": {"bpm": 105, "key": "A major",  "energy": 0.65, "style": "ambient"},
    "neutral":   {"bpm": 80,  "key": "C major",  "energy": 0.50, "style": "ambient"},
}


def payload_for(mood, duration_seconds=15, nonce=None, prompt=None, **overrides):
    base = MOOD_PROFILES.get(mood, MOOD_PROFILES["neutral"])
    p = {"mood": mood, "duration_seconds": duration_seconds, **base, **overrides}
    if nonce:
        p["nonce"] = nonce
    if prompt is not None:
        p["prompt"] = prompt
    return p


# ── paired statistics for the seed studies (S-G) ───────────────────────────

def paired_wilcoxon(a, b):
    """Wilcoxon signed-rank on paired samples. Returns {n, statistic, p}."""
    from scipy.stats import wilcoxon
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None and x != y]
    if len(pairs) < 6:
        return {"n": len(pairs), "statistic": None, "p": None}
    res = wilcoxon([p[0] for p in pairs], [p[1] for p in pairs])
    return {"n": len(pairs), "statistic": float(res.statistic), "p": float(res.pvalue)}


def mcnemar_exact(flags_a, flags_b):
    """Exact McNemar test for paired booleans (two-sided binomial on discordant pairs)."""
    from math import comb
    b = sum(1 for x, y in zip(flags_a, flags_b) if x and not y)
    c = sum(1 for x, y in zip(flags_a, flags_b) if y and not x)
    n = b + c
    if n == 0:
        return {"a_only": b, "b_only": c, "p": 1.0}
    k = min(b, c)
    p = min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)
    return {"a_only": b, "b_only": c, "p": p}
