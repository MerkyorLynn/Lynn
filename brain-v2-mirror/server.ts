// Brain v2 · HTTP Server
// 端口默认 8790,跟 brain v1 (8789) 共存
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import 'dotenv/config';
import './perf-init.js';
import { run as routerRun, detectCapability } from './router.js';
import { makeSSEEmitter } from './stream-bridge.js';
import { verifySignedRequest, AuthError } from './auth.js';
import { errorMessage, errorName, type ChatMessage, type ToolDefinition } from './types.js';

// H4 fix (2026-05-24): agentKey 是长期 bearer,不能进 INFO 日志 plaintext。
// 用 sha256 头 8 个 hex 做指纹 — 足够区分会话,不可反推。
function _agentFingerprint(key: unknown): string {
  if (!key) return 'anon';
  return 'ak:' + crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8);
}

// [deep-research v1 import]
import { runDeepResearch } from './deep-research.js';
// [web-search proxy v1 import] — server-side keys, client never sees MiMo/Zhipu API keys
import { webSearchStructured } from './tool-exec/web_search.js';
const PORT = Number(process.env.BRAIN_V2_PORT || 8790);
const HOST = process.env.BRAIN_V2_HOST || '127.0.0.1';
const VERSION = '0.0.1';
const CORS_ALLOWED_ORIGIN = process.env.BRAIN_V2_CORS_ORIGIN || '';
type JsonObject = Record<string, unknown>;
type LocalQwen35BridgeModule = typeof import('./local-qwen35-setup.js');
type ErrorWithExtras = Error & { errors?: unknown; code?: string };
let localQwen35BridgePromise: Promise<LocalQwen35BridgeModule> | null = null;

function log(level: string, msg: string): void {
  console.log('[' + new Date().toISOString() + '] [' + level + '] ' + msg);
}

function isLocalRequestAddress(remote: string): boolean {
  return remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1'
    || remote === 'localhost';
}

async function loadLocalQwen35Bridge(): Promise<LocalQwen35BridgeModule> {
  if (!localQwen35BridgePromise) {
    localQwen35BridgePromise = import('./local-qwen35-setup.js').catch((err) => {
      localQwen35BridgePromise = null;
      throw err;
    });
  }
  return localQwen35BridgePromise;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Uint8Array[] = [];
    req.on('data', (c: Uint8Array) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve((body ? JSON.parse(body) : {}) as JsonObject);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  // P1#1: parse body BEFORE writing SSE header → fail-fast 4xx JSON
  let body: JsonObject;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid request body: ' + errorMessage(e) }));
    return;
  }

  // HMAC sign verify (relaxed)
  let device = null;
  try {
    device = await verifySignedRequest(req, { pathname, method: 'POST', log });
  } catch (e) {
    if (e instanceof AuthError) {
      res.writeHead(e.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    log('error', 'auth unexpected: ' + errorMessage(e));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal auth error' }));
    return;
  }

  // P1#2: AbortController + req close → cancel upstream fetch
  const ctrl = new AbortController();
  let clientDisconnected = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      ctrl.abort();
    }
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Brain-Version': VERSION,
  });

  const messages = (body.messages || []) as ChatMessage[];
  // v0.77.7: extra_body 透传 (OpenAI 标准, 客户端可传 thinking:{type:disabled} 关思考)
  const extraBody = (body.extra_body && typeof body.extra_body === "object") ? body.extra_body as JsonObject : null;
  // Lynn ThinkingLevelButton (off/auto/high/xhigh) → Pi SDK reasoning_effort
  const reasoningEffort = (body.reasoning_effort || (extraBody && extraBody.reasoning_effort) || null) as string | null;
  const tools = (body.tools || null) as ToolDefinition[] | null;
  const capabilityRequired = detectCapability(messages);
  const id = 'chatcmpl-v2-' + Date.now();
  const emitter = makeSSEEmitter(res, { id, model: (body.model || 'lynn-v2') as string });

  emitter.emitRole();

  log('info', `[${id}] start agent=${_agentFingerprint(device?.key)} msgs=${messages.length} tools=${tools?.length || 0} cap=${JSON.stringify(capabilityRequired)}`);

  try {
    const result = await routerRun({
      messages, tools, capabilityRequired, extraBody, reasoningEffort,
      signal: ctrl.signal,
      onChunk: async (chunk, meta) => {
        if (clientDisconnected) return;
        emitter.emitChunk(chunk, meta);
      },
      log,
    });
    log('info', `[${id}] done provider=${result.providerId} iter=${result.iterations}` + (result.forwardedToClient ? ' forwarded' : '') + (result.hitMaxIterations ? ' MAX_ITER' : '') + (clientDisconnected ? ' (client_disconnected)' : ''));
  } catch (err) {
    if (clientDisconnected) {
      log('info', `[${id}] aborted (client_disconnect)`);
    } else if (errorName(err) === 'AbortError') {
      log('info', `[${id}] aborted`);
    } else {
      const routeError = err as ErrorWithExtras;
      log('error', `[${id}] route failed: ${errorMessage(err)}`);
      emitter.emitError(errorMessage(err), routeError.errors || null);
    }
  }
  emitter.done();
}

