#!/usr/bin/env bash
set -euo pipefail

# Product-facing one-command setup for Lynn's default Qwen3.5-9B Q4_K_M imatrix MTP llama.cpp route.
#
# This script intentionally glues together the release pieces:
#   - model discovery / optional download
#   - llama-server discovery
#   - local env file generation
#   - optional transient smoke test
#
# It does not replace the lower-level launcher:
#   scripts/local_qwen35_9b_q4km_llamacpp_server.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODEL_ROOT="${MODEL_ROOT:-$HOME/Models/Lynn/Qwen3.5-9B}"
Q4KM_VARIANT="${Q4KM_VARIANT:-default}"
Q4KM_FILE_EXPLICIT=0
if [[ -n "${Q4KM_FILE:-}" ]]; then
  Q4KM_FILE_EXPLICIT=1
fi
ARTIFACT_ID_EXPLICIT=0
if [[ -n "${ARTIFACT_ID:-}" ]]; then
  ARTIFACT_ID_EXPLICIT=1
fi
SERVED_NAME_EXPLICIT=0
if [[ -n "${SERVED_NAME:-}" ]]; then
  SERVED_NAME_EXPLICIT=1
fi
LYNN_PROVIDER_CONFIG_EXPLICIT=0
if [[ -n "${LYNN_PROVIDER_CONFIG:-}" ]]; then
  LYNN_PROVIDER_CONFIG_EXPLICIT=1
fi
case "$Q4KM_VARIANT" in
  imatrix)
    Q4KM_FILE="${Q4KM_FILE:-Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf}"
    ARTIFACT_ID="${ARTIFACT_ID:-qwen35-9b-q4km-imatrix-gguf}"
    ;;
  default)
    Q4KM_FILE="${Q4KM_FILE:-Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf}"
    ARTIFACT_ID="${ARTIFACT_ID:-qwen35-9b-q4km-imatrix-gguf}"
    ;;
  *)
    echo "[qwen35-setup] Q4KM_VARIANT must be imatrix or default" >&2
    exit 2
    ;;
esac
Q4KM_DIR="$MODEL_ROOT/q4_k_m"
Q4KM_PATH="${GGUF:-$Q4KM_DIR/$Q4KM_FILE}"
SOURCE="${SOURCE:-auto}"
PORT="${PORT:-18099}"
HOST="${HOST:-127.0.0.1}"
SERVED_NAME="${SERVED_NAME:-qwen35-9b-q4km-imatrix}"
CTX_SIZE="${CTX_SIZE:-32768}"
# llama.cpp divides --ctx across parallel slots. Keep the product default at
# one slot so "32K" really means 32K available context for the local user.
PARALLEL="${PARALLEL:-1}"
N_GPU_LAYERS="${N_GPU_LAYERS:-999}"
DOWNLOAD=0
SMOKE=0
SERVE=0
DRY_RUN="${DRY_RUN:-0}"
FORCE=0
REGISTER_PROVIDER=1
INSTALL_RUNTIME=0

DL_BASE_URL="${DL_BASE_URL:-https://dl.merkyorlynn.com/models/qwen35-9b}"
HF_REPO_Q4KM="${HF_REPO_Q4KM:-nerkyor/Qwen3.5-9B-GGUF-imatrix-MTP}"
MS_REPO_Q4KM="${MS_REPO_Q4KM:-Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP}"
LYNN_PROVIDER_DIR="${LYNN_PROVIDER_DIR:-$HOME/.lynn-engine/providers}"
LYNN_PROVIDER_CONFIG="${LYNN_PROVIDER_CONFIG:-$LYNN_PROVIDER_DIR/$ARTIFACT_ID.json}"

ENV_FILE_EXPLICIT=0
if [[ -n "${ENV_FILE:-}" ]]; then
  ENV_FILE_EXPLICIT=1
else
  ENV_FILE="$MODEL_ROOT/lynn-qwen35-9b.env"
fi

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/local_qwen35_9b_setup.sh [options]

Recommended first-run:
  bash scripts/local_qwen35_9b_setup.sh --download --smoke

Start the endpoint after setup:
  source ~/Models/Lynn/Qwen3.5-9B/lynn-qwen35-9b.env
  bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh

