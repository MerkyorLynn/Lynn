import { Agent } from "undici";

const pools = new Map();

function normalizePoolKey(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return String(baseUrl || "").trim();
  }
}

export function getPooledDispatcher(baseUrl) {
  const key = normalizePoolKey(baseUrl);
  if (!key) return null;
  if (!pools.has(key)) {
    pools.set(key, new Agent({
      connections: 4,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connect: {
        timeout: 10_000,
      },
    }));
  }
  return pools.get(key);
}

export async function prewarmHttpConnection(url, {
  method = "HEAD",
  headers = {},
  timeoutMs = 3000,
} = {}) {
  const dispatcher = getPooledDispatcher(url);
  return fetch(url, {
    method,
    headers,
    dispatcher: dispatcher || undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function closeHttpPools() {
  const closers = [...pools.values()].map((agent) => agent.close().catch(() => {}));
  pools.clear();
  await Promise.allSettled(closers);
}
