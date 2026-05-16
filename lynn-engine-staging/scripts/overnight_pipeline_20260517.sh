#!/bin/bash
# Lynn 27B A3B Spark overnight pipeline
# Author: Claude autonomous, started 2026-05-17 01:0X
# Goal: TPS >= 70 on Spark + v2 NVFP4 transfer + sha256 + A3B alias + SP-17
#
# Architecture:
#   Track 1 (background): v2 transfer monitor — auto retry stalls / sha256 / alias / SP-17 when done
#   Track 2 (sequential): TPS optimization grid — 5 configs, each restart→quality→bench
#   Final: lock best config + 15-iter long bench + write summary
#
# Run via nohup; logs to /home/merkyor/reports/overnight_optim_20260517/master.log

set -uo pipefail
RESULTSDIR=/home/merkyor/reports/overnight_optim_20260517
mkdir -p "$RESULTSDIR"
MASTERLOG="$RESULTSDIR/master.log"
SUMMARY="$RESULTSDIR/final_summary.md"
V2DIR=/home/merkyor/models/lynn-27b-w4a8-nvfp4-v2

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$MASTERLOG"
}

# =====================================================================
# v2 transfer monitor (background)
# =====================================================================
v2_monitor() {
  log "[v2] monitor started"
  local stalled_count=0
  local prev_size=0
  local retry_count=0

  while true; do
    local n_rsync
    n_rsync=$(pgrep -af "rsync.*lynn-27b-w4a8-nvfp4-v2" 2>/dev/null | grep -v grep | grep -v "v2_resume" | grep -vc "v2_monitor" || true)
    local cur_size
    cur_size=$(du -sb "$V2DIR" 2>/dev/null | awk '{print $1}')
    cur_size=${cur_size:-0}

    log "[v2] poll: rsync=$n_rsync size=$cur_size"

    if [ "$n_rsync" -eq 0 ]; then
      if [ "$cur_size" -ge 19000000000 ]; then
        log "[v2] transfer COMPLETE ($cur_size bytes)"
        break
      else
        retry_count=$((retry_count+1))
        if [ "$retry_count" -gt 3 ]; then
          log "[v2] FAIL: rsync stopped early after $retry_count retries (size=$cur_size)"
          return 1
        fi
        log "[v2] rsync stopped early ($cur_size bytes) — retry $retry_count/3"
        bash /tmp/v2_resume.sh &
        sleep 60
      fi
    else
      if [ "$cur_size" = "$prev_size" ]; then
        stalled_count=$((stalled_count+1))
        if [ "$stalled_count" -ge 6 ]; then
          retry_count=$((retry_count+1))
          if [ "$retry_count" -gt 3 ]; then
            log "[v2] FAIL: stalled $retry_count times, giving up"
            return 1
          fi
          log "[v2] STALL detected (6 min no growth) — kill+retry $retry_count/3"
          pkill -9 -f "rsync.*lynn-27b-w4a8-nvfp4-v2" 2>/dev/null || true
          sleep 5
          bash /tmp/v2_resume.sh &
          stalled_count=0
        fi
      else
        stalled_count=0
      fi
      prev_size=$cur_size
    fi
    sleep 60
  done

  # ===== Post-transfer: sha256 + alias + SP-17 =====
  log "[v2] running sha256sum -c SHA256SUMS..."
  (cd "$V2DIR" && sha256sum -c SHA256SUMS) > "$RESULTSDIR/sha256_result.txt" 2>&1
  local sha_rc=$?
  if [ "$sha_rc" -eq 0 ]; then
    log "[v2] sha256 PASS"
  else
    log "[v2] sha256 FAIL — see $RESULTSDIR/sha256_result.txt"
    return 1
  fi

  ln -sfn "$V2DIR" /home/merkyor/models/lynn-27b-a3b-w4a8-nvfp4-v2
  log "[v2] A3B alias symlink created"

  log "[v2] running SP-17 validation gate..."
  docker exec lynn-27b-nvfp4-server python3 /lynn-engine/benchmarks/sp17_v2_artifact_receive_validation.py \
    --v2-dir "$V2DIR" \
    --v0-dir /home/merkyor/models/lynn-27b-variable-recovery-step5000-nvfp4-final \
    > "$RESULTSDIR/sp17_result.txt" 2>&1 || true
  local sp17_overall=$(grep "SP-17 v2 artifact receive gate" "$RESULTSDIR/sp17_result.txt" | tail -1)
  log "[v2] SP-17 result: $sp17_overall"
  log "[v2] done"
}

