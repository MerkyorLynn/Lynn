#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Local Mac/Linux launcher for Lynn's default Qwen3.5-9B Q4_K_M imatrix MTP GGUF route.
#
# This is the product-facing counterpart to Lynn Engine's NVIDIA/NVFP4 route:
# it starts a llama.cpp OpenAI-compatible endpoint that agent CLIs can use with
# the same base_url/model shape as the Lynn server.
#
# Usage:
#   bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh
#   bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh --help
#   GGUF=~/Models/model.gguf bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh
#   DRY_RUN=1 bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh
#
# Environment variables:
#   HOST, PORT, SERVED_NAME, CTX_SIZE, THREADS, PARALLEL, N_GPU_LAYERS,
#   LLAMA_SERVER, LLAMA_EXTRA_ARGS, LLAMA_REASONING_ARGS, LLAMA_MTP_ARGS,
#   GGUF, MODEL_ROOT,
#   LOG_DIR, DRY_RUN
# ─────────────────────────────────────────────────────────────────────────────

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-18099}"
SERVED_NAME="${SERVED_NAME:-qwen35-9b-q4km-imatrix}"
CTX_SIZE="${CTX_SIZE:-32768}"
THREADS="${THREADS:-}"
# llama.cpp splits --ctx-size across parallel slots. Lynn's local-first UX is a
# single-user 32K experience, so default to one slot unless explicitly changed.
PARALLEL="${PARALLEL:-1}"
N_GPU_LAYERS="${N_GPU_LAYERS:-999}"
LLAMA_SERVER="${LLAMA_SERVER:-}"
LLAMA_EXTRA_ARGS="${LLAMA_EXTRA_ARGS:-}"
LLAMA_REASONING_ARGS="${LLAMA_REASONING_ARGS:---jinja --reasoning auto --reasoning-budget -1}"
LLAMA_MTP_ARGS="${LLAMA_MTP_ARGS:---spec-type draft-mtp --spec-draft-n-max 4}"
GGUF="${GGUF:-}"
MODEL_ROOT="${MODEL_ROOT:-$HOME/Models/Lynn/Qwen3.5-9B}"
LOG_DIR="${LOG_DIR:-$HOME/.lynn-engine/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/qwen35_9b_llamacpp_${PORT}.log}"
DRY_RUN="${DRY_RUN:-0}"

# ─────────────────────────────────────────────────────────────────────────────
# CLI flag parsing
# ─────────────────────────────────────────────────────────────────────────────
show_help() {
  cat <<'HELP'
Usage: local_qwen35_9b_q4km_llamacpp_server.sh [OPTIONS]

Start a local llama.cpp OpenAI-compatible endpoint for Qwen3.5-9B Q4_K_M imatrix MTP.

Options:
  --port PORT           Server port (default: 18099)
  --host ADDR           Bind address (default: 127.0.0.1)
  --model-name NAME     Served model name (default: qwen35-9b-q4km-imatrix)
  --ctx SIZE            Context window (default: 32768)
  --threads N           CPU threads (default: auto-detect)
  --parallel N          Max concurrent slots (default: 1; preserves full --ctx per user)
  --gpu-layers N        Layers to offload to GPU (default: 999=all)
  --gguf PATH           GGUF model file path (overrides auto-discovery)
  --llama-server PATH   llama-server binary path (overrides auto-discovery)
  --flash-attn [MODE]   Enable flash attention with MODE auto/on/off (default: off)
  --dry-run             Print resolved config and exit without starting
  --help, -h            Show this help message

Environment:
  GGUF                  Model path (same as --gguf)
  MODEL_ROOT            Root directory for model search (default: ~/Models/Lynn/Qwen3.5-9B)
  LLAMA_SERVER          Binary path (same as --llama-server)
  LLAMA_EXTRA_ARGS      Additional llama-server arguments
  LLAMA_REASONING_ARGS  Reasoning flags (default: --jinja --reasoning auto --reasoning-budget -1)
  LLAMA_MTP_ARGS        Speculative decoding flags (default: --spec-type draft-mtp --spec-draft-n-max 4)
  DRY_RUN=1             Same as --dry-run
  LOG_DIR               Log directory (default: ~/.lynn-engine/logs)

Examples:
  # Auto-discover everything:
  bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh

  # Explicit model path:
  GGUF=~/Models/Lynn/Qwen3.5-9B/q4_k_m/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh

  # Different port + dry run check:
  bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh --port 8080 --dry-run

  # Expose on LAN:
  bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh --host 0.0.0.0
HELP
  exit 0
}

