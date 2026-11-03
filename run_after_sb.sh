#!/usr/bin/env bash
# Everything in RUN_COMMANDS.md after S-B that can run unattended on the GPU machine.
#
# Run from WSL (it sets up the session block itself), with the musicgen-small
# service already up on :8000 (W2M_PREWARM=0 W2M_MODEL=musicgen-small uvicorn main:app --port 8000).
#
#   bash run_after_sb.sh                 # all steps
#   SKIP="d7 gapless" bash run_after_sb.sh   # skip named steps
#
# Steps: d6 d1 d7 gapless seam cpu cache profiles exposure fitgen fitscore
# d7 stops whatever is on :8000, starts musicgen-medium then audioldm2-music itself, and finally
# restarts musicgen-small so later steps (and your terminal A, which is gone) have a service.
# Every step runs even if its inputs are missing; a step that fails is logged and the script moves on.
# The summary at the end lists what failed.
set -u
cd "$(dirname "$(readlink -f "$0")")"
ROOT=$PWD
# session block (RUN_COMMANDS.md 0.0), so this script is the only thing to run
[[ -f $HOME/w2m312/bin/activate ]] && source "$HOME/w2m312/bin/activate"
export LOCAL_DB_URL=${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:5432/audio_cache}
export W2M_FORM_FACTOR=${W2M_FORM_FACTOR:-laptop} W2M_POWER_PLAN=${W2M_POWER_PLAN:-high-performance}
export CHROME_PATH=${CHROME_PATH:-$(node -e "console.log(require('playwright').chromium.executablePath())" 2>/dev/null)}
powercfg.exe /setactive SCHEME_MIN >/dev/null 2>&1 || true
docker compose -f docker/docker-compose.yml up -d db >/dev/null 2>&1 || echo "warning: could not start the db container"
SKIP="${SKIP:-}"
BASE=http://127.0.0.1:8000
export W2M_PREWARM=0
export W2M_COMPILE="${W2M_COMPILE:-0}"
LOGDIR="$ROOT/audio-generation/results/run_after_sb-logs"
mkdir -p "$LOGDIR"
FAILED=(); SKIPPED=(); DONE=()

want() { [[ " $SKIP " != *" $1 "* ]]; }

step() {   # step <name> <command...>; run in repo root
  local name=$1; shift
  echo; echo "=== [$name] $(date +%H:%M:%S) ==="
  if "$@"; then DONE+=("$name"); else echo "!!! [$name] failed"; FAILED+=("$name"); return 1; fi
}

in_ag() { ( cd "$ROOT/audio-generation" && "$@" ); }

wait_health() {
  for _ in $(seq 1 120); do
    curl -sf "$BASE/health" >/dev/null 2>&1 && return 0
    sleep 5
  done
  echo "service did not come up on $BASE"; return 1
}

start_service() {   # start_service <model>
  local model=$1
  pkill -f "uvicorn main:app" 2>/dev/null; sleep 5
  ( cd "$ROOT/audio-generation" && W2M_MODEL="$model" nohup uvicorn main:app --port 8000 \
      >"$LOGDIR/uvicorn-$model.log" 2>&1 & )
  wait_health
}

curl -sf "$BASE/health" >/dev/null || { echo "No service on $BASE. Start it first (RUN_COMMANDS.md step 2)."; exit 1; }

# ---- S-G loop study (220 clips) ----
want d6 && step d6 in_ag python experiments/d6_loop_seeds.py --seeds 20 --duration 15 \
  --keep-clips results/d6-loop-seeds-clips --out results/d6-loop-seeds-5060.json

# ---- S-G prompt ablation ----
want d1 && step d1 in_ag python experiments/d1_prompt_ablation.py --repeats 5 --duration 15 \
  --out results/d1-prompt-seeds.json

# ---- S-G generator comparison ----
if want d7; then
  gen_ok=1
  for m in musicgen-small musicgen-medium audioldm2-music; do
    if [[ $m == musicgen-small ]]; then
      # reuse the running service only if it really is musicgen-small
      curl -s "$BASE/health" | grep -q '"musicgen-small"' || start_service musicgen-small || { gen_ok=0; continue; }
    else
      start_service "$m" || { FAILED+=("d7-$m(start)"); gen_ok=0; continue; }
    fi
    step "d7-$m" in_ag python experiments/d7_generators.py run --seeds 5 --duration 15 \
      --clips-dir results/d7-clips --out "results/d7-$m.json" || gen_ok=0
  done
  step d7-merge in_ag python experiments/d7_generators.py merge \
    results/d7-musicgen-small.json results/d7-musicgen-medium.json results/d7-audioldm2-music.json \
    --out results/d7-generators.json
  start_service musicgen-small || echo "could not restart musicgen-small; later GPU steps may fail"
