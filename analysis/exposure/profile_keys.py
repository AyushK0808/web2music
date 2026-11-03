"""Cache keys of the real page profiles, and how many of them the pre-warm grid covers.

    python analysis/exposure/profile_keys.py \
        --profiles analysis/proxies/out/profiles.json --out analysis/exposure/profile_keys.json

simulate_exposure.py takes the output as --profile-keys: it replaces its assumed
share of grid hits with the measured one, and draws off-grid keys from the real
profiles instead of a synthetic Zipf key space.

Run it with the audio-generation environment (it imports the service's own
make_cache_key, so the keys are exactly the ones the cache would use). It does
not import prewarm.py, which would load the generator onto the GPU; the grid
constants are read from that file's source instead.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
AG = REPO / "audio-generation"


def prewarm_constants():
    """PREWARM_* literals from prewarm.py, without executing the module."""
    tree = ast.parse((AG / "prewarm.py").read_text(encoding="utf-8"))
    want = {"PREWARM_MOODS", "PREWARM_STYLES", "PREWARM_BPMS", "PREWARM_DURATION_SECONDS"}
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and getattr(node.targets[0], "id", None) in want:
            found[node.targets[0].id] = ast.literal_eval(node.value)
    missing = want - found.keys()
    if missing:
        raise SystemExit(f"could not read {sorted(missing)} from prewarm.py")
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profiles", default="analysis/proxies/out/profiles.json")
    ap.add_argument("--out", default="analysis/exposure/profile_keys.json")
    ap.add_argument("--duration", type=int, default=None,
                    help="duration used for the profiles' keys (default: the pre-warm duration, so both sides share a bucket)")
    args = ap.parse_args()

    sys.path.insert(0, str(AG))
    from d5_cache_local import make_cache_key   # noqa: E402
    from models import MusicProfile             # noqa: E402

    c = prewarm_constants()
    dur = args.duration or c["PREWARM_DURATION_SECONDS"]
    grid = {make_cache_key(MusicProfile(mood=m, style=s, bpm=b, duration_seconds=c["PREWARM_DURATION_SECONDS"]).model_dump())
            for m in c["PREWARM_MOODS"] for s in c["PREWARM_STYLES"] for b in c["PREWARM_BPMS"].values()}

    profiles = json.loads((REPO / args.profiles).read_text(encoding="utf-8"))
    base = MusicProfile().model_dump()
    rows = [{"id": p["id"], "mood": p["mood"],
             "key": make_cache_key({**base, **p["profile"], "duration_seconds": dur})} for p in profiles]
    hits = sum(1 for r in rows if r["key"] in grid)

    out = {"n_profiles": len(rows), "n_grid_keys": len(grid), "grid_hits": hits,
           "grid_hit_measured": hits / len(rows) if rows else None,
           "n_distinct_keys": len({r["key"] for r in rows}),
           "duration_s": dur, "profiles": rows}
    path = REPO / args.out
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"{len(rows)} profiles -> {out['n_distinct_keys']} distinct keys; "
          f"{hits} in the {len(grid)}-key pre-warm grid (measured grid_hit = {out['grid_hit_measured']:.3f}); wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
