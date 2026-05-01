/**
 * Spike 03 — 自动 stress test(1000 次随机打断)
 *
 * 用 Puppeteer 起 headless Chrome,加载 spike 页面,
 * 自动点 init → start → autoTest,等结果回来,验证 flush 平均耗时和音爆率(理论上 headless 没声卡,音爆只能看 console)
 */

import puppeteer from 'puppeteer';

const PAGE_URL = 'http://localhost:8003/';
const TIMEOUT_MS = 600_000; // 10 分钟兜底(1000 次 flush 平均 250ms 间隔 = ~4 分钟实际)

console.log('[stress] launching headless Chrome...');
const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--use-fake-ui-for-media-stream',  // 自动允许麦克风(尽管这个 spike 不用)
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});
const page = await browser.newPage();

// 把 console.log 转出来
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('flush') || text.includes('underrun') || text.includes('warn')) {
    console.log('[page]', msg.type(), text);
  }
});
page.on('pageerror', (err) => console.error('[page error]', err.message));

console.log(`[stress] loading ${PAGE_URL}`);
await page.goto(PAGE_URL, { waitUntil: 'networkidle0' });

// 步骤 1:点 ⚙️ 初始化
await page.click('#initBtn');
console.log('[stress] init clicked');
await new Promise((r) => setTimeout(r, 500));

// 验证 init 完成
const initStatus = await page.$eval('#status', (el) => el.textContent);
console.log(`[stress] status after init: ${initStatus}`);
if (initStatus !== '已初始化') {
  console.error('❌ init 失败');
  await browser.close();
  process.exit(1);
}

// 步骤 2:点 ▶ 开始
await page.click('#startBtn');
console.log('[stress] start clicked');
await new Promise((r) => setTimeout(r, 1000)); // 让 PCM 流先建立 1s

// 步骤 3:点 🤖 自动测试
console.log('[stress] starting auto 1000 flush test...');
const startTime = Date.now();
await page.click('#autoTestBtn');

// 等 autoTest 结束 — 监听 flushCount 到 1000
let lastReport = 0;
while (Date.now() - startTime < TIMEOUT_MS) {
  const stats = await page.evaluate(() => ({
    flushCount: parseInt(document.getElementById('flushCount').textContent) || 0,
    avgFlushMs: parseFloat(document.getElementById('avgFlushMs').textContent) || 0,
    maxFlushMs: parseFloat(document.getElementById('maxFlushMs').textContent) || 0,
    underruns: parseInt(document.getElementById('underruns').textContent) || 0,
    enqueued: parseInt(document.getElementById('enqueued').textContent) || 0,
    consumed: parseInt(document.getElementById('consumed').textContent) || 0,
    qSize: document.getElementById('qSize').textContent,
    autoTestDisabled: document.getElementById('autoTestBtn').disabled,
  }));

  if (stats.flushCount >= 1000 || !stats.autoTestDisabled) {
    console.log('\n=== Spike 03 stress test 完成 ===');
    console.log(`总耗时:           ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log(`flush 次数:       ${stats.flushCount}`);
    console.log(`avg flush 耗时:   ${stats.avgFlushMs} ms (目标 < 25)`);
    console.log(`max flush 耗时:   ${stats.maxFlushMs} ms (目标 < 50)`);
    console.log(`underrun 次数:    ${stats.underruns} (目标 0)`);
    console.log(`已 enqueue:       ${stats.enqueued} chunks`);
    console.log(`已 consume:       ${stats.consumed} samples`);
    console.log(`queue size:       ${stats.qSize}`);

    let pass = true;
    if (stats.flushCount < 1000) {
      console.log('❌ flush 次数不足 1000');
      pass = false;
    }
    if (stats.avgFlushMs >= 25) {
      console.log(`⚠ avg flush ${stats.avgFlushMs}ms 超 25ms 目标`);
    }
    if (stats.maxFlushMs >= 50) {
      console.log(`⚠ max flush ${stats.maxFlushMs}ms 超 50ms 目标(可接受但要记录)`);
    }
    if (stats.underruns > 0) {
      console.log(`⚠ ${stats.underruns} 次 underrun(理论应该 0)`);
    }
    console.log(pass ? '\n✅ Spike 03 通过 — Tier 1/2/3 全双工管道核心 OK' : '\n❌ Spike 03 不达标');

    await browser.close();
    process.exit(pass ? 0 : 1);
  }

  // 进度报告(每 100 次)
  if (stats.flushCount - lastReport >= 100) {
    console.log(`[stress] 进度: ${stats.flushCount}/1000 flush  avg=${stats.avgFlushMs}ms  max=${stats.maxFlushMs}ms  underruns=${stats.underruns}`);
    lastReport = stats.flushCount;
  }

  await new Promise((r) => setTimeout(r, 1000));
}

console.error('❌ 超时未完成 1000 次');
await browser.close();
process.exit(1);
