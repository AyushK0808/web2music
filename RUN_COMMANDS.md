# Web2Music revision — what to run, in order

Everything in [REVISION_PLAN.md](REVISION_PLAN.md) that can be written without
your machine or your people is written and committed on `revision-wp1`. This file
is the other half: **one command per study**, in the order the plan's GPU budget
and schedule need them, each with the file it writes and the `\tbd{…}` in
[paper/main.tex](paper/main.tex) it fills.

**Every command is a bash command for the WSL Ubuntu shell**, run from the repo root. The few Windows tools
(`powercfg.exe`, `pdflatex.exe`) are reached through WSL interop. Only the GPU Python environment (step 0.1)
has been run on this machine; no study has, and the WSL Node/Chromium setup in 0.3 has not been tried.
Python tests for the audio service were not run either (the coding machine had no `librosa`/`torch`); step 0.5 runs them.
Estimated durations are the plan's, not measurements.

---

## 0. One-time setup

### 0.0 Session block — run at the top of **every** WSL terminal (the studies use two: A and B)

```bash
cd /mnt/c/Users/theof/projects/personal/web2music
source ~/w2m312/bin/activate                      # created in 0.1
export LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/audio_cache
export W2M_FORM_FACTOR=laptop W2M_POWER_PLAN=high-performance W2M_COMPILE=0   # recorded in every result header (E-4/E-5)
export CHROME_PATH=$(node -e "console.log(require('playwright').chromium.executablePath())" 2>/dev/null)   # empty until 0.3 is done
```

Use the same `W2M_COMPILE` for every timed run.

### 0.1 GPU Python environment (E-1, E-2)

Verified on this machine. Ubuntu 26.04 WSL ships Python 3.14, which `laion-clap` cannot build on, so the
environment is Python 3.12 made with `uv`. It lives in the WSL home, not on `/mnt/c`, because venvs on NTFS are slow.

```bash
sudo apt-get update && sudo apt-get install -y python3-venv python3-pip ffmpeg      # once; WSL has none of them (ffmpeg also provides ffprobe, which pydub needs to decode the .ogg clips)
python3 -m venv ~/w2m-venv && ~/w2m-venv/bin/pip install uv
~/w2m-venv/bin/uv venv --python 3.12 ~/w2m312
source ~/w2m312/bin/activate
cd /mnt/c/Users/theof/projects/personal/web2music

U="$HOME/w2m-venv/bin/uv pip install --python $HOME/w2m312/bin/python"   # uv lives in w2m-venv, not on PATH once w2m312 is active
$U torch torchvision torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128   # RTX 5060 = sm_120 needs cu128
grep -vE '^(torch|huggingface_hub)==' audio-generation/requirements.txt > /tmp/req.txt        # keep the cu128 torch; hub is set below
$U -r /tmp/req.txt 'huggingface_hub>=1.32,<2' diffusers accelerate essentia-tensorflow laion-clap audiobox_aesthetics statsmodels scipy
python audio-generation/check_gpu.py                                       # must print READY and capability (12, 0)
```

Notes: torch is 2.11.0, not the 2.12.1 pinned in `requirements.txt`. `huggingface_hub` must be >= 1.32 for `diffusers`.
`torchaudio` must match torch exactly or `laion_clap` fails to import.

If `check_gpu.py` fails, use the Docker image instead (it now builds on CUDA 12.8):
`docker compose -f docker/docker-compose.yml --profile gpu up -d --build`.
If both fail, keep the M4 as the "GPU-class" tier and say so (plan §10).

### 0.2 Docker from WSL, and the cache database

Docker Desktop → Settings → Resources → WSL integration → enable **Ubuntu**. Then:

If `docker` says "permission denied ... /var/run/docker.sock", your WSL user is not in the `docker` group. Add it once, then
restart WSL (run `wsl --shutdown` from a Windows terminal and open Ubuntu again; a new tab is not enough):

```bash
sudo usermod -aG docker $USER
```

```bash
docker version --format '{{.Server.Version}}'          # must print a version
docker compose -f docker/docker-compose.yml up -d db
```

### 0.3 Node and a browser, inside WSL

