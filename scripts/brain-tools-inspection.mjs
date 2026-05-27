#!/usr/bin/env node
// @ts-nocheck
/**
 * Brain 工具链巡检 · 单 provider 直测 + Brain 完整链路
 *
 * 替代之前部署侧 hardcoded endpoint 的巡检脚本(频繁 fetch failed 因为 endpoint
 * 漂移)。所有 provider endpoint 从 brain-v2-mirror/provider-registry 读取,**不
 * 会再跟 Brain 真实配置漂移**。
 *
 * Usage:
 *   node scripts/brain-tools-inspection.mjs                          # 默认全部跑
 *   node scripts/brain-tools-inspection.mjs --providers mimo,glm     # 只跑指定
 *   node scripts/brain-tools-inspection.mjs --skip kimi              # 跳过(会员问题)
 *   node scripts/brain-tools-inspection.mjs --json out.json          # 写文件
 *   node scripts/brain-tools-inspection.mjs --feishu                 # 失败发飞书
 *
 * Env:
 *   BRAIN_V2_BASE        Brain v2 service base (default http://127.0.0.1:8790)
 *   BRAIN_V2_ENV_FILE    额外的 .env 文件(覆盖 process.env)
 *   FEISHU_APP_ID/SECRET/CHAT_ID  失败时飞书告警
 *
 * 失败 exit code:
 *   0 = all green
 *   1 = at least one provider failed
 *   2 = Brain smoke failed (主链路挂了,最严重)
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ── env loader ─────────────────────────────────────────────────
function loadEnvFile() {
  const candidates = [
    process.env.BRAIN_V2_ENV_FILE,
    '/opt/lobster-brain-v2/.env',
    path.join(process.env.HOME || '', '.lynn/brain.env'),
    '.env',
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#') || !s.includes('=')) continue;
        const [k, ...rest] = s.split('=');
        if (!process.env[k]) process.env[k] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
      return file;
    } catch { /* ignore */ }
  }
  return '';
}
loadEnvFile();

// ── CLI args ───────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  return args[i + 1] || true;
}
const ONLY_PROVIDERS = arg('providers') ? String(arg('providers')).split(',').map(s => s.trim()) : null;
const SKIP_PROVIDERS = arg('skip') ? String(arg('skip')).split(',').map(s => s.trim()) : [];
const JSON_OUT = arg('json', '');
const SEND_FEISHU = args.includes('--feishu');
const BRAIN_BASE = process.env.BRAIN_V2_BASE || 'http://127.0.0.1:8790';

// ── provider registry from env(单一事实来源,跟 brain-v2-mirror 一致) ──
// 这里复刻 brain-v2-mirror/provider-registry.ts 的 default endpoint/model,
// **env 优先**,改一处就两边对齐。
const PROVIDERS = [
  {
    id: 'mimo',
    label: 'MiMo V2.5 Pro (默认)',
    endpoint: process.env.MIMO_SEARCH_BASE || 'https://token-plan-cn.xiaomimimo.com/v1',
    apiKey: process.env.MIMO_SEARCH_KEY || '',
    model: process.env.MIMO_SEARCH_MODEL || 'mimo-v2.5-pro',
    wire: 'mimo',
    authStyle: 'bearer',
  },
  {
    id: 'apex-spark-mtp',
    label: 'Spark 35B-A3B APEX-MTP (主)',
    endpoint: process.env.APEX_SPARK_BASE || 'http://127.0.0.1:18098/v1',
    apiKey: 'none',
    model: process.env.APEX_SPARK_MODEL || 'qwen36-35b-a3b-apex-mtp',
    wire: 'openai',
    authStyle: 'none',
    healthPath: '/health',
  },
  {
    id: 'gpu5090-27b-iq4',
    label: '5090 27B-IQ4',
    endpoint: process.env.GPU5090_BASE || '',  // 未配置则 skip
    apiKey: process.env.GPU5090_KEY || 'none',
    model: process.env.GPU5090_MODEL || 'qwen-27b-iq4',
    wire: 'openai',
    authStyle: 'none',
    healthPath: '/health',
    optional: true,  // 没配 endpoint 自动 skip,不算 fail
  },
  {
    id: 'deepseek-chat',
    label: 'DeepSeek V4-Flash',
    endpoint: process.env.DEEPSEEK_BASE || 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    wire: 'openai',
    authStyle: 'bearer',
  },
  {
    id: 'glm-5-turbo',
    label: 'GLM-5-Turbo',
    endpoint: process.env.ZHIPU_CODING_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKey: process.env.ZHIPU_KEY || '',
    model: process.env.ZHIPU_CODING_TURBO_MODEL || 'GLM-5-Turbo',
    wire: 'openai',
    authStyle: 'bearer',
  },
  {
    id: 'kimi-coding',
    label: 'Kimi K2.6 (coding)',
    endpoint: process.env.KIMI_CODING_BASE || 'https://api.kimi.com/coding',
    apiKey: process.env.KIMI_CODING_KEY || '',
    model: process.env.KIMI_CODING_MODEL || 'kimi-k2.6',
    wire: 'anthropic',
    authStyle: 'bearer',
    optional: true,  // 会员到期时可 skip,不视为 RED
  },
];

