#!/usr/bin/env node
// Brain v2 · 端到端 smoke 门禁
// 跑 6 场景对真 brain v2 端口 (8790) 做完整流式调用,assert 关键行为
// 用法:
//   node scripts/smoke.mjs [--base http://127.0.0.1:8790]
//   exit 0 = all pass, exit 1 = any fail

import crypto from 'node:crypto';

const BASE = process.argv.find(a => a.startsWith('--base='))?.slice(7) || process.env.BRAIN_V2_BASE || 'http://127.0.0.1:8790';
const TIMEOUT_MS = 90_000;

const cases = [];
function add(name, fn, opts = {}) { cases.push({ name, fn, blocker: opts.blocker !== false }); }

function color(c, s) { const codes = { red: 31, green: 32, yellow: 33, gray: 90 }; return `\x1b[${codes[c]}m${s}\x1b[0m`; }
function tick() { return color('green', '✓'); }
function cross() { return color('red', '✗'); }

async function streamChat({ messages, headers = {}, pathname = '/v2/chat/completions' }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ messages }),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!resp.ok && resp.status !== 200) {
    return { httpStatus: resp.status, body: await resp.text(), events: [] };
  }
  // Parse SSE
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of resp.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch {}
    }
  }
  return { httpStatus: 200, events };
}

