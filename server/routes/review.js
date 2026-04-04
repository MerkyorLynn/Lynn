/**
 * review.js — 按需 Review 路由
 *
 * POST /api/review
 *   body: { context, reviewerKind? }
 *
 * 仅允许 Hanako / Butter 作为审查人。
 * 可在设置中分别绑定对应 persona 的 reviewer agent，并设置默认审查人。
 *
 * GET /api/review/config
 * PUT /api/review/config
 * GET /api/review/agents
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { runAgentSession } from "../../hub/agent-executor.js";
import { getLocale } from "../i18n.js";
import { buildReviewFollowUp, parseStructuredReview } from "../review-result.js";
import { buildReviewFollowUpTaskPrompt, buildReviewFollowUpTaskTitle } from "../review-follow-up.js";

const REVIEWER_YUANS = new Set(["hanako", "butter"]);
const REVIEW_PROGRESS_STAGES = ["packing_context", "reviewing", "structuring", "done"];
const MAX_CONTEXT_PREVIEW_CHARS = 2200;
const MAX_SESSION_LINES = 120;
const MAX_TOOL_ITEMS = 10;
const REVIEW_EXEC_TIMEOUT_MS = 45_000;

function isZh() {
  return getLocale().startsWith("zh");
}

function buildReviewSystemAppend() {
  if (isZh()) {
    return [
      "你现在是 Review 角色。另一个 Agent 刚刚完成了一项任务，用户请求你复查。",
      "",
      "要求：",
      "- 保留你的 MOOD / PULSE / REFLECT 区块（这是你的思维框架，review 时同样有用）",
      "- 聚焦于：逻辑漏洞、遗漏的边界情况、可改进的点、潜在风险",
      "- 如果一切看起来没问题，简短确认即可，不要为了挑刺而挑刺",
      "- 先在正文给出你自然语言的 review 结论",
      "- 然后严格追加一个 ```json 代码块，结构必须是 { summary, verdict, findings, nextStep? }",
      "- verdict 只能是 pass / concerns / blocker",
      "- findings 必须是数组；每项包含 severity(high|medium|low), title, detail, suggestion?, filePath?",
      "- 如果没有问题，findings 返回空数组",
      "- 语气：像一个认真但友善的同事在帮忙把关",
    ].join("\n");
  }

  return [
    "You are now in Review mode. Another agent just completed a task, and the user asked you to review it.",
    "",
    "Requirements:",
    "- Keep your MOOD / PULSE / REFLECT block (it's your thinking framework, useful for review too)",
    "- Focus on: logic gaps, missed edge cases, areas for improvement, potential risks",
    "- If everything looks fine, confirm briefly. Do not nitpick for the sake of it",
    "- First give your natural-language review conclusion",
    "- Then append a strict ```json code block with { summary, verdict, findings, nextStep? }",
    "- verdict must be one of pass / concerns / blocker",
    "- findings must be an array; each item should include severity(high|medium|low), title, detail, suggestion?, filePath?",
    "- If there are no issues, return an empty findings array",
    "- Tone: like a thoughtful colleague doing a careful review",
  ].join("\n");
}

function normalizeReviewerKind(kind) {
  return kind === "butter" ? "butter" : "hanako";
}

function normalizeReviewerId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function reviewerDisplayName(yuan) {
  return yuan === "butter" ? "Butter" : "Hanako";
}

function ensureReviewerAgentShape(engine, kind, reviewerId) {
  const agentId = normalizeReviewerId(reviewerId);
  if (!agentId || typeof engine.getAgent !== "function") return false;

  const agent = engine.getAgent(agentId);
  if (!agent || typeof agent.updateConfig !== "function") return false;

  const currentYuan = String(agent?.config?.agent?.yuan || agent?.yuan || "").trim().toLowerCase();
  const currentTier = String(agent?.config?.agent?.tier || agent?.tier || "").trim().toLowerCase();
  const nextAgent = {};

  if (currentYuan !== kind) nextAgent.yuan = kind;
  if (currentTier !== "reviewer") nextAgent.tier = "reviewer";
  if (Object.keys(nextAgent).length === 0) return false;

  try {
    agent.updateConfig({ agent: nextAgent });
    engine.invalidateAgentListCache?.();
    return true;
  } catch {
    return false;
  }
}

function normalizeReviewConfig(prefs = {}) {
  const raw = prefs.review && typeof prefs.review === "object" ? prefs.review : {};
  return {
    defaultReviewer: normalizeReviewerKind(raw.defaultReviewer),
    hanakoReviewerId: normalizeReviewerId(raw.hanakoReviewerId),
    butterReviewerId: normalizeReviewerId(raw.butterReviewerId),
  };
}

function getAgentModel(agent) {
  const raw = agent?.config?.models?.chat;
  if (typeof raw === "object" && raw) {
    return {
      modelId: raw.id || null,
      modelProvider: raw.provider || agent?.config?.api?.provider || null,
    };
  }

  return {
    modelId: raw || null,
    modelProvider: agent?.config?.api?.provider || null,
  };
}

async function runReviewerSessionWithFallback(engine, reviewerId, rounds, opts) {
  try {
    return await runAgentSession(reviewerId, rounds, opts);
  } catch (err) {
    const fallbackModel = engine.currentModel;
    if (!fallbackModel?.id) throw err;
    return runAgentSession(reviewerId, rounds, {
      ...opts,
      modelOverride: fallbackModel,
    });
  }
}

function listReviewCandidates(engine) {
  const agents = engine.listAgents?.() || [];
  return agents
    .filter((agent) => agent?.tier !== "expert")
    .filter((agent) => REVIEWER_YUANS.has(agent?.yuan))
    .map((agent) => {
      const runtimeAgent = engine.getAgent(agent.id);
      const { modelId, modelProvider } = getAgentModel(runtimeAgent);
      return {
        id: agent.id,
        name: agent.name || runtimeAgent?.agentName || agent.id,
        displayName: reviewerDisplayName(agent.yuan),
        yuan: agent.yuan,
        hasAvatar: !!agent.hasAvatar,
        isCurrent: agent.id === engine.currentAgentId,
        modelId,
        modelProvider,
      };
    });
}

function groupCandidatesByYuan(candidates) {
  return {
    hanako: candidates.filter((candidate) => candidate.yuan === "hanako"),
    butter: candidates.filter((candidate) => candidate.yuan === "butter"),
  };
}

function resolveReviewer(groupedCandidates, kind, config, currentAgentId) {
  const candidates = (groupedCandidates[kind] || []).filter((candidate) => candidate.id !== currentAgentId);
  const preferredId = kind === "hanako" ? config.hanakoReviewerId : config.butterReviewerId;

  if (preferredId) {
    const preferred = candidates.find((candidate) => candidate.id === preferredId);
    if (preferred) return preferred;
  }

  return candidates[0] || null;
}

export function buildReviewConfig(engine) {
  const prefs = engine.getPreferences?.() || {};
  const config = normalizeReviewConfig(prefs);
  const candidates = groupCandidatesByYuan(listReviewCandidates(engine));
  const resolved = resolveReviewer(candidates, config.defaultReviewer, config, engine.currentAgentId);

  return {
    ...config,
    candidates,
    resolvedReviewer: resolved ? { ...resolved, reviewerName: reviewerDisplayName(resolved.yuan) } : null,
  };
}

async function ensureDefaultReviewerAgents(engine) {
  if (typeof engine.createAgent !== "function") return buildReviewConfig(engine);

  const prefs = engine.getPreferences?.() || {};
  const normalizedConfig = normalizeReviewConfig(prefs);
  let repaired = false;
  repaired = ensureReviewerAgentShape(engine, "hanako", normalizedConfig.hanakoReviewerId || "hanako") || repaired;
  repaired = ensureReviewerAgentShape(engine, "butter", normalizedConfig.butterReviewerId || "butter") || repaired;

  let config = repaired ? buildReviewConfig(engine) : buildReviewConfig(engine);
  const missingKinds = ["hanako", "butter"].filter((kind) => {
    return !resolveReviewer(config.candidates, kind, config, engine.currentAgentId);
  });

  if (missingKinds.length === 0) return config;

  const nextBindings = {};
  for (const kind of missingKinds) {
    try {
      const created = await engine.createAgent({
        name: kind === "butter" ? "Butter Reviewer" : "Hanako Reviewer",
        yuan: kind,
      });
      if (created?.id) {
        ensureReviewerAgentShape(engine, kind, created.id);
        nextBindings[kind === "butter" ? "butterReviewerId" : "hanakoReviewerId"] = created.id;
      }
    } catch {}
  }

  config = Object.keys(nextBindings).length > 0
    ? saveReviewConfig(engine, nextBindings)
    : buildReviewConfig(engine);

  return config;
}

function saveReviewConfig(engine, partial = {}) {
  const prefs = engine.getPreferences?.() || {};
  const current = normalizeReviewConfig(prefs);
  const next = {
    defaultReviewer: partial.defaultReviewer === undefined ? current.defaultReviewer : normalizeReviewerKind(partial.defaultReviewer),
    hanakoReviewerId: partial.hanakoReviewerId === undefined ? current.hanakoReviewerId : normalizeReviewerId(partial.hanakoReviewerId),
    butterReviewerId: partial.butterReviewerId === undefined ? current.butterReviewerId : normalizeReviewerId(partial.butterReviewerId),
  };

  prefs.review = next;
  engine.savePreferences?.(prefs);
  return buildReviewConfig(engine);
}

function reviewerMissingMessage(kind) {
  if (isZh()) {
    return kind === "butter"
      ? "还没有可用的 Butter 审查人。请先在设置 > 工作 中创建或绑定 Butter reviewer。"
      : "还没有可用的 Hanako 审查人。请先在设置 > 工作 中创建或绑定 Hanako reviewer。";
  }

  return kind === "butter"
    ? "No Butter reviewer is available yet. Create or assign one in Settings > Work first."
    : "No Hanako reviewer is available yet. Create or assign one in Settings > Work first.";
}

function validateReviewerSelection(candidates, reviewerId, yuan) {
  if (!reviewerId) return true;
  return candidates.some((candidate) => candidate.id === reviewerId && candidate.yuan === yuan && !candidate.isCurrent);
}

function createReviewProgressEmitter({ broadcast, reviewId, sessionPath, reviewer }) {
  return (stage, extra = {}) => {
    const safeStage = REVIEW_PROGRESS_STAGES.includes(stage) ? stage : "reviewing";
    broadcast({
      type: "review_progress",
      reviewId,
      sessionPath,
      stage: safeStage,
      reviewerName: reviewerDisplayName(reviewer.yuan),
      reviewerAgent: reviewer.id,
      reviewerAgentName: reviewer.name,
      reviewerYuan: reviewer.yuan,
      reviewerHasAvatar: reviewer.hasAvatar,
      ...extra,
    });
  };
}

function cleanPreviewText(value, maxChars = MAX_CONTEXT_PREVIEW_CHARS) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\r\n?/g, "\n").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trim()}\n…`;
}

function summarizeToolUseBlocks(content) {
  if (!Array.isArray(content)) return [];
  const toolUses = [];
  for (const block of content) {
    if (!block || (block.type !== "tool_use" && block.type !== "toolCall")) continue;
    const rawArgs = block.input || block.arguments;
    let argsPreview = "";
    if (rawArgs && typeof rawArgs === "object") {
      const entries = Object.entries(rawArgs)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .slice(0, 3)
        .map(([key, value]) => {
          const rendered = typeof value === "string" ? value : JSON.stringify(value);
          return `${key}=${String(rendered).slice(0, 80)}`;
        });
      argsPreview = entries.join(", ");
    }
    toolUses.push({
      name: block.name || "unknown_tool",
      argsPreview,
    });
    if (toolUses.length >= MAX_TOOL_ITEMS) break;
  }
  return toolUses;
}

function buildSessionContextPack(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return null;
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean).slice(-MAX_SESSION_LINES);
    const entries = [];
    let assistantText = "";
    let userText = "";
    let toolUses = [];

    for (const line of lines) {
      if (entries.length >= MAX_SESSION_LINES) break;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type !== "message" || !parsed.message) continue;
      const msg = parsed.message;
      const role = msg.role || "unknown";
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (role === "user" && text) userText = cleanPreviewText(text, 1200);
      if (role === "assistant" && text) assistantText = cleanPreviewText(text, 1800);
      if (role === "assistant") {
        const summarizedTools = summarizeToolUseBlocks(content);
        if (summarizedTools.length) toolUses = summarizedTools;
      }
      entries.push({ role, text: cleanPreviewText(text, 600) });
    }

    return {
      userText,
      assistantText,
      toolUses,
      recentMessages: entries.slice(-8),
    };
  } catch {
    return null;
  }
}

function buildReviewContextPack(context, engine) {
  const sessionPath = engine.currentSessionPath || null;
  const gitContext = sessionPath
    ? {
        sessionPath,
        sessionFile: path.basename(sessionPath),
      }
    : null;

  const sessionContext = buildSessionContextPack(sessionPath);
  const workspacePath = engine.deskCwd || engine.homeCwd || null;

  return {
    request: cleanPreviewText(context, MAX_CONTEXT_PREVIEW_CHARS),
    gitContext,
    sessionContext,
    ...(workspacePath ? { workspacePath } : {}),
  };
}

function formatContextPack(contextPack) {
  const lines = [];
  if (isZh()) {
    lines.push("[用户要求复查的内容]");
    lines.push(contextPack.request || "（空）");
    if (contextPack.gitContext?.sessionFile) {
      lines.push("");
      lines.push("[当前会话]");
      lines.push(`session=${contextPack.gitContext.sessionFile}`);
    }
    if (contextPack.workspacePath) {
      lines.push("");
      lines.push("[当前工作目录]");
      lines.push(contextPack.workspacePath);
    }
    if (contextPack.sessionContext?.userText) {
      lines.push("");
      lines.push("[最近一次用户请求]");
      lines.push(contextPack.sessionContext.userText);
    }
    if (contextPack.sessionContext?.assistantText) {
      lines.push("");
      lines.push("[最近一次助手结论]");
      lines.push(contextPack.sessionContext.assistantText);
    }
    if (contextPack.sessionContext?.toolUses?.length) {
      lines.push("");
      lines.push("[最近一次工具轨迹]");
      for (const tool of contextPack.sessionContext.toolUses) {
        lines.push(`- ${tool.name}${tool.argsPreview ? ` (${tool.argsPreview})` : ""}`);
      }
    }
  } else {
    lines.push("[Requested review target]");
    lines.push(contextPack.request || "(empty)");
    if (contextPack.gitContext?.sessionFile) {
      lines.push("");
      lines.push("[Current session]");
      lines.push(`session=${contextPack.gitContext.sessionFile}`);
    }
    if (contextPack.workspacePath) {
      lines.push("");
      lines.push("[Current workspace]");
      lines.push(contextPack.workspacePath);
    }
    if (contextPack.sessionContext?.userText) {
      lines.push("");
      lines.push("[Latest user request]");
      lines.push(contextPack.sessionContext.userText);
    }
    if (contextPack.sessionContext?.assistantText) {
      lines.push("");
      lines.push("[Latest assistant conclusion]");
      lines.push(contextPack.sessionContext.assistantText);
    }
    if (contextPack.sessionContext?.toolUses?.length) {
      lines.push("");
      lines.push("[Latest tool trail]");
      for (const tool of contextPack.sessionContext.toolUses) {
        lines.push(`- ${tool.name}${tool.argsPreview ? ` (${tool.argsPreview})` : ""}`);
      }
    }
  }
  return lines.join("\n").trim();
}

export function createReviewRoute(engine, { broadcast, taskRuntime = null } = {}) {
  const route = new Hono();

  route.post("/review/follow-up-task", async (c) => {
    if (!taskRuntime) {
      return c.json({ error: isZh() ? "任务运行器不可用" : "Task runtime unavailable" }, 503);
    }

    const body = await c.req.json().catch(() => ({}));
    const structuredReview = body?.structuredReview;
    const findings = Array.isArray(structuredReview?.findings) ? structuredReview.findings : [];
    if (!structuredReview || findings.length === 0) {
      return c.json({ error: isZh() ? "缺少可执行的 review 发现项" : "Missing executable review findings" }, 400);
    }

    const sessionPath = typeof body.sessionPath === "string" && body.sessionPath.trim()
      ? body.sessionPath.trim()
      : (engine.currentSessionPath || null);
    const followUpPrompt = typeof body.followUpPrompt === "string" ? body.followUpPrompt : null;
    const contextPack = body.contextPack && typeof body.contextPack === "object" ? body.contextPack : null;
    const reviewerName = typeof body.reviewerName === "string" ? body.reviewerName : null;
    const title = buildReviewFollowUpTaskTitle(structuredReview, { zh: isZh() });
    const prompt = buildReviewFollowUpTaskPrompt({
      structuredReview,
      contextPack,
      followUpPrompt,
      reviewerName,
    }, { zh: isZh() });

    const task = taskRuntime.createReviewFollowUpTask({
      reviewId: typeof body.reviewId === "string" ? body.reviewId : null,
      title,
      prompt,
      structuredReview,
      contextPack,
      followUpPrompt,
      reviewerName,
      sessionPath,
    });

    return c.json({ ok: true, task });
  });

  route.get("/review/config", async (c) => {
    const config = await ensureDefaultReviewerAgents(engine);
    return c.json(config);
  });

  route.put("/review/config", async (c) => {
    await ensureDefaultReviewerAgents(engine);
    const body = await c.req.json().catch(() => ({}));
    const candidates = listReviewCandidates(engine);
    const defaultReviewer = body.defaultReviewer === undefined
      ? undefined
      : normalizeReviewerKind(body.defaultReviewer);
    const hanakoReviewerId = body.hanakoReviewerId === undefined
      ? undefined
      : normalizeReviewerId(body.hanakoReviewerId);
    const butterReviewerId = body.butterReviewerId === undefined
      ? undefined
      : normalizeReviewerId(body.butterReviewerId);

    if (!validateReviewerSelection(candidates, hanakoReviewerId, "hanako")) {
      return c.json({ error: isZh() ? "所选 Hanako 审查人无效" : "Selected Hanako reviewer is invalid" }, 400);
    }

    if (!validateReviewerSelection(candidates, butterReviewerId, "butter")) {
      return c.json({ error: isZh() ? "所选 Butter 审查人无效" : "Selected Butter reviewer is invalid" }, 400);
    }

    const config = saveReviewConfig(engine, {
      ...(defaultReviewer !== undefined ? { defaultReviewer } : {}),
      ...(hanakoReviewerId !== undefined ? { hanakoReviewerId } : {}),
      ...(butterReviewerId !== undefined ? { butterReviewerId } : {}),
    });

    return c.json(config);
  });

  route.post("/review", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { context } = body;

    if (!context || typeof context !== "string") {
      return c.json({ error: "missing context" }, 400);
    }

    const reviewConfig = await ensureDefaultReviewerAgents(engine);
    const reviewerKind = body.reviewerKind === "butter" ? "butter" : reviewConfig.defaultReviewer;
    const reviewer = resolveReviewer(reviewConfig.candidates, reviewerKind, reviewConfig, engine.currentAgentId);

    if (!reviewer) {
      return c.json({
        error: reviewerMissingMessage(reviewerKind),
        code: "reviewer_not_configured",
        reviewerKind,
        config: reviewConfig,
      }, 400);
    }

    try {
      const loadedReviewer = typeof engine.ensureAgentLoaded === "function"
        ? await engine.ensureAgentLoaded(reviewer.id)
        : engine.getAgent?.(reviewer.id);
      if (!loadedReviewer) {
        return c.json({
          error: isZh()
            ? `复查人 agent "${reviewer.id}" 不存在或未初始化`
            : `Reviewer agent "${reviewer.id}" does not exist or is not initialized`,
          reviewerKind,
          code: "reviewer_agent_missing",
        }, 500);
      }
    } catch (err) {
      return c.json({
        error: err?.message || (isZh() ? "复查人初始化失败" : "Reviewer initialization failed"),
        reviewerKind,
        code: "reviewer_agent_init_failed",
      }, 500);
    }

    const reviewerName = reviewerDisplayName(reviewer.yuan);
    const reviewerAgentName = reviewer.name;
    const sessionPath = engine.currentSessionPath || null;
    const reviewId = `review-${Date.now()}`;
    const emitProgress = createReviewProgressEmitter({ broadcast, reviewId, sessionPath, reviewer });

    broadcast({
      type: "review_start",
      reviewId,
      sessionPath,
      reviewerName,
      reviewerAgent: reviewer.id,
      reviewerAgentName,
      reviewerYuan: reviewer.yuan,
      reviewerHasAvatar: reviewer.hasAvatar,
    });

    (async () => {
      try {
        emitProgress("packing_context");
        const contextPack = buildReviewContextPack(context, engine);
        const prompt = formatContextPack(contextPack);

        emitProgress("reviewing");
        const result = await runReviewerSessionWithFallback(
          engine,
          reviewer.id,
          [{ text: prompt, capture: true }],
          {
            engine,
            signal: AbortSignal.timeout(REVIEW_EXEC_TIMEOUT_MS),
            sessionSuffix: "review",
            systemAppend: buildReviewSystemAppend(),
            readOnly: true,
            keepSession: false,
          },
        );

        emitProgress("structuring");
        const structured = parseStructuredReview(result || "");
        const followUpPrompt = structured ? buildReviewFollowUp(structured) : null;

        emitProgress("done", {
          verdict: structured?.verdict || null,
          findingsCount: structured?.findings?.length || 0,
          workflowGate: structured?.workflowGate || "clear",
        });

        broadcast({
          type: "review_result",
          reviewId,
          sessionPath,
          reviewerName,
          reviewerAgent: reviewer.id,
          reviewerAgentName,
          reviewerYuan: reviewer.yuan,
          reviewerHasAvatar: reviewer.hasAvatar,
          content: result || (isZh() ? "（review 无输出）" : "(no review output)"),
          structured,
          contextPack,
          followUpPrompt,
        });
      } catch (err) {
        emitProgress("done", { error: err?.message || "Review failed", workflowGate: "follow_up" });
        broadcast({
          type: "review_result",
          reviewId,
          sessionPath,
          reviewerName,
          reviewerAgent: reviewer.id,
          reviewerAgentName,
          reviewerYuan: reviewer.yuan,
          reviewerHasAvatar: reviewer.hasAvatar,
          content: "",
          error: err?.message || "Review failed",
        });
      }
    })();

    return c.json({
      reviewId,
      sessionPath,
      reviewerName,
      reviewerAgent: reviewer.id,
      reviewerAgentName,
      reviewerYuan: reviewer.yuan,
      reviewerHasAvatar: reviewer.hasAvatar,
    });
  });

  route.get("/review/agents", async (c) => {
    const config = await ensureDefaultReviewerAgents(engine);
    const reviewers = [...config.candidates.hanako, ...config.candidates.butter];
    return c.json({ reviewers, config });
  });

  return route;
}
