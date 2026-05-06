#!/usr/bin/env bash
# 冒烟测 12 家(V9 finance3 limit 1 · 1 run · 60s timeout)
# 通过的家才进 full batch
set -uo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
SMOKE_LOG="$BENCH_DIR/smoke-$(date +%Y%m%d-%H%M%S).log"

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
mkdir -p smoke-results

echo "Smoke test 10 providers (V9 finance3 · 1 题 · runs=1)" | tee "$SMOKE_LOG"
echo "Started: $(date)" | tee -a "$SMOKE_LOG"
echo "" | tee -a "$SMOKE_LOG"

for p in "${PROVIDERS[@]}"; do
  safe=$(echo "$p" | tr ' ()' '___')
  out="smoke-results/smoke_${safe}.json"
  echo "--- $p ---" | tee -a "$SMOKE_LOG"
  python3 scripts/harness_v9.py \
    --provider "$p" \
    --data finance3.json \
    --limit 1 \
    --runs 1 \
    --timeout 60 \
    --out "$out" 2>&1 | tail -5 | tee -a "$SMOKE_LOG"
  echo "" | tee -a "$SMOKE_LOG"
done

echo "Smoke complete. Log: $SMOKE_LOG"
