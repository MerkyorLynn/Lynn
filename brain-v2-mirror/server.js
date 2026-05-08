// Brain v2 · HTTP Server
// 端口默认 8790,跟 brain v1 (8789) 共存
import http from 'node:http';
import 'dotenv/config';
import './perf-init.js';
import { run as routerRun, detectCapability } from './router.js';
import { makeSSEEmitter } from './stream-bridge.js';
import { verifySignedRequest, AuthError } from './auth.js';

// [deep-research v1 import]
import { runDeepResearch } from './deep-research.mjs';
// [agent-checkpoint v1 import]
import { checkpointAgent } from './agent-checkpoint.mjs';
const PORT = Number(process.env.BRAIN_V2_PORT || 8790);
const HOST = process.env.BRAIN_V2_HOST || '127.0.0.1';
const VERSION = '0.0.1';
const CORS_ALLOWED_ORIGIN = process.env.BRAIN_V2_CORS_ORIGIN || '';

function log(level, msg) {
  console.log('[' + new Date().toISOString() + '] [' + level + '] ' + msg);
}

async function readJsonBody(req, maxBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleChatCompletions(req, res, pathname) {
  // P1#1: parse body BEFORE writing SSE header → fail-fast 4xx JSON
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid request body: ' + e.message }));
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
    log('error', 'auth unexpected: ' + e.message);
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

  const messages = body.messages || [];
  // v0.77.7: extra_body 透传 (OpenAI 标准, 客户端可传 thinking:{type:disabled} 关思考)
  const extraBody = (body.extra_body && typeof body.extra_body === "object") ? body.extra_body : null;
  // Lynn ThinkingLevelButton (off/auto/high/xhigh) → Pi SDK reasoning_effort
  const reasoningEffort = body.reasoning_effort || (extraBody && extraBody.reasoning_effort) || null;
  const tools = body.tools || null;
  const capabilityRequired = detectCapability(messages);
  const id = 'chatcmpl-v2-' + Date.now();
  const emitter = makeSSEEmitter(res, { id, model: body.model || 'lynn-v2' });

  emitter.emitRole();

  log('info', `[${id}] start agentKey=${device?.key || 'anon'} msgs=${messages.length} tools=${tools?.length || 0} cap=${JSON.stringify(capabilityRequired)}`);

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
    } else if (err.name === 'AbortError') {
      log('info', `[${id}] aborted`);
    } else {
      log('error', `[${id}] route failed: ${err.message}`);
      emitter.emitError(err.message, err.errors || null);
    }
  }
  emitter.done();
}

// [deep-research v1 handler]
async function handleDeepResearch(req, res, pathname) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid request body: ' + e.message }));
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
    log('error', 'auth unexpected: ' + e.message);
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

  const messages = body.messages || [];
  const candidates = Array.isArray(body.candidates) && body.candidates.length > 0 ? body.candidates : null;
  const id = 'chatcmpl-deep-' + Date.now();
  log('info', `[${id}] deep-research start agentKey=${device?.key || 'anon'} msgs=${messages.length} requestedCandidates=${candidates?.length || 'default'}`);

  // Helper to send SSE chunks in OpenAI-compat format
  const sendChunk = (deltaObj, finishReason = null) => {
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
  const sendMeta = (meta) => {
    if (clientDisconnected) return;
    res.write(`data: ${JSON.stringify({ id, object: 'deep-research.meta', meta })}\n\n`);
  };

  sendChunk({ role: 'assistant' });

  try {
    const onProgress = (event) => {
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

    const winnerContent = result.qualityRejected
      ? (result.fallbackContent || '')
      : (result.winner?.content || '');
    if (!winnerContent) {
      sendChunk({ content: '[deep-research] no winner content' }, 'stop');
      log('error', `[${id}] no winner content`);
    } else {
      // Send final winner pick + ranked scores as one meta chunk
      sendMeta({
        event: result.qualityRejected ? 'quality-rejected-final' : 'winner-picked',
        winnerProviderId: result.winner?.providerId || null,
        qualityRejected: !!result.qualityRejected,
        rankedScores: result.rankedScores || [],
        meta: result.meta || {},
      });
      // Stream winner content in 100-char chunks (simulated streaming for client compat)
      const CHUNK_SIZE = 200;
      for (let i = 0; i < winnerContent.length; i += CHUNK_SIZE) {
        if (clientDisconnected) return;
        sendChunk({ content: winnerContent.slice(i, i + CHUNK_SIZE) });
      }
      sendChunk({}, 'stop');
      log('info', `[${id}] done winner=${result.winner?.providerId || 'none'} qualityRejected=${!!result.qualityRejected} totalMs=${result.meta?.totalMs}`);
    }
  } catch (err) {
    if (!clientDisconnected) {
      log('error', `[${id}] deep-research failed: ${err.message}`);
      res.write(`data: ${JSON.stringify({ id, error: err.message })}\n\n`);
    }
  }

  if (!clientDisconnected) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
// [/deep-research v1 handler]

// [agent-checkpoint v1 handler]
async function handleAgentCheckpoint(req, res, pathname) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid request body: ' + e.message }));
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
    log('error', 'agent-checkpoint auth unexpected: ' + e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal auth error' }));
    return;
  }

  const userPrompt = String(body.userPrompt || '').slice(0, 4000);
  const trajectory = Array.isArray(body.trajectory) ? body.trajectory : [];
  const currentStep = body.currentStep ?? null;
  const maxSteps = body.maxSteps ?? null;

  if (!userPrompt) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'userPrompt is required' }));
    return;
  }

  const id = 'agent-ck-' + Date.now();
  log('info', `[${id}] agent-checkpoint agentKey=${device?.key || 'anon'} step=${currentStep}/${maxSteps} trajLen=${trajectory.length}`);

  try {
    const result = await checkpointAgent({ userPrompt, trajectory, currentStep, maxSteps, log });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Brain-Version': VERSION });
    res.end(JSON.stringify({
      id,
      ok: result.ok ?? false,
      verdict: result.verdict || 'continue',
      scores: result.scores || null,
      avg: result.avg ?? null,
      reason: result.reason || null,
      latencyMs: result.latencyMs || null,
      failOpen: result.failOpen || false,
      parseFailed: result.parseFailed || false,
    }));
    log('info', `[${id}] verdict=${result.verdict} avg=${result.avg?.toFixed(2)} latency=${result.latencyMs}ms`);
  } catch (err) {
    log('error', `[${id}] checkpoint failed: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, verdict: 'continue' }));
  }
}
// [/agent-checkpoint v1 handler]

function resolveCorsOrigin(origin) {
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

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin || '';
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

  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);

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
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, brain: 'v2', version: VERSION, uptime_s: Math.floor(process.uptime()) }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/v2') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      brain: 'v2', version: VERSION,
      endpoints: ['POST /v1/chat/completions', 'POST /v2/chat/completions', 'POST /api/v1/chat/completions', 'GET /health'],
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
  log('error', 'unhandledRejection: ' + (reason && reason.message || reason));
});
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, closing server...');
  server.close(() => { log('info', 'server closed'); process.exit(0); });
});
process.on('SIGINT', () => {
  log('info', 'SIGINT received, closing server...');
  server.close(() => { log('info', 'server closed'); process.exit(0); });
});
