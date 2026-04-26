#!/usr/bin/env bash
# ============================================================
# lynn-deploy-native.sh · 一键部署 Lynn brain 三服务（无 docker）
#
# 跟 lynn-deploy.sh 的区别:
#   • 不依赖 docker / docker-compose
#   • 复用现有 vipuser 的 vllm conda 环境
#   • 三个服务以 systemd unit 直接跑 Python
#   • 卸载更干净 (一行命令删 systemd unit)
#
# 适用场景:
#   • GPU 服务器没装 docker 且不想装
#   • 想用一套 conda env 管所有 Python 依赖
#   • 喜欢 systemd journalctl 看日志
# ============================================================
# 用法:
#   sudo bash lynn-deploy-native.sh                # 默认全装
#   sudo bash lynn-deploy-native.sh --no-asr       # 不装 Whisper
#   sudo bash lynn-deploy-native.sh --check        # 只检查
#   sudo bash lynn-deploy-native.sh --down         # 卸载
#   sudo bash lynn-deploy-native.sh --logs         # 看日志
# ============================================================

set -euo pipefail

# ---------- 配置 ----------
CONDA_ENV_OWNER="${CONDA_ENV_OWNER:-vipuser}"
CONDA_PATH="${CONDA_PATH:-/home/${CONDA_ENV_OWNER}/miniconda3}"
CONDA_ENV="${CONDA_ENV:-lynn-rag}"   # 新建一个隔离 env,不污染 vllm
PYTHON_VER="${PYTHON_VER:-3.11}"

LYNN_HOME="${LYNN_HOME:-/opt/lynn-rag}"
HF_MIRROR="${HF_MIRROR:-https://hf-mirror.com}"
HF_CACHE="${HF_CACHE:-/home/${CONDA_ENV_OWNER}/.cache/huggingface}"
WHISPER_CACHE="${WHISPER_CACHE:-/home/${CONDA_ENV_OWNER}/.cache/whisper}"

PORT_EMBED="${PORT_EMBED:-8002}"
PORT_RERANK="${PORT_RERANK:-8003}"
PORT_ASR="${PORT_ASR:-8004}"

VLLM_GPU_UTIL="${VLLM_GPU_UTIL:-0.85}"   # 跟方案 B 一致, 不动 vLLM 也行
VLLM_SERVICE="${VLLM_SERVICE:-vllm-qwen35.service}"

EMBED_MODEL="BAAI/bge-m3"
RERANK_MODEL="BAAI/bge-reranker-v2-m3"
WHISPER_MODEL="distil-large-v3"

# ---------- 颜色 ----------
C_RST="\033[0m"; C_RED="\033[31m"; C_GRN="\033[32m"
C_YEL="\033[33m"; C_BLU="\033[34m"; C_BLD="\033[1m"
log()  { echo -e "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $*"; }
ok()   { echo -e "${C_GRN}✓${C_RST} $*"; }
warn() { echo -e "${C_YEL}⚠${C_RST} $*"; }
err()  { echo -e "${C_RED}✗${C_RST} $*" >&2; }
hr()   { echo -e "${C_BLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RST}"; }

# ---------- 参数 ----------
ACTION="up"
SKIP_ASR=false
for arg in "$@"; do
  case $arg in
    --check) ACTION="check" ;;
    --down)  ACTION="down"  ;;
    --logs)  ACTION="logs"  ;;
    --no-asr) SKIP_ASR=true ;;
    --help|-h) sed -n '2,25p' "$0"; exit 0 ;;
  esac
done

