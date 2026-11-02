"""S-D' — conditioning-fidelity proxies (replaces the listening study for R3 W1 / R4 #2).

    # 1. extract features once per clip (GPU/CPU heavy, resumable, no statistics)
    python analysis/proxies/score_fit.py extract \
        --profiles analysis/proxies/out/profiles.json \
        --clips-dir analysis/proxies/out/clips \
        --fixed-clips-dir analysis/proxies/out/fixed-clips \
        --essentia-models models/essentia --clap-ckpt models/clap/music_audioset_epoch_15_esc_90.14.pt \
        --out analysis/proxies/out/features.json
    # 2. statistics from the cached features (seconds)
    python analysis/proxies/score_fit.py analyse \
        --profiles analysis/proxies/out/profiles.json --features analysis/proxies/out/features.json \
        --out analysis/proxies/out/fit_results.json
    python analysis/proxies/score_fit.py --self-test

What this measures, and what it does not
  Whether the audio generated for a page agrees with the mood/valence/arousal the
  system intended for that page, better than audio generated for a page of a
  different mood does. That is CONDITIONING FIDELITY. It is not perceived fit: no
  listener is involved, and the paper never says "suits the page".

Conditions, per (page, seed)
  matched    the clip generated from the page's own profile
  shuffled   a clip from another page whose mood is >= 2 steps away in
             valence-arousal space (same rule as analysis/s4/assignment.mjs); it
             costs no extra generation: it re-uses other pages' clips
  fixed      one page-agnostic prompt (optional --fixed-clips-dir)

Proxies (all non-generative scorers: no LLM or audio-language model judges anything, L-7)
  1. valence/arousal   Essentia emoMusic regressors on MusiCNN embeddings. Spearman
                       correlation between the intended and predicted values over
                       matched clips; paired distance matched vs shuffled.
  2. mood tags         Essentia MTG-Jamendo mood/theme tagger. Whether the intended
                       mood's tag set (MOOD_TAGS, fixed BEFORE scoring) intersects the
                       top-K predicted tags; paired matched vs shuffled.
  3. CLAP retrieval    LAION-CLAP music checkpoint. A page's own clip is ranked among
                       10 candidates (itself + 9 clips of other pages) by similarity to the
                       page's title + lead text (chance = 10% top-1). Also the paired
                       text<->audio similarity, matched vs shuffled.
  4. quality           Audiobox Aesthetics (CE, CU, PC, PQ) per clip; FAD over CLAP
                       embeddings against --fad-reference (embedding model named in the output).

Statistics: paired Wilcoxon on matched - shuffled, 10k-sample bootstrap CIs over
pages, and (if statsmodels is installed) a mixed model with random effects for page
and seed.

Caveats written into the output (the paper repeats them): CLAP is trained on music
captions, not web pages; the mood->tag mapping is an assumption; generator-vs-prompt
agreement measures whether the generator follows its prompt, which is why page-text
vs audio is the primary CLAP measure.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# ── fixed design choices (committed before any score is computed) ─────────────

VALENCE = {"calm": 0.5, "focused": 0.4, "joyful": 0.9, "energetic": 0.8, "sad": -0.7, "dark": -0.8,
           "nostalgic": 0.2, "curious": 0.5, "tense": -0.5, "uplifting": 0.9, "neutral": 0.0}
AROUSAL = {"calm": 0.15, "focused": 0.35, "joyful": 0.75, "energetic": 0.95, "sad": 0.20, "dark": 0.40,
           "nostalgic": 0.30, "curious": 0.55, "tense": 0.80, "uplifting": 0.65, "neutral": 0.50}
MOODS = list(VALENCE)

# MTG-Jamendo mood/theme tags that count as agreeing with each intended mood.
# An assumption: stated in the paper, fixed here before any clip is scored.
MOOD_TAGS = {
    "calm": {"calm", "relaxing", "meditative", "soft", "dream"},
    "focused": {"background", "melodic", "film", "documentary", "advertising", "corporate"},
    "joyful": {"happy", "fun", "positive", "upbeat", "summer"},
    "energetic": {"energetic", "powerful", "fast", "sport", "action"},
    "sad": {"sad", "melancholic", "emotional", "slow", "love"},
    "dark": {"dark", "deep", "heavy", "epic", "dramatic"},
    "nostalgic": {"nostalgia", "melancholic", "emotional", "romantic", "retro"},
    "curious": {"adventure", "movie", "trailer", "inspiring", "space"},
    "tense": {"dark", "dramatic", "epic", "heavy", "action"},
    "uplifting": {"uplifting", "inspiring", "hopeful", "positive", "motivational"},
    "neutral": {"background", "documentary", "film", "melodic", "soft"},
}
TOP_K_TAGS = 5
N_CANDIDATES = 10          # CLAP retrieval: own clip + 9 distractors
N_BOOT = 10000


def va_distance(a: str, b: str) -> float:
    """Distance in valence-arousal space, valence rescaled to [0,1] (as analysis/s4/assignment.mjs)."""
    va = lambda m: ((VALENCE.get(m, 0) + 1) / 2, AROUSAL.get(m, 0.5))
    (x1, y1), (x2, y2) = va(a), va(b)
    return math.hypot(x1 - x2, y1 - y2)


def step_size(moods=MOODS) -> float:
    nearest = sorted(min(va_distance(m, o) for o in moods if o != m) for m in moods)
    mid = len(nearest) // 2
    return nearest[mid] if len(nearest) % 2 else (nearest[mid - 1] + nearest[mid]) / 2


MIN_SHUFFLE_DISTANCE = 2 * step_size()


def pick_shuffled(page_id: str, mood: str, pool: list[tuple[str, str]], seed_key: str) -> str | None:
    """A page id from `pool` [(id, mood)] whose mood is >= MIN_SHUFFLE_DISTANCE from `mood`."""
    ok = [pid for pid, m in pool if pid != page_id and va_distance(mood, m) >= MIN_SHUFFLE_DISTANCE]
    if not ok:
        return None
    return random.Random(f"{page_id}|{seed_key}").choice(sorted(ok))


# ── statistics helpers ────────────────────────────────────────────────────────

def bootstrap_ci(values, stat=statistics.fmean, n_boot=N_BOOT, seed=0):
    vals = [v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))]
    if not vals:
        return {"n": 0, "point": None, "ci95": None}
    rng = random.Random(seed)
    n = len(vals)
    boots = sorted(stat([vals[rng.randrange(n)] for _ in range(n)]) for _ in range(n_boot))
    return {"n": n, "point": stat(vals), "ci95": [boots[int(0.025 * n_boot)], boots[min(n_boot - 1, int(0.975 * n_boot))]]}


def wilcoxon(diffs):
    d = [x for x in diffs if x is not None and x != 0]
    if len(d) < 6:
        return {"n": len(d), "p": None}
    try:
        from scipy.stats import wilcoxon as _w
    except Exception:
        return {"n": len(d), "p": None, "note": "scipy unavailable"}
    r = _w(d)
    return {"n": len(d), "statistic": float(r.statistic), "p": float(r.pvalue)}


def _ranks(v):
    order = sorted(range(len(v)), key=v.__getitem__)
    ranks = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return ranks


def spearman(x, y):
    """Spearman rho (average ranks); p from scipy when available."""
    pairs = [(a, b) for a, b in zip(x, y) if a is not None and b is not None]
    if len(pairs) < 4:
        return {"n": len(pairs), "rho": None}
    rx, ry = _ranks([p[0] for p in pairs]), _ranks([p[1] for p in pairs])
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    out = {"n": len(pairs), "rho": num / den if den else None}
    try:
        from scipy.stats import spearmanr
        out["p"] = float(spearmanr([p[0] for p in pairs], [p[1] for p in pairs]).pvalue)
    except Exception:
        pass
    return out


def mixed_model(rows):
    """diff ~ 1 with random intercepts for page and a variance component for seed (optional dependency)."""
    try:
        import pandas as pd
        import statsmodels.formula.api as smf
    except Exception as e:
        return {"available": False, "reason": f"{type(e).__name__}: {e}"}
    df = pd.DataFrame(rows)
    if len(df) < 20:
        return {"available": False, "reason": "too few rows"}
    try:
        m = smf.mixedlm("diff ~ 1", df, groups=df["page"], vc_formula={"seed": "0 + C(seed)"}).fit()
        return {"available": True, "intercept": float(m.params["Intercept"]),
                "ci95": [float(x) for x in m.conf_int().loc["Intercept"]], "p": float(m.pvalues["Intercept"])}
    except Exception as e:
        return {"available": True, "error": f"{type(e).__name__}: {e}"}


def frechet_distance(a, b):
    import numpy as np
    from scipy import linalg
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    mu1, mu2 = a.mean(0), b.mean(0)
    s1, s2 = np.cov(a, rowvar=False), np.cov(b, rowvar=False)
    covmean, _ = linalg.sqrtm(s1.dot(s2), disp=False)
    if not np.isfinite(covmean).all():
        off = np.eye(s1.shape[0]) * 1e-6
        covmean = linalg.sqrtm((s1 + off).dot(s2 + off))
    covmean = covmean.real
    return float(((mu1 - mu2) ** 2).sum() + np.trace(s1) + np.trace(s2) - 2 * np.trace(covmean))


# ── feature extraction (heavy, lazy imports) ─────────────────────────────────

class Extractors:
    def __init__(self, essentia_dir, clap_ckpt, want_quality=True):
        self.essentia_dir, self.clap_ckpt = Path(essentia_dir), clap_ckpt
        self._load_essentia()
        self._load_clap()
        self.audiobox = self._load_audiobox() if want_quality else None

    def _load_essentia(self):
        try:
            from essentia.standard import (MonoLoader, TensorflowPredict2D, TensorflowPredictEffnetDiscogs,
                                           TensorflowPredictMusiCNN)
        except Exception as e:
            raise SystemExit(f"essentia-tensorflow is required for extract ({e}). Install it in WSL2/Linux: "
                             "pip install essentia-tensorflow  (there are no Windows wheels).")
        d = self.essentia_dir
        need = ["msd-musicnn-1.pb", "emomusic-msd-musicnn-2.pb", "discogs-effnet-bs64-1.pb",
                "mtg_jamendo_moodtheme-discogs-effnet-1.pb", "mtg_jamendo_moodtheme-discogs-effnet-1.json"]
        missing = [n for n in need if not (d / n).exists()]
        if missing:
            raise SystemExit(f"missing Essentia model files in {d}: {', '.join(missing)} "
                             "(download from https://essentia.upf.edu/models.html)")
        self.MonoLoader = MonoLoader
        self.musicnn = TensorflowPredictMusiCNN(graphFilename=str(d / "msd-musicnn-1.pb"), output="model/dense/BiasAdd")
        self.emo = TensorflowPredict2D(graphFilename=str(d / "emomusic-msd-musicnn-2.pb"), output="model/Identity")
        self.effnet = TensorflowPredictEffnetDiscogs(graphFilename=str(d / "discogs-effnet-bs64-1.pb"), output="PartitionedCall:1")
        self.mood = TensorflowPredict2D(graphFilename=str(d / "mtg_jamendo_moodtheme-discogs-effnet-1.pb"),
                                        input="serving_default_model_Placeholder", output="PartitionedCall:0")
        self.mood_labels = json.loads((d / "mtg_jamendo_moodtheme-discogs-effnet-1.json").read_text())["classes"]

    def _load_clap(self):
        try:
            import laion_clap
        except Exception as e:
            raise SystemExit(f"laion_clap is required for extract ({e}): pip install laion-clap")
        self.clap = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base")
        self.clap.load_ckpt(self.clap_ckpt)

    def _load_audiobox(self):
        try:
            from audiobox_aesthetics.infer import initialize_predictor
            return initialize_predictor()
        except Exception as e:
            print(f"[score_fit] Audiobox Aesthetics unavailable ({e}); quality proxy will be skipped", file=sys.stderr)
            return None

    def clip_features(self, path: Path) -> dict:
        import numpy as np
        audio = self.MonoLoader(filename=str(path), sampleRate=16000, resampleQuality=4)()
        va_raw = np.asarray(self.emo(self.musicnn(audio))).mean(axis=0)          # [valence, arousal] on 1..9
        tags = np.asarray(self.mood(self.effnet(audio))).mean(axis=0)
        top = [self.mood_labels[i] for i in np.argsort(tags)[::-1][:TOP_K_TAGS]]
        emb = self.clap.get_audio_embedding_from_filelist(x=[str(path)], use_tensor=False)[0]
        feat = {"valence": float((va_raw[0] - 5) / 4), "arousal": float((va_raw[1] - 1) / 8),
                "top_tags": top, "clap_audio": [float(v) for v in emb]}
        if self.audiobox:
            try:
                q = self.audiobox.forward([{"path": str(path)}])[0]
                feat["aesthetics"] = {k: float(q[k]) for k in ("CE", "CU", "PC", "PQ") if k in q}
            except Exception as e:
                feat["aesthetics_error"] = str(e)
        return feat

    def texts(self, texts):
        return [[float(v) for v in e] for e in self.clap.get_text_embedding(texts, use_tensor=False)]


def cmd_extract(args):
    profiles = json.loads((REPO / args.profiles).read_text(encoding="utf-8"))
    out_path = REPO / args.out
    cache = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {"clips": {}, "texts": {}}
    ex = Extractors(Path(args.essentia_models), args.clap_ckpt, want_quality=not args.no_quality)

    def do_dir(label, clips_dir):
        for p in sorted(Path(clips_dir).glob("*.ogg")):
            key = f"{label}/{p.name}"
            if key in cache["clips"]:
                continue
            try:
                cache["clips"][key] = ex.clip_features(p)
            except Exception as e:
                cache["clips"][key] = {"error": f"{type(e).__name__}: {e}"}
            if len(cache["clips"]) % 25 == 0:
                out_path.write_text(json.dumps(cache), encoding="utf-8")
                print(f"  {len(cache['clips'])} clips", flush=True)

    do_dir("matched", REPO / args.clips_dir)
    if args.fixed_clips_dir:
        do_dir("fixed", REPO / args.fixed_clips_dir)
    if args.fallback_dir:
        do_dir("fallback", REPO / args.fallback_dir)
    for spec in args.extra_clips or []:
        name, _, d = spec.partition("=")
        do_dir(f"gen:{name}", REPO / d)
    if args.fad_reference:
        do_dir("fad-reference", REPO / args.fad_reference)

    todo = [p for p in profiles if p["id"] not in cache["texts"]]
    if todo:
        for p, e in zip(todo, ex.texts([f"{p['title']}. {p['lead']}"[:600] for p in todo])):
            cache["texts"][p["id"]] = e
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(cache), encoding="utf-8")
    print(f"features for {len(cache['clips'])} clip(s), {len(cache['texts'])} page text(s) -> {out_path}")
    return 0


# ── analysis ─────────────────────────────────────────────────────────────────

def _cos(a, b):
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def analyse(profiles, features, n_boot=N_BOOT):
    clips = features["clips"]
    by_id = {p["id"]: p for p in profiles}
    pool = [(p["id"], p["mood"]) for p in profiles]
    seeds_ = sorted({k.split("__")[1].split(".")[0] for k in clips if k.startswith("matched/")})

    def feat(cond, pid, s):
        f = clips.get(f"{cond}/{pid}__{s}.ogg")
        return f if f and "error" not in f else None

    recs = []
    for p in profiles:
        for s in seeds_:
            m = feat("matched", p["id"], s)
            sid = pick_shuffled(p["id"], p["mood"], pool, s)
            sh = feat("matched", sid, s) if sid else None
            if not m or not sh:
                continue
            tv, ta = VALENCE[p["mood"]], AROUSAL[p["mood"]]
            tgt = MOOD_TAGS[p["mood"]]
            text = features["texts"].get(p["id"])
            rec = {"page": p["id"], "seed": s, "mood": p["mood"], "shuffled_from": sid,
                   "va_dist_matched": math.hypot(m["valence"] - tv, m["arousal"] - ta),
                   "va_dist_shuffled": math.hypot(sh["valence"] - tv, sh["arousal"] - ta),
                   "tag_hit_matched": float(bool(tgt & set(m["top_tags"]))),
                   "tag_hit_shuffled": float(bool(tgt & set(sh["top_tags"]))),
                   "pred_valence": m["valence"], "pred_arousal": m["arousal"], "tv": tv, "ta": ta}
            if text:
                rec["clap_matched"] = _cos(text, m["clap_audio"])
                rec["clap_shuffled"] = _cos(text, sh["clap_audio"])
                rng = random.Random(f"clap|{p['id']}|{s}")
                others = [q["id"] for q in profiles if q["id"] != p["id"] and feat("matched", q["id"], s)]
                if len(others) >= N_CANDIDATES - 1:
                    cands = rng.sample(others, N_CANDIDATES - 1)
                    sims = [rec["clap_matched"]] + [_cos(text, feat("matched", c, s)["clap_audio"]) for c in cands]
                    rec["clap_top1"] = float(max(range(len(sims)), key=sims.__getitem__) == 0)
            recs.append(rec)

    def paired(a_key, b_key, better):
        diffs = [(r[a_key] - r[b_key]) * (1 if better == "higher" else -1) for r in recs if a_key in r and b_key in r]
        # report matched - shuffled as "matched advantage": positive = matched is better
        by_page: dict = {}
        for r in recs:
            if a_key in r and b_key in r:
                by_page.setdefault(r["page"], []).append((r[a_key] - r[b_key]) * (1 if better == "higher" else -1))
        page_means = [statistics.fmean(v) for v in by_page.values()]
        return {"matched_advantage": bootstrap_ci(page_means, n_boot=n_boot), "wilcoxon": wilcoxon(page_means),
                "mixed_model": mixed_model([{"page": r["page"], "seed": r["seed"],
                                             "diff": (r[a_key] - r[b_key]) * (1 if better == "higher" else -1)}
                                            for r in recs if a_key in r and b_key in r]),
                "n_pairs": len(diffs)}

    out = {
        "n_pages": len({r["page"] for r in recs}), "n_pairs": len(recs), "seeds": seeds_,
        "min_shuffle_distance": MIN_SHUFFLE_DISTANCE,
        "valence_arousal": {
            "spearman_valence": spearman([r["tv"] for r in recs], [r["pred_valence"] for r in recs]),
            "spearman_arousal": spearman([r["ta"] for r in recs], [r["pred_arousal"] for r in recs]),
            "distance_matched_vs_shuffled": paired("va_dist_shuffled", "va_dist_matched", "higher"),
        },
        "mood_tags": {"top_k": TOP_K_TAGS,
                      "hit_rate_matched": bootstrap_ci([r["tag_hit_matched"] for r in recs], n_boot=n_boot),
                      "hit_rate_shuffled": bootstrap_ci([r["tag_hit_shuffled"] for r in recs], n_boot=n_boot),
                      "matched_minus_shuffled": paired("tag_hit_matched", "tag_hit_shuffled", "higher")},
        "clap": {"candidates": N_CANDIDATES, "chance_top1": 1 / N_CANDIDATES,
                 "top1": bootstrap_ci([r["clap_top1"] for r in recs if "clap_top1" in r], n_boot=n_boot),
                 "similarity_matched_minus_shuffled": paired("clap_matched", "clap_shuffled", "higher")},
        "caveats": ["CLAP is trained on music captions, not web pages",
                    "the mood->tag mapping is an assumption fixed before scoring",
                    "prompt-vs-audio agreement only shows the generator follows its prompt; page-text vs audio is the primary CLAP measure",
                    "these are proxies for conditioning fidelity, not perceived fit"],
    }

    # quality, by source
    def quality(prefix):
        vals = {k: [] for k in ("CE", "CU", "PC", "PQ")}
        for key, f in clips.items():
            if key.startswith(prefix) and f.get("aesthetics"):
                for m_, v in f["aesthetics"].items():
                    vals[m_].append(v)
        return {m_: bootstrap_ci(v, n_boot=n_boot) for m_, v in vals.items() if v}

    sources = {"matched": "matched/", "fixed": "fixed/", "fallback": "fallback/"}
    sources.update({k.split("/")[0]: k.split("/")[0] + "/" for k in clips if k.startswith("gen:")})
    out["quality_audiobox"] = {name: quality(pref) for name, pref in sources.items() if any(k.startswith(pref) for k in clips)}

    ref = [f["clap_audio"] for k, f in clips.items() if k.startswith("fad-reference/") and "clap_audio" in f]
    if ref and len(ref) > 2:
        out["fad_clap"] = {"embedding_model": "LAION-CLAP music (audio embeddings)", "reference_n": len(ref)}
        for name, pref in sources.items():
            gen = [f["clap_audio"] for k, f in clips.items() if k.startswith(pref) and "clap_audio" in f]
            if len(gen) > 2:
                out["fad_clap"][name] = frechet_distance(gen, ref)
    return out


def cmd_analyse(args):
    profiles = json.loads((REPO / args.profiles).read_text(encoding="utf-8"))
    features = json.loads((REPO / args.features).read_text(encoding="utf-8"))
    res = analyse(profiles, features)
    out = REPO / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=2), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("n_pages", "n_pairs", "valence_arousal", "mood_tags", "clap") if k in res}, indent=2))
    print(f"wrote {out}")
    return 0


# ── self-test (no models needed) ─────────────────────────────────────────────

def _self_test():
    assert MIN_SHUFFLE_DISTANCE > 0
    for m in MOODS:
        far = [o for o in MOODS if va_distance(m, o) >= MIN_SHUFFLE_DISTANCE]
        assert far, f"no distant mood for {m}: the shuffled control would be impossible"
    pool = [(f"p{i}", MOODS[i % len(MOODS)]) for i in range(60)]
    for pid, mood in pool[:20]:
        s = pick_shuffled(pid, mood, pool, "s0")
        assert s and s != pid
        assert va_distance(mood, dict(pool)[s]) >= MIN_SHUFFLE_DISTANCE
        assert s == pick_shuffled(pid, mood, pool, "s0"), "deterministic"
    # synthetic features where matched clips are perfect and shuffled ones are not
    profiles = [{"id": f"p{i}", "mood": MOODS[i % len(MOODS)], "title": "t", "lead": "l"} for i in range(60)]
    rng = random.Random(0)
    clips, texts = {}, {}
    for p in profiles:
        tv, ta = VALENCE[p["mood"]], AROUSAL[p["mood"]]
        for s in ("s0", "s1"):
            clips[f"matched/{p['id']}__{s}.ogg"] = {
                "valence": tv + rng.gauss(0, .05), "arousal": ta + rng.gauss(0, .05),
                "top_tags": sorted(MOOD_TAGS[p["mood"]])[:3] + ["x", "y"], "clap_audio": [tv, ta, 1.0]}
        texts[p["id"]] = [tv, ta, 1.0]
    res = analyse(profiles, {"clips": clips, "texts": texts}, n_boot=200)
    assert res["valence_arousal"]["distance_matched_vs_shuffled"]["matched_advantage"]["point"] > 0.1, res
    assert res["mood_tags"]["hit_rate_matched"]["point"] > res["mood_tags"]["hit_rate_shuffled"]["point"]
    assert res["clap"]["similarity_matched_minus_shuffled"]["matched_advantage"]["point"] > 0
    assert res["clap"]["top1"]["point"] > 0.5
    # no signal -> no advantage
    for k in clips:
        clips[k]["valence"], clips[k]["arousal"] = rng.random() * 2 - 1, rng.random()
    res0 = analyse(profiles, {"clips": clips, "texts": texts}, n_boot=200)
    assert abs(res0["valence_arousal"]["distance_matched_vs_shuffled"]["matched_advantage"]["point"]) < 0.15, res0
    print("self-test ok")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    sub = ap.add_subparsers(dest="cmd")
    e = sub.add_parser("extract")
    e.add_argument("--profiles", default="analysis/proxies/out/profiles.json")
    e.add_argument("--clips-dir", default="analysis/proxies/out/clips")
    e.add_argument("--fixed-clips-dir")
    e.add_argument("--fallback-dir", default="audio-generation/fallback_clips")
    e.add_argument("--extra-clips", action="append", help="name=dir of another generator's clips; repeatable")
    e.add_argument("--fad-reference", help="dir of reference clips for FAD")
    e.add_argument("--essentia-models", default="models/essentia")
    e.add_argument("--clap-ckpt", default="models/clap/music_audioset_epoch_15_esc_90.14.pt")
    e.add_argument("--no-quality", action="store_true", help="skip Audiobox Aesthetics")
    e.add_argument("--out", default="analysis/proxies/out/features.json")
    a = sub.add_parser("analyse")
    a.add_argument("--profiles", default="analysis/proxies/out/profiles.json")
    a.add_argument("--features", default="analysis/proxies/out/features.json")
    a.add_argument("--out", default="analysis/proxies/out/fit_results.json")
    args = ap.parse_args()
    if args.self_test:
        return _self_test()
    if args.cmd == "extract":
        return cmd_extract(args)
    if args.cmd == "analyse":
        return cmd_analyse(args)
    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
