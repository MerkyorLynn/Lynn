# Spike 02 — WebSocket binary PCM 协议(双向流 + RTT)

> 验证:client → server PCM frame 不丢序、本机 RTT < 50ms、5 分钟连续测试零异常。

## 协议(每帧 4 字节 header + payload)

```
[type:u8] [flags:u8] [seq:u16 BE] [payload:variable]

types:
  0x01  PCM_AUDIO   client → server  麦克风 PCM
  0x02  PCM_TTS     server → client  TTS PCM (spike 用 echo 回去模拟)
  0x10  PING        双向              RTT 测量(payload = u64 BE 客户端发送 ts)
  0x11  PONG        双向              RTT 测量(payload = 原 PING 时间戳)
  0x20  RESET       双向              重置 seq
```

## 跑法

```bash
cd spike/02-ws-binary

# 1. 启动 server
node server.mjs
# stdout 会显示:[spike02] http://localhost:8002/

# 2. 浏览器打开 http://localhost:8002/

# 3. 点 ▶ 连接 + 开始
#    - WS 自动连
#    - 麦克风 PCM 自动通过 WS 推到 server,server echo 回 PCM_TTS
#    - 同时每秒一次 PING/PONG 测 RTT
#    - 页面实时显示 frames out/in / KB / seq 错乱 / RTT 分布
```

## 验收标准

| 指标 | 目标 | 不达标含义 |
|------|------|-----------|
| RTT < 50ms 比例 | ≥ 95% | 本机 WS RTT 应该 < 10ms,> 50ms 说明 Node event loop 阻塞 |
| RTT p95 | < 20ms | 偶发 spike 可接受,长期 > 20ms 说明 GC 或 OS 调度 |
| seq 错乱次数 | 0 | TCP 应保证有序,出错说明 client / server 实现 bug |
| 5 分钟连续测 | 无 WS 断连、无 OOM | 长测试稳定性 |
| 双向吞吐 | client out / server in 字节相等 | echo 协议要求精确对称 |

## 失败模式记录

```
Mac mini M4 (2026-04-29):  - 待测
Lynn Electron 内 (2026-04-29):  - 待测
```

## 已知 caveat

- **echo 协议**:server 收到 PCM_AUDIO 立刻回 PCM_TTS(纯 echo)。这只是**协议测试**,不模拟真 TTS 延迟
- **PING 频率**:每秒 1 次,过密会污染 PCM 吞吐统计
- **seq u16 wrap-around**:65536 帧后 seq 回 0,client/server 都要正确处理(已实现)
- **payload 大小**:每帧 PCM 1600 samples * 2 bytes = 3200 bytes payload + 4 bytes header,跟生产一致

## 一旦 Spike 02 通过

把 `server.mjs` 的协议代码 port 到 `server/routes/voice-ws.js`,
把 `index.html` 的 client 代码 port 到 `desktop/src/react/services/voice-ws-client.ts`。

## 下一步

- ✅ 通过 → 进 Spike 03(把 echo 回来的 PCM 真接 AudioWorklet 流式播放)
- ⚠️ RTT 偶发 spike → 加 ring buffer + worker thread 解码
- ❌ 失败 → 整体重评 voice-ws 协议(可能用 SSE 或 gRPC-Web 替代)