FLASH_ATTN_MODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)          PORT="$2"; shift 2 ;;
    --host)          HOST="$2"; shift 2 ;;
    --model-name)    SERVED_NAME="$2"; shift 2 ;;
    --ctx)           CTX_SIZE="$2"; shift 2 ;;
    --threads)       THREADS="$2"; shift 2 ;;
    --parallel)      PARALLEL="$2"; shift 2 ;;
    --gpu-layers)    N_GPU_LAYERS="$2"; shift 2 ;;
    --gguf)          GGUF="$2"; shift 2 ;;
    --llama-server)  LLAMA_SERVER="$2"; shift 2 ;;
    --flash-attn)
      if [[ $# -ge 2 && ! "$2" =~ ^-- ]]; then
        FLASH_ATTN_MODE="$2"
        shift 2
      else
        FLASH_ATTN_MODE="auto"
        shift
      fi
      ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --help|-h)       show_help ;;
    *)               echo "[qwen35-q4km-local] Unknown flag: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$LOG_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Platform detection
# ─────────────────────────────────────────────────────────────────────────────
PLATFORM="unknown"
GPU_HINT=""

case "$(uname -s)" in
  Darwin)
    PLATFORM="macos"
    if sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi apple; then
      GPU_HINT="metal"
    fi
    ;;
  Linux)
    PLATFORM="linux"
    if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
      GPU_HINT="cuda"
    fi
    ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# llama-server auto-discovery
