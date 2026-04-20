/**
 * bge-reranker-v2-m3 client · v0.77
 */
const RERANK_URL = process.env.LYNN_RERANK_URL || "http://localhost:8003";
const TIMEOUT_MS = Number(process.env.LYNN_RERANK_TIMEOUT_MS || 5000);

export async function rerank(query, docs, topK = 5) {
  const res = await fetch(`${RERANK_URL}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, texts: docs, raw_scores: false, truncate: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`rerank failed: HTTP ${res.status}`);
  const scored = await res.json();
  return scored.slice(0, topK);
}

export async function rerankHealth() {
  try {
    const r = await fetch(`${RERANK_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
