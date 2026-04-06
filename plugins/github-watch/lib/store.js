import crypto from "crypto";
import fs from "fs";
import path from "path";

const EVENTS_FILE = "events.json";

function safeJsonRead(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readBooleanConfig(ctx, key, fallback) {
  const value = ctx.config.get(key);
  if (value === undefined) return fallback;
  return value !== false;
}

export function verifyGithubWebhookSignature(secret, payloadText, signatureHeader) {
  if (!secret) return true;
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(payloadText).digest("hex")}`;
  return timingSafeEqualHex(expected, signatureHeader.trim());
}

export function normalizeGithubEvent({ eventName, deliveryId, payload }) {
  const repository = payload?.repository?.full_name || "unknown/unknown";
  const pullRequest = payload?.pull_request || null;
  const action = payload?.action || "unknown";
  const sender = payload?.sender?.login || null;
  const prNumber = pullRequest?.number || null;
  const title = pullRequest?.title || payload?.repository?.full_name || repository;

  const idSource = deliveryId || [eventName, repository, action, prNumber || title].join(':');
  const stableId = crypto.createHash('sha1').update(idSource).digest('hex');

  return {
    id: stableId,
    deliveryId: deliveryId || null,
    event: eventName,
    action,
    repository,
    sender,
    pullRequest: pullRequest ? {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.html_url,
      state: pullRequest.state,
      draft: !!pullRequest.draft,
      headRef: pullRequest.head?.ref || null,
      baseRef: pullRequest.base?.ref || null,
      changedFiles: pullRequest.changed_files ?? null,
      additions: pullRequest.additions ?? null,
      deletions: pullRequest.deletions ?? null,
    } : null,
    summary: prNumber
      ? `PR #${prNumber} ${action}: ${title}`
      : `${eventName} ${action}: ${title}`,
    receivedAt: new Date().toISOString(),
    raw: payload,
  };
}

export function loadEvents(ctx) {
  const filePath = path.join(ctx.dataDir, EVENTS_FILE);
  const loaded = safeJsonRead(filePath, []);
  return Array.isArray(loaded) ? loaded : [];
}

export function saveEvents(ctx, events) {
  const filePath = path.join(ctx.dataDir, EVENTS_FILE);
  atomicWriteJson(filePath, events);
}

export function appendGithubEvent(ctx, event) {
  const maxEvents = Math.max(1, Number(ctx.config.get("max_events") || 100));
  const current = loadEvents(ctx).filter((item) => item?.id !== event.id);
  current.unshift(event);
  const trimmed = current.slice(0, maxEvents);
  saveEvents(ctx, trimmed);
  return trimmed;
}

export function shouldAutoReview(ctx, event) {
  if (!readBooleanConfig(ctx, "auto_review", true)) return false;
  if (!event?.pullRequest) return false;
  if (event.event !== "pull_request") return false;
  return ["opened", "synchronize", "reopened", "ready_for_review"].includes(event.action);
}

export function shouldNotify(ctx, event) {
  if (!readBooleanConfig(ctx, "notify_on_pr", true)) return false;
  if (!event?.pullRequest) return false;
  return ["opened", "synchronize", "reopened", "ready_for_review", "closed"].includes(event.action);
}

function buildReviewPrompt(event) {
  const pr = event.pullRequest;
  const repo = event.repository;
  const lines = [
    `Repository: ${repo}`,
    `Event: ${event.event}`,
    `Action: ${event.action}`,
    `PR: #${pr.number} ${pr.title}`,
    `URL: ${pr.url || ""}`,
    `Base: ${pr.baseRef || ""}`,
    `Head: ${pr.headRef || ""}`,
    `Changed files: ${pr.changedFiles ?? "unknown"}`,
    `Additions: ${pr.additions ?? "unknown"}`,
    `Deletions: ${pr.deletions ?? "unknown"}`,
  ];
  return [
    "Review this GitHub pull request event at a high level.",
    "Focus on likely risk areas, missing validation, and what the user should inspect next.",
    "Do not invent file-level details you cannot see.",
    "Keep it concise: one short summary line, then 2-4 bullets.",
    "",
    ...lines,
  ].join("\n");
}

export async function maybeAutoReview(ctx, event) {
  const engine = ctx.engine;
  if (!engine || !shouldAutoReview(ctx, event)) return null;

  const requestedAgentId = String(ctx.config.get("auto_review_agent") || "").trim();
  const availableAgents = engine.listAgents?.() || [];
  const fallbackAgentId = requestedAgentId
    ? (engine.getAgent?.(requestedAgentId) ? requestedAgentId : null)
    : (engine.currentAgentId || availableAgents[0]?.id || null);

  if (!fallbackAgentId || typeof engine.executeIsolated !== "function") return null;

  const result = await engine.executeIsolated(buildReviewPrompt(event), {
    agentId: fallbackAgentId,
    builtinFilter: [],
    toolFilter: [],
    persist: false,
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return {
    agentId: fallbackAgentId,
    content: result?.replyText || "",
  };
}
