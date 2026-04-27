/**
 * LLM Triage v1 — Hybrid regex+LLM intent classifier
 *
 * 用法:当 regex 分类器对一条 query 给出多个互斥分类(ambiguous)时,
 * 让 Spark FP8 帮做 final 判定。结果带 5min in-memory cache 避免重复调用。
 *
 * 设计目标:替换"硬编码关键词分类器"成"agent 化判断",
 * 同时保留 fast path —— regex 高 confidence 直接走,只在 ambiguous 时调 LLM。
 *
 * 输入/输出契约:
 *   classifyByLLM(text, opts) → { intent, confidence, reason, source: "llm" } | null
 *   intent ∈ { vision, utility, coding, reasoning, chat }
 *   返回 null = LLM 不可达 / 超时 / 解析失败 → caller 应 fallback 到 regex
 *
 * 故意不做的事:
 *   - 不做远端 cache(Redis 等)— 单进程内存 cache 够用,部署架构变了再说
 *   - 不做命中统计 metrics — 后续可加,先保证分类对
 *   - 不参与回答 — 只做路由分类,不污染主链路单 LLM 一次过的语义
 */

const TRIAGE_TTL_MS = 5 * 60 * 1000;
const TRIAGE_CACHE_MAX = 200;
const cache = new Map(); // text-hash → { result, expiry }

function hashKey(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

function pruneCacheIfFull() {
  if (cache.size <= TRIAGE_CACHE_MAX) return;
  // drop oldest 1/4
  const drop = Math.ceil(TRIAGE_CACHE_MAX / 4);
  let i = 0;
  for (const k of cache.keys()) {
    cache.delete(k);
    if (++i >= drop) break;
  }
}

const TRIAGE_PROMPT_ZH = `你是任务类型分类器。仔细读用户消息,分到下面 5 类之一:

vision      — 真正的图像/截图分析(用户上传图片要看/识别/解读图中内容)
utility     — 文件管理 / 命令执行 / 工具调用(新建/移动/挪/整理/归档 文件夹/文件;跑命令;查天气/股价/新闻/比分;打开/读取本地文件)
coding      — 写代码 / 改代码 / 调试 / 重构 / 代码审查
reasoning   — 分析、推理、调研、深度思考(没有具体可执行动作,要思考)
chat        — 一般对话/问候/闲聊/泛泛科普

判定铁律(必须遵守):
- 用户的动词包含"新建/创建/移动/挪/整理/归档/拷贝/复制" + 对象包含"文件夹/目录/文件/桌面/下载" → 一律 utility,不管是否提到"图片"二字
- 用户没上传图片但仅文本提到"图片"作为对象 → 看动词:移动图片=utility,识别图片内容=vision
- vision 仅在用户真的有图要看时使用

只输出一行 JSON,不要任何解释/前缀/思考过程:
{"intent":"<分类>","confidence":<0~1 小数>,"reason":"<不超过 25 字>"}`;

function safeParseJSON(text) {
  if (!text) return null;
  // 提取第一个 {...} 块,容忍前后噪音
  const m = text.match(/\{[^{}]*"intent"[^{}]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const VALID_INTENTS = new Set(["vision", "utility", "coding", "reasoning", "chat"]);

const DEFAULT_BASE_URL = (typeof process !== "undefined" && process.env && process.env.SPARK_BASE)
  || "http://127.0.0.1:18002";
const DEFAULT_MODEL = (typeof process !== "undefined" && process.env && process.env.QWEN_LOCAL_MODEL)
  || "Qwen3.6-35B-A3B-FP8";

export async function classifyByLLM(text, opts = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.length < 2) return null;

  const key = hashKey(trimmed);
  const cached = cache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.result;

  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || 4000;

  let resp;
  let data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: TRIAGE_PROMPT_ZH },
            { role: "user", content: trimmed.slice(0, 800) },
          ],
          max_tokens: 120,
          temperature: 0.1,
          // 分类不需要 thinking,关掉省 latency
          chat_template_kwargs: { enable_thinking: false },
          stream: false,
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return null;
    data = await resp.json();
  } catch {
    return null; // network / timeout / Spark down → caller fallback to regex
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  const parsed = safeParseJSON(String(content || ""));
  if (!parsed || !VALID_INTENTS.has(parsed.intent)) return null;

  const result = {
    intent: parsed.intent,
    confidence: typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.7,
    reason: String(parsed.reason || "").slice(0, 80),
    source: "llm",
  };
  pruneCacheIfFull();
  cache.set(key, { result, expiry: Date.now() + TRIAGE_TTL_MS });
  return result;
}

/**
 * 给 regex hits 算 confidence。
 *
 * 规则:
 *   0 个分类命中 → 0.50(可能是 chat,也可能是 LLM 才能识别的特殊任务)
 *   1 个分类命中 → 0.92(单一明确)
 *   2 个分类命中 → 0.55(歧义,call LLM)
 *   3+ 个分类命中 → 0.40(高度歧义)
 *
 * 高 confidence(≥ 0.85)= regex 直接定;低 confidence = LLM 兜底。
 */
export function scoreRegexConfidence(regexHits) {
  const hits = Object.values(regexHits || {}).filter(Boolean).length;
  if (hits === 0) return 0.50;
  if (hits === 1) return 0.92;
  if (hits === 2) return 0.55;
  return 0.40;
}

/**
 * 测试用:清缓存。生产代码不应调用。
 */
export function _resetTriageCache() {
  cache.clear();
}

/**
 * 测试用:暴露 cache size。生产不调。
 */
export function _triageCacheSize() {
  return cache.size;
}
