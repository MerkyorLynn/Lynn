"""
Spike 06 — Qwen3-ASR-0.6B hello world (V2: 用 qwen_asr.Qwen3ASRModel API + transformers backend)

Run on DGX:
  cd /home/merkyor/voice-services/qwen3-asr-spike
  source .venv/bin/activate
  cd /home/merkyor/voice-services
  python qwen3-asr-test-v2.py
"""
import time
import sys
import os

print("=" * 60)
print("Qwen3-ASR-0.6B hello world (transformers backend, SM121)")
print("=" * 60)

# 国内优先 ModelScope
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("MODELSCOPE_CACHE", "/home/merkyor/.cache/modelscope")

print("\n[1/3] 加载模型(transformers backend)...")
t0 = time.time()
try:
    import torch
    from qwen_asr import Qwen3ASRModel
    print(f"torch: {torch.__version__}")
    print(f"CUDA capability: {torch.cuda.get_device_capability(0)}")  # 期望 (12, 1) 即 SM121

    # 模型路径:用 ModelScope 镜像下载
    model_id = "Qwen/Qwen3-ASR-0.6B"
    # qwen-asr 0.0.6 应该自动从 HF 拉,如果走 mirror 也 OK
    asr = Qwen3ASRModel.from_pretrained(
        model_id,
        torch_dtype=torch.bfloat16,
        device_map="cuda:0",
    )
    load_ms = (time.time() - t0) * 1000
    print(f"✓ 模型加载完毕 {load_ms:.0f}ms")

    if torch.cuda.is_available():
        mem_alloc = torch.cuda.memory_allocated() / 1024 / 1024
        print(f"VRAM allocated after load: {mem_alloc:.1f} MB")
except Exception as e:
    import traceback
    print(f"❌ 加载失败: {type(e).__name__}: {e}")
    traceback.print_exc()
    sys.exit(1)

print("\n[2/3] 准备测试音频...")
test_wav = "/home/merkyor/.cache/modelscope/hub/models/iic/emotion2vec_plus_base/example/test.wav"
if not os.path.exists(test_wav):
    print(f"❌ {test_wav} 没找到,需先跑 emotion2vec test")
    sys.exit(1)

import wave
with wave.open(test_wav) as w:
    duration = w.getnframes() / w.getframerate()
    print(f"音频: {test_wav}")
    print(f"时长: {duration:.2f}s @ {w.getframerate()}Hz")

print("\n[3/3] 跑 transcribe(5 次取 P50/P99)...")
RUNS = 5
times = []
text_sample = None
for i in range(RUNS):
    t0 = time.time()
    try:
        # qwen-asr 调用:看 API 应该有 .transcribe(audio_path, lang=None) 或类似
        # 可能是 .infer 或 .__call__
        # 先试 transcribe
        result = asr.transcribe(audio=test_wav)
        elapsed = (time.time() - t0) * 1000
        times.append(elapsed)
        if text_sample is None:
            text_sample = str(result)[:100]
        print(f"  Run {i+1}/{RUNS}: {elapsed:.0f}ms")
    except AttributeError:
        # 也许不是 .transcribe,试 __call__
        try:
            result = asr(test_wav)
            elapsed = (time.time() - t0) * 1000
            times.append(elapsed)
            if text_sample is None:
                text_sample = str(result)[:100]
            print(f"  Run {i+1}/{RUNS}: {elapsed:.0f}ms (via __call__)")
        except Exception as e2:
            print(f"  Run {i+1}/{RUNS} ❌: {e2}")
            print(f"  asr 对象方法: {[m for m in dir(asr) if not m.startswith('_')][:10]}")
            sys.exit(2)
    except Exception as e:
        print(f"  Run {i+1}/{RUNS} ❌: {type(e).__name__}: {e}")
        if i == 0:
            sys.exit(2)

if times:
    times.sort()
    print(f"\n=== 测量结果 ===")
    print(f"加载耗时:        {load_ms:.0f}ms")
    print(f"音频时长:        {duration:.2f}s")
    print(f"transcribe latency:")
    print(f"  min:           {times[0]:.0f}ms")
    print(f"  P50:           {times[len(times)//2]:.0f}ms")
    print(f"  P99:           {times[-1]:.0f}ms")
    print(f"  mean:          {sum(times)/len(times):.0f}ms")

    rtf = (sum(times) / len(times)) / 1000 / duration
    print(f"  RTF (mean):    {rtf:.3f}")

    mem_alloc = torch.cuda.memory_allocated() / 1024 / 1024
    print(f"VRAM (final):    {mem_alloc:.1f} MB")
    print(f"\n转写示例: {text_sample}")
    print(f"\n✅ Spike 06 Qwen3-ASR transformers backend on SM121 通过")
    print(f"v2.3.1 doc 填:加载 {load_ms:.0f}ms / P50 {times[len(times)//2]:.0f}ms / RTF {rtf:.3f} / VRAM {mem_alloc:.1f}MB")
else:
    print("\n❌ 全失败")
    sys.exit(2)
