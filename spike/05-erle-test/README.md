# Spike 05 — TTS Reference Signal AEC ERLE 实测

> **依赖 Spike 04 编译产物**(`../04-tonarino-aec-napi/lynn-aec-napi.node`)。
>
> 验证:tonarino webrtc-audio-processing 在真实 TTS reference 信号下的 ERLE 数字。
>
> ERLE(Echo Return Loss Enhancement)= 输入 mic 能量 / AEC 输出能量,单位 dB,数字越大越好。

## 准备测试音频(你需要先录这 3 个 WAV)

录音工具:Audacity(免费跨平台)或 macOS 自带"语音备忘录"

**3 个 WAV 都要 16 kHz mono PCM 16-bit**(WAV 导出选 "16-bit PCM mono"):

| 文件 | 内容 | 时长 | 录法 |
|------|------|------|------|
| `tts.wav` | 一段干净的 AI 说话 | 5-10s | Lynn V0.78 调 CosyVoice 录一段中文,直接保存 PCM 输出 |
| `mic.wav` | **同步**录的麦克风 | 同上 | 扬声器播放 tts.wav,你坐扬声器旁,**不要戴耳机**,期间你也说几句中文 |
| `speech-only.wav`(可选) | 仅你说话(对照) | 5-10s | 扬声器关掉,只录你的声音 |

**关键**:`tts.wav` 和 `mic.wav` 必须**时间同步**(AEC 算法靠 reference 对齐回声)。最简单方法:
- 先开始录 mic.wav
- 然后立即播放 tts.wav
- 两个文件 trim 成同样时长起点

如果你怕同步不准,可以让 AI 说话时**夹一个 click 声**(开头 0.5s 一个短脉冲),后续手动对齐。

## 跑法

```bash
# 1. 先确保 Spike 04 build 通过
cd ../04-tonarino-aec-napi
cargo build --release && npm run build

# 2. 回到 Spike 05
cd ../05-erle-test

# 3. 准备 tts.wav + mic.wav(放在当前目录)

# 4. 跑
node erle-bench.mjs tts.wav mic.wav

# 或带 speech-only 对照
node erle-bench.mjs tts.wav mic.wav speech-only.wav
```

## 输出

```
处理 N 帧 (10s)
AEC processor: sample_rate=16000Hz channels=1 samples/frame=160
输出已写: out-cleaned.wav

=== 测量结果 ===
mic 平均 RMS:        0.0850   (-21.41 dBFS)
cleaned 平均 RMS:    0.0095   (-40.42 dBFS)
mic→cleaned 衰减:    19.01 dB

=== Foundation Gate 判定 ===
✓ ERLE ≥ 15 dB → Tier 1 全双工 Jarvis 准入
```

然后**听 `out-cleaned.wav`**:
- 应该:你的语音清晰保留,扬声器拾到的"AI 说话"明显消除
- 不应该:你的语音也被吃掉(过度抑制),或残留明显"AI 说话"片段

## 验收标准(Foundation Gate)

| ERLE | 判定 | 体验承诺 |
|------|------|----------|
| **≥ 15 dB** | ✓ Tier 1 准入 | 全双工 Jarvis(AI 说话时插嘴 200ms 内停) |
| 10-15 dB | ⚠ Tier 2 | 半双工 Jarvis(双讲场景吞字明显,但用户开口暂停 TTS 可接受) |
| 5-10 dB | ⚠ Tier 3 | PTT + 文档"建议戴耳机" |
| < 5 dB | ❌ 配置错 | 检查 reference 信号是否对齐,或 tonarino API 用错 |

## 失败模式记录

```
Mac mini M4(2026-04-29):     - 待测,需先 Spike 04 build
MacBook Pro M3(2026-04-29):  - 待测
Windows 11(2026-04-29):     - 待测
```

## 已知 caveat

- **严格 ERLE** 需要 echo-only 信号(mic 只录回声不含用户语音),本 spike 用粗估
- **双讲场景** ERLE 偏低正常(用户语音也算进 cleaned 能量)
- **延迟对齐** 是最大坑:tts.wav 和 mic.wav 起点偏差 > 50ms 会让 ERLE 数字打折
- **tonarino enable_delay_agnostic: true** 已开,理论上 50-200ms 内 delay 自适应

## 下一步

- ✅ ERLE ≥ 15 dB → 写入 v2.3.1 文档,**Foundation Gate 通过 → Tier 1**
- ⚠️ 10-15 dB → 试调 `EchoCancellationSuppressionLevel::Highest`(更激进抑制)
- ❌ < 10 dB → 详查 reference 对齐 + 试 SpeexDSP MDF AEC(Tier 2 兜底)
