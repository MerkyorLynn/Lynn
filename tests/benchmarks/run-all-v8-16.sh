#!/usr/bin/env bash
# V8 cloud · 16 家并行(走 v8-cloud.mjs 统一)
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TS=$(date +%Y%m%d-%H%M%S)
RUN_DIR="$REPO/tests/benchmarks/output/v8-cloud-batch16-$TS"
mkdir -p "$RUN_DIR"

PROVIDERS=(
  "DeepSeek V4-Pro"
  "DeepSeek V4-Flash"
  "Kimi K2.6"
  "GLM-5.1"
  "MiniMax M2.7"
  "Step-3.5-Flash"
  "MiMo 2.5 Pro"
  "HY3 (Hy3-Preview)"
  "GPT-5.5"
  "GPT-5.4"
  "Gemini 2.5 Pro"
  "Gemini 2.5 Flash"
  "Gemini 3 Flash"
  "Gemini 3.1 Flash-Lite"
  "Gemini 3.1 Pro"
  # GLM-5-Turbo 单跑(rate-limit 历史)
)

cd "$REPO"
echo "V8 16-family batch · ts=$TS" | tee "$RUN_DIR/run.log"
echo "Output: $RUN_DIR" | tee -a "$RUN_DIR/run.log"

PIDS=()
for p in "${PROVIDERS[@]}"; do
  safe=$(echo "$p" | tr ' ()' '___' | tr -d '.')
  outdir="$RUN_DIR/$safe"
  log="$RUN_DIR/v8_${safe}.log"
  (
    node tests/benchmarks/v8-cloud.mjs --provider "$p" --output "$outdir" > "$log" 2>&1
    echo "[done] $p exit=$?" >> "$RUN_DIR/run.log"
  ) &
  PIDS+=($!)
  echo "[start] $p (pid $!)" | tee -a "$RUN_DIR/run.log"
  sleep 0.5
done

# GLM-5-Turbo sequential 延后
sleep 5
echo "[start] GLM-5-Turbo (sequential)" | tee -a "$RUN_DIR/run.log"
(
  node tests/benchmarks/v8-cloud.mjs --provider "GLM-5-Turbo" --output "$RUN_DIR/GLM-5-Turbo" > "$RUN_DIR/v8_GLM-5-Turbo.log" 2>&1
  echo "[done] GLM-5-Turbo exit=$?" >> "$RUN_DIR/run.log"
) &
PIDS+=($!)

echo "Waiting for ${#PIDS[@]} jobs..." | tee -a "$RUN_DIR/run.log"
wait
echo "All V8 jobs complete at $(date)" | tee -a "$RUN_DIR/run.log"
echo "Results: $RUN_DIR"