# =====================================================================
# Helper: restart container with env vars
# =====================================================================
restart_with_envs() {
  local name="$1"
  shift
  log "[restart] $name"

  docker rm -f lynn-27b-nvfp4-server > /dev/null 2>&1 || true

  local -a docker_cmd=(
    docker run -d --name lynn-27b-nvfp4-server
    --gpus all --restart=no --ipc=host
    -p 18099:18099
    -v /home/merkyor/models:/models
    -v /home/merkyor/lynn-engine:/lynn-engine
    -w /lynn-engine
    -e PYTHONPATH=/lynn-engine
  )
  for e in "$@"; do
    docker_cmd+=(-e "$e")
  done
  docker_cmd+=(
    lmsysorg/sglang:dev-cu13
    bash -c "pip install -q transformers==4.57.0 fastapi uvicorn pydantic 2>&1 | tail -3 && python3 -m server.openai_http --model /models/lynn-27b-variable-recovery-step5000-nvfp4-final --host 0.0.0.0 --port 18099 --served-name Lynn-V4-Distill-Qwen-27B-A3B-NVFP4 2>&1"
  )

  "${docker_cmd[@]}" > /tmp/docker_run.log 2>&1
  local i=0
  while [ "$i" -lt 40 ]; do
    if curl -sf -m 3 http://localhost:18099/v1/models > /dev/null 2>&1; then
      log "[restart] $name UP after $((i*5))s"
      return 0
    fi
    sleep 5
    i=$((i+1))
  done
  log "[restart] $name FAIL: server did not become ready in 200s"
  return 1
}