WSL has no Node yet (`npm` on its PATH is the Windows one and does not work). Ubuntu's Node 22 is enough; the repo was
developed on Node 24, so if anything misbehaves, install 24 with `nvm` instead. Dependencies install into Linux
`node_modules`; do not share one `node_modules` between Windows and WSL.

```bash
sudo apt-get install -y nodejs npm
npm install
npx playwright install --with-deps chromium           # needs sudo for the system libraries
export CHROME_PATH=$(node -e "console.log(require('playwright').chromium.executablePath())")   # for extractionCost.js
```

The extension tests run headless by default; add `--headed` to see them (WSLg provides the display).

### 0.4 Model files for S-D'

From **PowerShell** (the one non-WSL step; about 2.3 GB, mostly the CLAP checkpoint; re-running skips files already there):

```powershell
powershell -ExecutionPolicy Bypass -File analysis\proxies\download_models.ps1
```

It fetches `msd-musicnn-1.pb`, `emomusic-msd-musicnn-2.pb`, `discogs-effnet-bs64-1.pb`,
`mtg_jamendo_moodtheme-discogs-effnet-1.pb` and its `.json` into `models\essentia\`, and the LAION-CLAP music checkpoint
`music_audioset_epoch_15_esc_90.14.pt` into `models\clap\`. WSL sees them at `models/essentia` and `models/clap`.

### 0.5 Gate: everything that already exists must pass

```bash
npm test                                   # Feature A/B tests + telemetry HMAC + annotation-export leak test
node analysis/corpus/check_urls_test.mjs --self-test
python -m pytest audio-generation/tests -q                 # includes the seam-selector default (C-1)
python analysis/exposure/simulate_exposure.py --self-test
python analysis/proxies/score_fit.py --self-test
python analysis/proxies/seam_relative.py --self-test
python analysis/annotate/majority_gold.py --self-test
python analysis/numbers_diff.py --self-test
```

If `pytest` fails in `test_d4_process.py`, it is the new default loop selector
(`W2M_LOOP_SELECTOR=seam`); `W2M_LOOP_SELECTOR=chroma python -m pytest audio-generation/tests -q` shows whether
the failure is the selector or something else.

### 0.5b Timing hygiene (E-5) — before **every** timed run

```bash
powercfg.exe /setactive SCHEME_MIN             # High performance (Windows power plan, via interop); plug the laptop in
```

Close everything else on the GPU. Do not run CLAP/Essentia/Audiobox while timing.
The result headers (`manifest`) record all of this.

---

## 1. Freeze (E-6) — before the test corpus is collected

C-1, C-2, C-3 are already committed on `revision-wp1` (branched from `paper-docx-update`). Merge it into the branch you submit from
(`main` once `paper-docx-update` is merged), then tag that commit:

```bash
git checkout main && git merge --no-ff revision-wp1        # or merge into paper-docx-update first
git tag -a revision-freeze -m "pipeline frozen before the held-out corpus is collected"
```

The tag must contain `mood-classification/feature_b/llmConfig.js` and the prompts
(it does; do not edit them afterwards, L-5).

---

## 2. Night 1 — GPU service up

Terminal A (session block first; leave running; `W2M_PREWARM=0` so the grid does not compete with timed requests):

```bash
cd /mnt/c/Users/theof/projects/personal/web2music/audio-generation
W2M_PREWARM=0 W2M_MODEL=musicgen-small uvicorn main:app --port 8000
```

Terminal B (session block first):

```bash
curl -s http://127.0.0.1:8000/health      # "generator": {"model":"musicgen-small","device":"NVIDIA GeForce RTX 5060 ...","precision":"fp16",...}
```

### S-B — generation latency by duration and concurrency  → `\tbd{S-B…}`

```bash
cd /mnt/c/Users/theof/projects/personal/web2music/audio-generation
python experiments/d4_latency.py --sections duration --durations 8,10,15,20,28 --moods calm,focused,joyful,energetic,sad,dark,nostalgic,curious,tense,uplifting,neutral --spread-moods --repeats 33 --timeout 600 --out results/d4-duration-5060.json
python experiments/d4_latency.py --sections concurrency --concurrency-levels 1,2,4,8 --duration 15 --timeout 600 --out results/d4-concurrency-5060.json
python experiments/d3_clip_length.py --durations 8,10,15,20,28 --moods calm,tense,energetic --repeats 3 --out results/d3-clip-length-5060.json
```

(`--repeats 33` = 3 per mood × 11 moods per duration, i.e. n ≥ 30.)

### S-G — loop study, 220 fresh clips  → `\tbd{S-G: chroma/seam …}`

```bash
cd /mnt/c/Users/theof/projects/personal/web2music/audio-generation
python experiments/d6_loop_seeds.py --seeds 20 --duration 15 --keep-clips results/d6-loop-seeds-clips --out results/d6-loop-seeds-5060.json
```

---

## 3. Night 2 — prompt ablation and generators  (terminal B in `audio-generation/`)

### S-G — prompt ablation, 11 moods × 5 seeds × 3 prompts  → `\tbd{S-G: P3−P2 …}`

```bash
cd /mnt/c/Users/theof/projects/personal/web2music/audio-generation
python experiments/d1_prompt_ablation.py --repeats 5 --duration 15 --out results/d1-prompt-seeds.json
```

### S-G — generator comparison  → Table `tab:generators`

Restart the service once per generator (terminal A: Ctrl-C, then the matching line), and run the
`d7_generators.py run` line in terminal B each time:

```bash
cd /mnt/c/Users/theof/projects/personal/web2music/audio-generation
# terminal A:  W2M_PREWARM=0 W2M_MODEL=musicgen-small  uvicorn main:app --port 8000
python experiments/d7_generators.py run --seeds 5 --duration 15 --clips-dir results/d7-clips --out results/d7-musicgen-small.json
# terminal A:  W2M_PREWARM=0 W2M_MODEL=musicgen-medium uvicorn main:app --port 8000
python experiments/d7_generators.py run --seeds 5 --duration 15 --clips-dir results/d7-clips --out results/d7-musicgen-medium.json
# terminal A:  W2M_PREWARM=0 W2M_MODEL=audioldm2-music uvicorn main:app --port 8000
python experiments/d7_generators.py run --seeds 5 --duration 15 --clips-dir results/d7-clips --out results/d7-audioldm2-music.json