# ============================================================
# Step 1: 环境检查
# ============================================================
check_env() {
  hr; log "Step 1/5 · 环境检查"; hr

  [[ $EUID -eq 0 ]] || { err "需要 root"; exit 1; }
  ok "root"

  command -v nvidia-smi &>/dev/null || { err "nvidia 驱动未装"; exit 1; }
  GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
  GPU_FREE=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)
  ok "GPU: $GPU (${GPU_MEM} MB total, ${GPU_FREE} MB free)"

  if [[ ${GPU_FREE} -lt 5500 ]]; then
    warn "可用显存 ${GPU_FREE} MB < 5500 MB 方案 B 阈值"
    warn "可考虑: bash $0 --no-asr (省 2.2 GB)"
  fi

  # conda
  if [[ ! -d "$CONDA_PATH" ]]; then
    err "找不到 conda: $CONDA_PATH (CONDA_PATH 可覆盖)"
    exit 1
  fi
  ok "conda: $CONDA_PATH"

  source "$CONDA_PATH/etc/profile.d/conda.sh"
  if ! conda env list | grep -q "^$CONDA_ENV "; then
    warn "conda env $CONDA_ENV 不存在,稍后会创建"
  else
    ok "conda env: $CONDA_ENV (已存在)"
  fi

  # systemd
  command -v systemctl &>/dev/null || { err "systemd 不可用"; exit 1; }
  ok "systemd"

  # 网络 (优先 wget,curl 不一定装)
  if command -v wget &>/dev/null; then
    if wget -q --tries=1 --timeout=5 -O /dev/null "$HF_MIRROR" 2>/dev/null; then
      ok "HF mirror reachable: $HF_MIRROR"
    else
      warn "HF mirror 不通,首次下载模型可能慢"
    fi
  elif command -v curl &>/dev/null; then
    if curl -s -m 5 -o /dev/null -w "%{http_code}" "$HF_MIRROR" 2>/dev/null | grep -q "^[23]"; then
      ok "HF mirror reachable: $HF_MIRROR"
    else
      warn "HF mirror 不通"
    fi
  else
    warn "wget/curl 都没装,跳过网络检查"
  fi

  ok "环境 OK"
}

# ============================================================
# Step 2: 创建 conda env + 装依赖
# ============================================================
setup_conda_env() {
  hr; log "Step 2/5 · conda env + Python 依赖"; hr

  source "$CONDA_PATH/etc/profile.d/conda.sh"

  if ! sudo -u "$CONDA_ENV_OWNER" "$CONDA_PATH/bin/conda" env list 2>/dev/null | grep -q "^$CONDA_ENV "; then
    log "创建 conda env: $CONDA_ENV (Python $PYTHON_VER)"
    sudo -u "$CONDA_ENV_OWNER" "$CONDA_PATH/bin/conda" create -y -n "$CONDA_ENV" python="$PYTHON_VER"
  fi

  # 自动检测 env 实际路径 (用户 default 可能是 ~/.conda/envs/ 也可能是 ~/miniconda3/envs/)
  CONDA_ENV_PATH=$(sudo -u "$CONDA_ENV_OWNER" "$CONDA_PATH/bin/conda" env list 2>/dev/null \
                    | awk -v n="$CONDA_ENV" '$1==n{print $NF}' | head -1)
  if [[ -z "$CONDA_ENV_PATH" || ! -d "$CONDA_ENV_PATH" ]]; then
    err "找不到 conda env $CONDA_ENV 的实际路径"
    exit 1
  fi
  ok "conda env path: $CONDA_ENV_PATH"

  PY="$CONDA_ENV_PATH/bin/python"
  PIP="$CONDA_ENV_PATH/bin/pip"

  log "安装 Python 包 (用 HF/PyPI 镜像加速)..."
  PIP_MIRROR_ARGS=("-i" "https://pypi.tuna.tsinghua.edu.cn/simple")
  HF_ENV="HF_ENDPOINT=$HF_MIRROR"

  # pip 自身先升级
  sudo -u "$CONDA_ENV_OWNER" env $HF_ENV "$PIP" install -q --upgrade pip "${PIP_MIRROR_ARGS[@]}"

  # torch 必须单独装(自带 CUDA wheels 走 pytorch 官方源)
  log "  装 torch (CUDA 12.1 wheels, ~2GB)..."
  sudo -u "$CONDA_ENV_OWNER" env $HF_ENV "$PIP" install -q \
    --index-url https://download.pytorch.org/whl/cu121 \
    "torch>=2.4" \
    || warn "torch 装失败 (如已存在可忽略)"

  # 其他依赖走清华镜像
  log "  装其他依赖..."
  sudo -u "$CONDA_ENV_OWNER" env $HF_ENV "$PIP" install -q "${PIP_MIRROR_ARGS[@]}" \
    "fastapi>=0.110" "uvicorn[standard]>=0.27" \
    "FlagEmbedding>=1.3.0" \
    "faster-whisper>=1.0.3" \
    "ctranslate2>=4.4" \
    "huggingface_hub>=0.26" \
    "pydantic>=2.0" \
    || warn "pip 部分失败,如已存在可忽略"

  ok "Python 依赖装完"
}