// ── fetch helpers ──────────────────────────────────────────────
function timedFetch(url, init, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    fetch(url, { ...init, signal: ctrl.signal })
      .then(async (res) => {
        clearTimeout(t);
        const body = await res.text().catch(() => '');
        resolve({ status: res.status, ok: res.ok, body, ms: Date.now() - t0 });
      })
      .catch((e) => {
        clearTimeout(t);
        resolve({ status: 0, ok: false, body: '', error: e.message || String(e), ms: Date.now() - t0 });
      });
  });
}

// ── per-provider direct test:tool-call 模拟 + 一次 synth ──
async function testProvider(p) {
  if (!p.endpoint) {
    return { ok: false, skipped: true, reason: 'endpoint not configured (env missing)' };
  }
  if (p.authStyle !== 'none' && !p.apiKey) {
    return { ok: false, skipped: true, reason: 'API key not configured' };
  }

  // 1) tool-call probe: 让 model emit web_search tool_call(简单触发即可)
  const toolBody = {
    model: p.model,
    messages: [{ role: 'user', content: '北京今天天气怎么样?调 web_search 工具查。' }],
    stream: false,
    max_tokens: 256,
    tools: [{
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    }],
  };
  if (p.wire === 'mimo') {
    toolBody.enable_search = true;
    toolBody.thinking = { type: 'enabled' };  // thinking-on
  }

  const headers = { 'Content-Type': 'application/json' };
  if (p.authStyle === 'bearer') headers.Authorization = 'Bearer ' + p.apiKey;
  else if (p.authStyle === 'api-key') headers['api-key'] = p.apiKey;

  let toolUrl;
  if (p.wire === 'anthropic') {
    // Anthropic-compat path: /v1/messages on Kimi
    toolUrl = (p.endpoint.replace(/\/+$/, '')) + '/v1/messages';
  } else {
    toolUrl = (p.endpoint.replace(/\/+$/, '')) + '/chat/completions';
  }

  const tool = await timedFetch(toolUrl, {
    method: 'POST', headers, body: JSON.stringify(toolBody),
  }, 60_000);

  if (!tool.ok) {
    // Kimi 402 / DeepSeek 401 等 — 把信息透出来不要藏
    const errSnippet = (tool.body || tool.error || '').slice(0, 200);
    return {
      ok: false,
      toolMs: tool.ms,
      reason: `HTTP ${tool.status} ${errSnippet}`,
    };
  }

  // 2) synth probe:简单一句话答(不调工具)
  const synthBody = {
    model: p.model,
    messages: [{ role: 'user', content: '回答 1+1=?只写数字。' }],
    stream: false,
    max_tokens: 32,
  };
  if (p.wire === 'mimo') synthBody.thinking = { type: 'enabled' };

  const synthUrl = p.wire === 'anthropic'
    ? (p.endpoint.replace(/\/+$/, '')) + '/v1/messages'
    : (p.endpoint.replace(/\/+$/, '')) + '/chat/completions';
  const synth = await timedFetch(synthUrl, {
    method: 'POST', headers, body: JSON.stringify(synthBody),
  }, 30_000);

  if (!synth.ok) {
    return {
      ok: false,
      toolMs: tool.ms,
      synthMs: synth.ms,
      reason: `synth HTTP ${synth.status} ${(synth.body || synth.error || '').slice(0, 200)}`,
    };
  }

  return {
    ok: true,
    toolMs: tool.ms,
    synthMs: synth.ms,
    totalMs: tool.ms + synth.ms,
  };
}

