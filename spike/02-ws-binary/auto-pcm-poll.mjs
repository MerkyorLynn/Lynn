/**
 * Spike 02 — 仅 poll 状态,不操作 page(假定 user 已点 ▶)
 */
import puppeteer from "puppeteer";

const browser = await puppeteer.connect({
  browserURL: "http://localhost:9223",
  protocolTimeout: 60_000,
});
const pages = await browser.pages();
const page = pages.find((p) => p.url().includes(":8002")) || pages[0];

// 检查 button state — 不点击
const initial = await Promise.race([
  page.evaluate(() => ({
    wsStatus: document.getElementById("wsStatus").textContent,
    framesOut: parseInt(document.getElementById("framesOut").textContent) || 0,
    framesIn: parseInt(document.getElementById("framesIn").textContent) || 0,
    rttCount: parseInt(document.getElementById("rttCount").textContent) || 0,
    connectBtnDisabled: document.getElementById("connectBtn").disabled,
  })),
  new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30_000)),
]);
console.log("[poll] initial state:", initial);

if (!initial.connectBtnDisabled) {
  console.log("[poll] connectBtn 没禁用 — user 还没点 ▶,试着替他点");
  await page.evaluate(() => document.getElementById("connectBtn").click());
  await new Promise((r) => setTimeout(r, 3000));
}

const TEST_DURATION_MS = 60_000; // 缩到 1 分钟即可证明 PCM 流通
const startTime = Date.now();
let lastSampleAt = 0;

while (Date.now() - startTime < TEST_DURATION_MS) {
  const stats = await Promise.race([
    page.evaluate(() => ({
      wsStatus: document.getElementById("wsStatus").textContent,
      framesOut: parseInt(document.getElementById("framesOut").textContent) || 0,
      framesIn: parseInt(document.getElementById("framesIn").textContent) || 0,
      kbOut: parseFloat(document.getElementById("kbOut").textContent) || 0,
      kbIn: parseFloat(document.getElementById("kbIn").textContent) || 0,
      seqErrors: parseInt(document.getElementById("seqErrors").textContent) || 0,
      rttCount: parseInt(document.getElementById("rttCount").textContent) || 0,
      rttDist: document.getElementById("rttDist").textContent,
      rttUnder50: document.getElementById("rttUnder50").textContent,
    })),
    new Promise((_, rej) => setTimeout(() => rej(new Error("eval timeout")), 5000)),
  ]).catch((e) => {
    console.warn("[poll] eval err:", e.message);
    return null;
  });
  if (stats) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`[poll] ${elapsed}s | ws=${stats.wsStatus} out/in=${stats.framesOut}/${stats.framesIn} KB=${stats.kbOut}/${stats.kbIn} seq_err=${stats.seqErrors} RTT=${stats.rttUnder50}`);
    lastSampleAt = stats;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}

const final = lastSampleAt;
console.log("\n=== Spike 02 PCM 流 1 分钟 polling 结果 ===");
console.log(JSON.stringify(final, null, 2));

let pass = true;
if (final.framesOut < 400) {
  console.log(`⚠ frames out ${final.framesOut} 低于期望 ~600(60s × 10/s)`);
}
if (Math.abs(final.framesOut - final.framesIn) > 5) {
  console.log(`❌ echo 不对称: out=${final.framesOut} in=${final.framesIn}`);
  pass = false;
}
if (final.seqErrors > 0) {
  console.log(`❌ seq 错乱 ${final.seqErrors}`);
  pass = false;
}
if (final.wsStatus !== "已连接") {
  console.log(`❌ WS 状态: ${final.wsStatus}`);
  pass = false;
}

console.log(pass ? "\n✅ Spike 02 PCM 流通过" : "\n❌ Spike 02 不达标");
await browser.disconnect();
process.exit(pass ? 0 : 1);