fi

# ---- S-I gapless + relative seam (uses the d6 clips) ----
want gapless && step gapless npm run test:gapless -- --clips-dir=audio-generation/results/d6-loop-seeds-clips \
  --limit=30 --cycles=10 --out audio-generation/results/gapless.json
want seam && step seam python analysis/proxies/seam_relative.py --clips-dir audio-generation/fallback_clips \
  --out audio-generation/results/seam-relative.json

# ---- S-B CPU-only generation (censored timeouts; up to ~3 h) ----
if want cpu; then
  pkill -f "uvicorn main:app" 2>/dev/null; sleep 5
  ( cd "$ROOT/audio-generation" && CUDA_VISIBLE_DEVICES= nohup uvicorn main:app --port 8000       >"$LOGDIR/uvicorn-cpu.log" 2>&1 & )
  wait_health && step cpu in_ag python experiments/d4_latency.py --sections duration --durations 10,15     --moods calm,tense,energetic --spread-moods --repeats 12 --timeout 300 --out results/d4-duration-cpu2.json
  start_service musicgen-small || echo "could not restart musicgen-small"
fi

# ---- 5.5 LLM answer cache (only if it does not exist yet) ----
CACHE=analysis/llm-cache/gpt-oss-20b.jsonl
if want cache && [[ ! -s $CACHE ]]; then
  grep -qE '^GROQ_API_KEY=gsk_' .env 2>/dev/null || echo "warning: .env has no GROQ_API_KEY=gsk_...; the LLM stage will fail"
  mkdir -p analysis/llm-cache
  docker compose -f docker/docker-compose.yml up -d classify-service >/dev/null 2>&1 || echo "warning: could not start classify-service"
  for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:8078/ && break; sleep 2; done
  export W2M_LLM_CACHE=$CACHE W2M_LLM_CACHE_MODE=readwrite
  step cache-dev node mood-classification/experiments/s2_tier_ablation.js --corpus "$ROOT/analysis/corpus/s2_corpus.json"     --with-a6 --zs-local --zs-fp32 --out mood-classification/results/s2-ablation-dev.json
  step cache-test node mood-classification/experiments/s2_tier_ablation.js --corpus "$ROOT/analysis/corpus/s2_corpus_test.json"     --with-a6 --zs-local --zs-fp32 --out mood-classification/results/s2-ablation-test.json
  unset W2M_LLM_CACHE W2M_LLM_CACHE_MODE
elif [[ -s $CACHE ]]; then
  echo "[cache] $CACHE already exists; not rebuilding"
fi

# ---- 7.1 profiles and the mood list S-C needs.
# PROFILES_LLM selects what builds B1/B2:
#   local (default)  qwen2.5:7b-instruct served by Ollama inside WSL (nothing leaves the machine)
#   none             no LLM at all: keyword -> on-device zero-shot for category, B2 tier-1 heuristic for mood
#   groq             gpt-oss-20b through the classify-service (cache: analysis/llm-cache/gpt-oss-20b.jsonl)
PROFILES=analysis/proxies/out/profiles.json
OLLAMA_BIN=${OLLAMA_BIN:-$HOME/ollama-wsl/dist/bin/ollama}
OLLAMA_ADDR=127.0.0.1:11435
LOCAL_LLM=${LOCAL_LLM:-qwen2.5:7b-instruct}
start_ollama() {
  curl -sf "http://$OLLAMA_ADDR/api/version" >/dev/null 2>&1 && return 0
  ( OLLAMA_HOST=$OLLAMA_ADDR OLLAMA_MODELS=$HOME/ollama-wsl/models OLLAMA_KEEP_ALIVE=2m       nohup "$OLLAMA_BIN" serve >"$LOGDIR/ollama.log" 2>&1 & )
  for _ in $(seq 1 30); do curl -sf "http://$OLLAMA_ADDR/api/version" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "Ollama did not start; see $LOGDIR/ollama.log"; return 1
}
if want profiles; then
  mkdir -p analysis/proxies/out analysis/out
  case ${PROFILES_LLM:-local} in
    local)
      start_ollama || exit 1
      W2M_LLM_CACHE="analysis/llm-cache/${LOCAL_LLM//[:\/]/-}.jsonl" W2M_LLM_CACHE_MODE=readwrite         step profiles node analysis/proxies/build_profiles.mjs --llm-url "http://$OLLAMA_ADDR/v1/chat/completions" --llm-model "$LOCAL_LLM" --corpus analysis/corpus/s2_corpus.json     --corpus analysis/corpus/s2_corpus_test.json --out $PROFILES
      # free the GPU for MusicGen (fitgen)
      OLLAMA_HOST=$OLLAMA_ADDR "$OLLAMA_BIN" stop "$LOCAL_LLM" >/dev/null 2>&1 || true ;;
    none)
      step profiles node analysis/proxies/build_profiles.mjs --no-llm --corpus analysis/corpus/s2_corpus.json     --corpus analysis/corpus/s2_corpus_test.json --out $PROFILES ;;
    groq)
      W2M_LLM_CACHE=analysis/llm-cache/gpt-oss-20b.jsonl W2M_LLM_CACHE_MODE=readwrite         step profiles node analysis/proxies/build_profiles.mjs --corpus analysis/corpus/s2_corpus.json     --corpus analysis/corpus/s2_corpus_test.json --out $PROFILES ;;
    *) echo "PROFILES_LLM must be local, none or groq"; exit 1 ;;
  esac
  step corpus-moods python - <<'PY'
