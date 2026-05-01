# Lynn V0.79 DGX Voice Services

Phase 2 Day 1-2 的两个 HTTP 服务骨架,对齐 `server/clients/{asr,ser}/` 客户端契约。

## 文件

| 文件 | 作用 |
|------|------|
| `asr_server.py` | Qwen3-ASR-0.6B HTTP server(FastAPI),端口 **18007** |
| `emotion_server.py` | emotion2vec+ base HTTP server(FastAPI),端口 **18008** |
| `systemd/lynn-qwen3-asr.service` | ASR systemd unit |
| `systemd/lynn-emotion2vec.service` | emotion systemd unit |

## DGX 部署步骤(merkyor@dgx)

### 0. 前置(应该已做过,Session 2026-04-30)

```bash
# 两个 venv 已建好,内含:
# - qwen3-asr-spike/.venv   →  qwen-asr 0.0.6 + torch 2.11.0+cu130
# - emotion2vec-spike/.venv →  funasr + modelscope

# 模型已下,位置:
# - ~/.cache/modelscope/hub/models/iic/emotion2vec_plus_base/   (1.12 GB)
# - Qwen3-ASR 按 ~/.cache/huggingface 走
```

### 1. 拷 server 文件到 DGX

```bash
# Mac 侧(从 Lynn repo)
scp dgx-services/asr_server.py      dgx:/home/merkyor/voice-services/qwen3-asr-spike/
scp dgx-services/emotion_server.py  dgx:/home/merkyor/voice-services/emotion2vec-spike/
```

### 2. 装 FastAPI 到两个 venv(各装一次)

```bash
# DGX 上
ssh dgx
cd /home/merkyor/voice-services/qwen3-asr-spike
source .venv/bin/activate
pip install fastapi 'uvicorn[standard]' python-multipart soundfile
deactivate

cd /home/merkyor/voice-services/emotion2vec-spike
source .venv/bin/activate
pip install fastapi 'uvicorn[standard]' python-multipart soundfile
deactivate
```

### 3. 前台验证一次(不起 systemd)

```bash
# Tab 1
cd /home/merkyor/voice-services/qwen3-asr-spike
source .venv/bin/activate
uvicorn asr_server:app --host 0.0.0.0 --port 18007 --log-level info
# 等 "model loaded in ~503s" + "warmup transcribe OK"

# Tab 2(新开 ssh)
cd /home/merkyor/voice-services/emotion2vec-spike
source .venv/bin/activate
uvicorn emotion_server:app --host 0.0.0.0 --port 18008 --log-level info

# Tab 3 验收
curl -s http://127.0.0.1:18007/health | jq
curl -s http://127.0.0.1:18008/health | jq

# 跑一遍真实转写(用 emotion2vec 示例 wav)
TEST_WAV=~/.cache/modelscope/hub/models/iic/emotion2vec_plus_base/example/test.wav
curl -s -F "file=@$TEST_WAV" -F "language=zh" http://127.0.0.1:18007/transcribe | jq
curl -s -F "file=@$TEST_WAV" http://127.0.0.1:18008/classify | jq
```

**期望**:
- ASR `text` 非空,`latency_ms` < 300
- emotion `top1` 是 9 类之一(生气/厌恶/恐惧/开心/中立/其他/难过/吃惊/`<unk>`),`latency_ms` < 200

### 4. 装 systemd unit

```bash
sudo cp dgx-services/systemd/lynn-qwen3-asr.service /etc/systemd/system/
sudo cp dgx-services/systemd/lynn-emotion2vec.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lynn-qwen3-asr.service
sudo systemctl enable --now lynn-emotion2vec.service

# 看 ASR 首次加载(503s)
journalctl -fu lynn-qwen3-asr

# 看 emotion 加载(快得多)
journalctl -fu lynn-emotion2vec
```

### 5. Mac 本机 .env 加两行

```bash
# /Users/lynn/Downloads/Lynn/server/.env(或全局 env)
LYNN_QWEN3_ASR_URL=http://127.0.0.1:18007
LYNN_EMOTION2VEC_URL=http://127.0.0.1:18008

# 注:这俩走 ssh frp 隧道,本机 127.0.0.1:18007 映射到 DGX:18007
# 隧道配置见 reference_ssh_dgx.md
```

## 客户端契约(必须锁死,改一边就崩)

| HTTP | Lynn client 调用点 | 必须字段 |
|------|------------------|---------|
| `GET /health` | `qwen3-asr.js::health()` / `emotion2vec-plus.js::health()` | `{ ok: bool }` |
| `POST /warmup` | `emotion2vec-plus.js::warmup()`,voice-ws session 启动调 | `{ ok: bool }` |
| `POST /transcribe` | `qwen3-asr.js::transcribe(audioBuffer, {language, filename})` | `{ text, language, duration_ms }` |
| `POST /classify` | `emotion2vec-plus.js::classify(audioBuffer, {filename})` | `{ labels, scores, top1, top1_score }` |

## 健康监控

```bash
# 一键看两个服务
for svc in lynn-qwen3-asr lynn-emotion2vec; do
  echo "=== $svc ==="
  systemctl is-active $svc
  systemctl status $svc --no-pager -n 3
done

# GPU 占用
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv
```

## 重要约束(回到 MEMORY.md 铁律 #13)

```
DGX mem-fraction 统一上限 0.70(2026-05-01 铁律 #13):
  - LLM 最高 0.70 → 共 88GB,留 40GB 给 host/ASR/SER/TTS
  - ASR 占 VRAM ~1.5GB(transformers bfloat16)
  - emotion 占 VRAM ~1-2GB(funasr eager)
  - CosyVoice 2 常驻 ~4GB
  - 合计副链 ~7GB + host 22GB 安全
  - 绝对禁止 > 0.70 单 LLM(0.85 实证 30min 必挂)
```

## 失败兜底(Lynn 侧自动)

本服务挂 → `server/clients/asr/index.js::createASRFallbackProvider` 自动回退 SenseVoice(:8004 保留)。
emotion 挂 → voice-ws.js 代码已做 null 保护(`serProvider?.classify`),主链不阻塞。

## 后续任务(Phase 2 Day 6)

`asr_server.py` 末尾的 `/transcribe_stream` WS endpoint 还是注释状态,Day 6 实装:
- `qwen_asr.init_streaming_state()` + `streaming_transcribe(state, chunk)`
- 每 320ms PCM chunk → partial text
- 配合 `qwen3-asr.js::transcribeStreaming` 改真实 WS client
