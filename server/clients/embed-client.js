/**
 * bge-m3 embedding client · v0.77
 * Talks to lynn-embed.service (port 8002 by default)
 * 接口: TEI 兼容 + FastAPI 自实现兼容
 */
const EMBED_URL = process.env.LYNN_EMBED_URL || "http://localhost:8002";
const TIMEOUT_MS = Number(process.env.LYNN_EMBED_TIMEOUT_MS || 5000);

export async function embed(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const res = await fetch(`${EMBED_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: arr }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`embed failed: HTTP ${res.status}`);
  return await res.json();
}

export async function embedHealth() {
  try {
    const r = await fetch(`${EMBED_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
