#!/usr/bin/env node
// Brain v2 · Pulse healthcheck (高频,5min)
// 检查 /health 200 + brain=v2 + 一个最小 chat round trip
// 失败 → 写 metrics jsonl + 飞书告警(复用 brain v1 webhook)
// 成功 silent
import https from 'node:https';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import { URL } from 'node:url';

const BASE = process.env.BRAIN_V2_BASE || 'http://127.0.0.1:8790';
const METRICS_FILE = process.env.BRAIN_V2_METRICS || '/opt/lobster-brain-v2/data/healthcheck.jsonl';
const PULSE_TIMEOUT = 8_000;

// 飞书 (复用 brain v1 health-check.py 的 chat)
const FEISHU_APP_ID = 'cli_a93aa76026381bd8';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || '';
const FEISHU_CHAT_ID = 'oc_a63c109725f909d85a25135b25a8be6d';

function nowIso() { return new Date().toISOString(); }

async function appendJsonl(line) {
  try {
    const dir = METRICS_FILE.substring(0, METRICS_FILE.lastIndexOf('/'));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(METRICS_FILE, JSON.stringify(line) + '\n');
  } catch (e) { /* swallow: metrics 不能阻塞 */ }
}

async function getFeishuToken() {
  return new Promise((resolve, reject) => {
    const req = https.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body).tenant_access_token); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }));
    req.end();
  });
}

async function sendFeishu(text) {
  try {
    const token = await getFeishuToken();
    return new Promise((resolve) => {
      const req = https.request(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
        (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); }
      );
      req.on('error', () => resolve(0));
      req.write(JSON.stringify({
        receive_id: FEISHU_CHAT_ID,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }));
      req.end();
    });
  } catch (e) { return 0; }
}

function fetchTimeout(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const t = setTimeout(() => { req.destroy(new Error('timeout')); }, opts.timeout || PULSE_TIMEOUT);
    const req = lib.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { clearTimeout(t); resolve({ status: res.statusCode, body }); });
    });
    req.on('error', (e) => { clearTimeout(t); reject(e); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function checkHealth() {
  const t0 = Date.now();
  try {
    const r = await fetchTimeout(BASE + '/health', { timeout: 3_000 });
    const ms = Date.now() - t0;
    if (r.status !== 200) return { ok: false, ms, error: '/health HTTP ' + r.status };
    const j = JSON.parse(r.body);
    if (j.brain !== 'v2') return { ok: false, ms, error: '/health brain != v2: ' + j.brain };
    return { ok: true, ms, version: j.version, uptime_s: j.uptime_s };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: '/health ' + e.message }; }
}

async function checkChat() {
  const t0 = Date.now();
  try {
    const r = await fetchTimeout(BASE + '/v2/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '只回 OK 两字' }] }),
      timeout: PULSE_TIMEOUT,
    });
    const ms = Date.now() - t0;
    if (r.status !== 200) return { ok: false, ms, error: 'chat HTTP ' + r.status };
    if (!r.body.includes('data: ')) return { ok: false, ms, error: 'chat no SSE' };
    if (!r.body.includes('[DONE]')) return { ok: false, ms, error: 'chat no [DONE]' };
    return { ok: true, ms };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: 'chat ' + e.message }; }
}

async function main() {
  const ts = nowIso();
  const health = await checkHealth();
  const chat = await checkChat();
  const ok = health.ok && chat.ok;
  const record = { ts, kind: 'pulse', ok, health, chat };
  await appendJsonl(record);
  if (ok) {
    process.exit(0);
  } else {
    const issues = [];
    if (!health.ok) issues.push('health: ' + health.error);
    if (!chat.ok) issues.push('chat: ' + chat.error + ' (' + chat.ms + 'ms)');
    const text = '🔴 brain v2 pulse FAIL @ ' + BASE + '\n' + issues.join('\n') + '\n时间: ' + ts;
    await sendFeishu(text);
    console.error('FAIL:', issues.join(' | '));
    process.exit(1);
  }
}
main();