# =====================================================================
# Quality smoke (5 prompts, must contain key strings)
# =====================================================================
quality_smoke() {
  local name="$1"
  local out_file="$RESULTSDIR/${name}_quality.json"
  docker exec lynn-27b-nvfp4-server python3 <<'PYEOF' > "$out_file" 2>&1
import json, urllib.request
URL = 'http://localhost:18099/v1/completions'
PROMPTS = [
    ('What is the capital of France? Answer briefly.', 'Paris'),
    ('List three programming languages.', 'Python'),
    ('Translate to Chinese: I love machine learning.', '机器学习'),
    ('Calculate: 17 * 23 = ?', '391'),
    ('Write a Python Fibonacci function.', 'def '),
]
results = []
for p, must in PROMPTS:
    body = json.dumps({'model':'Lynn-V4-Distill-Qwen-27B-A3B-NVFP4','prompt':p,'max_tokens':80,'temperature':0.0}).encode()
    req = urllib.request.Request(URL, data=body, headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            d = json.loads(resp.read())
        out = d['choices'][0]['text']
        ok = must in out
    except Exception as e:
        out = f'ERROR: {e}'
        ok = False
    results.append({'prompt': p, 'must': must, 'output': out[:200], 'pass': ok})
all_pass = all(r['pass'] for r in results)
print(json.dumps({'all_pass': all_pass, 'results': results}, indent=2, ensure_ascii=False))
PYEOF

  local pass=$(python3 -c "import json; print(json.load(open('$out_file')).get('all_pass', False))" 2>/dev/null)
  if [ "$pass" = "True" ]; then
    return 0
  else
    return 1
  fi
}

# =====================================================================
# TPS bench (N warm + N measure iters of 128-token greedy decode)
# =====================================================================
tps_bench() {
  local name="$1"
  local n_iter=${2:-7}
  local out_file="$RESULTSDIR/${name}_tps.json"
  docker exec lynn-27b-nvfp4-server python3 <<PYEOF > "$out_file" 2>&1
import json, urllib.request, time, statistics
URL = 'http://localhost:18099/v1/completions'
P = 'Write a detailed essay on the future of artificial intelligence and human collaboration in scientific research, covering at least three major application areas.'
N_WARM = 2
N_TOTAL = $n_iter + 2
times, tokens = [], []
for i in range(N_TOTAL):
    body = json.dumps({'model':'Lynn-V4-Distill-Qwen-27B-A3B-NVFP4','prompt':P,'max_tokens':128,'temperature':0.0}).encode()
    req = urllib.request.Request(URL, data=body, headers={'Content-Type':'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as resp:
        d = json.loads(resp.read())
    dt = time.time() - t0
    n = d['usage']['completion_tokens']
    if i >= N_WARM:
        times.append(dt)
        tokens.append(n)
tps_per = [n/t for n,t in zip(tokens, times)]
print(json.dumps({
    'mean_tps': statistics.mean(tps_per),
    'stdev_tps': statistics.stdev(tps_per) if len(tps_per)>1 else 0.0,
    'min_tps': min(tps_per),
    'max_tps': max(tps_per),
    'n_iters': len(tps_per),
    'per_iter': [{'time': t, 'tokens': n, 'tps': r} for t,n,r in zip(times, tokens, tps_per)],
}, indent=2))
PYEOF

  python3 -c "import json; print(json.load(open('$out_file')).get('mean_tps', 0))" 2>/dev/null || echo 0
}

# =====================================================================
# Main pipeline
# =====================================================================
log "========== OVERNIGHT PIPELINE START =========="
log "Goal: TPS >= 70 on Spark Lynn 27B A3B + v2 transfer + SP-17 gate"
log "Baseline measured: 36.4 TPS (config A: packed_nvfp4 + native_fast_2d + graph)"

# Start v2 monitor in background
v2_monitor &
V2_PID=$!
log "[main] v2 monitor pid=$V2_PID"

# Config grid (additive: each builds on previous)
BASE_ENVS=(
  "LYNN_MOE_IMPL=packed_nvfp4"
  "LYNN_PACKED_DECODE=1"
  "LYNN_PACKED_DECODE_BACKEND=native_fast_2d"
  "LYNN_PACKED_DECODE_FULL_ATTN=1"
  "LYNN_PACKED_DECODE_LINEAR_ATTN=1"
  "LYNN_LINEAR_BLOCK_GRAPH=1"
  "LYNN_LINEAR_BLOCK_GRAPH_REUSE=1"
  "LYNN_LINEAR_BLOCK_GRAPH_PREWARM=1"
  "LYNN_LINEAR_ATTN_RECURRENT_BACKEND=triton_fused_prepare"
  "LYNN_LINEAR_ATTN_RECURRENT_INPLACE=1"
  "LYNN_LINEAR_ATTN_INPROJ_FUSED=1"
  "LYNN_QK_NORM_ROPE_BACKEND=triton_pair"
  "LYNN_RMSNORM_GATED_BACKEND=triton"
  "LYNN_LINEAR_STATE_UPDATE=inplace"
  "LYNN_PREFILL_WARMUP=1"
  "LYNN_SP_TRITON_AUTOTUNE=1"
  "LYNN_NATIVE_CUDA_ARCH=sm_121a"
)

declare -A TPS_RESULTS
declare -A QUALITY_RESULTS

run_config() {
  local name="$1"
  shift
  local -a envs=("$@")
  log ""
  log "----- [grid] config: $name -----"
  if ! restart_with_envs "$name" "${envs[@]}"; then
    TPS_RESULTS[$name]="FAIL_STARTUP"
    QUALITY_RESULTS[$name]="N/A"
    return
  fi
  if quality_smoke "$name"; then
    QUALITY_RESULTS[$name]="PASS"
    log "[grid] $name quality PASS"
    local tps
    tps=$(tps_bench "$name")
    TPS_RESULTS[$name]="$tps"
    log "[grid] $name mean TPS = $tps"
  else
    QUALITY_RESULTS[$name]="FAIL"
    TPS_RESULTS[$name]="QUALITY_FAIL"
    log "[grid] $name quality FAIL — see ${name}_quality.json"
  fi
}

# Config A: baseline (already verified 36.4 TPS but rebench for stable reference)
run_config "A_baseline" "${BASE_ENVS[@]}"

# Config B: + native FP4 lm_head
run_config "B_native_fp4_lm_head" "${BASE_ENVS[@]}" "LYNN_NATIVE_FP4_LM_HEAD=1"

# Config C: + linear attn inproj fused native FP4
run_config "C_linear_attn_native_fp4" "${BASE_ENVS[@]}" "LYNN_NATIVE_FP4_LM_HEAD=1" "LYNN_LINEAR_ATTN_INPROJ_FUSED_NATIVE_FP4=1"

# Config D: + packed shared expert
run_config "D_packed_shared_expert" "${BASE_ENVS[@]}" "LYNN_NATIVE_FP4_LM_HEAD=1" "LYNN_LINEAR_ATTN_INPROJ_FUSED_NATIVE_FP4=1" "LYNN_PACKED_SHARED_EXPERT=1"

# Config E: + packed decode prepare native
run_config "E_packed_prep_native" "${BASE_ENVS[@]}" "LYNN_NATIVE_FP4_LM_HEAD=1" "LYNN_LINEAR_ATTN_INPROJ_FUSED_NATIVE_FP4=1" "LYNN_PACKED_SHARED_EXPERT=1" "LYNN_PACKED_DECODE_PREPARE_NATIVE=1"

# ===== Pick best =====
log ""
log "========== TPS GRID RESULTS =========="
best_name=""
best_tps=0
for name in A_baseline B_native_fp4_lm_head C_linear_attn_native_fp4 D_packed_shared_expert E_packed_prep_native; do
  r="${TPS_RESULTS[$name]:-MISSING}"
  q="${QUALITY_RESULTS[$name]:-N/A}"
  log "  $name: TPS=$r quality=$q"
  if [[ "$r" =~ ^[0-9.]+$ ]] && [ "$q" = "PASS" ]; then
    if awk "BEGIN {exit !($r > $best_tps)}"; then
      best_tps=$r
      best_name=$name
    fi
  fi
done

log ""
log "========== BEST: $best_name @ $best_tps TPS =========="

# Lock best config + extended bench
if [ -n "$best_name" ]; then
  log ""
  log "===== locking BEST config $best_name + extended bench (15 iter) ====="
  case "$best_name" in
    A_baseline) envs=("${BASE_ENVS[@]}") ;;
    B_native_fp4_lm_head) envs=("${BASE_ENVS[@]}" "LYNN_NATIVE_FP4_LM_HEAD=1") ;;
    C_linear_attn_native_fp4) envs=("${BASE_ENVS[@]}" "LYNN_NATIVE_FP4_LM_HEAD=1" "LYNN_LINEAR_ATTN_INPROJ_FUSED_NATIVE_FP4=1") ;;
    D_packed_shared_expert) envs=("${BASE_ENVS[@]}" "LYNN_NATIVE_FP4_LM_HEAD=1" "LYNN_LINEAR_ATTN_INPROJ_FUSED_NATIVE_FP4=1" "LYNN_PACKED_SHARED_EXPERT=1") ;;
    E_packed_prep_native) envs=("${BASE_ENVS[@]}" "LYNN_NATIVE_FP4_LM_HEAD=1" "LYNN_LINEAR_ATTN_INPROJ_FUSED_NATIVE_FP4=1" "LYNN_PACKED_SHARED_EXPERT=1" "LYNN_PACKED_DECODE_PREPARE_NATIVE=1") ;;
  esac
  restart_with_envs "FINAL_$best_name" "${envs[@]}"
  quality_smoke "FINAL_$best_name" || true
  final_tps=$(tps_bench "FINAL_$best_name" 15)
  log "[final] $best_name extended-bench TPS = $final_tps"
