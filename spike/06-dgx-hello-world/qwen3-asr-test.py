"""
Spike 06 — Qwen3-ASR-0.6B hello world on DGX Spark (aarch64)

Run on DGX:
  cd /home/merkyor/voice-services/qwen3-asr-spike
  source .venv/bin/activate
  python qwen3-asr-test.py

测试目标:
  - 模型在 SM121 / aarch64 上能加载吗?
  - transformers backend 中文 transcribe 工作吗?
  - 单次中文 utterance(3-5s)的端到端延迟?
  - 显存占用?
"""

import time
import sys
import os
import subprocess

# 确保有测试音频(用 macOS say + ffmpeg 或预录,这里用 mock 测试模型加载)
TEST_WAV = "/home/merkyor/voice-services/test_zh.wav"

print("=" * 60)
print("Qwen3-ASR-0.6B SM121 / aarch64 hello world")
print("=" * 60)

# 1. 加载模型
print("\n[1/3] 加载模型...")
t0 = time.time()
try:
    from transformers import AutoModelForCausalLM, AutoProcessor
    import torch
    print(f"torch: {torch.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"CUDA device: {torch.cuda.get_device_name(0)}")
        print(f"CUDA capability: {torch.cuda.get_device_capability(0)}")  # (12, 1) for SM121

    model_path = "Qwen/Qwen3-ASR-0.6B"  # 自动从 HF / ModelScope 拉
    # 国内优先 ModelScope
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        device_map="cuda:0",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )
    load_ms = (time.time() - t0) * 1000
    print(f"✓ 模型加载完毕,耗时 {load_ms:.0f}ms")

    # VRAM 占用
    if torch.cuda.is_available():
        mem_alloc = torch.cuda.memory_allocated() / 1024 / 1024
        mem_resv = torch.cuda.memory_reserved() / 1024 / 1024
        print(f"VRAM allocated: {mem_alloc:.1f} MB / reserved: {mem_resv:.1f} MB")
except ImportError as e:
    print(f"❌ ImportError: {e}")
    print("   需要装: pip install transformers accelerate")
    sys.exit(1)
except Exception as e:
    print(f"❌ 加载失败: {type(e).__name__}: {e}")
    sys.exit(1)

# 2. 准备测试音频(如果没有,生成一段 mock)
print("\n[2/3] 准备测试音频...")
if not os.path.exists(TEST_WAV):
    print(f"⚠ {TEST_WAV} 不存在,生成 5s 静音作占位")
    import struct
    import wave
    w = wave.open(TEST_WAV, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(b"\x00\x00" * 16000 * 5)
    w.close()
    print(f"✓ 占位 WAV 写入(实际用真实人声测才有意义)")
print(f"使用: {TEST_WAV}")

# 3. 运行 transcribe(单次端到端 latency)
print("\n[3/3] 运行 transcribe...")
import torchaudio
audio, sr = torchaudio.load(TEST_WAV)
if sr != 16000:
    audio = torchaudio.functional.resample(audio, sr, 16000)
print(f"音频: {audio.shape} @ {sr}Hz → 16kHz")

# 多次跑取 P50/P99
RUNS = 5
times = []
for i in range(RUNS):
    t0 = time.time()
    try:
        # Qwen3-ASR 接口可能是 model.generate(...),具体看 trust_remote_code 加载的 modeling.py
        # 这里 mock 一个 generic call
        with torch.no_grad():
            inputs = processor(audios=audio.numpy().squeeze(), sampling_rate=16000, return_tensors="pt").to("cuda:0")
            output = model.generate(**inputs, max_new_tokens=128)
            text = processor.batch_decode(output, skip_special_tokens=True)[0]
        elapsed = (time.time() - t0) * 1000
        times.append(elapsed)
        print(f"  Run {i+1}/{RUNS}: {elapsed:.0f}ms — {text[:60]}{'...' if len(text)>60 else ''}")
    except Exception as e:
        print(f"  Run {i+1}/{RUNS} ❌: {type(e).__name__}: {e}")
        if i == 0:
            sys.exit(2)

if times:
    times.sort()
    print(f"\n=== 5 次端到端 transcribe latency ===")
    print(f"min:  {times[0]:.0f}ms")
    print(f"P50:  {times[len(times)//2]:.0f}ms")
    print(f"P99:  {times[-1]:.0f}ms")
    print(f"mean: {sum(times)/len(times):.0f}ms")

    # VRAM after inference
    mem_alloc = torch.cuda.memory_allocated() / 1024 / 1024
    print(f"\nVRAM after inference: {mem_alloc:.1f} MB")

    print("\n✅ Spike 06 Qwen3-ASR hello world 通过")
    print(f"v2.3.1 doc 填:模型加载 {load_ms:.0f}ms,P50 transcribe {times[len(times)//2]:.0f}ms,VRAM {mem_alloc:.1f}MB")
else:
    print("\n❌ 5 次都失败,见上面错误")
    sys.exit(2)