// [deep-research v1 handler]
async function handleDeepResearch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  let body: JsonObject;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid request body: ' + errorMessage(e) }));
    return;
  }

  let device = null;
  try {
    device = await verifySignedRequest(req, { pathname, method: 'POST', log });
  } catch (e) {
    if (e instanceof AuthError) {
      res.writeHead(e.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    log('error', 'auth unexpected: ' + errorMessage(e));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal auth error' }));
    return;
  }

  const ctrl = new AbortController();
  let clientDisconnected = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      ctrl.abort();
    }
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Brain-Version': VERSION,
    'X-Brain-Mode': 'deep-research-v1',
  });

  const messages = (body.messages || []) as ChatMessage[];
  const candidates = Array.isArray(body.candidates) && body.candidates.length > 0 ? body.candidates as string[] : null;
  const id = 'chatcmpl-deep-' + Date.now();
  log('info', `[${id}] deep-research start agent=${_agentFingerprint(device?.key)} msgs=${messages.length} requestedCandidates=${candidates?.length || 'default'}`);

  // Helper to send SSE chunks in OpenAI-compat format
  const sendChunk = (deltaObj: JsonObject, finishReason: string | null = null): void => {
    if (clientDisconnected) return;
    const payload = {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'lynn-deep-research-v1',
      choices: [{ index: 0, delta: deltaObj, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const sendMeta = (meta: JsonObject): void => {
    if (clientDisconnected) return;
    res.write(`data: ${JSON.stringify({ id, object: 'deep-research.meta', meta })}\n\n`);
  };

  sendChunk({ role: 'assistant' });

  try {
    const onProgress = (event: JsonObject): void => {
      sendMeta(event);
    };
    const result = await runDeepResearch({
      messages,
      candidates,
      signal: ctrl.signal,
      log,
      onProgress,
    });

    if (clientDisconnected) {
      log('info', `[${id}] aborted (client_disconnect)`);
      return;
    }

    const winnerContent = result.winner?.content || '';
    // Send the provider that produced the answer as one meta chunk. Even if the
    // provider produced an empty answer, keep it faithful: do not invent a
    // fallback sentence.
    sendMeta({
      event: 'winner-picked',
      winnerProviderId: result.winner?.providerId || null,
      meta: result.meta || {},
    });
    const CHUNK_SIZE = 200;
    for (let i = 0; i < winnerContent.length; i += CHUNK_SIZE) {
      if (clientDisconnected) return;
      sendChunk({ content: winnerContent.slice(i, i + CHUNK_SIZE) });
    }
    sendChunk({}, 'stop');
    log('info', `[${id}] done winner=${result.winner?.providerId || 'none'} contentLen=${winnerContent.length} totalMs=${result.meta?.totalMs}`);
  } catch (err) {
    if (!clientDisconnected) {
      log('error', `[${id}] deep-research failed: ${errorMessage(err)}`);
      res.write(`data: ${JSON.stringify({ id, error: errorMessage(err) })}\n\n`);
    }
  }

  if (!clientDisconnected) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
// [/deep-research v1 handler]

// [agent-checkpoint v1 handler]
async function handleAgentCheckpoint(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  try {
    await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid request body: ' + errorMessage(e) }));
    return;
  }

  let device = null;
  try {
    device = await verifySignedRequest(req, { pathname, method: 'POST', log });
  } catch (e) {
    if (e instanceof AuthError) {
      res.writeHead(e.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    log('error', 'agent-checkpoint auth unexpected: ' + errorMessage(e));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal auth error' }));
    return;
  }

  const id = 'agent-ck-' + Date.now();
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Brain-Version': VERSION });
  res.end(JSON.stringify({
    id,
    ok: true,
    verdict: 'continue',
    scores: null,
    avg: null,
    reason: 'disabled_by_byok_equality',
    latencyMs: 0,
    failOpen: false,
    parseFailed: false,
  }));
  log('info', `[${id}] agent-checkpoint disabled by BYOK-equality policy → continue`);
}
// [/agent-checkpoint v1 handler]

// [web-search proxy v1 handler]
// Lynn desktop client's web_search tool calls this localhost endpoint so the
// MiMo / Zhipu / Bocha / Tavily / Serper API keys can stay in this Node process
// only and are never embedded in client code, renderer process, or distributed
// binaries. Returns { ok, provider, items[], summary?, sources[] } so the UI
// can render a synthesized answer plus a collapsible "View sources (N)" list.
async function handleWebSearch(req: IncomingMessage, res: ServerResponse, _pathname: string): Promise<void> {
  const remote = req.socket?.remoteAddress || '';
  if (!isLocalRequestAddress(remote)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'local_only', remote }));
    return;
  }

  let body: JsonObject;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid request body: ' + errorMessage(e) }));
    return;
  }

  const query = String(body.query || '').trim();
  if (!query) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'empty query' }));
    return;
  }

  try {
    const result = await webSearchStructured(query, { log });
    res.writeHead(result.ok ? 200 : 503, { 'Content-Type': 'application/json', 'X-Brain-Version': VERSION });
    res.end(JSON.stringify(result));
  } catch (err) {
    log('error', 'web-search proxy failed: ' + errorMessage(err));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
  }
}
// [/web-search proxy v1 handler]

