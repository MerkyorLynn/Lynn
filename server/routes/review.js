/**
 * review.js — 按需 Review 路由
 *
 * POST /api/review
 *   body: { context, reviewerAgent? }
 *
 * 调用指定 reviewer agent（默认取第一个非当前的 agent，优先 hanako 人格）
 * 以 readOnly 模式执行 review，结果通过 WS broadcast 推送到前端。
 *
 * GET /api/review/agents
 *   返回可用的 reviewer agent 列表
 */

import { Hono } from "hono";
import { runAgentSession } from "../../hub/agent-executor.js";
import { t, getLocale } from "../i18n.js";

/**
 * 构建 review 的 system prompt 追加内容
 */
function buildReviewSystemAppend() {
  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return [
      "你现在是 Review 角色。另一个 Agent 刚刚完成了一项任务，用户请求你复查。",
      "",
      "要求：",
      "- 保留你的 MOOD / PULSE / REFLECT 区块（这是你的思维框架，review 时同样有用）",
      "- 聚焦于：逻辑漏洞、遗漏的边界情况、可改进的点、潜在风险",
      "- 如果一切看起来没问题，简短确认即可，不要为了挑刺而挑刺",
      "- 输出结构化：先给 1-2 句总结结论，然后列出具体发现（如有）",
      "- 语气：像一个认真但友善的同事在帮忙把关",
    ].join("\n");
  }
  return [
    "You are now in Review mode. Another agent just completed a task, and the user asked you to review it.",
    "",
    "Requirements:",
    "- Keep your MOOD / PULSE / REFLECT block (it's your thinking framework, useful for review too)",
    "- Focus on: logic gaps, missed edge cases, areas for improvement, potential risks",
    "- If everything looks fine, confirm briefly — don't nitpick for the sake of it",
    "- Structure your output: 1-2 sentence summary first, then specific findings (if any)",
    "- Tone: like a thoughtful colleague doing a careful review",
  ].join("\n");
}

/**
 * 从 agents 列表中选择 reviewer（优先 hanako yuan、非当前 agent）
 */
function pickReviewer(engine, preferredId) {
  if (preferredId) {
    const agent = engine.getAgent(preferredId);
    if (agent) return preferredId;
  }

  const currentId = engine.currentAgentId;
  const agents = engine.listAgents?.() || [];

  // 优先选 hanako yuan 的非当前 agent
  const hanako = agents.find(a => a.id !== currentId && a.yuan === "hanako");
  if (hanako) return hanako.id;

  // 其次选任何非当前 agent
  const other = agents.find(a => a.id !== currentId);
  if (other) return other.id;

  return null;
}

export function createReviewRoute(engine, { broadcast }) {
  const route = new Hono();

  route.post("/review", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { context, reviewerAgent } = body;

    if (!context || typeof context !== "string") {
      return c.json({ error: "missing context" }, 400);
    }

    const reviewerId = pickReviewer(engine, reviewerAgent);
    if (!reviewerId) {
      return c.json({ error: "No reviewer agent available. Create a second agent first." }, 400);
    }

    const reviewer = engine.getAgent(reviewerId);
    const reviewerName = reviewer?.agentName || reviewerId;

    const reviewId = `review-${Date.now()}`;

    // 通知前端：review 开始
    broadcast({
      type: "review_start",
      reviewId,
      reviewerName,
      reviewerAgent: reviewerId,
    });

    // 异步执行 review（不阻塞 HTTP 响应）
    (async () => {
      try {
        const isZh = getLocale().startsWith("zh");
        const prompt = isZh
          ? `请复查以下内容：\n\n${context}`
          : `Please review the following:\n\n${context}`;

        const result = await runAgentSession(
          reviewerId,
          [{ text: prompt, capture: true }],
          {
            engine,
            sessionSuffix: "review",
            systemAppend: buildReviewSystemAppend(),
            readOnly: true,
            keepSession: false,
          },
        );

        broadcast({
          type: "review_result",
          reviewId,
          reviewerName,
          reviewerAgent: reviewerId,
          content: result || (isZh ? "（review 无输出）" : "(no review output)"),
        });
      } catch (err) {
        broadcast({
          type: "review_result",
          reviewId,
          reviewerName,
          reviewerAgent: reviewerId,
          content: "",
          error: err.message || "Review failed",
        });
      }
    })();

    return c.json({ reviewId, reviewerName, reviewerAgent: reviewerId });
  });

  // 列出可用的 reviewer agents
  route.get("/review/agents", (c) => {
    const currentId = engine.currentAgentId;
    const agents = engine.listAgents?.() || [];
    const reviewers = agents
      .filter(a => a.id !== currentId)
      .map(a => ({ id: a.id, name: a.name, yuan: a.yuan }));
    return c.json({ reviewers });
  });

  return route;
}