Options:
  --download            Download Q4_K_M GGUF if missing.
  --source auto|dl|hf|ms Download source. auto tries ms, then hf, then dl.
  --variant imatrix|default
                        Q4_K_M artifact variant (default: imatrix).
  --smoke               Run transient llama.cpp smoke after setup.
  --serve               Exec the persistent llama.cpp endpoint after setup.
  --model-root PATH     Model root (default: ~/Models/Lynn/Qwen3.5-9B).
  --gguf PATH           Explicit GGUF path.
  --llama-server PATH   Explicit llama-server binary.
  --port PORT           Server port (default: 18099).
  --host HOST           Bind host (default: 127.0.0.1).
  --ctx SIZE            Context size (default: 32768).
  --parallel N          llama.cpp parallel slots (default: 1; preserves full context).
  --gpu-layers N        GPU layers (default: 999).
  --env-file PATH       Env file to write.
  --force               Redownload even if target file exists.
  --install-runtime     Install llama.cpp if missing (macOS Homebrew).
  --no-register         Do not write ~/.lynn-engine/providers/*.json.
  --dry-run             Print resolved actions without downloading or running.
  -h, --help            Show this help.

Environment overrides:
  DL_BASE_URL           Lynn CDN base URL.
  HF_REPO_Q4KM          Hugging Face repo id (default: nerkyor/Qwen3.5-9B-GGUF-imatrix-MTP).
  MS_REPO_Q4KM          ModelScope repo id (default: Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP).
  Q4KM_FILE             GGUF file name.
  Q4KM_VARIANT          imatrix or default.
  LYNN_PROVIDER_DIR     Provider config directory.
  LLAMA_SERVER          llama-server binary path.
  MODEL_ROOT, GGUF      Same as flags.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --download) DOWNLOAD=1; shift ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --variant)
      Q4KM_VARIANT="${2:-}"
      case "$Q4KM_VARIANT" in
        imatrix)
          if [[ "$Q4KM_FILE_EXPLICIT" != "1" ]]; then
            Q4KM_FILE="Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf"
          fi
          if [[ "$ARTIFACT_ID_EXPLICIT" != "1" ]]; then
            ARTIFACT_ID="qwen35-9b-q4km-imatrix-gguf"
          fi
          if [[ "$SERVED_NAME_EXPLICIT" != "1" ]]; then
            SERVED_NAME="qwen35-9b-q4km-imatrix"
          fi
          ;;
        default)
          if [[ "$Q4KM_FILE_EXPLICIT" != "1" ]]; then
            Q4KM_FILE="Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf"
          fi
          if [[ "$ARTIFACT_ID_EXPLICIT" != "1" ]]; then
            ARTIFACT_ID="qwen35-9b-q4km-imatrix-gguf"
          fi
          if [[ "$SERVED_NAME_EXPLICIT" != "1" ]]; then
            SERVED_NAME="qwen35-9b-q4km-imatrix"
          fi
          ;;
        *) echo "[qwen35-setup] --variant must be imatrix or default" >&2; exit 2 ;;
      esac
      Q4KM_DIR="$MODEL_ROOT/q4_k_m"
      Q4KM_PATH="${GGUF:-$Q4KM_DIR/$Q4KM_FILE}"
      if [[ "$LYNN_PROVIDER_CONFIG_EXPLICIT" != "1" ]]; then
        LYNN_PROVIDER_CONFIG="$LYNN_PROVIDER_DIR/$ARTIFACT_ID.json"
      fi
      shift 2
      ;;
    --smoke) SMOKE=1; shift ;;
    --serve) SERVE=1; shift ;;
    --model-root)
      MODEL_ROOT="${2:-}"
      Q4KM_DIR="$MODEL_ROOT/q4_k_m"
      Q4KM_PATH="${GGUF:-$Q4KM_DIR/$Q4KM_FILE}"
      if [[ "$ENV_FILE_EXPLICIT" != "1" ]]; then
        ENV_FILE="$MODEL_ROOT/lynn-qwen35-9b.env"
      fi
      if [[ "$LYNN_PROVIDER_CONFIG_EXPLICIT" != "1" ]]; then
        LYNN_PROVIDER_CONFIG="$LYNN_PROVIDER_DIR/$ARTIFACT_ID.json"
      fi
      shift 2
      ;;
    --gguf) Q4KM_PATH="${2:-}"; shift 2 ;;
    --llama-server) LLAMA_SERVER="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; ENV_FILE_EXPLICIT=1; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --ctx|--ctx-size) CTX_SIZE="${2:-}"; shift 2 ;;
    --parallel) PARALLEL="${2:-}"; shift 2 ;;
    --gpu-layers) N_GPU_LAYERS="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --install-runtime|--install-llama) INSTALL_RUNTIME=1; shift ;;
    --no-register) REGISTER_PROVIDER=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[qwen35-setup] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$SOURCE" in
  auto|dl|hf|ms) ;;
  *) echo "[qwen35-setup] --source must be auto, dl, hf, or ms" >&2; exit 2 ;;
esac

find_llama_server() {
  if [[ -n "${LLAMA_SERVER:-}" && -x "${LLAMA_SERVER:-}" ]]; then
    printf '%s\n' "$LLAMA_SERVER"
    return 0
  fi
  local candidate
  for candidate in \
    "$(command -v llama-server 2>/dev/null || true)" \
    "$(command -v llama.cpp-server 2>/dev/null || true)" \
    "/opt/homebrew/bin/llama-server" \
    "/usr/local/bin/llama-server" \
    "$HOME/llama.cpp/build/bin/llama-server" \
    "$HOME/llama.cpp/build/tools/server/llama-server" \
    "$HOME/src/llama.cpp/build/bin/llama-server" \
    "$HOME/dev/llama.cpp/build/bin/llama-server"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

is_complete_gguf_candidate() {
  local path="$1"
  [[ -s "$path" ]] || return 1
  case "$path" in
    *"/._____temp/"*|*"/.cache/"*|*"/.tmp/"*|*.part|*.tmp|*.download) return 1 ;;
  esac
  return 0
}

is_default_mtp_gguf_path() {
  local base lower expected
  base="${1##*/}"
  lower="${base,,}"
  expected="${Q4KM_FILE,,}"
  [[ "$lower" == "$expected" ]] && return 0
  [[ "$lower" == *qwen3.5*9b*q4*k*m*mtp*.gguf ]] && return 0
  return 1
}

