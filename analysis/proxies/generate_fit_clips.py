"""S-D' step 2 — generate the matched clips (one per page x seed) through a running Feature D.

    # Feature D on the GPU, one setting for the whole run:
    #   W2M_COMPILE=0 uvicorn main:app --port 8000        (from audio-generation/)
    python analysis/proxies/generate_fit_clips.py \
        --profiles analysis/proxies/out/profiles.json \
        --clips-dir analysis/proxies/out/clips --seeds 3 --duration 15 \
        --base-url http://127.0.0.1:8000

The run is RESUMABLE: a clip that already exists on disk is skipped, and the
manifest is rewritten after every page, so an overnight run that is interrupted
(sleep, driver reset, power) loses at most one clip. Run it twice if the first
night did not finish; the second run does only what is missing.

Every request carries the page's own profile exactly as Feature B produced it
(profiles.json -> `profile`), a unique nonce so the cache never answers, and a
fixed seed from the shared pool (audio-generation/experiments/_dcommon.seeds), so
the same page gets the same seeds on every generator and every rerun. Fallback
responses are recorded as failures, not as clips.

Output: <clips-dir>/<page-id>__s<k>.ogg and <clips-dir>/manifest.json
        {"generator": {...}, "seeds": [...], "pages": {id: {"seed_k": {"clip", "wall_ms", "error"}}}}
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "audio-generation"))
sys.path.insert(0, str(REPO / "audio-generation" / "experiments"))

from _dcommon import fetch_audio, hardware_manifest, health, request, seeds  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profiles", default="analysis/proxies/out/profiles.json")
    ap.add_argument("--clips-dir", default="analysis/proxies/out/clips")
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--duration", type=int, default=15)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--limit", type=int, default=0, help="only the first N pages (smoke test)")
    args = ap.parse_args()

    profiles = json.loads((REPO / args.profiles).read_text(encoding="utf-8"))
    if args.limit:
        profiles = profiles[: args.limit]
    clips_dir = REPO / args.clips_dir
    clips_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = clips_dir / "manifest.json"
    manifest = (json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists()
                else {"pages": {}})

    _body, err = health(args.base_url)
    if err:
        print(f"Cannot reach Feature D at {args.base_url} ({err})", file=sys.stderr)
        return 1
    seed_list = seeds(args.seeds)
    manifest.update(generator=hardware_manifest(args.base_url), seeds=seed_list, duration_seconds=args.duration)

    done = failed = 0
    started = time.time()
    for n, page in enumerate(profiles, 1):
        entry = manifest["pages"].setdefault(page["id"], {})
        for k, seed in enumerate(seed_list):
            key = f"s{k}"
            clip = clips_dir / f"{page['id']}__{key}.ogg"
            if clip.exists() and entry.get(key, {}).get("clip"):
                continue
            payload = {**page["profile"], "duration_seconds": args.duration, "seed_override": seed,
                       "nonce": f"fit-{page['id']}-{key}-{seed}"}
            wall_ms, resp, rerr = request(f"{args.base_url}/generate", payload, timeout=args.timeout)
            meta = (resp or {}).get("metadata") or {}
            if rerr or not resp or meta.get("is_fallback") or not resp.get("audio_url"):
                entry[key] = {"clip": None, "wall_ms": round(wall_ms, 1),
                              "error": rerr or ("fallback served" if meta.get("is_fallback") else "no audio_url")}
                failed += 1
                continue
            audio, aerr = fetch_audio(resp["audio_url"])
            if not audio:
                entry[key] = {"clip": None, "wall_ms": round(wall_ms, 1), "error": aerr}
                failed += 1
                continue
            clip.write_bytes(audio)
            entry[key] = {"clip": clip.name, "wall_ms": round(wall_ms, 1), "error": None,
                          "generation_seed": meta.get("generation_seed")}
            done += 1
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        elapsed = time.time() - started
        print(f"  [{n}/{len(profiles)}] {page['id']}  ok={done} failed={failed}  "
              f"{elapsed / 60:.1f} min elapsed", flush=True)

    print(f"done: {done} new clip(s), {failed} failure(s); manifest -> {manifest_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