python experiments/d7_generators.py merge results/d7-musicgen-small.json results/d7-musicgen-medium.json results/d7-audioldm2-music.json --out results/d7-generators.json
```

AudioLDM2 is fp16 within 8 GB; lower `W2M_AUDIOLDM2_STEPS` (default 100) only if it does not fit, and say so.

---

## 4. Daytime, CPU/browser-bound (any order; terminals start at the repo root)

### S-B — CPU-only generation (censored timeouts)  → `\tbd{S-B…}` CPU rows

```bash
# terminal A (stop the GPU service first): hides the GPU from torch
cd /mnt/c/Users/theof/projects/personal/web2music/audio-generation && CUDA_VISIBLE_DEVICES= W2M_PREWARM=0 uvicorn main:app --port 8000
# terminal B
cd /mnt/c/Users/theof/projects/personal/web2music/audio-generation && python experiments/d4_latency.py --sections duration --durations 10,15 --moods calm,tense,energetic --spread-moods --repeats 12 --timeout 300 --out results/d4-duration-cpu2.json
```

Timeouts are recorded as errors and are treated as **censored** by S-C; report them as "> 300 s, k of n".

### S-A — real end-to-end latency  (C-6)  → `\tbd{S-A…}`

Needs the built extension (`npm run build` is part of `test:latency`), the classify
proxy for A6b (`docker compose -f docker/docker-compose.yml up -d classify-service`, needs the Groq key
in `.env`), and Feature D on :8000 (GPU service from step 2, **or** the CPU service from above).

```bash
# A6, GPU generation, cold cache  (LLM unreachable: do NOT start classify-service)
npm run test:latency -- --repeats 10 --d-url=http://127.0.0.1:8000 --swap-timeout=300000 --label=A6-gpu-cold --out data-extraction/results/e2e-latency-real-A6-gpu-cold.json
# A6b, GPU generation, cold cache  (classify-service up)
npm run test:latency -- --repeats 10 --real-classify --d-url=http://127.0.0.1:8000 --swap-timeout=300000 --label=A6b-gpu-cold --out data-extraction/results/e2e-latency-real-A6b-gpu-cold.json
# warm cache: primes every fixture once, then measures cache hits
npm run test:latency -- --repeats 10 --real-classify --d-url=http://127.0.0.1:8000 --cache=warm --label=A6b-gpu-warm --out data-extraction/results/e2e-latency-real-A6b-gpu-warm.json
```

Repeat the three with the CPU service running (`--label=…-cpu-…`; many loads will be censored — that is the result).
Cold = restart the service with an empty `audio-generation/audio-cache` and the Postgres table cleared:

```bash
docker exec web2music-db psql -U postgres -d audio_cache -c "TRUNCATE audio_cache"
```

Fixture loads are 11 × 10 = 110 per setup.

### S-A — descriptor cost with the real embedding model  → `\tbd{S-A: descriptor…}`

```bash
cd data-extraction
npx esbuild benchmark/.embed-bundle-build/entry.mjs --bundle --format=iife --platform=browser --minify --outfile=benchmark/.embed-bundle-build/transformers-bundle.js
node benchmark/make_top_sites.mjs --target 200                 # grows top-sites.txt from the Tranco list (or: --list top-1m.csv)
node benchmark/extractionCost.js --sites benchmark/top-sites.txt --real-embedding --out benchmark/extraction-cost-real-embedding.json   # uses $CHROME_PATH
cd ..
```

### S-H — network-level privacy audit  (C-7)  → `\tbd{S-H…}`

```bash
npm run test:network-audit -- --mode=a6  --repeats 3 --out data-extraction/results/network-audit-a6.json
# A6b: classify-service up
npm run test:network-audit -- --mode=a6b --repeats 3 --out data-extraction/results/network-audit-a6b.json
```

Exit code 1 means an assertion failed; the evidence is in the JSON either way. Compare `verdict.off_device_rate`
(A6b) with the replayed off-device rate of A6b from S-E.

### S-I — gapless + relative seam  → `\tbd{S-I…}`

```bash
npm run test:gapless -- --clips-dir=audio-generation/results/d6-loop-seeds-clips --limit=30 --cycles=10 --out audio-generation/results/gapless.json
python analysis/proxies/seam_relative.py --clips-dir audio-generation/fallback_clips --out audio-generation/results/seam-relative.json
```

Night 1 already kept the 220 loop-study clips (`--keep-clips`), so S-I needs no further generation; `--limit=30` takes the first 30.

### S-C — generated-audio exposure  → Table `tab:exposure`, `\tbd{S-C…}`

After S-B has produced the three duration files (the M4 file is your existing `audio-generation/results/d4-duration.json`):

```bash
python analysis/exposure/simulate_exposure.py --d4 5060=audio-generation/results/d4-duration-5060.json --d4 cpu=audio-generation/results/d4-duration-cpu2.json --d4 m4=audio-generation/results/d4-duration.json --moods analysis/out/corpus_moods.json --durations 10,15,28 --medians 10,20,30,60,120 --grid-hit 0.5 --out analysis/exposure/exposure.json
```

Sensitivity: rerun with `--grid-hit 0.2` and `--grid-hit 0.8`, `--stickiness 0.0/0.6`. `analysis/out/corpus_moods.json` is a JSON array of
mood strings, e.g. the `mood` of each page from `analysis/proxies/out/profiles.json` (step 7.1).

---

## 5. Corpus, labelling and the cascade (S-E) — people + code, weeks 1–3

### 5.1 Freeze the URL list **before any classifier sees it**  (L-3, L-6)

Write `analysis/corpus/urls-test.jsonl` (fields in [check_urls_test.mjs](analysis/corpus/check_urls_test.mjs): `id,url,slice,true_category,source,query,published`).
No URL suggested by an LLM. Then:

```bash
node analysis/corpus/check_urls_test.mjs analysis/corpus/urls-test.jsonl --cutoff 2025-06-01 --min-post-cutoff 80
git add analysis/corpus/urls-test.jsonl && git commit -m "freeze held-out test URL list"      # quote the printed sha256
```

(`--cutoff` = gpt-oss-20b's documented knowledge cutoff; check the model card and use that date.)

### 5.2 Capture the test pages

```bash
npm run build
node analysis/corpus/capture_corpus.mjs --urls analysis/corpus/urls-test.jsonl --out analysis/corpus/s2_corpus_test.json
```

### 5.3 Blind labelling files

```bash
node analysis/annotate/export_for_annotation.mjs analysis/corpus/s2_corpus_test.json analysis/out/annotation-test.json
node analysis/annotate/export_for_annotation.mjs --check analysis/out/annotation-test.json
node analysis/annotate/export_for_annotation.mjs analysis/corpus/s2_corpus.json analysis/out/annotation-dev.json   # calibration round on dev
```

Each author opens [analysis/annotate/index.html](analysis/annotate/index.html) in a normal Windows browser (it is a standalone page), loads
`annotation-test.json`, labels, and exports `annotations-<name>.json` into `analysis/out/annotations/test/`.
**Freeze `analysis/annotate/GUIDELINES.md` (commit it) before the first test label.**

### 5.4 Agreement and gold labels

```bash
python analysis/krippendorff.py --annotations "analysis/out/annotations/test/*.json"
python analysis/annotate/majority_gold.py --annotations "analysis/out/annotations/test/*.json" --out analysis/out/gold-test.json
# after the tie-break discussion:
python analysis/annotate/majority_gold.py --annotations "analysis/out/annotations/test/*.json" --adjudicated analysis/out/adjudicated-test.json --out analysis/out/gold-test.json
# same for the dev set -> analysis/out/gold-dev.json
```

### 5.5 Raw cascade results for dev and test, LLM answers cached

Needs `classify-service` up and the Groq key. `readwrite` on the first pass, `replay` for every later run (L-5).

```bash
export W2M_LLM_CACHE=analysis/llm-cache/gpt-oss-20b.jsonl W2M_LLM_CACHE_MODE=readwrite
node mood-classification/experiments/s2_tier_ablation.js --corpus analysis/corpus/s2_corpus.json      --with-a6 --out mood-classification/results/s2-ablation-dev.json
node mood-classification/experiments/s2_tier_ablation.js --corpus analysis/corpus/s2_corpus_test.json --with-a6 --out mood-classification/results/s2-ablation-test.json
```

L-5 agreement check (re-run the LLM stage on 50 test pages, expect a few % flips because hosted temperature-0 is not deterministic):
move the cache aside, set `W2M_LLM_CACHE_MODE=record` into a second file, rerun on a 50-page corpus slice, and compare.

### 5.6 Dev/test protocol  → Tables `tab:cascade-test`, abstract

```bash
node analysis/s_e_dev_test.mjs --dev mood-classification/results/s2-ablation-dev.json --test mood-classification/results/s2-ablation-test.json --gold-dev analysis/out/gold-dev.json --gold-test analysis/out/gold-test.json --meta analysis/corpus/urls-test.jsonl --cutoff 2025-06-01 --out analysis/out/s_e_dev_test.json
```

Reads the test file only after choosing the gates on dev. Prints macro-F1 with CIs, paired differences, accuracy by deciding stage (L-8) and post-cutoff macro-F1 (L-6).

---

## 6. S-F — sensitive detector (on-device) → Table `tab:sensitive`

Put the real crisis/support pages (captured as part of 5.2, `source: helpline-directory`) into
`analysis/audit/blackbox_sensitive.json` as `{"pages":[{"id","title","text","lang","sensitive":true}]}`. Confirm the provenance of the
47-page white-box slice with its authors (L-4). Then:

```bash
node analysis/audit/s_f_detector_study.mjs --blackbox analysis/audit/blackbox_sensitive.json --benign-corpus analysis/corpus/s2_corpus.json --benign-corpus analysis/corpus/s2_corpus_test.json --gold analysis/out/gold-dev.json --gold analysis/out/gold-test.json --hosted-url http://localhost:8078/v1/zero-shot --calibrate --out analysis/audit/results/s_f_detectors.json
# optional upper bound:  add  --upper-model Xenova/nli-deberta-v3-base
```

`--calibrate` chooses the 3-way gates on the **white-box slice only**; every reported claim comes from the black-box and benign sets.
Drop `--hosted-url` if `classify-service` is not up (the hosted row is then omitted).

---

## 7. Nights 3–5 — S-D' conditioning fidelity  (needs 5.2 + 5.5)

### 7.1 Profiles Feature D would receive for every non-sensitive page

```bash
export W2M_LLM_CACHE=analysis/llm-cache/gpt-oss-20b.jsonl W2M_LLM_CACHE_MODE=replay
node analysis/proxies/build_profiles.mjs --corpus analysis/corpus/s2_corpus.json --corpus analysis/corpus/s2_corpus_test.json --out analysis/proxies/out/profiles.json
```

### 7.2 Generate ~1,500 matched clips (resumable; run it each night until it reports 0 failures)

Service up as in step 2 (`W2M_PREWARM=0 W2M_MODEL=musicgen-small`, same `W2M_COMPILE`).

```bash
python analysis/proxies/generate_fit_clips.py --profiles analysis/proxies/out/profiles.json --clips-dir analysis/proxies/out/clips --seeds 3 --duration 15 --base-url http://127.0.0.1:8000
```

Fixed-prompt control (one page-agnostic prompt, same seeds):

```bash
mkdir -p analysis/proxies/out
echo '[{"id":"fixed","profile":{"mood":"neutral","bpm":80,"key":"C major","energy":0.5,"style":"ambient"}}]' > analysis/proxies/out/fixed_profiles.json
python analysis/proxies/generate_fit_clips.py --profiles analysis/proxies/out/fixed_profiles.json --clips-dir analysis/proxies/out/fixed-clips --seeds 3 --duration 15
```

### 7.3 Score (night 5; no timing runs at the same time)

```bash
python analysis/proxies/score_fit.py extract --profiles analysis/proxies/out/profiles.json --clips-dir analysis/proxies/out/clips --fixed-clips-dir analysis/proxies/out/fixed-clips --fallback-dir audio-generation/fallback_clips --extra-clips musicgen-medium=audio-generation/results/d7-clips/musicgen-medium --extra-clips audioldm2-music=audio-generation/results/d7-clips/audioldm2-music --fad-reference audio-generation/fallback_clips --out analysis/proxies/out/features.json
python analysis/proxies/score_fit.py analyse --profiles analysis/proxies/out/profiles.json --features analysis/proxies/out/features.json --out analysis/proxies/out/fit_results.json
```

`extract` is resumable and is the slow step; `analyse` takes seconds and can be rerun. A null result (matched is not better than shuffled) is reported as is —
do not go looking for a proxy that works (plan §10).

---

## 8. Figures, numbers, paper

```bash
python -m analysis.figures.f10_disclosure_frontier
python -m analysis.figures.f11_cold_generation
python -m analysis.figures.f12_seam_cdf
python analysis/build_all.py
```

1. Replace each `\tbd{…}` in [paper/main.tex](paper/main.tex) with the value from the named result file.
2. Register every number in `paper/numbers.json` (format in [analysis/numbers_diff.py](analysis/numbers_diff.py);
   `python analysis/numbers_diff.py --list` prints what needs a source).
3. `python analysis/numbers_diff.py --require-ack` must print `numbers-diff: OK` (it fails while any `\tbd` remains).
4. Build and check the page count; move overflow to [paper/SUPPLEMENTARY.md](paper/SUPPLEMENTARY.md)
   (CPU-only details, full gate sweep, per-mood tables). The version with every placeholder in is 9 pages; the original was 7.

```bash
cd paper && pdflatex.exe -interaction=nonstopmode main.tex && pdflatex.exe -interaction=nonstopmode main.tex; cd ..   # MiKTeX on Windows, via interop
```

## 9. Release (R-1) — see [RELEASE.md](RELEASE.md)

## 10. Response letter — [RESPONSE_LETTER.md](RESPONSE_LETTER.md): fill the `⟦…⟧` cells once the numbers are in.

---

## Quick map: study → command → paper

| Study | Section above | Fills |
|---|---|---|
| S-A | §4 | abstract (descriptor cost), Table latency (real-pipeline rows), descriptor-cost and latency text |
| S-B | §2, §4 | Table latency (GPU/CPU rows), Table hardware, Fig. cold generation |
| S-C | §4 | "How often generated audio is heard", Table exposure, abstract |
| S-D' | §7 | "Conditioning fidelity", Table fidelity |
| S-E | §5 | Table cascade-test, "Annotation agreement", abstract |
| S-F | §6 | Table sensitive, "Restraint" text |
| S-G | §2, §3 | Table generators, loop-quality paragraph, prompt ablation |
| S-H | §4 | restraint paragraph (network audit) |
| S-I | §4 | loop-quality paragraph |
