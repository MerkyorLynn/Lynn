// Brain v2 perf init — 全局 undici Agent + keep-alive pool
// 复用上游 connections,解决晚高峰冷连接(并发 3 12.7s → 期望 ~6s)
import { setGlobalDispatcher, Agent } from 'undici';

const POOL_CONNECTIONS = Number(process.env.BRAIN_V2_POOL_CONNECTIONS || 16);
const KEEPALIVE_TIMEOUT_MS = Number(process.env.BRAIN_V2_KEEPALIVE_MS || 30_000);
const KEEPALIVE_MAX_MS = Number(process.env.BRAIN_V2_KEEPALIVE_MAX_MS || 600_000);

setGlobalDispatcher(new Agent({
  keepAliveTimeout: KEEPALIVE_TIMEOUT_MS,
  keepAliveMaxTimeout: KEEPALIVE_MAX_MS,
  connections: POOL_CONNECTIONS,
  pipelining: 1,
  connect: { timeout: 10_000 },
}));

console.log('[perf-init] undici Agent: connections=' + POOL_CONNECTIONS + ' keepAlive=' + KEEPALIVE_TIMEOUT_MS + 'ms');