is_legacy_9b_gguf_path() {
  local base lower
  base="${1##*/}"
  lower="${base,,}"
  [[ "$lower" == *qwen3.5*9b*q4*k*m*.gguf && "$lower" != *mtp* ]] && return 0
  return 1
}

find_existing_gguf() {
  if is_complete_gguf_candidate "$Q4KM_PATH" && is_default_mtp_gguf_path "$Q4KM_PATH"; then
    printf '%s\n' "$Q4KM_PATH"
    return 0
  fi
  local root candidate
  for root in "$HOME/.lynn/models" "$Q4KM_DIR" "$MODEL_ROOT" "$HOME/Models" "$HOME/models" "$HOME/Downloads" "$ROOT/models"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r candidate; do
      is_complete_gguf_candidate "$candidate" || continue
      is_default_mtp_gguf_path "$candidate" || continue
      printf '%s\n' "$candidate"
      return 0
    done < <(find "$root" -maxdepth 5 -type f \( \
      -iname '*Qwen3.5*9B*Q4*K*M*.gguf' -o \
      -iname '*qwen3.5*9b*q4*k*m*.gguf' -o \
      -iname '*Qwen3.5*9B*Q4_K_M*.gguf' -o \
      -iname '*qwen3.5*9b*q4_k_m*.gguf' \
    \) 2>/dev/null | sort)
  done
  return 1
}

find_legacy_gguf() {
  local root candidate
  for root in "$HOME/.lynn/models" "$Q4KM_DIR" "$MODEL_ROOT" "$HOME/Models" "$HOME/models" "$HOME/Downloads" "$ROOT/models"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r candidate; do
      is_complete_gguf_candidate "$candidate" || continue
      is_legacy_9b_gguf_path "$candidate" || continue
      printf '%s\n' "$candidate"
      return 0
    done < <(find "$root" -maxdepth 5 -type f \( \
      -iname '*Qwen3.5*9B*Q4*K*M*.gguf' -o \
      -iname '*qwen3.5*9b*q4*k*m*.gguf' -o \
      -iname '*Qwen3.5*9B*Q4_K_M*.gguf' -o \
      -iname '*qwen3.5*9b*q4_k_m*.gguf' \
    \) 2>/dev/null | sort)
  done
  return 1
}

print_install_llama_cpp() {
  cat >&2 <<'EOF'
[qwen35-setup] llama-server was not found.

Install llama.cpp:
  # macOS
  brew install llama.cpp

  # Linux CUDA
  git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
  cmake -S ~/llama.cpp -B ~/llama.cpp/build -DGGML_CUDA=ON
  cmake --build ~/llama.cpp/build -j

Then rerun setup, or set LLAMA_SERVER=/path/to/llama-server.
EOF
}

