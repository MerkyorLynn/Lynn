#!/usr/bin/env node
// Brain v2 · 简化巡检 smoke (低频,2h)
// 4 个核心场景:simple chat / web_search / weather / HMAC bad sig
// 失败 → 飞书 + 写 jsonl,成功 silent
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

function loadEnvFile() {
  for (const file of [process.env.BRAIN_V2_ENV_FILE, '/opt/lobster-brain-v2/.env', '.env'].filter(Boolean)) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#') || !s.includes('=')) continue;
        const [key, ...rest] = s.split('=');
        if (!process.env[key]) process.env[key] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
      return file;
    } catch (_) {}
  }
  return '';
}

loadEnvFile();

const BASE = process.env.BRAIN_V2_BASE || 'http://127.0.0.1:8790';
const METRICS_FILE = process.env.BRAIN_V2_METRICS || '/opt/lobster-brain-v2/data/cron-smoke.jsonl';

// Secrets must be supplied by deployment env; never commit app secrets.
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || '';
const FEISHU_CHAT_ID = process.env.FEISHU_CHAT_ID || process.env.LARK_CHAT_ID || '';

function nowIso() { return new Date().toISOString(); }

async function appendJsonl(line) {
  try {
    const dir = METRICS_FILE.substring(0, METRICS_FILE.lastIndexOf('/'));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(METRICS_FILE, JSON.stringify(line) + '\n');
  } catch (e) {}
}

async function sendFeishu(text) {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_CHAT_ID) return 0;
  try {
    const tokenResp = await new Promise((resolve, reject) => {
      const req = https.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body).tenant_access_token); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }));
      req.end();
    });
    return new Promise((resolve) => {
      const req = https.request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenResp },
      }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0));
      req.write(JSON.stringify({ receive_id: FEISHU_CHAT_ID, msg_type: 'text', content: JSON.stringify({ text }) }));
      req.end();
    });
  } catch (e) { return 0; }
}

async function streamChat({ messages, headers = {}, timeout = 60_000 }) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { req.destroy(new Error('timeout')); }, timeout);
    const u = new URL(BASE + '/v2/chat/completions');
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { clearTimeout(t); resolve({ status: res.statusCode, body }); });
    });
    req.on('error', (e) => { clearTimeout(t); resolve({ status: 0, error: e.message }); });
    req.write(JSON.stringify({ messages }));
    req.end();
  });
}

const cases = [];
function add(name, fn) { cases.push({ name, fn }); }

add('simple_chat', async () => {
  const t0 = Date.now();
  const r = await streamChat({ messages: [{ role: 'user', content: '1+1=?直接给数字' }], timeout: 30_000 });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (!r.body.includes('"content":"2"') && !/"content":"[^"]*2[^"]*"/.test(r.body)) throw new Error('answer missing 2');
  return { ms: Date.now() - t0 };
});

add('web_search_multiturn', async () => {
  const t0 = Date.now();
  const r = await streamChat({ messages: [{ role: 'user', content: '今天比特币价格?用一句话' }], timeout: 60_000 });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (!r.body.includes('lynn_tool_progress')) throw new Error('no tool exec markers');
  // 模型有时直接答不调 web_search,只验有 tool exec markers 即可
  return { ms: Date.now() - t0 };
});

add('weather_tool', async () => {
  const t0 = Date.now();
  const r = await streamChat({ messages: [{ role: 'user', content: '上海现在天气?用一句话' }], timeout: 30_000 });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (!r.body.includes('lynn_tool_progress')) throw new Error('no tool exec markers');
  return { ms: Date.now() - t0 };
});

add('hmac_bad_sig_401', async () => {
  const r = await streamChat({
    messages: [{ role: 'user', content: 'x' }],
    headers: {
      'x-agent-key': 'ak_049db1ef16b6452f910d0fa61cd7d741',
      'x-lynn-timestamp': String(Date.now()),
      'x-lynn-nonce': 'cron-' + Math.random().toString(36).slice(2),
      'x-lynn-signature': 'v1:' + '0'.repeat(64),
    },
    timeout: 5_000,
  });
  if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
  return { ms: 0 };
});

async function main() {
  const ts = nowIso();
  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const r = await c.fn();
      results.push({ name: c.name, ok: true, ms: r.ms || (Date.now() - t0) });
    } catch (e) {
      results.push({ name: c.name, ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  const fails = results.filter(r => !r.ok);
  const record = { ts, kind: 'cron-smoke', ok: fails.length === 0, results };
  await appendJsonl(record);

  if (fails.length > 0) {
    const lines = fails.map(f => '  ✗ ' + f.name + ': ' + f.error + ' (' + f.ms + 'ms)');
    const okStr = results.filter(r => r.ok).map(r => r.name + ' ' + r.ms + 'ms').join(' / ');
    const text = '🔴 brain v2 cron-smoke FAIL ' + fails.length + '/' + cases.length + '\n' + lines.join('\n') + '\n通过: ' + okStr + '\n时间: ' + ts;
    await sendFeishu(text);
    console.error('FAIL ' + fails.length + '/' + cases.length, lines.join(' | '));
    process.exit(1);
  }
  console.log('OK ' + cases.length + '/' + cases.length, results.map(r => r.name + ':' + r.ms + 'ms').join(' / '));
  process.exit(0);
}
main();