import json
d = json.load(open("analysis/proxies/out/profiles.json"))
d = d.get("profiles", d) if isinstance(d, dict) else d
json.dump([e["profile"]["mood"] for e in d], open("analysis/out/corpus_moods.json", "w"))
PY
fi

# ---- S-C exposure (20 s added to the durations; the 5060 data covers it) ----
if want exposure; then
  # real cache keys of the page profiles: gives the measured pre-warm-grid hit rate and the off-grid key distribution
  step profile-keys python analysis/exposure/profile_keys.py --profiles $PROFILES --out analysis/exposure/profile_keys.json
  # cold per-session cache (measured grid hits) is the primary scenario; warm persistent cache and an assumed 0.5 grid hit are bounds
  step exposure python analysis/exposure/simulate_exposure.py   --d4 5060=audio-generation/results/d4-duration-5060.json   --d4 cpu=audio-generation/results/d4-duration-cpu2.json   --d4 m4=audio-generation/results/d4-duration.json   --moods analysis/out/corpus_moods.json --profile-keys analysis/exposure/profile_keys.json --durations 10,15,20,28 --medians 10,20,30,60,120   --grid-hit-sensitivity 0.5 --out analysis/exposure/exposure.json
fi

# ---- S-D' conditioning fidelity ----
if want fitgen; then
  # the fit clips are musicgen-small; the service may be left on another generator by a d7 re-run
  curl -s "$BASE/health" | grep -q '"musicgen-small"' || start_service musicgen-small || echo "could not start musicgen-small; fitgen will fail"
  step fitgen python analysis/proxies/generate_fit_clips.py --profiles $PROFILES     --clips-dir analysis/proxies/out/clips --seeds 3 --duration 15 --base-url $BASE
  mkdir -p analysis/proxies/out
  echo '[{"id":"fixed","profile":{"mood":"neutral","bpm":80,"key":"C major","energy":0.5,"style":"ambient"}}]'     > analysis/proxies/out/fixed_profiles.json
  step fitgen-fixed python analysis/proxies/generate_fit_clips.py --profiles analysis/proxies/out/fixed_profiles.json     --clips-dir analysis/proxies/out/fixed-clips --seeds 3 --duration 15
fi
if want fitscore; then
  step fit-extract python analysis/proxies/score_fit.py extract --profiles $PROFILES     --clips-dir analysis/proxies/out/clips --fixed-clips-dir analysis/proxies/out/fixed-clips     --fallback-dir audio-generation/fallback_clips     --extra-clips musicgen-medium=audio-generation/results/d7-clips/musicgen-medium     --extra-clips audioldm2-music=audio-generation/results/d7-clips/audioldm2-music     --fad-reference audio-generation/fallback_clips --out analysis/proxies/out/features.json
  step fit-analyse python analysis/proxies/score_fit.py analyse --profiles $PROFILES     --features analysis/proxies/out/features.json --out analysis/proxies/out/fit_results.json
fi

echo; echo "=============== summary ==============="
echo "done:    ${DONE[*]:-none}"
echo "skipped: ${SKIPPED[*]:-none}"
echo "failed:  ${FAILED[*]:-none}"
[[ ${#FAILED[@]} -eq 0 ]]