install_llama_cpp_runtime() {
  case "$(uname -s)" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        echo "[qwen35-setup] Homebrew is not installed; cannot auto-install llama.cpp" >&2
        return 1
      fi
      echo "[qwen35-setup] installing llama.cpp via Homebrew..."
      brew install llama.cpp
      ;;
    *)
      cat >&2 <<'EOF'
[qwen35-setup] --install-runtime is currently automatic only on macOS/Homebrew.
Build llama.cpp manually on Linux:
  git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
  cmake -S ~/llama.cpp -B ~/llama.cpp/build -DGGML_CUDA=ON
  cmake --build ~/llama.cpp/build -j
EOF
      return 1
      ;;
  esac
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

download_dl() {
  local url="$DL_BASE_URL/q4_k_m/$Q4KM_FILE"
  echo "[qwen35-setup] downloading via Lynn CDN: $url"
  curl -L --fail --continue-at - --create-dirs --output "$Q4KM_PATH" "$url"
}

download_hf() {
  if ! have_command huggingface-cli; then
    echo "[qwen35-setup] huggingface-cli not found" >&2
    return 127
  fi
  echo "[qwen35-setup] downloading via Hugging Face: $HF_REPO_Q4KM $Q4KM_FILE"
  huggingface-cli download "$HF_REPO_Q4KM" "$Q4KM_FILE" \
    --local-dir "$Q4KM_DIR" --local-dir-use-symlinks False
}

download_ms() {
  if ! have_command modelscope; then
    echo "[qwen35-setup] modelscope CLI not found" >&2
    return 127
  fi
  echo "[qwen35-setup] downloading via ModelScope: $MS_REPO_Q4KM $Q4KM_FILE"
  modelscope download --model "$MS_REPO_Q4KM" "$Q4KM_FILE" --local_dir "$Q4KM_DIR"
}

download_model() {
  mkdir -p "$Q4KM_DIR"
  if [[ "$FORCE" != "1" && -s "$Q4KM_PATH" ]]; then
    echo "[qwen35-setup] GGUF already exists: $Q4KM_PATH"
    return 0
  fi

  case "$SOURCE" in
    dl) download_dl ;;
    hf) download_hf ;;
    ms) download_ms ;;
    auto)
      download_ms && return 0
      download_hf && return 0
      download_dl && return 0
      return 1
      ;;
  esac
}

write_env_file() {
  local llama_server="$1"
  local gguf="$2"
  mkdir -p "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<EOF
# Lynn Qwen3.5-9B Q4_K_M imatrix MTP local backend
# Generated by scripts/local_qwen35_9b_setup.sh
export ARTIFACT_ID="$ARTIFACT_ID"
export Q4KM_VARIANT="$Q4KM_VARIANT"
export GGUF="$gguf"
export LLAMA_SERVER="$llama_server"
export HOST="$HOST"
export PORT="$PORT"
export SERVED_NAME="$SERVED_NAME"
export CTX_SIZE="$CTX_SIZE"
export PARALLEL="$PARALLEL"
export N_GPU_LAYERS="$N_GPU_LAYERS"
export OPENAI_BASE_URL="http://$HOST:$PORT/v1"
export OPENAI_API_KEY="local"
export OPENAI_MODEL="$SERVED_NAME"
export LYNN_PROVIDER_CONFIG="$LYNN_PROVIDER_CONFIG"
EOF
}

resolved_gguf="$(find_existing_gguf || true)"
resolved_legacy_gguf=""
if [[ -z "$resolved_gguf" ]]; then
  resolved_legacy_gguf="$(find_legacy_gguf || true)"
fi
resolved_llama="$(find_llama_server || true)"
if [[ -z "$resolved_llama" && "$INSTALL_RUNTIME" == "1" && "$DRY_RUN" != "1" ]]; then
  install_llama_cpp_runtime
  resolved_llama="$(find_llama_server || true)"
fi

