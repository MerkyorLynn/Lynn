// Brain v2 · Tool-result verifier middleware (v1)
// 单条 trajectory 评分(C1/C2/C3),fail-open,log-only(不直接 retry/fallback)。
// 复用 brain v2 既有 provider-registry + wire-adapter,不新建 provider。
// Deploy target: /opt/lobster-brain-v2/verifier-middleware.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildVerifierPrompt, parseVerifierResponse } from './verifier-prompts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const whitelist = JSON.parse(
  readFileSync(join(__dirname, 'verifier-whitelist.json'), 'utf-8')
);

const PASS_THRESHOLD = parseFloat(process.env.VERIFIER_PASS_THRESHOLD || '4');
const MAX_DIMENSION_PASS = Number(process.env.VERIFIER_MAX_DIMENSION_PASS || 5);
const TIMEOUT_MS = Number(process.env.VERIFIER_TIMEOUT_MS || 5000);
const VERIFIER_PROVIDER = process.env.VERIFIER_PROVIDER || 'deepseek-chat';
// Disable thinking for verifier — JSON output is short, no reasoning needed.
// DeepSeek accepts {thinking: {type: 'disabled'}}; harmless on non-thinking providers.
const VERIFIER_EXTRA_BODY = {
  thinking: { type: 'disabled' },
  temperature: 0,
  top_p: 0.1,
  max_tokens: 256,
};

let _providerCache = null;
async function getVerifierProvider() {
  if (_providerCache) return _providerCache;
  const { getProvider } = await import('./provider-registry.js');
  const { getAdapter } = await import('./wire-adapter/index.js');
  const provider = getProvider(VERIFIER_PROVIDER);
  if (!provider) throw new Error(`verifier provider not found: ${VERIFIER_PROVIDER}`);
  const adapter = getAdapter(provider.wire);
  _providerCache = { provider, adapter };
  return _providerCache;
}

async function callVerifierLLM(prompt, signal) {
  const { provider, adapter } = await getVerifierProvider();
  let text = '';
  for await (const chunk of adapter({
    provider,
    messages: [{ role: 'user', content: prompt }],
    tools: null,
    signal,
    log: null,
    extraBody: VERIFIER_EXTRA_BODY,
  })) {
    if (chunk.type === 'content') text += chunk.delta;
  }
  return text;
}

export async function verifyToolResult({ userPrompt, toolName, toolResult, log = null }) {
  if (process.env.VERIFIER_ENABLED !== '1') {
    return { skipped: true, pass: true, reason: 'disabled' };
  }
  if (!whitelist.tools.includes(toolName)) {
    return { skipped: true, pass: true, reason: 'not-in-whitelist' };
  }
  const minLen = whitelist.min_result_chars?.[toolName];
  const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
  if (minLen && resultStr.length < minLen) {
    return { skipped: true, pass: true, reason: 'below-min-length' };
  }

  const prompt = buildVerifierPrompt({
    userPrompt: String(userPrompt || '').slice(0, 2000),
    toolName,
    toolResult: resultStr,
  });
  const t0 = Date.now();

  let scores;
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let raw;
    try {
      raw = await callVerifierLLM(prompt, ctrl.signal);
    } finally {
      clearTimeout(timeoutId);
    }
    scores = parseVerifierResponse(raw);
    if (!scores) {
      log && log('warn', `[verifier] ${toolName}: parse failed, raw="${String(raw).slice(0, 200)}"`);
      return {
        skipped: false,
        pass: true,
        parseFailed: true,
        failOpen: true,
        latencyMs: Date.now() - t0,
      };
    }
  } catch (err) {
    log && log('warn', `[verifier] ${toolName}: ${err.message}, fail-open`);
    return {
      skipped: false,
      pass: true,
      error: err.message,
      failOpen: true,
      latencyMs: Date.now() - t0,
    };
  }

  const avg = (scores.C1 + scores.C2 + scores.C3) / 3;
  const maxDimension = Math.max(scores.C1, scores.C2, scores.C3);
  const pass = avg <= PASS_THRESHOLD && maxDimension <= MAX_DIMENSION_PASS;

  return {
    skipped: false,
    pass,
    scores,
    avg,
    maxDimension,
    latencyMs: Date.now() - t0,
    action: pass ? 'continue' : 'log-only-v1',
    // v1 只 log,不直接触发 retry/fallback。v2 加 action: 'retry-with-tighter-query' / 'fallback-secondary' / 'mark-uncertain'
  };
}

export const _internals = { PASS_THRESHOLD, MAX_DIMENSION_PASS, TIMEOUT_MS, VERIFIER_PROVIDER, whitelist };
