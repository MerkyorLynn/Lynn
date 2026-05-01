# Spike 03 — AudioWorklet 流式播放 + 中途清空 + 淡出

> 验证:1000 次随机打断,音爆率 0,平均淡出耗时 < 25ms。

## 跑法

```bash
cd spike/03-streaming-player
python3 -m http.server 8003
# 浏览器打开 http://localhost:8003/

# 1. 点 ⚙️ 初始化(允许浏览器播放音频权限)
# 2. 点 ▶ 开始流式播放(440Hz 持续生成)
# 3. 听到 440Hz 正弦音
# 4. 试手动 ✋ 打断 — 应该立即静音(20ms 淡出),不应该有音爆
# 5. 试 ↻ 切换频率 — 听到 440 → 880 → 1320 切换
# 6. 试 🤖 自动 1000 次随机打断 — 自动跑 ~5 分钟,统计 flush 耗时分布
```

## 验收标准

| 指标 | 目标 | 不达标含义 |
|------|------|-----------|
| 1000 次 flush 平均耗时 | < 25 ms | AudioWorklet quantum 是 128 samples ≈ 2.7ms @ 48k,正常应在一个 quantum 内完成 |
| max flush 耗时 | < 50 ms | 偶发 GC 抖动可接受 |
| 音爆 | 0 次(主观听) | 直接清队列没淡出会有 click,这正是 spike 验证的关键 |
| underruns | 始终 0 | enqueue 速度与播放速度匹配,队列不该耗尽 |
| 1000 次后 queueSamples 不积压 | < 16000 (1s 缓冲) | 长测内存不泄漏 |

## 失败模式记录

```
Mac mini M4 (2026-04-29):  - 待测
Lynn Electron 内 (2026-04-29):  - 待测
```

## 关键设计点

- **20ms 淡出**:flush 不是粗暴丢弃,先线性淡出 20ms 再清队列。这是无音爆的关键
- **设备 sampleRate 上采样**:输入是 16kHz Int16,设备通常 48kHz,Worklet 内做线性插值上采样(spike 用,生产用 SRC)
- **mono → mono**:不做 stereo,如果以后要 stereo,output[1] 复制 output[0]
- **underrun 静音 fill**:队列空时输出 0,不报错,避免 destroy 当前 AudioContext

## 一旦 Spike 03 通过

把 `pcm-player.worklet.js` port 到 `desktop/public/workers/pcm-player.worklet.js`
把 client API port 到 `desktop/src/react/services/audio-playback.ts`

## 下一步

- ✅ 1000 次自动测试通过 → Spike 03 通过,进 Spike 04(tonarino N-API)
- ⚠️ 偶发音爆 → 加 fade-in / 检查 fadeOutDuration 是否够长(可能 20ms 不够,试 50ms)
- ❌ 失败 → 降级 AudioBuffer 一次性播放(放弃打断,等 TTS 整段做完才播)
