/**
 * Spike 02 — WebSocket binary PCM 协议服务端
 *
 * 协议(每帧):
 *   [type:u8] [flags:u8] [seq:u16 BE] [payload:variable]
 *
 * Types:
 *   0x01  PCM_AUDIO  client → server  麦克风 PCM
 *   0x02  PCM_TTS    server → client  TTS PCM(spike 用 echo 回去模拟)
 *   0x10  PING       双向              RTT 测量 ping
 *   0x11  PONG       双向              RTT 测量 pong (含 client_send_ts u64 BE)
 *   0x20  RESET      双向              重置 seq
 *
 * 此 server:
 *   - 收到 PCM_AUDIO 立刻 echo 回去作 PCM_TTS(模拟全双工双向流)
 *   - 收到 PING 立刻回 PONG(包含原 client_send_ts 用于 RTT 计算)
 *   - 统计 frame seq 不丢序
 *   - 统计 RTT 分布
 *
 * 跑法:
 *   cd spike/02-ws-binary
 *   node server.mjs
 *   # 默认 :8002
 */

import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "8002", 10);

// HTTP server 同时 serve 静态文件(index.html / *.js / *.worklet.js)
const httpServer = http.createServer((req, res) => {
  let urlPath = req.url === "/" ? "/index.html" : req.url;
  // 也允许引用 spike/01-audioworklet-pcm 的 worklet
  let filePath;
  if (urlPath.startsWith("/01-audioworklet-pcm/")) {
    filePath = path.join(__dirname, "..", urlPath);
  } else {
    filePath = path.join(__dirname, urlPath);
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("not found: " + urlPath);
    return;
  }
  const ext = path.extname(filePath);
  const ctype = ({
    ".html": "text/html",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
  })[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": ctype });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server: httpServer, path: "/voice-ws" });

const FRAME = {
  PCM_AUDIO: 0x01,
  PCM_TTS:   0x02,
  PING:      0x10,
  PONG:      0x11,
  RESET:     0x20,
};

function makeFrame(type, flags, seq, payload) {
  const buf = Buffer.alloc(4 + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt8(flags, 1);
  buf.writeUInt16BE(seq & 0xffff, 2);
  payload.copy(buf, 4);
  return buf;
}

function parseFrame(buf) {
  if (buf.length < 4) return null;
  return {
    type: buf.readUInt8(0),
    flags: buf.readUInt8(1),
    seq: buf.readUInt16BE(2),
    payload: buf.subarray(4),
  };
}

wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  let lastSeq = -1;
  let outSeq = 0;
  let totalIn = 0;
  let outOfOrder = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  const startTime = Date.now();

  const statsInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(
      `[ws] elapsed=${elapsed.toFixed(0)}s | in=${totalIn} frames (${(bytesIn / 1024).toFixed(1)}KB) | out_of_order=${outOfOrder} | bytes_out=${(bytesOut / 1024).toFixed(1)}KB`,
    );
  }, 5000);

  ws.on("message", (data) => {
    if (!Buffer.isBuffer(data)) {
      console.warn("[ws] unexpected non-binary message");
      return;
    }
    const frame = parseFrame(data);
    if (!frame) return;
    bytesIn += data.length;
    totalIn++;

    if (frame.type === FRAME.PCM_AUDIO) {
      // 检查 seq 顺序
      const expectedSeq = (lastSeq + 1) & 0xffff;
      if (lastSeq !== -1 && frame.seq !== expectedSeq) {
        outOfOrder++;
        console.warn(`[ws] seq out of order: expected ${expectedSeq}, got ${frame.seq}`);
      }
      lastSeq = frame.seq;

      // Echo 回去作 PCM_TTS(spike 模拟全双工)
      const echo = makeFrame(FRAME.PCM_TTS, 0, outSeq++, frame.payload);
      ws.send(echo);
      bytesOut += echo.length;
    } else if (frame.type === FRAME.PING) {
      // 立即回 PONG,payload 原样回(含 client_send_ts u64 BE)
      const pong = makeFrame(FRAME.PONG, 0, frame.seq, frame.payload);
      ws.send(pong);
      bytesOut += pong.length;
    } else if (frame.type === FRAME.RESET) {
      lastSeq = -1;
      outSeq = 0;
      console.log("[ws] RESET received");
    }
  });

  ws.on("close", () => {
    clearInterval(statsInterval);
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(
      `[ws] disconnect after ${elapsed.toFixed(1)}s | total_in=${totalIn} | out_of_order=${outOfOrder} | KB in/out=${(bytesIn / 1024).toFixed(1)}/${(bytesOut / 1024).toFixed(1)}`,
    );
  });

  ws.on("error", (err) => console.error("[ws] error:", err.message));
});

httpServer.listen(PORT, () => {
  console.log(`[spike02] http://localhost:${PORT}/`);
  console.log(`[spike02] ws://localhost:${PORT}/voice-ws`);
});