# ─────────────────────────────────────────────────────────────────────────────
find_llama_server() {
  if [[ -n "$LLAMA_SERVER" && -x "$LLAMA_SERVER" ]]; then
    printf '%s\n' "$LLAMA_SERVER"
    return 0
  fi
  for candidate in \
    "$(command -v llama-server 2>/dev/null || true)" \
    "$(command -v llama.cpp-server 2>/dev/null || true)" \
    "/opt/homebrew/bin/llama-server" \
    "/usr/local/bin/llama-server" \
    "$HOME/llama.cpp/build/bin/llama-server" \
    "$HOME/llama.cpp/build/tools/server/llama-server" \
    "$HOME/llama.cpp/build-cuda/bin/llama-server"; do
    if [[ -n "${candidate:-}" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

server_bin="$(find_llama_server || true)"
if [[ -z "$server_bin" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    server_bin="${LLAMA_SERVER:-/absolute/path/to/llama-server}"
  else
  cat >&2 <<'EOF'
[qwen35-q4km-local] ERROR: llama-server not found.

Install one of:
  # macOS (Homebrew):
  brew install llama.cpp

  # Build from source (macOS Metal):
  git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
  cmake -S ~/llama.cpp -B ~/llama.cpp/build -DGGML_METAL=ON
  cmake --build ~/llama.cpp/build -j

  # Build from source (Linux CUDA):
  git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
  cmake -S ~/llama.cpp -B ~/llama.cpp/build -DGGML_CUDA=ON
  cmake --build ~/llama.cpp/build -j

Then rerun this script, or set LLAMA_SERVER=/path/to/llama-server.
EOF
  exit 3
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# GGUF auto-discovery
# ─────────────────────────────────────────────────────────────────────────────
find_gguf() {
  if [[ -n "$GGUF" && -s "$GGUF" ]]; then
    printf '%s\n' "$GGUF"
    return 0
  fi
  if [[ -n "$GGUF" && ! -e "$GGUF" ]]; then
    echo "[qwen35-q4km-local] ERROR: specified GGUF path does not exist: $GGUF" >&2
    return 1
  fi

  local roots=(
    "$HOME/.lynn/models"
    "$MODEL_ROOT"
    "$HOME/Models"
    "$HOME/models"
    "$HOME/Downloads"
    "$HOME/.cache/huggingface/hub"
    "$PWD"
  )
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r candidate; do
      [[ "$candidate" == *"/."* ]] && continue
      if [[ -s "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done < <(find "$root" -maxdepth 5 -type f \( \
      -iname '*Qwen3.5*9B*Q4*K*M*.gguf' -o \
      -iname '*qwen3.5*9b*q4*k*m*.gguf' -o \
      -iname '*Qwen3.5*9B*Q4_K_M*.gguf' -o \
      -iname '*qwen3.5*9b*q4_k_m*.gguf' \
    \) 2>/dev/null | sort)
  done
  return 1
}

gguf_path="$(find_gguf || true)"
if [[ -z "$gguf_path" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    gguf_path="${GGUF:-/absolute/path/to/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf}"
  else
  cat >&2 <<EOF
[qwen35-q4km-local] ERROR: Qwen3.5-9B Q4_K_M imatrix MTP GGUF not found.

Searched:
  $MODEL_ROOT
  $HOME/Models
  $HOME/models
  $HOME/Downloads
  $HOME/.cache/huggingface/hub
  $PWD

Download options:

  # HuggingFace mirror:
  aria2c -x 16 -s 16 -c -d ~/Models \\
    'https://hf-mirror.com/nerkyor/Qwen3.5-9B-GGUF-imatrix-MTP/resolve/main/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf'

  # ModelScope (China):
  modelscope download Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf --local_dir ~/Models/Lynn/Qwen3.5-9B/q4_k_m

Then rerun, or set GGUF=/path/to/model.gguf
EOF
  exit 4
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Thread auto-detection
# ─────────────────────────────────────────────────────────────────────────────
if [[ -z "$THREADS" ]]; then
  THREADS="$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null \
    || sysctl -n hw.ncpu 2>/dev/null \
    || nproc 2>/dev/null \
    || echo 8)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary banner
# ─────────────────────────────────────────────────────────────────────────────
GGUF_SIZE="$(du -sh "$gguf_path" 2>/dev/null | cut -f1 || echo '?')"
SERVER_VER="$("$server_bin" --version 2>/dev/null | head -1 || echo 'unknown')"

cat <<EOF
┌──────────────────────────────────────────────────────────────────┐
│  Lynn Engine — Qwen3.5-9B Q4_K_M imatrix MTP Local Endpoint    │
└──────────────────────────────────────────────────────────────────┘
  Platform:      $PLATFORM ($GPU_HINT)
  Server:        $server_bin
  Server ver:    $SERVER_VER
  Model:         $gguf_path ($GGUF_SIZE)
  Endpoint:      http://$HOST:$PORT/v1
  Served name:   $SERVED_NAME
  Context:       $CTX_SIZE
  Threads:       $THREADS
  Parallel:      $PARALLEL
  GPU layers:    $N_GPU_LAYERS
  Flash attn:    ${FLASH_ATTN_MODE:-off}
  MTP:           ${LLAMA_MTP_ARGS:-off}
  Log:           $LOG_FILE

  Connect your agent:
    base_url = http://$HOST:$PORT/v1
    api_key  = local
    model    = $SERVED_NAME
EOF

# ─────────────────────────────────────────────────────────────────────────────
# DRY_RUN: print config and exit
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "1" ]]; then
  echo ""
  echo "[qwen35-q4km-local] DRY_RUN=1 — not starting server."
  echo "[qwen35-q4km-local] All discovery passed. Ready to serve."
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Build and exec
# ─────────────────────────────────────────────────────────────────────────────
CMD=(
  "$server_bin"
  --model "$gguf_path"
  --host "$HOST"
  --port "$PORT"
  --ctx-size "$CTX_SIZE"
  --threads "$THREADS"
  --parallel "$PARALLEL"
  --n-gpu-layers "$N_GPU_LAYERS"
  -a "$SERVED_NAME"
)

# With `set -o pipefail`, `grep -q` can close the pipe early and make
# `llama-server --help` report SIGPIPE, so capture help text before matching.
server_help="$("$server_bin" --help 2>&1 || true)"
if [[ "$server_help" == *"--metrics"* ]]; then
  CMD+=(--metrics)
fi

# MTP speculative decoding. Older llama.cpp builds may not expose the new
# draft-mtp flags yet; keep startup usable and warn instead of failing.
if [[ -n "$LLAMA_MTP_ARGS" ]]; then
  if [[ "$server_help" == *"--spec-type"* ]]; then
    read -ra _mtp_arr <<< "$LLAMA_MTP_ARGS"
    CMD+=("${_mtp_arr[@]}")
  else
    echo "[qwen35-q4km-local] WARN: llama-server does not support --spec-type; starting without MTP." >&2
  fi
fi

# Reasoning/jinja args (space-separated, intentionally unquoted for word-splitting)
if [[ -n "$LLAMA_REASONING_ARGS" ]]; then
  read -ra _reasoning_arr <<< "$LLAMA_REASONING_ARGS"
  CMD+=("${_reasoning_arr[@]}")
fi

# Flash attention
if [[ -n "$FLASH_ATTN_MODE" ]]; then
  CMD+=(--flash-attn "$FLASH_ATTN_MODE")
fi

# Extra args (space-separated, intentionally unquoted for word-splitting)
if [[ -n "$LLAMA_EXTRA_ARGS" ]]; then
  read -ra _extra_arr <<< "$LLAMA_EXTRA_ARGS"
  CMD+=("${_extra_arr[@]}")
fi

echo ""
echo "[qwen35-q4km-local] Starting: ${CMD[*]}"
echo ""

exec "${CMD[@]}"