# ============================================================
# Step 3: 写 Python 服务脚本
# ============================================================
write_servers() {
  hr; log "Step 3/5 · 写服务脚本到 $LYNN_HOME"; hr
  mkdir -p "$LYNN_HOME"

  # ---------- embed_server.py ----------
  cat > "$LYNN_HOME/embed_server.py" <<'PYEOF'
"""bge-m3 embedding server · FastAPI"""
import os, time
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
import uvicorn

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
from FlagEmbedding import BGEM3FlagModel

MODEL_NAME = os.getenv("EMBED_MODEL", "BAAI/bge-m3")
USE_FP16 = os.getenv("USE_FP16", "1") == "1"

print(f"[embed] loading {MODEL_NAME} (fp16={USE_FP16})...")
t0 = time.time()
model = BGEM3FlagModel(MODEL_NAME, use_fp16=USE_FP16)
print(f"[embed] loaded in {time.time()-t0:.1f}s")

app = FastAPI()

class EmbedReq(BaseModel):
    inputs: List[str]

@app.post("/embed")
def embed(req: EmbedReq):
    if not req.inputs: raise HTTPException(400, "empty inputs")
    out = model.encode(req.inputs, return_dense=True, return_sparse=False,
                       return_colbert_vecs=False)
    return out["dense_vecs"].tolist()

@app.get("/health")
def health(): return {"status": "ok", "model": MODEL_NAME}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8002")), log_level="warning")
PYEOF

  # ---------- rerank_server.py ----------
  cat > "$LYNN_HOME/rerank_server.py" <<'PYEOF'
"""bge-reranker-v2-m3 server · FastAPI · TEI 兼容接口"""
import os, time
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
import uvicorn

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
from FlagEmbedding import FlagReranker

MODEL_NAME = os.getenv("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")

print(f"[rerank] loading {MODEL_NAME}...")
t0 = time.time()
model = FlagReranker(MODEL_NAME, use_fp16=True)
print(f"[rerank] loaded in {time.time()-t0:.1f}s")

app = FastAPI()

class RerankReq(BaseModel):
    query: str
    texts: List[str]
    raw_scores: bool = False
    truncate: bool = True

@app.post("/rerank")
def rerank(req: RerankReq):
    if not req.texts: raise HTTPException(400, "empty texts")
    pairs = [[req.query, t] for t in req.texts]
    scores = model.compute_score(pairs, normalize=not req.raw_scores)
    if isinstance(scores, float): scores = [scores]
    indexed = sorted(enumerate(scores), key=lambda x: -x[1])
    return [{"index": i, "score": float(s)} for i, s in indexed]

@app.get("/health")
def health(): return {"status": "ok", "model": MODEL_NAME}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8003")), log_level="warning")
PYEOF

  # ---------- whisper_server.py ----------
  cat > "$LYNN_HOME/whisper_server.py" <<'PYEOF'
"""faster-whisper server · OpenAI 兼容接口"""
import os, io, time, tempfile, json
from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse
import uvicorn
from faster_whisper import WhisperModel

MODEL_NAME = os.getenv("WHISPER_MODEL", "distil-large-v3")
COMPUTE = os.getenv("WHISPER_COMPUTE", "float16")
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")

print(f"[asr] loading {MODEL_NAME} ({COMPUTE}/{DEVICE})...")
t0 = time.time()
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
print(f"[asr] loaded in {time.time()-t0:.1f}s")

app = FastAPI()

@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("zh"),
    response_format: str = Form("json"),
):
    """OpenAI 兼容: 同步返回完整文本"""
    raw = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=True) as f:
        f.write(raw); f.flush()
        segments, info = model.transcribe(
            f.name, language=None if language == "auto" else language,
            beam_size=5, vad_filter=True
        )
        text = "".join(s.text for s in segments).strip()
    return {"text": text, "language": info.language, "duration": info.duration}

