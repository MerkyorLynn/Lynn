#!/usr/bin/env bash
# V9 56 题 batch · 16 家 · 4 harness 协调
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TS=$(date +%Y%m%d-%H%M%S)
RUN_DIR="$REPO/tests/benchmarks/v9-comprehensive/results/batch56-$TS"
mkdir -p "$RUN_DIR"

cd "$REPO/tests/benchmarks/v9-comprehensive"

# Path-based provider runners
H9="python3 scripts/harness_v9.py"
H_GPT5="python3 scripts/harness_v9_gpt5.py"
H_GEMINI_CLI="python3 scripts/harness_v9_gemini.py"
H_GEMINI_API="python3 scripts/harness_v9_gemini_api.py"

declare -a JOBS=(
  # 10 家走通用 harness_v9.py(原有 PROVIDERS)
  "v9 'DeepSeek V4-Pro' DeepSeek_V4-Pro"
  "v9 'DeepSeek V4-Flash' DeepSeek_V4-Flash"
  "v9 'Kimi K2.6' Kimi_K26"
  "v9 'GLM-5.1' GLM-51"
  "v9 'MiniMax M2.7' MiniMax_M27"
  "v9 'Step-3.5-Flash' Step-35-Flash"
  "v9 'MiMo 2.5 Pro' MiMo_25_Pro"
  "v9 'HY3 (Hy3-Preview)' HY3_Hy3-Preview"
  # GPT 走 codex OAuth
  "gpt5 gpt-5.4 GPT-54"
  "gpt5 gpt-5.5 GPT-55"
  # Gemini 2.5 走 CLI OAuth (免费)
  "gemcli gemini-2.5-pro Gemini-25-Pro"
  "gemcli gemini-2.5-flash Gemini-25-Flash"
  # Gemini 3.x 走 GAS native API
  "gemapi gemini-3-flash-preview 'Gemini 3 Flash' Gemini-3-Flash"
  "gemapi gemini-3.1-flash-lite-preview 'Gemini 3.1 Flash-Lite' Gemini-31-Flash-Lite"
  "gemapi gemini-3.1-pro-preview 'Gemini 3.1 Pro' Gemini-31-Pro"
)
# Note: GLM-5-Turbo 因历史 rate-limit 单跑;Qwen3.6-Plus DashScope free 耗尽跳过

run_v9() {
  local prov="$1" safe="$2"
  $H9 --provider "$prov" --all --runs 1 --timeout 240 \
      --out "$RUN_DIR/v9_${safe}.json" > "$RUN_DIR/v9_${safe}.log" 2>&1
}
run_gpt5() {
  local model="$1" safe="$2"
  $H_GPT5 --model "$model" --all --runs 1 --timeout 240 \
      --out "$RUN_DIR/v9_${safe}.json" > "$RUN_DIR/v9_${safe}.log" 2>&1
}
run_gemcli() {
  local model="$1" safe="$2"
  $H_GEMINI_CLI --model "$model" --all --runs 1 --timeout 240 \
      --out "$RUN_DIR/v9_${safe}.json" > "$RUN_DIR/v9_${safe}.log" 2>&1
}
run_gemapi() {
  local model="$1" name="$2" safe="$3"
  $H_GEMINI_API --model "$model" --name "$name" --all --runs 1 --timeout 240 \
      --out "$RUN_DIR/v9_${safe}.json" > "$RUN_DIR/v9_${safe}.log" 2>&1
}

echo "V9 56 batch · ${#JOBS[@]} providers · ts=$TS" | tee "$RUN_DIR/run.log"
echo "Output: $RUN_DIR" | tee -a "$RUN_DIR/run.log"

PIDS=()
for j in "${JOBS[@]}"; do
  eval "args=($j)"
  type="${args[0]}"
  case "$type" in
    v9)
      prov="${args[1]}" safe="${args[2]}"
      (run_v9 "$prov" "$safe"; echo "[done] $prov exit=$?" >> "$RUN_DIR/run.log") &
      ;;
    gpt5)
      model="${args[1]}" safe="${args[2]}"
      (run_gpt5 "$model" "$safe"; echo "[done] $model exit=$?" >> "$RUN_DIR/run.log") &
      ;;
    gemcli)
      model="${args[1]}" safe="${args[2]}"
      (run_gemcli "$model" "$safe"; echo "[done] $model exit=$?" >> "$RUN_DIR/run.log") &
      ;;
    gemapi)
      model="${args[1]}" name="${args[2]}" safe="${args[3]}"
      (run_gemapi "$model" "$name" "$safe"; echo "[done] $name exit=$?" >> "$RUN_DIR/run.log") &
      ;;
  esac
  PIDS+=($!)
  echo "[start] $type ${args[*]:1} (pid $!)" | tee -a "$RUN_DIR/run.log"
  sleep 0.5
done

# GLM-5-Turbo sequential (rate-limit 历史,延后启动)
sleep 5
echo "[start] GLM-5-Turbo (sequential延后)" | tee -a "$RUN_DIR/run.log"
($H9 --provider "GLM-5-Turbo" --all --runs 1 --timeout 240 \
    --out "$RUN_DIR/v9_GLM-5-Turbo.json" > "$RUN_DIR/v9_GLM-5-Turbo.log" 2>&1
 echo "[done] GLM-5-Turbo exit=$?" >> "$RUN_DIR/run.log") &
PIDS+=($!)

echo "Waiting for ${#PIDS[@]} jobs..." | tee -a "$RUN_DIR/run.log"
wait
echo "All V9 jobs complete at $(date)" | tee -a "$RUN_DIR/run.log"
echo "Results: $RUN_DIR"