cat <<EOF
[qwen35-setup] model_root=$MODEL_ROOT
[qwen35-setup] variant=$Q4KM_VARIANT artifact_id=$ARTIFACT_ID
[qwen35-setup] source=$SOURCE download=$DOWNLOAD smoke=$SMOKE serve=$SERVE install_runtime=$INSTALL_RUNTIME
[qwen35-setup] target_gguf=$Q4KM_PATH
[qwen35-setup] found_gguf=${resolved_gguf:-<missing>}
[qwen35-setup] legacy_gguf=${resolved_legacy_gguf:-<none>}
[qwen35-setup] llama_server=${resolved_llama:-<missing>}
EOF

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[qwen35-setup] DRY_RUN=1; no download/server/smoke actions."
  exit 0
fi

if [[ -z "$resolved_gguf" ]]; then
  if [[ -n "$resolved_legacy_gguf" ]]; then
    echo "[qwen35-setup] legacy 9B GGUF found but default requires MTP; will download/upgrade to $Q4KM_FILE"
  fi
  if [[ "$DOWNLOAD" == "1" ]]; then
    if ! download_model; then
      cat >&2 <<EOF
[qwen35-setup] ERROR: download failed.

Manual fallback:
  mkdir -p "$Q4KM_DIR"
  # Put Qwen3.5-9B Q4_K_M imatrix MTP GGUF at:
  #   $Q4KM_PATH
EOF
      exit 4
    fi
    resolved_gguf="$(find_existing_gguf || true)"
  else
    cat >&2 <<EOF
[qwen35-setup] ERROR: Q4_K_M GGUF not found.

Run:
  bash scripts/local_qwen35_9b_setup.sh --download --smoke

Or place the file at:
  $Q4KM_PATH
EOF
    exit 4
  fi
fi

if [[ -z "$resolved_gguf" || ! -s "$resolved_gguf" ]]; then
  echo "[qwen35-setup] ERROR: GGUF still missing after download: $Q4KM_PATH" >&2
  exit 4
fi

if [[ -z "$resolved_llama" ]]; then
  print_install_llama_cpp
  exit 5
fi

write_env_file "$resolved_llama" "$resolved_gguf"

if [[ "$REGISTER_PROVIDER" == "1" ]]; then
  python3 "$ROOT/scripts/local_qwen35_9b_register_provider.py" \
    --artifact-id "$ARTIFACT_ID" \
    --variant "$Q4KM_VARIANT" \
    --gguf "$resolved_gguf" \
    --llama-server "$resolved_llama" \
    --host "$HOST" \
    --port "$PORT" \
    --served-name "$SERVED_NAME" \
    --ctx-size "$CTX_SIZE" \
    --parallel "$PARALLEL" \
    --gpu-layers "$N_GPU_LAYERS" \
    --env-file "$ENV_FILE" \
    --output "$LYNN_PROVIDER_CONFIG"
fi

cat <<EOF
[qwen35-setup] ready
[qwen35-setup] env_file=$ENV_FILE
[qwen35-setup] provider_config=$LYNN_PROVIDER_CONFIG
[qwen35-setup] model=$resolved_gguf
[qwen35-setup] endpoint=http://$HOST:$PORT/v1

Next:
  source "$ENV_FILE"
  bash scripts/local_qwen35_9b_q4km_llamacpp_server.sh

Agent config:
  base_url = http://$HOST:$PORT/v1
  api_key  = local
  model    = $SERVED_NAME
  provider = $LYNN_PROVIDER_CONFIG
EOF

if [[ "$SMOKE" == "1" ]]; then
  echo "[qwen35-setup] running transient smoke..."
  GGUF="$resolved_gguf" \
  LLAMA_SERVER="$resolved_llama" \
  HOST="$HOST" \
  PORT="$PORT" \
  SERVED_NAME="$SERVED_NAME" \
  CTX_SIZE="$CTX_SIZE" \
  PARALLEL=1 \
  N_GPU_LAYERS="$N_GPU_LAYERS" \
    bash "$ROOT/scripts/local_qwen35_9b_llamacpp_smoke.sh"
fi

if [[ "$SERVE" == "1" ]]; then
  echo "[qwen35-setup] starting persistent endpoint..."
  GGUF="$resolved_gguf" \
  LLAMA_SERVER="$resolved_llama" \
  HOST="$HOST" \
  PORT="$PORT" \
  SERVED_NAME="$SERVED_NAME" \
  CTX_SIZE="$CTX_SIZE" \
  PARALLEL="$PARALLEL" \
  N_GPU_LAYERS="$N_GPU_LAYERS" \
    exec bash "$ROOT/scripts/local_qwen35_9b_q4km_llamacpp_server.sh"
fi