@app.post("/transcribe")
async def transcribe_stream(request: Request, file: UploadFile = File(...)):
    """SSE 流式 (Lynn brain 内部用)"""
    raw = await file.read()
    qs = request.query_params
    language = qs.get("language", "auto")
    if language == "auto": language = None

    async def gen():
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=True) as f:
            f.write(raw); f.flush()
            segments, info = model.transcribe(
                f.name, language=language, beam_size=5, vad_filter=True
            )
            buf = ""
            for seg in segments:
                buf += seg.text
                yield f"data: {json.dumps({'type':'partial','text':buf.strip()})}\n\n"
            yield f"data: {json.dumps({'type':'final','text':buf.strip(),'duration_ms':int(info.duration*1000),'language':info.language})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")

@app.get("/health")
def health(): return {"status": "ok", "model": MODEL_NAME}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8004")), log_level="warning")
PYEOF

  chown -R "$CONDA_ENV_OWNER:$CONDA_ENV_OWNER" "$LYNN_HOME"
  ok "服务脚本写入: $LYNN_HOME/{embed,rerank,whisper}_server.py"
}

# ============================================================
# Step 4: 写 systemd units
# ============================================================
write_systemd() {
  hr; log "Step 4/5 · systemd units"; hr

  # 优先用 setup_conda_env 探测出的路径,否则 fallback 默认两处
  if [[ -z "${CONDA_ENV_PATH:-}" ]]; then
    for cand in \
        "/home/$CONDA_ENV_OWNER/.conda/envs/$CONDA_ENV" \
        "$CONDA_PATH/envs/$CONDA_ENV"; do
      [[ -d "$cand" ]] && CONDA_ENV_PATH="$cand" && break
    done
  fi
  if [[ -z "$CONDA_ENV_PATH" ]]; then
    err "找不到 conda env $CONDA_ENV"; exit 1
  fi
  PY="$CONDA_ENV_PATH/bin/python"
  ok "using PY: $PY"

  COMMON_ENV="Environment=HF_ENDPOINT=$HF_MIRROR
Environment=HF_HOME=$HF_CACHE
Environment=TRANSFORMERS_CACHE=$HF_CACHE
Environment=CUDA_VISIBLE_DEVICES=0"

  # ---- embed ----
  cat > /etc/systemd/system/lynn-embed.service <<EOF
[Unit]
Description=Lynn embedding server (bge-m3)
After=network-online.target

[Service]
Type=simple
User=$CONDA_ENV_OWNER
WorkingDirectory=$LYNN_HOME
$COMMON_ENV
Environment=PORT=$PORT_EMBED
Environment=EMBED_MODEL=$EMBED_MODEL
ExecStart=$PY $LYNN_HOME/embed_server.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

  # ---- rerank ----
  cat > /etc/systemd/system/lynn-rerank.service <<EOF
[Unit]
Description=Lynn rerank server (bge-reranker-v2-m3)
After=network-online.target

[Service]
Type=simple
User=$CONDA_ENV_OWNER
WorkingDirectory=$LYNN_HOME
$COMMON_ENV
Environment=PORT=$PORT_RERANK
Environment=RERANK_MODEL=$RERANK_MODEL
ExecStart=$PY $LYNN_HOME/rerank_server.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

  if [[ "$SKIP_ASR" == false ]]; then
    cat > /etc/systemd/system/lynn-asr.service <<EOF
[Unit]
Description=Lynn ASR server (faster-whisper $WHISPER_MODEL)
After=network-online.target

[Service]
Type=simple
User=$CONDA_ENV_OWNER
WorkingDirectory=$LYNN_HOME
$COMMON_ENV
Environment=PORT=$PORT_ASR
Environment=WHISPER_MODEL=$WHISPER_MODEL
Environment=WHISPER_COMPUTE=float16
Environment=WHISPER_DEVICE=cuda
ExecStart=$PY $LYNN_HOME/whisper_server.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  fi

  systemctl daemon-reload
  ok "systemd units 写入 /etc/systemd/system/lynn-{embed,rerank,asr}.service"
}

