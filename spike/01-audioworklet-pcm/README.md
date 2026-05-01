# Spike 01 — AudioWorklet 16kHz PCM 采集

> Phase 0B 的第一项 spike。**目的:验证 AudioWorklet 16kHz Int16 PCM 采集稳定 1 小时不丢帧。**

## 跑法

需要一个能 serve 静态文件的 web server(AudioWorklet 必须 HTTP/HTTPS context,不能直接 `file://`):

```bash
# 选项 A:Python 标准库
cd spike/01-audioworklet-pcm
python3 -m http.server 8001
# 浏览器打开 http://localhost:8001/

# 选项 B:Node http-server
npx http-server -p 8001
```

也可以打开 Lynn 自身(Electron context),但暂时简单先 browser 验证。

## 验收标准

| 指标 | 目标 | 不达标含义 |
|------|------|-----------|
| 连续运行时长 | 1 小时不掉 | AudioWorklet 在长时间运行下有 GC 抖动或采样器内存泄漏 |
| chunks/sec | 10.0 ± 0.5 | 重采样或 AudioWorklet 阻塞,可能浏览器调度问题 |
| buffer lag | < 1600(<100ms) | inputBuffer 累积 = 上游采得快下游处理不及,生产环境必须 0 |
| underrun count | 0 | 任何一次都说明系统调度有问题 |
| JS heap | 1 小时增长 < 5 MB | 大于这个数说明有内存泄漏 |

## 失败模式记录

如果跑挂了,请在这里追加(每个测试机记一条):

```
Mac mini M4(2026-04-29): - 待测
MacBook Pro M3(2026-04-29): - 待测
Windows 11 ARM64 笔记本: - 待测
```

## 测试方法 — 1 小时连续

1. 点 ▶ 开始采集
2. 让它跑 1 小时(可以最小化窗口,但浏览器需要保持运行)
3. 期间观察:
   - chunks/sec 应稳定在 10.0
   - VU meter 应跟着环境音变化
   - underrun count 应 = 0
   - JS heap 缓慢增长但 < 5MB(可能 Chrome 自己的 GC 抖动)
4. 1 小时后点 ■ 停止,记录最终数字

## 已知 caveat

- **浏览器 echoCancellation/noiseSuppression 都关了**。Spike 01 只测**纯采集**,AEC 是 Spike 04 的事。开了反而看不出底层是否稳定
- **重采样是线性下采样**(粗糙),生产应用 SRC。Spike 01 用最简单实现,只验证管道
- **AudioContext sampleRate 由设备决定**(通常 48kHz),AudioWorklet 内部重采样到 16kHz。如果设备恰好是 16kHz,resampleRatio = 1 跳过

## 下一步

跑过 1 小时验证后:
- ✅ 通过 → 进 Spike 02(WebSocket binary 接收 chunk)
- ⚠️ 部分通过(buffer lag 偶发涨)→ 加 ring buffer 优化
- ❌ 失败 → 降级 MediaRecorder 整段(放弃实时流式),Tier 4 V0.78++
