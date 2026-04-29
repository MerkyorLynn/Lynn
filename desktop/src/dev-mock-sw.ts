/**
 * Lynn Client · v0.77 Mock Service Worker
 *
 * 用法:
 *   1. npm i -D msw
 *   2. npx msw init public/ --save
 *   3. 在 main.tsx 里:
 *        if (import.meta.env.DEV) {
 *          const { worker } = await import("./dev-mock-sw");
 *          await worker.start({ onUnhandledRequest: "bypass" });
 *        }
 *
 * 拦截:
 *   • POST /api/v1/memory/recall    → 返回假记忆
 *   • POST /api/v1/memory/write     → 假装写入
 *   • GET  /api/v1/memory/list      → 返回 mock 列表
 *   • POST /api/v1/audio/transcribe → SSE 流式假转写
 *   • POST /api/v1/knowledge/upload → SSE 进度
 *   • POST /api/v1/chat/completions → 在首帧塞 memory_used 事件
 *
 * 切真实后端: 直接删除 main.tsx 里的 worker.start() 即可
 */
import { http, HttpResponse, delay } from "msw";
import { setupWorker } from "msw/browser";

// ============ Mock 数据 ============
const NOW = Date.now();
const DAY = 86_400_000;

const mockMemories = [
  {
    id: 1001,
    text: "Lynn v0.76.2 用 vllm 64K context + qwen3_coder parser, gpu-mem 0.85",
    layer: "L4",
    source: "chat",
    timestamp: NOW - 7 * DAY,
    score: 0.92,
    snippet: "Lynn v0.76.2 用 vllm 64K context + qwen3_coder parser...",
  },
  {
    id: 1002,
    text: "MoE 量化对比笔记: FP8 vs AWQ-4bit, 35B-A3B 测试结果",
    layer: "L5",
    source: "note",
    timestamp: NOW - 30 * DAY,
    score: 0.84,
    snippet: "MoE 量化对比: FP8 比 4bit 多用 8GB 显存,质量 +1.5 分",
  },
  {
    id: 1003,
    text: "GPU 服务器 SSH js1.blockelite.cn:30112, 4090 48G 改装",
    layer: "L6",
    source: "manual",
    timestamp: NOW - 60 * DAY,
    score: 0.71,
  },
];

const mockDocuments = [
  { id: "doc-001", name: "MoE-quant-compare.md", chunks_count: 42,
    indexed_at: NOW - 3 * DAY, size_bytes: 18_432, status: "ready" },
  { id: "doc-002", name: "lynn-roadmap-v2.md", chunks_count: 28,
    indexed_at: NOW - 1 * DAY, size_bytes: 12_800, status: "ready" },
];

// ============ SSE helper ============
function sseStream(events: unknown[], delayMs = 80) {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for (const evt of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
        await delay(delayMs);
      }
      controller.close();
    },
  });
}

// ============ Handlers ============
export const handlers = [
  // ---- memory/recall ----
  http.post("/api/v1/memory/recall", async ({ request }) => {
    const body = (await request.json()) as { query: string; top_k?: number };
    await delay(50);
    const k = body.top_k ?? 5;
    const matched = mockMemories
      .filter((m) => fuzzyMatch(body.query, m.text))
      .slice(0, k);
    return HttpResponse.json({
      hits: matched.length ? matched : mockMemories.slice(0, Math.min(k, 3)),
      total_ms: 28,
      embed_ms: 8,
      recall_ms: 12,
      rerank_ms: 8,
    });
  }),

  // ---- memory/write ----
  http.post("/api/v1/memory/write", async () => {
    await delay(20);
    return HttpResponse.json({ id: Date.now(), embedding_ms: 8 });
  }),

  // ---- memory/write_batch ----
  http.post("/api/v1/memory/write_batch", async ({ request }) => {
    const body = (await request.json()) as { items: unknown[] };
    await delay(80);
    return HttpResponse.json({
      ids: body.items.map(() => Date.now() + Math.random()),
      total_ms: 80,
    });
  }),

  // ---- memory/list ----
  http.get("/api/v1/memory/list", ({ request }) => {
    const url = new URL(request.url);
    const layer = url.searchParams.get("layer");
    const filtered = layer
      ? mockMemories.filter((m) => m.layer === layer)
      : mockMemories;
    return HttpResponse.json({ items: filtered, total: filtered.length });
  }),

  // ---- memory delete ----
  http.delete("/api/v1/memory/:id", () => new Response(null, { status: 204 })),

  // ---- knowledge/list ----
  http.get("/api/v1/knowledge/list", () => {
    return HttpResponse.json({ documents: mockDocuments });
  }),

  // ---- knowledge/upload (SSE 进度) ----
  http.post("/api/v1/knowledge/upload", async () => {
    const events = [
      { phase: "parsing",   progress: 0.3 },
      { phase: "chunking",  progress: 0.6, chunks: 42 },
      { phase: "embedding", progress: 0.9, chunks: 42 },
      { phase: "done", document_id: `doc-${Date.now()}`, chunks: 42 },
    ];
    return new HttpResponse(sseStream(events, 400), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  // ---- audio/transcribe (SSE 流式) ----
  http.post("/api/v1/audio/transcribe", async () => {
    const segments = [
      { type: "partial", text: "你好" },
      { type: "partial", text: "你好,我" },
      { type: "partial", text: "你好,我是" },
      { type: "partial", text: "你好,我是 Lynn" },
      { type: "partial", text: "你好,我是 Lynn,这是一段" },
      { type: "partial", text: "你好,我是 Lynn,这是一段模拟" },
      { type: "final", text: "你好,我是 Lynn,这是一段模拟语音转写", duration_ms: 1234, language: "zh" },
    ];
    return new HttpResponse(sseStream(segments, 120), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  // ---- audio/chat (SSE: 转写 → 记忆 → chat) ----
  http.post("/api/v1/audio/chat", async () => {
    const events = [
      { type: "transcribed", text: "上次我们说的 vllm 调整怎么样了", duration_ms: 1100 },
      { type: "memory_used", items: mockMemories.slice(0, 2), recall_ms: 24 },
      { choices: [{ delta: { content: "你 4 月" } }] },
      { choices: [{ delta: { content: "12 日把" } }] },
      { choices: [{ delta: { content: " vllm 64K" } }] },
      { choices: [{ delta: { content: " 配置好了。" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    return new HttpResponse(sseStream(events, 140), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  // ---- chat/completions (在首帧塞 memory_used) ----
  http.post("/api/v1/chat/completions", async ({ request }) => {
    const body = (await request.json()) as { memory?: { enabled?: boolean; top_k?: number } };
    const events: unknown[] = [];
    if (body.memory?.enabled) {
      events.push({
        type: "memory_used",
        items: mockMemories.slice(0, body.memory.top_k ?? 3),
        recall_ms: 24,
      });
    }
    const reply = "这是 mock 回复。真实场景下会基于你的记忆给出针对性回答。";
    for (const ch of reply.split("")) {
      events.push({ choices: [{ delta: { content: ch } }] });
    }
    events.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
    return new HttpResponse(sseStream(events, 30), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),
];

// ============ helpers ============
function fuzzyMatch(query: string, text: string) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  return q.split(/\s+/).some((w) => w.length > 1 && t.includes(w));
}

// ============ worker ============
export const worker = setupWorker(...handlers);