else
  log "[final] NO config passed quality+TPS — leaving server in last grid config"
  final_tps="$best_tps"
fi

# Wait for v2 monitor
log ""
log "===== waiting for v2 transfer pipeline to complete ====="
wait $V2_PID || log "[main] v2 monitor exited non-zero"

# ===== Write final summary =====
log ""
log "===== writing final summary ====="
{
  echo "# Lynn 27B A3B Spark Overnight Optimization Summary"
  echo
  echo "**Date**: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "**Goal**: TPS >= 70 on Spark Lynn 27B A3B NVFP4"
  echo
  echo "## TPS Optimization Grid"
  echo
  echo "| Config | Mean TPS | Quality |"
  echo "|---|---|---|"
  for name in A_baseline B_native_fp4_lm_head C_linear_attn_native_fp4 D_packed_shared_expert E_packed_prep_native; do
    r="${TPS_RESULTS[$name]:-MISSING}"
    q="${QUALITY_RESULTS[$name]:-N/A}"
    echo "| $name | $r | $q |"
  done
  echo
  echo "## Best Result"
  echo
  if [ -n "$best_name" ]; then
    echo "- **Config**: $best_name"
    echo "- **Extended bench TPS**: $final_tps"
    echo "- **Target gap**: $(awk "BEGIN {printf \"%.1f\", (70 - $final_tps) / 70 * 100}")% to 70 TPS"
    if awk "BEGIN {exit !($final_tps >= 70)}"; then
      echo "- **VERDICT: ✅ TARGET HIT (>= 70 TPS)**"
    else
      echo "- **VERDICT: ⚠️ Below 70 TPS target. Best result locked in production."
    fi
  else
    echo "- NO config passed quality + TPS"
  fi
  echo
  echo "## v2 NVFP4 Artifact Status"
  echo
  if [ -f "$RESULTSDIR/sha256_result.txt" ]; then
    last_sha=$(tail -3 "$RESULTSDIR/sha256_result.txt")
    echo "**sha256sum**: \`$last_sha\`"
  else
    echo "**sha256sum**: NOT RUN (transfer incomplete)"
  fi
  if [ -L /home/merkyor/models/lynn-27b-a3b-w4a8-nvfp4-v2 ]; then
    echo "**A3B alias**: ✅ created"
  fi
  if [ -f "$RESULTSDIR/sp17_result.txt" ]; then
    sp17=$(grep "SP-17 v2 artifact receive gate" "$RESULTSDIR/sp17_result.txt" | tail -1)
    echo "**SP-17 gate**: \`$sp17\`"
  else
    echo "**SP-17**: NOT RUN"
  fi
  echo
  echo "## Production Server (locked)"
  echo
  docker ps --filter "name=lynn-27b-nvfp4-server" --format "Container: {{.Names}} | Status: {{.Status}}"
  echo
  echo "Env:"
  docker exec lynn-27b-nvfp4-server printenv 2>/dev/null | grep -E "^LYNN_" | sort | sed 's/^/  /'
  echo
  echo "## Files"
  echo
  echo "- Master log: \`$MASTERLOG\`"
  echo "- Per-config TPS: \`$RESULTSDIR/*_tps.json\`"
  echo "- Per-config quality: \`$RESULTSDIR/*_quality.json\`"
  echo "- sha256 / SP-17: \`$RESULTSDIR/sha256_result.txt\` / \`$RESULTSDIR/sp17_result.txt\`"
} > "$SUMMARY"

log "===== OVERNIGHT PIPELINE COMPLETE ====="
log "Summary: $SUMMARY"
