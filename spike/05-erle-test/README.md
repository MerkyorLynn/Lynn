# Spike 05 · ERLE 实测 — 2026-05-01 方案

## 背景

Foundation Gate Tier 1 的 AEC 准入指标 = **ERLE ≥ 15 dB**,
需要一对"扬声器在播 AI 时,mic 同时段录音"的 WAV。

## ❌ 旧方案(session_0430)被推翻

原 DS/v2.3 文档写"用户自己录 3 个 WAV",实际不可行:
- macOS 默认没装 sox
- afrecord 已被删
- BlackHole 虚拟声卡也没装
- 历史 Lynn 对话只存 TTS 侧 (`~/.lynn/audio/msg_*.wav`),不存 mic

## ✅ 新方案:voice-ws 内置双轨录制

voice-ws.js 本来就同时持有 mic (PCM_AUDIO 入) 和 TTS (PCM_TTS 出) 两路 PCM,
改个 debug 开关就能落盘。零外部依赖。时间天然对齐(同一 AudioContext 时序)。

## 用法

```bash
# 1. 设开关 + 启动 Lynn
export LYNN_ERLE_RECORD_DIR=/tmp/lynn-erle
mkdir -p /tmp/lynn-erle
npm run dev   # 或 npm run start

# 2. Cmd+Shift+L 呼出 Jarvis overlay,正常对话
#    说几句话 → 听 AI 回复 → 再说一句让它被 mic 和扬声器同时录到
#    (关键:扬声器外放不要戴耳机,这样 mic 才能真采到 echo)

# 3. 关闭 overlay / 退出 voice session
#    voice-ws.js::onClose 自动写:
#      /tmp/lynn-erle/session-<ts>-<rand>-mic.wav
#      /tmp/lynn-erle/session-<ts>-<rand>-tts.wav

# 4. 跑 ERLE bench
node spike/05-erle-test/erle-bench.mjs \
  /tmp/lynn-erle/session-XXX-tts.wav \
  /tmp/lynn-erle/session-XXX-mic.wav
```

## 期望输出

```
=== 测量结果 ===
mic 平均 RMS:     0.0234   (-32.61 dBFS)
cleaned 平均 RMS: 0.0041   (-47.73 dBFS)
mic→cleaned 衰减: 15.12 dB

=== Foundation Gate 判定 ===
✓ ERLE ≥ 15 dB → Tier 1 全双工 Jarvis 准入
```

## 判定

- **≥ 15 dB** → Tier 1 (全双工 Jarvis)
- **10-15 dB** → Tier 2 (半双工,双讲吞字明显)
- **< 10 dB** → Tier 3 (PTT 模式,建议戴耳机)

## 注意事项

1. **扬声器外放必须开**,戴耳机时 mic 几乎采不到 echo,ERLE 数字虚高
2. **环境噪音会降低 ERLE 数值**,但这是真实场景,不回避
3. **第一次跑建议录 60s+ 多轮对话**,再 trim 中间稳态 30s 测(减少 warmup 影响)
4. voice-ws 录的是 **经过 AEC 后的 mic PCM**(AEC native 已接线),所以
   理论 ERLE 会比 raw mic 高 —— 这才是 Lynn 真正提供的体验。
   若想测 raw mic,需另开 `LYNN_ERLE_RECORD_RAW=1`(待实现,看是否真需要)

## 文件清单

- `erle-bench.mjs`  — ERLE 计算主程(session_0430 留下,不用改)
- `erle-self-record.mjs` — 弃用提示(保留以便老文档引用)
- `README.md`       — 本文档
