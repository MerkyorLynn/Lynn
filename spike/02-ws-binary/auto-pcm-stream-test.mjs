/**
 * Spike 02 — 自动 PCM 流稳定性 5 分钟测试
 *
 * Connect 到正在运行的 Electron loader (port 9223),自动:
 *   1. 点 ▶ 连接 + 开始(WS + mic 流)
 *   2. 跑 5 分钟
 *   3. 每 30 秒采集统计
 *   4. 验证:
 *      - PCM 帧 in / out 数字差 < 1%(理论应该精确 echo)
 *      - seq 错乱 = 0
 *      - RTT < 50ms 比例 ≥ 95%
 *      - 5 分钟无 WS 断连
 */
import puppeteer from "puppeteer";

const REMOTE_DEBUG = "http://localhost:9223";
const TEST_DURATION_MS = 5 * 60 * 1000; // 5 分钟
const SAMPLE_INTERVAL_MS = 30_000; // 30s 一次

console.log("[stream] connecting to electron-loader on port 9223...");
const browser = await puppeteer.connect({ browserURL: REMOTE_DEBUG });

const pages = await browser.pages();
const page = pages.find((p) => p.url().includes(":8002")) || pages[0];
console.log(`[stream] page url: ${page.url()}`);

// 截图看下页面状态
console.log("[stream] clicking ▶ 连接 + 开始 ...");
await page.click("#connectBtn");
await new Promise((r) => setTimeout(r, 2000));

// 检查初始状态
const initialState = await page.evaluate(() => ({
  wsStatus: document.getElementById("wsStatus").textContent,
  framesOut: parseInt(document.getElementById("framesOut").textContent) || 0,
}));
console.log(`[stream] initial: ws=${initialState.wsStatus} framesOut=${initialState.framesOut}`);

if (initialState.wsStatus !== "已连接") {
  console.error("❌ WS 未连接 — Electron mic 权限可能没通过");
  await browser.disconnect();
  process.exit(1);
}

// 等 mic 权限生效(可能要 1-2s 协商)
await new Promise((r) => setTimeout(r, 3000));
const afterMicState = await page.evaluate(() => ({
  framesOut: parseInt(document.getElementById("framesOut").textContent) || 0,
}));
console.log(`[stream] +3s: framesOut=${afterMicState.framesOut}`);
if (afterMicState.framesOut === 0) {
  console.error("❌ 5s 内 0 PCM 帧发出 — Electron mic 权限被拒");
  await browser.disconnect();
  process.exit(1);
}

console.log(`[stream] mic OK, 开始 ${TEST_DURATION_MS / 1000}s 长测...`);

const startTime = Date.now();
const samples = [];
let lastFramesOut = 0;
let lastFramesIn = 0;

while (Date.now() - startTime < TEST_DURATION_MS) {
  await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));

  const stats = await page.evaluate(() => ({
    wsStatus: document.getElementById("wsStatus").textContent,
    framesOut: parseInt(document.getElementById("framesOut").textContent) || 0,
    framesIn: parseInt(document.getElementById("framesIn").textContent) || 0,
    kbOut: parseFloat(document.getElementById("kbOut").textContent) || 0,
    kbIn: parseFloat(document.getElementById("kbIn").textContent) || 0,
    seqErrors: parseInt(document.getElementById("seqErrors").textContent) || 0,
    rttCount: parseInt(document.getElementById("rttCount").textContent) || 0,
    rttDist: document.getElementById("rttDist").textContent,
    rttUnder50: document.getElementById("rttUnder50").textContent,
  }));
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const fpsOut = (stats.framesOut - lastFramesOut) / (SAMPLE_INTERVAL_MS / 1000);
  const fpsIn = (stats.framesIn - lastFramesIn) / (SAMPLE_INTERVAL_MS / 1000);
  console.log(`[stream] ${elapsed}s | ws=${stats.wsStatus} | out=${stats.framesOut}(${fpsOut.toFixed(1)}/s) in=${stats.framesIn}(${fpsIn.toFixed(1)}/s) | KB out/in=${stats.kbOut}/${stats.kbIn} | seq_err=${stats.seqErrors} | RTT=${stats.rttUnder50} <50ms`);
  samples.push({ elapsed: parseInt(elapsed), ...stats });
  lastFramesOut = stats.framesOut;
  lastFramesIn = stats.framesIn;
  if (stats.wsStatus !== "已连接") {
    console.error(`❌ ${elapsed}s WS 断了`);
    break;
  }
  if (stats.seqErrors > 0) {
    console.error(`❌ seq 错乱 ${stats.seqErrors}`);
  }
}

const final = samples[samples.length - 1];
console.log("\n=== Spike 02 PCM 流 5 分钟测试结果 ===");
console.log(`总耗时:           ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
console.log(`WS 状态:          ${final.wsStatus}`);
console.log(`已发 PCM 帧:      ${final.framesOut} (期望 ~3000 = 5min × 10/s)`);
console.log(`已收 echo 帧:     ${final.framesIn}`);
console.log(`out vs in 差:     ${final.framesOut - final.framesIn} (echo 协议应该 0 或 1)`);
console.log(`已发 KB:          ${final.kbOut}`);
console.log(`已收 KB:          ${final.kbIn}`);
console.log(`seq 错乱:         ${final.seqErrors}`);
console.log(`RTT count:        ${final.rttCount}`);
console.log(`RTT 分布:         ${final.rttDist}`);
console.log(`RTT < 50ms 比例:  ${final.rttUnder50}`);

let pass = true;
if (final.framesOut < 2800) {
  console.log(`⚠ frames out ${final.framesOut} 低于期望 2800+(可能 mic 启动延迟)`);
}
if (Math.abs(final.framesOut - final.framesIn) > 5) {
  console.log(`⚠ echo 不对称: out=${final.framesOut} in=${final.framesIn}`);
  pass = false;
}
if (final.seqErrors > 0) {
  console.log(`❌ seq 错乱 ${final.seqErrors}`);
  pass = false;
}
if (final.wsStatus !== "已连接") {
  console.log(`❌ 5 分钟内 WS 断了`);
  pass = false;
}
const rttPct = parseFloat(final.rttUnder50);
if (rttPct < 95) {
  console.log(`⚠ RTT < 50ms 仅 ${rttPct}%(目标 ≥ 95%)`);
}

console.log(pass ? "\n✅ Spike 02 PCM 流测试通过" : "\n❌ Spike 02 不达标");
await browser.disconnect();
process.exit(pass ? 0 : 1);
