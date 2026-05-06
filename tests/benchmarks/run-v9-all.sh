#!/usr/bin/env bash
# V9 batch · 10 家并行 · 24 题/家 · runs=1
set -uo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
TS=$(date +%Y%m%d-%H%M%S)
RUN_DIR="$BENCH_DIR/v9-comprehensive/results/batch-$TS"
mkdir -p "$RUN_DIR"

PROVIDERS=(
  "Qwen3.6-Plus"
  "DeepSeek V4-Pro"
  "DeepSeek V4-Flash"
  "Kimi K2.6"
  "GLM-5-Turbo"
  "GLM-5.1"
  "MiniMax M2.7"
  "Step-3.5-Flash"
  "MiMo 2.5 Pro"
  "HY3 (Hy3-Preview)"
)

cd "$BENCH_DIR/v9-comprehensive"
echo "V9 batch · ${#PROVIDERS[@]} providers · 24 题/家 · runs=1 · ts=$TS" | tee "$RUN_DIR/run.log"
echo "Output: $RUN_DIR" | tee -a "$RUN_DIR/run.log"

PIDS=()
for p in "${PROVIDERS[@]}"; do
  safe=$(echo "$p" | tr ' ()' '___' | tr -d '.')
  out="$RUN_DIR/v9_${safe}.json"
  log="$RUN_DIR/v9_${safe}.log"
  (
    python3 scripts/harness_v9.py \
      --provider "$p" \
      --all \
      --runs 1 \
      --timeout 240 \
      --out "$out" > "$log" 2>&1
    echo "[done] $p exit=$?" >> "$RUN_DIR/run.log"
  ) &
  PIDS+=($!)
  echo "[start] $p (pid $!)" | tee -a "$RUN_DIR/run.log"
  sleep 0.5
done

echo "Waiting for ${#PIDS[@]} jobs..." | tee -a "$RUN_DIR/run.log"
wait
echo "All V9 jobs complete at $(date)" | tee -a "$RUN_DIR/run.log"
echo "Results: $RUN_DIR"
