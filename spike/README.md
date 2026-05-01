# Lynn V0.79 — Phase 0B Foundation Spike

> 6 项工程底座 spike,**不进 Lynn 生产**,只在这个目录里跑通验证。
> 跑通后才把对应代码 port 到 `desktop/src/react/services/` 等正式位置。
>
> 上下文:见 [`docs/PLAN-v0.79-JARVIS-MODE.md`](../docs/PLAN-v0.79-JARVIS-MODE.md) v2.3

## 6 项 Spike 清单

| # | 目录 | 核心问题 | 验收 | 失败降级 |
|---|------|---------|------|---------|
| 1 | [`01-audioworklet-pcm/`](01-audioworklet-pcm/) | AudioWorklet 16kHz PCM 采集稳定吗? | 1 小时连续运行,无 underrun | 降级 MediaRecorder(放弃实时流式) |
| 2 | [`02-ws-binary/`](02-ws-binary/) | WebSocket binary PCM 双向流 RTT 多少? | 本机 RTT < 50ms,frame seq 不丢序 | 降级 HTTP POST 整段(V0.78 路径) |
| 3 | [`03-streaming-player/`](03-streaming-player/) | AudioWorklet 流式播放 + 中途清空有音爆吗? | 1000 次随机打断音爆率 0,淡出 < 25ms | 降级 AudioBuffer 一次性播放(放弃打断) |
| 4 | [`04-tonarino-aec-napi/`](04-tonarino-aec-napi/) ★ | tonarino webrtc-audio-processing 能在 macOS arm64 编出 .node 吗? | macOS arm64 .node + hello world process 跑通 | 降级 SpeexDSP WASM(精度差一档) |
| 5 | [`05-erle-test/`](05-erle-test/) | tonarino AEC + TTS reference 实测 ERLE 多少? | ERLE ≥ 15 dB → Tier 1 准入 | < 15 dB → Tier 2 半双工 |
| 6 | [`06-dgx-hello-world/`](06-dgx-hello-world/) | DGX 上 Qwen3-ASR + emotion2vec+ 真跑得动吗? | hello world 出转写/情绪 | 各自降级见 spike README |

## 体验承诺三档(由 spike 结果决定)

```
1+2+3+4+5 全过 → Tier 1 全双工 Jarvis  (插嘴 200ms 内停)
1+2+3 过, 4 部分过 → Tier 2 半双工 Jarvis (用户开口 → 暂停 TTS)
1+2 过, 3+4 卡 → Tier 3 V0.78++ 增强语音 (PTT + ASR/TTS 升级)
1+2 都不通 → 整体重评 (但概率极低)
```

## 团队分工

```
Codex (本机)      → spike 1-5 落代码 + 测试
用户             → spike 6 SSH DGX 跑 + 提供 Phase 0A 真实数据
外部 LLM         → spike 失败时做规划评审 + 风险提醒
```

## 每项 spike 必须产出

- 可运行的 demo(能 `npm start` / `cargo run` / `python main.py`)
- README:运行方法 + 实测数字 + 失败模式
- 失败的项也保留报告,**不删除**

## 启动顺序

```
Day 1: Spike 1 (AudioWorklet PCM)         — 基础,最先验
Day 1: Spike 6 (DGX 平行)                  — 用户 SSH 跑,不阻塞本机
Day 2: Spike 2 (WS binary)                 — 接 Spike 1 输出
Day 2: Spike 3 (流式播放)                  — 跟 Spike 2 共测
Day 3-5: Spike 4 (tonarino N-API) ★        — 关键路径,可能踩坑
Day 5-7: Spike 5 (ERLE 实测)               — 等 Spike 4 完成
```

## Foundation Gate 收口

7 天后,根据 spike 结果决定 V0.79 走哪一档,**写进 v2.3.1 文档**。