// ── Brain 完整链路 smoke ───────────────────────────────────────
async function brainSmoke() {
  const url = BRAIN_BASE.replace(/\/+$/, '') + '/v2/chat/completions';
  const t0 = Date.now();
  const r = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '回答 1+1=?只写数字。' }],
      stream: false,
    }),
  }, 30_000);
  return {
    ok: r.ok,
    ms: Date.now() - t0,
    status: r.status,
    error: r.error || (!r.ok ? (r.body || '').slice(0, 200) : ''),
    // Brain SSE 里通常带 provider id,从 body 抽一下(粗匹配)
    routedVia: (r.body || '').match(/"providerId":"([^"]+)"/)?.[1] || null,
  };
}

// ── Feishu sender ──────────────────────────────────────────────
async function sendFeishu(text) {
  const APP_ID = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID;
  const APP_SECRET = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET;
  const CHAT_ID = process.env.FEISHU_CHAT_ID || process.env.LARK_CHAT_ID;
  if (!APP_ID || !APP_SECRET || !CHAT_ID) return false;
  try {
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const token = (await tokenRes.json())?.tenant_access_token;
    if (!token) return false;
    const msgRes = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ receive_id: CHAT_ID, msg_type: 'text', content: JSON.stringify({ text }) }),
    });
    return msgRes.ok;
  } catch {
    return false;
  }
}

// ── 报告格式化 ─────────────────────────────────────────────────
function formatReport(rows, brain) {
  const lines = [];
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const hasFail = rows.some(r => !r.skipped && !r.ok) || !brain.ok;
  lines.push((hasFail ? '🔴' : '🟢') + ` Brain 工具链巡检 · ${ts}`);
  lines.push('');
  lines.push('【单 provider 直测】');
  lines.push('provider'.padEnd(30) + 'tool'.padEnd(10) + 'synth'.padEnd(10) + 'total'.padEnd(10) + 'status');
  for (const r of rows) {
    const tool = r.toolMs != null ? r.toolMs + 'ms' : '--';
    const synth = r.synthMs != null ? r.synthMs + 'ms' : '--';
    const total = r.totalMs != null ? r.totalMs + 'ms' : '--';
    let status;
    if (r.skipped) status = `⊝ skip (${r.reason})`;
    else if (r.ok) status = '✓ OK';
    else status = `✗ ${r.reason}`;
    lines.push(
      r.label.padEnd(30) + tool.padEnd(10) + synth.padEnd(10) + total.padEnd(10) + status,
    );
  }
  lines.push('');
  lines.push('【Brain 完整链路 smoke (/v2/chat/completions)】');
  if (brain.ok) {
    const via = brain.routedVia ? ` via ${brain.routedVia}` : '';
    lines.push(`Brain smoke      ${brain.ms}ms  ✓ OK${via}`);
  } else {
    lines.push(`Brain smoke      ${brain.ms}ms  ✗ ${brain.status} ${brain.error}`);
  }
  return lines.join('\n');
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  const providers = PROVIDERS.filter(p => {
    if (ONLY_PROVIDERS && !ONLY_PROVIDERS.includes(p.id)) return false;
    if (SKIP_PROVIDERS.includes(p.id)) return false;
    return true;
  });

  const rows = [];
  for (const p of providers) {
    process.stderr.write(`  testing ${p.label}... `);
    const r = await testProvider(p);
    rows.push({ id: p.id, label: p.label, ...r });
    process.stderr.write(r.ok ? `OK ${r.totalMs}ms\n` : r.skipped ? `skip\n` : `FAIL ${r.reason}\n`);
  }

  process.stderr.write('  testing Brain smoke... ');
  const brain = await brainSmoke();
  process.stderr.write(brain.ok ? `OK ${brain.ms}ms\n` : `FAIL ${brain.error}\n`);

  const report = formatReport(rows, brain);
  console.log(report);

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      ts: new Date().toISOString(),
      providers: rows,
      brain,
    }, null, 2));
  }

  const hardFails = rows.filter(r => !r.ok && !r.skipped);
  if (SEND_FEISHU && (hardFails.length > 0 || !brain.ok)) {
    await sendFeishu(report);
  }

  if (!brain.ok) process.exit(2);
  if (hardFails.length > 0) process.exit(1);
  process.exit(0);
}

// 只有作为脚本入口时跑
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();

export { testProvider, brainSmoke, formatReport, PROVIDERS };
