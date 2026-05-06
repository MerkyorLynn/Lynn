import { getToolArgs, isToolCallBlock } from "../../core/llm-utils.js";

const ARTIFACT_TOOL_NAMES = new Set(["create_artifact", "create_report"]);

function normalizeArgs(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? raw : null;
}

function looksLikeHtml(content) {
  return /<!doctype\s+html|<html[\s>]|<body[\s>]|<style[\s>]/i.test(String(content || ""));
}

function normalizeArtifactType(type, content) {
  const raw = String(type || "").trim().toLowerCase();
  if (raw === "html" || raw === "markdown" || raw === "code") return raw;
  return looksLikeHtml(content) ? "html" : "markdown";
}

export function artifactPreviewDedupeKey(artifact) {
  const title = String(artifact?.title || "");
  const content = String(artifact?.content || "");
  return [
    artifact?.artifactId || "",
    artifact?.artifactType || "",
    title.slice(0, 80),
    content.length,
    content.slice(0, 120),
  ].join("|");
}

export function artifactPreviewFromToolCall(toolCall, { fallbackIdPrefix = "recovered-artifact" } = {}) {
  if (!toolCall || typeof toolCall !== "object") return null;
  const name = String(toolCall.name || toolCall.function?.name || "").trim();
  if (!ARTIFACT_TOOL_NAMES.has(name)) return null;

  const args = normalizeArgs(getToolArgs(toolCall) || toolCall.function?.arguments);
  if (!args) return null;
  const content = String(args.content || args.html || "").trim();
  if (!content) return null;

  const artifactType = normalizeArtifactType(args.type, content);
  const title = String(args.title || args.label || (artifactType === "html" ? "HTML 报告" : "生成内容")).trim();
  const callId = String(toolCall.id || toolCall.toolCallId || toolCall.callId || "").trim();
  const artifactId = String(args.artifactId || args.id || callId || `${fallbackIdPrefix}-${Date.now()}`).trim();

  return {
    type: "artifact",
    artifactId,
    artifactType,
    title,
    content,
    language: args.language || (artifactType === "html" ? "html" : undefined),
    recovered: true,
    recoveredFromTool: name,
  };
}

export function artifactPreviewsFromContent(content, opts = {}) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(isToolCallBlock)
    .map((block) => artifactPreviewFromToolCall(block, opts))
    .filter(Boolean);
}
