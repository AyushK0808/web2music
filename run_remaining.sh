#!/usr/bin/env bash
# Everything still to run for the revision, in one go (WSL, repo root):  bash run_remaining.sh
#   S-A descriptor cost, S-H network audit (A6b with the local Qwen 7B proxy, then A6),
#   S-F detector study (only if analysis/audit/blackbox_sensitive.json exists),
#   figures, build_all and the numbers check.
# Failed steps are reported at the end and do not stop the later ones. SKIP="desc audit sf figs" skips steps.
cd "$(dirname "$0")" || exit 1
[[ -f $HOME/w2m312/bin/activate ]] && source "$HOME/w2m312/bin/activate"
export CHROME_PATH=${CHROME_PATH:-$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome}
OLLAMA_BIN=${OLLAMA_BIN:-$HOME/ollama-wsl/dist/bin/ollama}
OLLAMA_ADDR=127.0.0.1:11435
LOCAL_LLM=${LOCAL_LLM:-qwen2.5:7b-instruct}
LOGDIR=analysis/run-logs; mkdir -p "$LOGDIR"
DONE=(); FAILED=(); SKIPPED=()
want() { [[ " $SKIP " != *" $1 "* ]]; }
step() {
  local name=$1; shift
  echo; echo "=== [$name] $(date +%H:%M:%S) ==="
  if "$@"; then DONE+=("$name"); else FAILED+=("$name"); fi
}
proxy_up()   { LLM_BASE_URL=http://$OLLAMA_ADDR/v1 LLM_MODEL=$LOCAL_LLM PORT=8078 nohup node services/classify/classifyService.js > "$LOGDIR/classify.log" 2>&1 & sleep 3; curl -sf localhost:8078/health >/dev/null; }
proxy_down() { pkill -f classifyService.js; sleep 1; ! curl -sf -m2 localhost:8078/health >/dev/null; }
start_ollama() {
  curl -sf "http://$OLLAMA_ADDR/api/version" >/dev/null 2>&1 && return 0
  ( OLLAMA_HOST=$OLLAMA_ADDR OLLAMA_MODELS=$HOME/ollama-wsl/models OLLAMA_KEEP_ALIVE=2m nohup "$OLLAMA_BIN" serve > "$LOGDIR/ollama.log" 2>&1 & )
  for _ in $(seq 1 30); do curl -sf "http://$OLLAMA_ADDR/api/version" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

if want desc; then
  step desc-cost bash -c 'cd data-extraction && node benchmark/extractionCost.js --sites benchmark/top-sites.txt --warm-embedding --out benchmark/extraction-cost-real-embedding.json'
else SKIPPED+=(desc-cost); fi

if want audit; then
  docker stop web2music-classify-service >/dev/null 2>&1
  proxy_down >/dev/null 2>&1
  step ollama start_ollama
  step proxy-up proxy_up
  step audit-a6b npm run test:network-audit -- --mode=a6b --repeats 3 --out data-extraction/results/network-audit-a6b.json
  step proxy-down proxy_down
  step audit-a6 npm run test:network-audit -- --mode=a6 --repeats 3 --out data-extraction/results/network-audit-a6.json
  OLLAMA_HOST=$OLLAMA_ADDR "$OLLAMA_BIN" stop "$LOCAL_LLM" >/dev/null 2>&1 || true
else SKIPPED+=(audit-a6b audit-a6); fi

if want sf; then
  if [[ -f analysis/audit/blackbox_sensitive.json ]]; then
    mkdir -p analysis/audit/results
    step s-f node analysis/audit/s_f_detector_study.mjs --blackbox analysis/audit/blackbox_sensitive.json --benign-corpus analysis/corpus/s2_corpus.json --benign-corpus analysis/corpus/s2_corpus_test.json --calibrate --out analysis/audit/results/s_f_detectors.json
  else
    echo; echo "S-F skipped: analysis/audit/blackbox_sensitive.json does not exist (the real crisis pages must be captured first)"; SKIPPED+=(s-f)
  fi
else SKIPPED+=(s-f); fi

if want figs; then
  step fig-f10 python -m analysis.figures.f10_disclosure_frontier
  step fig-f11 python -m analysis.figures.f11_cold_generation
  step fig-f12 python -m analysis.figures.f12_seam_cdf
  step build-all python analysis/build_all.py
  step numbers python analysis/numbers_diff.py --list
else SKIPPED+=(figures); fi

echo; echo "=============== summary ==============="
echo "done:    ${DONE[*]:-none}"
echo "skipped: ${SKIPPED[*]:-none}"
echo "failed:  ${FAILED[*]:-none}"
[[ ${#FAILED[@]} -eq 0 ]]
