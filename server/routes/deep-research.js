import { Hono } from "hono";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { safeJson } from "../hono-helpers.js";
import { BRAIN_API_ROOT, BRAIN_BACKUP_API_ROOT } from "../../shared/brain-provider.js";

export const DEFAULT_DEEP_RESEARCH_TIMEOUT_MS = 180_000;

function normalizeBaseUrl(rawValue) {
  const value = String(rawValue || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function resolveDeepResearchBaseUrl(value) {
  return resolveDeepResearchBaseUrls(value)[0] || "";
}

export function resolveDeepResearchBaseUrls(value) {
  const explicit = normalizeBaseUrl(value);
  if (explicit) return [explicit];

  const envValue = normalizeBaseUrl(
    process.env.LYNN_DEEP_RESEARCH_BASE_URL
      || process.env.LYNN_BRAIN_V2_BASE_URL
      || process.env.LYNN_BRAIN_V2_BASE
      || process.env.BRAIN_V2_BASE_URL
      || process.env.BRAIN_V2_BASE,
  );
  if (envValue) return [envValue];

  return unique([
    normalizeBaseUrl(`${BRAIN_API_ROOT}/v2`),
    normalizeBaseUrl(`${BRAIN_BACKUP_API_ROOT}/v2`),
    "http://127.0.0.1:8790",
  ]);
}

export function buildDeepResearchEndpoint(baseUrl) {
  return buildDeepResearchEndpointCandidates(baseUrl)[0] || "";
}

export function buildDeepResearchEndpointCandidates(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return [];

  // Public mirrors often expose /api/v2 as an nginx prefix that strips itself
  // before proxying to Brain v2. In that shape, the real upstream route is
  // /api/v2/v2/deep-research/completions, while direct :8790 uses /v2/....
  if (/\/api\/v2$/iu.test(normalized)) {
    return unique([
      `${normalized}/v2/deep-research/completions`,
      `${normalized}/deep-research/completions`,
    ]);
  }

  if (/\/v2$/iu.test(normalized)) {
    return unique([
      `${normalized}/deep-research/completions`,
      `${normalized}/v2/deep-research/completions`,
    ]);
  }

  return [`${normalized}/v2/deep-research/completions`];
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function parseDeepResearchSse(rawText) {
  const textParts = [];
  const metaEvents = [];
  let finishReason = null;
  let winnerProviderId = null;
  let qualityRejected = false;
  let rankedScores = null;
  let usage = null;

  for (const rawLine of String(rawText || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    const payload = parseJsonLine(data);
    if (!payload) {
      metaEvents.push({ type: "parse_error", raw: data.slice(0, 300) });
      continue;
    }

    if (payload.object === "deep-research.meta" || payload.type || payload.meta?.event) {
      const eventType = payload.type || payload.meta?.event || null;
      const normalizedMeta = {
        ...payload,
        type: eventType || payload.type,
      };
      metaEvents.push(normalizedMeta);
      if (eventType === "winner-picked") {
        winnerProviderId = payload.providerId || payload.winnerProviderId || payload.meta?.winnerProviderId || payload.meta?.providerId || winnerProviderId;
        rankedScores = payload.rankedScores || payload.meta?.rankedScores || rankedScores;
      }
      if (eventType === "quality-rejected" || eventType === "quality-rejected-final") {
        qualityRejected = true;
        winnerProviderId = payload.winnerProviderId || payload.providerId || payload.meta?.winnerProviderId || payload.meta?.providerId || winnerProviderId;
        rankedScores = payload.rankedScores || payload.meta?.rankedScores || payload.scores || rankedScores;
      }
      continue;
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const deltaContent = choice?.delta?.content;
    const messageContent = choice?.message?.content;
    if (typeof deltaContent === "string") textParts.push(deltaContent);
    else if (typeof messageContent === "string") textParts.push(messageContent);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (payload.usage) usage = payload.usage;
  }

  return {
    ok: !qualityRejected,
    text: textParts.join(""),
    finishReason,
    winnerProviderId,
    rankedScores,
    qualityRejected,
    metaEvents,
    usage,
  };
}

function normalizeMessages(body) {
  if (Array.isArray(body.messages) && body.messages.length) {
    return body.messages
      .filter((message) => message && typeof message === "object")
      .map((message) => ({
        role: String(message.role || "user"),
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      }))
      .filter((message) => message.content.trim());
  }

  const prompt = String(body.prompt || body.query || body.text || "").trim();
  return prompt ? [{ role: "user", content: prompt }] : [];
}

function isValidSessionPath(sessionPath, agentsDir) {
  if (!sessionPath || !agentsDir || !sessionPath.endsWith(".jsonl")) return false;
  const resolved = path.resolve(sessionPath);
  const base = path.resolve(agentsDir);
  return resolved.startsWith(base + path.sep);
}

function formatDeepResearchResultText(parsed) {
  const text = String(parsed?.text || "").trim()
    || "Deep Research 没有返回可见答案，请稍后重试或把问题拆得更具体。";
  const winner = parsed?.winnerProviderId ? ` · winner: ${parsed.winnerProviderId}` : "";
  const status = parsed?.qualityRejected
    ? "质量地板已拦截"
    : parsed?.ok === false
      ? "未通过质量复核"
      : "已通过质量复核";
  const scoreLines = Array.isArray(parsed?.rankedScores)
    ? parsed.rankedScores.slice(0, 3).map((row, index) => {
      const provider = String(row?.providerId || row?.provider || `候选 ${index + 1}`);
      const avg = Number(row?.avg ?? row?.average ?? NaN);
      return Number.isFinite(avg) ? `- ${provider}: ${avg.toFixed(2)}` : `- ${provider}`;
    })
    : [];
  return [
    text,
    "",
    "---",
    `**Deep Research**：${status}${winner}`,
    scoreLines.length ? `\n${scoreLines.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

function buildDeepResearchSessionEntries({ messages, parsed }) {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const userText = messages.filter((message) => message.role === "user").at(-1)?.content
    || messages.at(-1)?.content
    || "";
  const userId = randomUUID().slice(0, 8);
  const assistantId = randomUUID().slice(0, 8);
  return [
    {
      type: "message",
      id: userId,
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: userText }],
        timestamp: now,
      },
    },
    {
      type: "message",
      id: assistantId,
      parentId: userId,
      timestamp: new Date(now + 1).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: formatDeepResearchResultText(parsed) }],
        api: "deep-research",
        provider: "brain-v2",
        model: parsed?.winnerProviderId || "deep-research",
        stopReason: parsed?.finishReason || "stop",
        timestamp: now + 1,
      },
    },
  ];
}

function persistDeepResearchExchange(engine, body, messages, parsed) {
  const sessionPath = String(body?.sessionPath || "").trim();
  if (!sessionPath) return { persisted: false };
  if (!isValidSessionPath(sessionPath, engine?.agentsDir)) {
    return { persisted: false, persistError: "invalid_session_path" };
  }
  try {
    const entries = buildDeepResearchSessionEntries({ messages, parsed });
    const block = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    fs.appendFileSync(sessionPath, block, "utf8");
    return { persisted: true, persistedSessionPath: sessionPath };
  } catch (err) {
    return { persisted: false, persistError: err?.message || String(err) };
  }
}

export function createDeepResearchRoute(engine, options = {}) {
  const route = new Hono();
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  route.post("/deep-research", async (c) => {
    const body = await safeJson(c, {});
    const messages = normalizeMessages(body);
    if (!messages.length) {
      return c.json({ error: "missing_prompt" }, 400);
    }

    const baseUrls = resolveDeepResearchBaseUrls(body.baseUrl);
    const baseUrl = baseUrls[0];
    const timeoutMs = Number.isFinite(Number(body.timeoutMs))
      ? Math.max(1_000, Math.min(Number(body.timeoutMs), 300_000))
      : DEFAULT_DEEP_RESEARCH_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const upstreamBody = {
        messages,
        ...(Array.isArray(body.candidates) ? { candidates: body.candidates } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(Number.isFinite(Number(body.max_tokens)) ? { max_tokens: Number(body.max_tokens) } : {}),
      };

      let lastFailure = null;
      for (const candidateBaseUrl of baseUrls) {
        for (const endpoint of buildDeepResearchEndpointCandidates(candidateBaseUrl)) {
          try {
            const upstream = await fetchImpl(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(upstreamBody),
              signal: controller.signal,
            });

            const raw = await upstream.text();
            if (!upstream.ok) {
              lastFailure = {
                status: upstream.status,
                message: raw.slice(0, 1_000),
                baseUrl: candidateBaseUrl,
                endpoint,
              };
              continue;
            }

            const parsed = parseDeepResearchSse(raw);
            const persistence = persistDeepResearchExchange(engine, body, messages, parsed);
            return c.json({
              ...parsed,
              baseUrl: candidateBaseUrl,
              endpoint,
              attemptedBaseUrls: baseUrls,
              ...persistence,
              source: "brain-v2-deep-research",
            });
          } catch (err) {
            if (err?.name === "AbortError") throw err;
            lastFailure = {
              status: 0,
              message: err?.message || String(err),
              baseUrl: candidateBaseUrl,
              endpoint,
            };
          }
        }
      }

      return c.json({
        error: "deep_research_upstream_error",
        status: lastFailure?.status || 0,
        message: lastFailure?.message || "all deep research upstreams failed",
        baseUrl: lastFailure?.baseUrl || baseUrl,
        endpoint: lastFailure?.endpoint,
        attemptedBaseUrls: baseUrls,
      }, 502);
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      return c.json({
        error: isAbort ? "deep_research_timeout" : "deep_research_request_failed",
        message: err?.message || String(err),
        baseUrl,
      }, isAbort ? 504 : 502);
    } finally {
      clearTimeout(timer);
    }
  });

  return route;
}