async function handleLocalQwen35(req: IncomingMessage, res: ServerResponse, pathname: string, method: 'GET' | 'POST'): Promise<void> {
  const remote = req.socket?.remoteAddress || '';
  if (!isLocalRequestAddress(remote)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'local_only', remote }));
    return;
  }

  let bridge;
  try {
    bridge = await loadLocalQwen35Bridge();
  } catch (err) {
    const bridgeError = err as ErrorWithExtras;
    res.writeHead(503, { 'Content-Type': 'application/json', 'X-Brain-Version': VERSION });
    res.end(JSON.stringify({
      ok: false,
      error: 'local_qwen35_bridge_unavailable',
      message: bridgeError.code === 'ERR_MODULE_NOT_FOUND' ? 'local setup bridge is not bundled on this host' : errorMessage(err),
    }));
    return;
  }

  if (method === 'GET') {
    const status = await bridge.getLocalQwen35Plan();
    res.writeHead(status.ok ? 200 : 503, { 'Content-Type': 'application/json', 'X-Brain-Version': VERSION });
    res.end(JSON.stringify({ ...status, job: bridge.getLocalQwen35Job() }));
    return;
  }

  let body: JsonObject;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid request body: ' + errorMessage(e) }));
    return;
  }
  const authorized = body.authorized === true || body.yesUserAuthorized === true;
  const result = bridge.startLocalQwen35Setup({
    authorized,
    start: body.start !== false,
    installRuntime: body.installRuntime !== false,
    variant: (body.variant || 'imatrix') as string,
    host: (body.host || undefined) as string | undefined,
    port: (body.port || undefined) as string | number | undefined,
  });
  res.writeHead(result.ok ? 202 : 403, { 'Content-Type': 'application/json', 'X-Brain-Version': VERSION });
  res.end(JSON.stringify(result));
}

