# Spike 06 — DGX 平行任务 hello world

> **不阻塞本机 spike 1-5 关键路径**。用户 SSH 到 DGX Spark 跑 3 个 hello world,~30 分钟出结果。
>
> 目的:验证 v2.3 选定的 3 个 voice service 在 DGX SM121 上真跑得动。

## 3 个目标候选

```
1. Qwen3-ASR-0.6B           — 主转写
2. emotion2vec+ base        — 情绪副链
3. CosyVoice 2.0-SFT        — TTS,V0.78 已部署,只验证连通性,不重装
```

## SSH 入口

```bash
ssh dgx
# (memory 已记 frp through Tencent:2224)
cd /home/merkyor/voice-services
```

---

## Task 1:Qwen3-ASR-0.6B

### 拉镜像 + 启动

```bash
# 1. 拉官方 Docker(13.4 GB,首次 5-15 分钟,看网速)
docker pull qwenllm/qwen3-asr:latest

# 2. 启动容器(端口 / 模型路径 / Spark SM121 兼容性 全是 spike 验证项)
docker run -d --name qwen3-asr-spike \
  --gpus '"device=0"' \
  -p 18007:8000 \
  -v /home/merkyor/models/qwen3-asr-0.6b:/models \
  qwenllm/qwen3-asr:latest \
  --enforce-eager
# ⚠️ vLLM 25.09+ 在 SM121 已知挂(vllm#31128),--enforce-eager 是兜底
# 实测如果加 --enforce-eager 还卡,改用 transformers 路径(见下)

# 3. 健康检查
sleep 30
curl http://localhost:18007/v1/models
```

### 备用路径:Python 包(若 Docker SM121 不通)

```bash
conda create -n qwen3-asr python=3.10 -y && conda activate qwen3-asr
pip install -U qwen-asr[vllm]   # 或 pip install -U qwen-asr (走 transformers backend)

# 跑 hello world
python -c "
from qwen_asr import Qwen3ASR
asr = Qwen3ASR(model='Qwen/Qwen3-ASR-0.6B', device='cuda:0')
import torchaudio
wav, sr = torchaudio.load('test_zh.wav')  # 准备一段 16kHz 中文
import time
t0 = time.time()
text = asr.transcribe(wav)
print(f'转写: {text}')
print(f'耗时: {(time.time()-t0)*1000:.1f}ms')
print(f'TTFT (首 token): 待 streaming 模式测')
"
```

### 验收记录(填回这里)

```
SM121 兼容性:        [✓ / ⚠ --enforce-eager / ❌]
中文短句 TTFT:       ___ ms (目标 < 300ms,paper 92ms 是 H100 上的)
中文长段 RTF:        ___ (Real-Time Factor,< 0.3 OK)
VRAM 占用:           ___ GB (理论 1.5 GB)
streaming partial 稳定性: [ 待 streaming 模式测 ]
```

---

## Task 2:emotion2vec+ base

```bash
conda create -n emotion2vec python=3.10 -y && conda activate emotion2vec
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
pip install -U funasr modelscope

# Hello world(自动从 ModelScope 拉 1.12GB checkpoint 到 ~/.cache/modelscope/)
python -c "
from funasr import AutoModel
import time, os
m = AutoModel(model='iic/emotion2vec_plus_base', hub='ms')
wav = f'{m.model_path}/example/test.wav'

# 单帧 P99 延迟测试(跑 100 次)
times = []
for _ in range(100):
    t0 = time.time()
    res = m.generate(wav, granularity='utterance', extract_embedding=False)
    times.append((time.time()-t0)*1000)
times.sort()
print(f'示例输出: {res}')
print(f'P50: {times[50]:.1f}ms')
print(f'P90: {times[90]:.1f}ms')
print(f'P99: {times[99]:.1f}ms')
print(f'平均: {sum(times)/len(times):.1f}ms')
"
```

### 关键决策点 ★

**根据 P99 延迟决定 emotion 注入时机**:

```
P99 < 200ms → emotion 注入当前轮 LLM(实时情感感知,体验大幅升级)
P99 200-300ms → 注入下一轮(DS V4 Pro 原方案,稳妥)
P99 > 300ms → 跳过当前段 emotion(不阻塞主链)
```

### 验收记录

```
模型下载大小:        ___ MB (理论 1.12 GB)
4s 段 P50 延迟:      ___ ms
4s 段 P99 延迟:      ___ ms
9 类输出格式:        [✓ {labels: [...], scores: [...]}]
跟 Qwen3-ASR 共存 VRAM 总占: ___ GB (Spark mem-fraction 实测)
```

---

## Task 3:CosyVoice 2.0-SFT(已部署,只 ping)

```bash
# Lynn V0.78 已经部署,这一步只是确认它还活着
# 端口和路径见 CLAUDE.md GPU Models 表
curl http://localhost:???/health   # 端口待 V0.78 docker ps 查
```

```
状态: ✓ V0.78 还活着 / ⚠ 重启 / ❌ 需重新部署
延迟: V0.78 实测 ___ ms 首音 / ___ ms 整段
```

不需要新部署,V0.79 直接复用现有端点。

---

## 关键 caveat

1. **SenseVoice :8004 保留作 ASR fallback**,V0.79 主链不用它(改 emotion2vec+ 作情绪)
2. **mem-fraction 0.80 红线**:Qwen3-ASR + emotion2vec+ + CosyVoice 2.0 + LLM 35B-A3B 共存,实测必须 < 80%
3. **网络**:DGX 拉 docker hub 走 frp 隧道,慢的话考虑用国内镜像源(`registry.cn-hangzhou.aliyuncs.com/qwenllm/...`)

## 提交方式

把上面"验收记录"填进对应 Task 的 `___` 位置,提交回 PR 或贴到这个 README 的下面段:

```
## 实测结果(2026-MM-DD,设备:DGX Spark)

### Task 1 Qwen3-ASR-0.6B
- ...

### Task 2 emotion2vec+ base
- ...

### Task 3 CosyVoice 2.0-SFT
- ...
```

## Foundation Gate 收口

跟 Spike 1-5 一起,Spike 6 的实测数字进入 v2.3.1 修订版。