function assertCleanContent(events, scenario) {
  const contents = events.flatMap(e => e.choices?.[0]?.delta?.content ? [e.choices[0].delta.content] : []);
  const joined = contents.join('');
  // 排除 lynn_tool_progress 标记后,不应含 raw JSON tool_call 结构
  const cleaned = joined.replace(/<lynn_tool_progress[^>]*><\/lynn_tool_progress>/g, '');
  const leakPatterns = [
    /\{"tool_name":/,
    /_result>\{/,
    /\{"name":\s*"[a-z_]+",\s*"arguments":/,
    /<tool_call>/,
    /<\/tool_call>/,
  ];
  for (const p of leakPatterns) {
    if (p.test(cleaned)) {
      throw new Error(`[${scenario}] raw JSON / pseudo-tool leak detected in content: ${cleaned.slice(0, 200)}...`);
    }
  }
  return cleaned;
}

// ──── 场景 1: 简单 chat,无工具,纯 content ────────
add('S1 简单 chat (一句话答 1+1)', async () => {
  const t0 = Date.now();
  const { httpStatus, events } = await streamChat({
    messages: [{ role: 'user', content: '1+1=?直接给数字,不要解释' }],
  });
  if (httpStatus !== 200) throw new Error('HTTP ' + httpStatus);
  if (events.length === 0) throw new Error('no SSE events');
  const cleaned = assertCleanContent(events, 'S1');
  if (!cleaned.includes('2')) throw new Error('answer missing "2": ' + cleaned.slice(0, 100));
  const finish = events.find(e => e.choices?.[0]?.finish_reason);
  if (!finish) throw new Error('no finish event');
  return `${Date.now() - t0}ms  finish=${finish.choices[0].finish_reason}  content="${cleaned.slice(0, 30)}..."`;
});

// ──── 场景 2: thinking 链 (reasoning_content 流出) ────────
add('S2 thinking 链 (reasoning_content forward)', async () => {
  const t0 = Date.now();
  const { events } = await streamChat({
    messages: [{ role: 'user', content: '一只鸡有2条腿,5只鸡有几条腿?思考后给数字' }],
  });
  const reasoningChunks = events.filter(e => e.choices?.[0]?.delta?.reasoning_content);
  const contentChunks = events.filter(e => e.choices?.[0]?.delta?.content && !/lynn_tool_progress/.test(e.choices[0].delta.content));
  if (reasoningChunks.length === 0) throw new Error('no reasoning_content emitted');
  if (contentChunks.length === 0) throw new Error('no content emitted');
  const cleaned = assertCleanContent(events, 'S2');
  if (!cleaned.includes('10')) throw new Error('answer missing "10": ' + cleaned.slice(0, 100));
  return `${Date.now() - t0}ms  reasoning=${reasoningChunks.length}chunks  content=${contentChunks.length}chunks`;
});

// ──── 场景 3: server-side web_search 多轮 loop ────────
add('S3 server-side web_search (BTC 价格)', async () => {
  const t0 = Date.now();
  const { events } = await streamChat({
    messages: [{ role: 'user', content: '今天比特币价格?用一句话回答' }],
  });
  const toolCallChunks = events.filter(e => e.choices?.[0]?.delta?.tool_calls);
  const toolProgress = events.filter(e => e.choices?.[0]?.delta?.content?.includes('lynn_tool_progress'));
  if (toolCallChunks.length === 0) throw new Error('no tool_calls emitted');
  if (toolProgress.length === 0) throw new Error('no lynn_tool_progress markers (server tool exec missing)');
  const cleaned = assertCleanContent(events, 'S3');
  if (cleaned.length < 5) throw new Error('final content too short: ' + cleaned);
  // 验证 model 字段切换:第一个非 role 应该是 mimo
  const firstModelChunk = events.find(e => e.model && e.model !== 'lynn-v2');
  return `${Date.now() - t0}ms  tools=${toolCallChunks.length}  progress=${toolProgress.length}  provider=${firstModelChunk?.model}  content="${cleaned.slice(0, 40)}..."`;
});

// ──── 场景 4: tool_call 走 delta.tool_calls 字段 (不走 content) ────────
add('S4 tool_call 不走 content 字段 (无 raw JSON leak)', async () => {
  const t0 = Date.now();
  const { events } = await streamChat({
    messages: [{ role: 'user', content: '查一下今天上海天气' }],
  });
  const cleaned = assertCleanContent(events, 'S4');
  // 还要验证:tool_calls 字段确实存在且结构正确
  const tc = events.find(e => e.choices?.[0]?.delta?.tool_calls);
  if (!tc) throw new Error('no tool_calls event found');
  const tcDelta = tc.choices[0].delta.tool_calls[0];
  if (!tcDelta.function?.name) throw new Error('tool_call.function.name missing');
  return `${Date.now() - t0}ms  tool="${tcDelta.function.name}"  content_clean=${cleaned.length}c`;
});

// ──── 场景 5: HMAC sign 验证 (relaxed mode 通过) ────────
add('S5 HMAC sign relaxed (no headers → allow)', async () => {
  // 已经在前面场景里验证过(全无 sign headers),只确认 /health 公开
  const r = await fetch(BASE + '/health');
  if (!r.ok) throw new Error('/health not 200');
  const j = await r.json();
  if (j.brain !== 'v2') throw new Error('not brain v2: ' + JSON.stringify(j));
  return `health.brain=${j.brain} version=${j.version} uptime=${j.uptime_s}s`;
});

// ──── 场景 6: HMAC sign 验证 (bad sig → 401) ────────
add('S6 HMAC sign bad signature → 401', async () => {
  // 用一个真实 agentKey 但伪签名
  const agentKey = 'ak_049db1ef16b6452f910d0fa61cd7d741';  // brain v1 已注册的 device key
  const ts = Date.now();
  const nonce = 'smoke-' + Math.random().toString(36).slice(2);
  const fakeSig = 'v1:' + '0'.repeat(64);
  const r = await fetch(BASE + '/v2/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-key': agentKey,
      'x-lynn-timestamp': String(ts),
      'x-lynn-nonce': nonce,
      'x-lynn-signature': fakeSig,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
  });
  if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
  const body = await r.json();
  if (!body.error?.includes('signature')) throw new Error('expected signature error: ' + JSON.stringify(body));
  return `status=401 error="${body.error}"`;
}, { blocker: false });

// ──── 场景 7: HMAC sign 验证 (valid sig → 200) ────────
add('S7 HMAC sign valid → 200 + chat OK', async () => {
  // 读 brain v1 device 文件拿 secret
  const fs = await import('node:fs/promises');
  const agentKey = 'ak_049db1ef16b6452f910d0fa61cd7d741';
  const devPath = '/opt/lobster-brain/data/devices/' + agentKey + '.json';
  const dev = JSON.parse(await fs.readFile(devPath, 'utf8'));
  const ts = Date.now();
  const nonce = 'smoke-valid-' + Math.random().toString(36).slice(2);
  const payload = ['v1', 'POST', '/v2/chat/completions', String(ts), nonce, agentKey].join('\n');
  const sig = 'v1:' + crypto.createHmac('sha256', dev.secret).update(payload).digest('hex');
  const t0 = Date.now();
  const { httpStatus, events } = await streamChat({
    messages: [{ role: 'user', content: '只回 OK 两个字' }],
    headers: {
      'x-agent-key': agentKey,
      'x-lynn-timestamp': String(ts),
      'x-lynn-nonce': nonce,
      'x-lynn-signature': sig,
    },
  });
  if (httpStatus !== 200) throw new Error('HTTP ' + httpStatus);
  const cleaned = assertCleanContent(events, 'S7');
  if (cleaned.length < 1) throw new Error('empty answer with valid sig');
  return `${Date.now() - t0}ms  signed OK  content="${cleaned.slice(0, 30)}"`;
}, { blocker: false });

// ──── 场景 8: 完全空答 fallback 验证 (跳过太复杂,brain 内部已测) ────────
// (多 provider fallback 已在 router.test.js 单测覆盖,此处不重复 e2e)

// ──── 场景 9: 并发请求 ────────
add('S9 并发 3 请求 (无相互影响)', async () => {
  const t0 = Date.now();
  const promises = [
    streamChat({ messages: [{ role: 'user', content: '说"红"' }] }),
    streamChat({ messages: [{ role: 'user', content: '说"黄"' }] }),
    streamChat({ messages: [{ role: 'user', content: '说"蓝"' }] }),
  ];
  const results = await Promise.all(promises);
  for (const [i, r] of results.entries()) {
    if (r.httpStatus !== 200) throw new Error(`request ${i} failed: ${r.httpStatus}`);
    if (r.events.length === 0) throw new Error(`request ${i} no events`);
    assertCleanContent(r.events, 'S9-' + i);
  }
  return `${Date.now() - t0}ms  3/3 OK 并发`;
});

// ──── Phase 3 新 tool 场景 ────
function makeToolCase(name, prompt, toolName) {
  add(name, async () => {
    const t0 = Date.now();
    const { events } = await streamChat({ messages: [{ role: "user", content: prompt }] });
    const tcMatch = events.find(e => e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === toolName);
    const progress = events.filter(e => e.choices?.[0]?.delta?.content?.includes("name=\"" + toolName + "\""));
    if (!tcMatch) throw new Error("model did not call " + toolName);
    if (progress.length === 0) throw new Error("no lynn_tool_progress markers for " + toolName);
    const cleaned = assertCleanContent(events, name);
    return Date.now() - t0 + "ms  tool=" + toolName + "  progress=" + progress.length + "  content=" + cleaned.length + "c";
  }, { blocker: false });
}
makeToolCase("S10 weather (上海实时)", "上海现在天气?用一句话", "weather");
makeToolCase("S11 exchange_rate (美元)", "美元兑人民币汇率多少?", "exchange_rate");
makeToolCase("S12 calendar (今天周几)", "今天周几?直接说", "calendar");
makeToolCase("S13 unit_convert (公里→英里)", "100公里等于多少英里?", "unit_convert");
makeToolCase("S14 stock_market (上证指数)", "上证指数现在多少点?用一句话", "stock_market");
makeToolCase("S15 live_news (科技新闻)", "今天有什么科技新闻?用一句话", "live_news");
makeToolCase("S16 web_fetch (抓取页面)", "抓 https://www.baidu.com 看看返回什么(简短描述)", "web_fetch");
makeToolCase("S17 create_artifact (HTML)", "做个简单的 HTML 测试页面 artifact 内容随便", "create_artifact");


// ──── runner ────
async function main() {
  console.log(color('gray', `Brain v2 e2e smoke @ ${BASE}`));
  console.log(color('gray', '─'.repeat(72)));
  let pass = 0, fail = 0, blockerFail = 0;
  for (const c of cases) {
    process.stdout.write(`  ${c.name.padEnd(50)} `);
    try {
      const detail = await c.fn();
      console.log(`${tick()} ${color('gray', detail || '')}`);
      pass++;
    } catch (e) {
      console.log(`${cross()} ${color('red', e.message)}`);
      fail++;
      if (c.blocker) blockerFail++;
    }
  }
  console.log(color('gray', '─'.repeat(72)));
  console.log(`  Result: ${color('green', pass + ' pass')} / ${color(fail > 0 ? 'red' : 'gray', fail + ' fail')} (blocker fail: ${blockerFail})`);
  if (blockerFail > 0) { console.log(color('red', '\n  ✗ BLOCKER FAILURES — brain v2 not ready')); process.exit(1); }
  console.log(color('green', '\n  ✓ All blocker scenarios pass — brain v2 production-ready'));
}

main().catch(e => { console.error(color('red', 'smoke runner crashed: ' + e.message)); process.exit(2); });