function resolveCorsOrigin(origin: string): string | null {
  if (CORS_ALLOWED_ORIGIN === '*') return '*';
  if (CORS_ALLOWED_ORIGIN && origin === CORS_ALLOWED_ORIGIN) return origin;
  if (!origin || origin === 'null') return null;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname;
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]')
    ) {
      return origin;
    }
  } catch {}
  return null;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = (req.headers.origin || '') as string;
  const allowedOrigin = resolveCorsOrigin(origin);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Agent-Key, X-Lynn-Timestamp, X-Lynn-Nonce, X-Lynn-Signature, X-Lynn-Client-Version, X-Lynn-Client-Platform');
  return Boolean(allowedOrigin || !origin);
}

const server = http.createServer(async (req, res) => {
  const corsAllowed = applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(corsAllowed ? 204 : 403);
    res.end();
    return;
  }

  const url = new URL(req.url as string, 'http://' + HOST + ':' + PORT);

  if (req.method === 'POST' && (url.pathname === '/v2/chat/completions' || url.pathname === '/v1/chat/completions' || url.pathname === '/api/v1/chat/completions')) {
    return handleChatCompletions(req, res, url.pathname);
  }

  // [deep-research v1 route]
  if (req.method === 'POST' && (url.pathname === '/v2/deep-research/completions' || url.pathname === '/v1/deep-research/completions')) {
    return handleDeepResearch(req, res, url.pathname);
  }
  // [/deep-research v1 route]
  // [agent-checkpoint v1 route]
  if (req.method === 'POST' && (url.pathname === '/v2/agent-checkpoint' || url.pathname === '/v1/agent-checkpoint')) {
    return handleAgentCheckpoint(req, res, url.pathname);
  }
  // [/agent-checkpoint v1 route]

  // [web-search proxy v1 route]
  if (req.method === 'POST' && (url.pathname === '/v2/web-search' || url.pathname === '/v1/web-search')) {
    return handleWebSearch(req, res, url.pathname);
  }
  // [/web-search proxy v1 route]

  if ((url.pathname === '/v2/local-qwen35-9b/plan' || url.pathname === '/v2/local-qwen35-9b/status' || url.pathname === '/v1/local-qwen35-9b/status') && req.method === 'GET') {
    return handleLocalQwen35(req, res, url.pathname, 'GET');
  }
  if ((url.pathname === '/v2/local-qwen35-9b/setup' || url.pathname === '/v2/local-qwen35-9b/execute' || url.pathname === '/v1/local-qwen35-9b/setup') && req.method === 'POST') {
    return handleLocalQwen35(req, res, url.pathname, 'POST');
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, brain: 'v2', version: VERSION, uptime_s: Math.floor(process.uptime()) }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/v2') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      brain: 'v2', version: VERSION,
      endpoints: ['POST /v1/chat/completions', 'POST /v2/chat/completions', 'POST /api/v1/chat/completions', 'POST /v1/web-search', 'GET /v2/local-qwen35-9b/status', 'POST /v2/local-qwen35-9b/setup', 'GET /health'],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
});

server.listen(PORT, HOST, () => {
  log('info', 'brain v2 listening http://' + HOST + ':' + PORT);
  log('info', 'endpoints: POST /v1/chat/completions  POST /v2/chat/completions  GET /health');
});

process.on('unhandledRejection', (reason) => {
  const rejection = reason as { message?: unknown } | null | undefined;
  log('error', 'unhandledRejection: ' + (rejection && rejection.message || reason));
});
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, closing server...');
  server.close(() => { log('info', 'server closed'); process.exit(0); });
});
process.on('SIGINT', () => {
  log('info', 'SIGINT received, closing server...');
  server.close(() => { log('info', 'server closed'); process.exit(0); });
});
