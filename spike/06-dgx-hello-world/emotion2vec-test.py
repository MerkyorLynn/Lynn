"""
Spike 06 — emotion2vec+ base 4s 段 P99 实测 on DGX

★ 关键决策点 1:P99 延迟决定 emotion 是否可注入当前轮 LLM
   P99 < 200ms → 注入当前轮(emotion-aware first-reply,体验大幅升级)
   P99 200-300ms → 注入下一轮(DS V4 Pro 原方案)
   P99 > 300ms → 跳过当前段(降级,不阻塞主链)
"""

import time
import os
import sys

print("=" * 60)
print("emotion2vec+ base 4s 段 P99 测试 on DGX SM121")
print("=" * 60)

print("\n[1/3] 加载模型...")
t0 = time.time()
try:
    from funasr import AutoModel
    m = AutoModel(model="iic/emotion2vec_plus_base", hub="ms")
    load_ms = (time.time() - t0) * 1000
    print(f"✓ 加载完毕,耗时 {load_ms:.0f}ms")
    print(f"模型路径: {m.model_path}")
except Exception as e:
    print(f"❌ 加载失败: {type(e).__name__}: {e}")
    sys.exit(1)

print("\n[2/3] 准备测试音频...")
test_wav = f"{m.model_path}/example/test.wav"
if not os.path.exists(test_wav):
    print(f"⚠ {test_wav} 不存在,model 包没自带")
    sys.exit(1)
print(f"✓ 用模型自带样本: {test_wav}")

print("\n[3/3] 跑 100 次推理测 P99...")
import wave
with wave.open(test_wav) as w:
    duration = w.getnframes() / w.getframerate()
    print(f"  音频时长: {duration:.2f}s")

RUNS = 100
times = []
result_sample = None
for i in range(RUNS):
    t0 = time.time()
    try:
        res = m.generate(test_wav, granularity="utterance", extract_embedding=False)
        elapsed = (time.time() - t0) * 1000
        times.append(elapsed)
        if result_sample is None:
            result_sample = res
        if (i + 1) % 20 == 0:
            print(f"  进度 {i+1}/{RUNS},当前 {elapsed:.0f}ms")
    except Exception as e:
        print(f"  Run {i+1} ❌: {e}")
        if i == 0:
            sys.exit(2)

times.sort()

print("\n=== 测量结果 ===")
print(f"加载耗时:     {load_ms:.0f}ms")
print(f"音频时长:     {duration:.2f}s (注:不是严格 4s,实际可能更长/短)")
print(f"推理 100 次:")
print(f"  min:        {times[0]:.1f}ms")
print(f"  P50:        {times[50]:.1f}ms")
print(f"  P90:        {times[90]:.1f}ms")
print(f"  P99:        {times[99]:.1f}ms")
print(f"  max:        {times[-1]:.1f}ms")
print(f"  mean:       {sum(times)/len(times):.1f}ms")

print(f"\n输出 schema 示例:")
print(result_sample)

print("\n=== ★ Foundation Gate 决策点 1 判定 ===")
p99 = times[99]
if p99 < 200:
    print(f"✅ P99 {p99:.0f}ms < 200ms → emotion 注入【当前轮】LLM")
    print("   (Qwen3-ASR TTFT ~92ms + emotion P99 < 200ms 都在 LLM TTFT 之前到达)")
    print("   → AI 第一句话就能 emotion-aware,贾维斯体验大幅升级")
elif p99 < 300:
    print(f"⚠ P99 {p99:.0f}ms 200-300ms → emotion 注入【下一轮】(DS V4 Pro 原方案,稳妥)")
else:
    print(f"❌ P99 {p99:.0f}ms > 300ms → emotion 跳过当前段,不阻塞主链")
    print("   考虑只在转写完结后异步打 emotion,作为对话历史的元数据,不参与即时回复")

print(f"\nv2.3.1 doc 填:emotion2vec+ base SM121 P99 {p99:.0f}ms / 加载 {load_ms:.0f}ms")
