#!/usr/bin/env python3
"""
d1_prompt_ablation.py — C-06 / plan §7 ablation 2: does the prompt engineering
do work the model would have done anyway?

    # Terminal 1
    uvicorn main:app --port 8000
    # Terminal 2
    python experiments/d1_prompt_ablation.py --moods calm,tense,energetic --repeats 3
    python experiments/d1_prompt_ablation.py --dry-run     # prompts only, no generation

Three prompt conditions, everything else held fixed — same mood profile, same
duration, same seed where the backend honours one:

  P1  bare        just the mood word. The floor: "calm".
  P2  d2 fallback `d2_prompt.build_prompt` with no B4 prompt supplied — the
                  template Feature D writes for itself from the profile.
  P3  b4          Feature B's engineered prompt, which is what production
                  actually sends (build_prompt prefers it whenever it is
                  longer than 20 characters).

§7 asks whether P3 earns its complexity over P2. Right now the honest answer
is that nobody has checked, and the ablation is cheap because both prompt
builders already exist.

── What is measured, and what is not ──────────────────────────────────────
Objective only: seam discontinuity after the crossfade, delivered duration and
its ratio to the request, loudness, and generation latency. Those are the
metrics `d2_loop_test.py` already reports, computed the same way, so numbers
from the two scripts are comparable.

What this cannot measure is whether the music is *better*, which is the actual
question P3 exists to answer. A prompt condition can win on every number here
and still produce worse music. §7 pairs this with a small preference test for
exactly that reason, and this script's output is one half of that pair — it is
written to say so rather than to let a reader assume otherwise.

── Cache ──────────────────────────────────────────────────────────────────
Every request carries a unique nonce. Without one, the second condition for a
given mood would hit D5's cache and return the *first* condition's audio, and
the ablation would report three identical rows and call it a null result.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from d2_prompt import build_prompt  # noqa: E402
from experiments._dcommon import (  # noqa: E402
    MOOD_PROFILES, analyse_clip, fetch_audio, health, payload_for, request, summarise,
)

DEFAULT_BASE = os.getenv("D_BASE_URL", "http://127.0.0.1:8000")

# A stand-in for Feature B's B4 prompt. In production this arrives on the
# handoff; here it is reconstructed from b4_promptEngineer.js's shape so the
# condition is reproducible without running the extension. Recorded verbatim in
# the output so a reader can see exactly what P3 was.
B4_TEMPLATE = (
    "{mood} {style} instrumental for {context}, {bpm} bpm in {key}, "
    "{energy_words}, featuring {instruments}, {timbre} timbre with "
    "{reverb_words} reverb, evolving gently, no vocals, no percussion hits at "
    "the loop point, seamless and loopable, high quality studio recording"
)

B4_CONTEXT = {
    "calm": "quiet focused reading", "focused": "deep work at a desk",
    "joyful": "a bright morning", "energetic": "an active session",
    "sad": "a reflective moment", "dark": "a tense narrative",
    "nostalgic": "looking back", "curious": "exploring something new",
    "tense": "a suspenseful passage", "uplifting": "a hopeful moment",
    "neutral": "background listening",
}
B4_INSTRUMENTS = {
    "calm": "soft piano, warm pads and distant strings",
    "focused": "muted piano, minimal synth and light texture",
    "joyful": "acoustic guitar, bright keys and hand percussion",
    "energetic": "analog synth, driving bass and crisp percussion",
    "sad": "solo piano, cello and low strings",
    "dark": "orchestral strings, bass drones and low brass",
    "nostalgic": "vintage piano, tape-saturated strings and soft rhodes",
    "curious": "marimba, electronic bells and plucked synth",
    "tense": "tremolo strings, pulse synth and low percussion",
    "uplifting": "piano, gentle synth pads and airy strings",
    "neutral": "ambient synth pads and soft texture",
}


def b4_prompt(mood: str) -> str:
    p = MOOD_PROFILES.get(mood, MOOD_PROFILES["neutral"])
    energy = p["energy"]
    return B4_TEMPLATE.format(
        mood=mood, style=p["style"], context=B4_CONTEXT.get(mood, "background listening"),
        bpm=p["bpm"], key=p["key"],
        energy_words=("very low energy and minimal" if energy < 0.3
                      else "moderate energy and flowing" if energy < 0.6
                      else "high energy and dynamic"),
        instruments=B4_INSTRUMENTS.get(mood, "ambient pads"),
        timbre="warm" if energy < 0.6 else "bright",
        reverb_words="generous" if energy < 0.4 else "restrained",
    )


def conditions_for(mood: str) -> dict[str, str]:
    profile = {"mood": mood, **MOOD_PROFILES.get(mood, MOOD_PROFILES["neutral"])}
    return {
        "P1_bare": mood,
        # build_prompt only uses its own template when the B-supplied prompt is
        # absent or shorter than 20 chars — pass None to force that branch.
        "P2_d2_fallback": build_prompt(profile, None),
        "P3_b4_engineered": b4_prompt(mood),
    }


def run(base_url, moods, repeats, duration, timeout, dry_run):
    rows = []
    for mood in moods:
        conds = conditions_for(mood)
        for cond_name, prompt in conds.items():
            for i in range(repeats):
                if dry_run:
                    rows.append({"mood": mood, "condition": cond_name, "iteration": i,
                                 "prompt": prompt, "prompt_chars": len(prompt), "dry_run": True})
                    continue

                nonce = f"pa-{cond_name}-{mood}-{i}-{int(time.time()*1000)}"
                payload = payload_for(mood, duration_seconds=duration, nonce=nonce, prompt=prompt)
                wall_ms, body, err = request(f"{base_url}/generate", payload, timeout=timeout)

                row = {
                    "mood": mood, "condition": cond_name, "iteration": i,
                    "prompt": prompt, "prompt_chars": len(prompt),
                    "wall_ms": round(wall_ms, 1), "error": err,
                }
                if body:
                    meta = body.get("metadata") or {}
                    row.update(
                        cache=body.get("cache"),
                        is_fallback=bool(meta.get("is_fallback")),
                        generation_seed=meta.get("generation_seed"),
                        prompt_used=meta.get("prompt"),
                        timings=body.get("timings") or {},
                        audio_url=body.get("audio_url"),
                    )
                    # A fallback clip is not this condition's audio, so it is
                    # recorded and then excluded from the quality summary
                    # rather than averaged in as if it were a generation.
                    if body.get("audio_url") and not meta.get("is_fallback"):
                        audio, aerr = fetch_audio(body["audio_url"])
                        if audio:
                            try:
                                row["quality"] = analyse_clip(audio)
                            except Exception as e:
                                row["quality_error"] = f"{type(e).__name__}: {e}"
                        else:
                            row["quality_error"] = aerr
                rows.append(row)

                q = row.get("quality") or {}
                print(f"  {mood:<10} {cond_name:<18} #{i}  "
                      f"{row['wall_ms']/1000:7.1f}s  "
                      f"{'FALLBACK ' if row.get('is_fallback') else ''}"
                      f"seam {q.get('post_energy_delta_db', float('nan')):6.2f} dB  "
                      f"dur {q.get('duration_ms', 0)/1000:5.1f}s"
                      f"{'  ERROR ' + row['error'][:40] if row.get('error') else ''}")
    return rows


def report(rows, duration):
    conds = sorted({r["condition"] for r in rows})
    print("\n" + "=" * 78)
    print("PROMPT ABLATION — objective summary")
    print("=" * 78)

    out = {}
    for cond in conds:
        rs = [r for r in rows if r["condition"] == cond]
        generated = [r for r in rs if r.get("quality") and not r.get("is_fallback")]
        seam = [r["quality"]["post_energy_delta_db"] for r in generated]
        cent = [r["quality"]["post_spectral_centroid_delta_hz"] for r in generated]
        lufs = [r["quality"]["lufs"] for r in generated]
        ratio = [r["quality"]["duration_ms"] / (duration * 1000) for r in generated]
        walls = [r.get("wall_ms") for r in rs]
        gen_ms = [(r.get("timings") or {}).get("d3_generate_ms") for r in rs]

        out[cond] = {
            "n_requests": len(rs),
            "n_generated": len(generated),
            "fallback_rate": round(sum(1 for r in rs if r.get("is_fallback")) / len(rs), 3) if rs else None,
            "error_rate": round(sum(1 for r in rs if r.get("error")) / len(rs), 3) if rs else None,
            "prompt_chars": summarise([r["prompt_chars"] for r in rs]),
            "seam_energy_delta_db": summarise([abs(v) for v in seam if v is not None]),
            "seam_centroid_delta_hz": summarise([abs(v) for v in cent if v is not None]),
            "lufs": summarise(lufs),
            "duration_retention": summarise(ratio),
            "wall_ms": summarise(walls),
            "d3_generate_ms": summarise(gen_ms),
        }
        s = out[cond]
        print(f"\n{cond}  (n={s['n_generated']} generated of {s['n_requests']} requests, "
              f"fallback {s['fallback_rate']})")
        print(f"  prompt length      {s['prompt_chars'].get('p50')} chars")
        print(f"  |seam energy|      p50 {s['seam_energy_delta_db'].get('p50')} dB")
        print(f"  duration retention p50 {s['duration_retention'].get('p50')}")
        print(f"  d3_generate        p50 {s['d3_generate_ms'].get('p50')} ms")

    print("\n" + "-" * 78)
    print("What this does NOT say: nothing here measures whether the music is better.")
    print("A prompt can win on every number above and still sound worse. §7 pairs this")
    print("with a preference test; report the two together or neither.")
    print("=" * 78)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--moods", default="calm,focused,tense,energetic,sad")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--duration", type=int, default=15)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the three prompts per mood and exit — no generation")
    ap.add_argument("--out", default="results/d1-prompt-ablation.json")
    args = ap.parse_args()

    moods = [m.strip() for m in args.moods.split(",") if m.strip()]

    if args.dry_run:
        for mood in moods:
            print(f"\n{mood}")
            for name, prompt in conditions_for(mood).items():
                print(f"  {name:<18} ({len(prompt):3d} chars)  {prompt}")
        return 0

    body, err = health(args.base_url)
    if err:
        print(f"Cannot reach Feature D at {args.base_url} ({err}).\n"
              f"Start it with:  uvicorn main:app --port 8000", file=sys.stderr)
        return 1
    print(f"[d1_prompt_ablation] backend up: {json.dumps(body)[:120]}")
    print(f"[d1_prompt_ablation] {len(moods)} mood(s) x 3 conditions x {args.repeats} "
          f"repeat(s) = {len(moods) * 3 * args.repeats} generations at {args.duration}s each.\n"
          f"  Every request carries a nonce, so none of them will hit the cache — this is a "
          f"long run on CPU. Budget accordingly.\n")

    started = time.time()
    rows = run(args.base_url, moods, args.repeats, args.duration, args.timeout, False)
    summary = report(rows, args.duration)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "elapsed_s": round(time.time() - started, 1),
        "config": {"base_url": args.base_url, "moods": moods, "repeats": args.repeats,
                   "duration_seconds": args.duration},
        "b4_template": B4_TEMPLATE,
        "summary": summary,
        "rows": rows,
    }, indent=2), encoding="utf-8")
    print(f"\nWrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