# ============================================================
# Step 5: 启动 + 健康检查
# ============================================================
start_services() {
  hr; log "Step 5/5 · 启动服务"; hr

  systemctl enable --now lynn-embed.service
  systemctl enable --now lynn-rerank.service
  [[ "$SKIP_ASR" == false ]] && systemctl enable --now lynn-asr.service

  log "等待健康 (首次加载模型可能 60-120 秒)..."
  local services=("lynn-embed:$PORT_EMBED" "lynn-rerank:$PORT_RERANK")
  [[ "$SKIP_ASR" == false ]] && services+=("lynn-asr:$PORT_ASR")

  for svc_port in "${services[@]}"; do
    svc=${svc_port%:*}; port=${svc_port#*:}
    elapsed=0
    while [[ $elapsed -lt 180 ]]; do
      if (command -v curl &>/dev/null && curl -sf "http://localhost:$port/health" >/dev/null 2>&1) \
         || wget -q --tries=1 --timeout=2 -O /dev/null "http://localhost:$port/health" 2>/dev/null; then
        ok "$svc healthy (port $port)"
        break
      fi
      sleep 3; elapsed=$((elapsed+3))
      printf "."
    done
    [[ $elapsed -ge 180 ]] && err "$svc 超时" && journalctl -u "$svc" -n 20 --no-pager
  done
  echo ""
}

show_status() {
  hr; log "状态总览"; hr
  systemctl status lynn-embed lynn-rerank ${SKIP_ASR:+lynn-asr} --no-pager 2>/dev/null \
    | grep -E "lynn-|Active:" || true
  echo ""
  log "GPU 占用:"
  nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv

  cat <<EOF

${C_BLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RST}
${C_GRN}✓ Lynn brain 三件套 (native conda) 部署成功${C_RST}

API 端点:
  • Embed   POST  http://localhost:$PORT_EMBED/embed
  • Rerank  POST  http://localhost:$PORT_RERANK/rerank
$([ "$SKIP_ASR" == false ] && echo "  • ASR     POST  http://localhost:$PORT_ASR/v1/audio/transcriptions")

systemd 管理:
  • 看日志:  journalctl -u lynn-embed -f
  • 重启:    systemctl restart lynn-embed
  • 停止:    bash $0 --down
  • GPU:     watch -n 1 nvidia-smi

测试调用:
  curl http://localhost:$PORT_EMBED/embed \\
    -H 'Content-Type: application/json' \\
    -d '{"inputs":["hello world"]}'
${C_BLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RST}
EOF
}

do_down() {
  hr; log "卸载 Lynn 服务"; hr
  for svc in lynn-asr lynn-rerank lynn-embed; do
    systemctl disable --now "$svc.service" 2>/dev/null || true
    rm -f "/etc/systemd/system/$svc.service"
  done
  systemctl daemon-reload
  ok "服务已停止 + 卸载"
  log "（保留 $LYNN_HOME 和 conda env $CONDA_ENV 不动,确认无用再手动删除）"
}

do_logs() {
  journalctl -u lynn-embed -u lynn-rerank ${SKIP_ASR:+-u lynn-asr} -f --no-pager
}

# ============================================================
main() {
  hr
  echo -e "${C_BLD}Lynn Brain Deploy (Native conda) · v1.0${C_RST}"
  echo -e "Action: ${C_YEL}$ACTION${C_RST}  ASR: $([ "$SKIP_ASR" == true ] && echo off || echo on)"
  hr

  case "$ACTION" in
    check) check_env ;;
    down)  do_down ;;
    logs)  do_logs ;;
    up)
      check_env
      setup_conda_env
      write_servers
      write_systemd
      start_services
      show_status
      ;;
  esac
}
main "$@"
