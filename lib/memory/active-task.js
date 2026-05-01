/**
 * active-task.js — 当前任务状态
 *
 * 这是记忆系统里的低延迟工作态层：不依赖 LLM、不做向量检索，
 * 只保存用户当前正在推进的目标、下一步和少量注意事项。
 */

import fs from "fs";
import path from "path";

const ACTIVE_STATUSES = new Set(["idle", "active", "blocked", "done"]);

function cleanString(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function cleanArray(value, maxItems = 6, maxLength = 300) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeStatus(value) {
  const status = cleanString(value, 30).toLowerCase().replace(/\s+/g, "_");
  return ACTIVE_STATUSES.has(status) ? status : "active";
}

function normalizeTask(input = {}) {
  const now = new Date().toISOString();
  return {
    title: cleanString(input.title, 160),
    status: normalizeStatus(input.status),
    goal: cleanString(input.goal, 800),
    next_step: cleanString(input.next_step ?? input.nextStep, 500),
    project_path: cleanString(input.project_path ?? input.projectPath, 500),
    notes: cleanArray(input.notes),
    evidence: cleanArray(input.evidence),
    source: cleanString(input.source, 120),
    updated_at: cleanString(input.updated_at ?? input.updatedAt, 80) || now,
  };
}

export class ActiveTaskMemory {
  /**
   * @param {{ filePath: string }} opts
   */
  constructor({ filePath }) {
    this.filePath = filePath;
  }

  get() {
    try {
      if (!this.filePath || !fs.existsSync(this.filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      const task = normalizeTask(parsed);
      return task.title || task.goal || task.next_step || task.notes.length > 0 ? task : null;
    } catch {
      return null;
    }
  }

  set(task) {
    const normalized = normalizeTask(task);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2));
    fs.renameSync(tmpPath, this.filePath);
    return normalized;
  }

  patch(partial) {
    return this.set({
      ...(this.get() || {}),
      ...(partial || {}),
      updated_at: new Date().toISOString(),
    });
  }

  clear() {
    try {
      if (this.filePath && fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    } catch {}
  }

  formatForPrompt(isZh = true) {
    const task = this.get();
    if (!task || task.status === "idle" || task.status === "done") return "";

    const lines = [];
    if (task.title) lines.push(isZh ? `- 标题：${task.title}` : `- Title: ${task.title}`);
    if (task.goal) lines.push(isZh ? `- 目标：${task.goal}` : `- Goal: ${task.goal}`);
    lines.push(isZh ? `- 状态：${task.status}` : `- Status: ${task.status}`);
    if (task.next_step) lines.push(isZh ? `- 下一步：${task.next_step}` : `- Next step: ${task.next_step}`);
    if (task.project_path) lines.push(isZh ? `- 关联项目：${task.project_path}` : `- Project: ${task.project_path}`);
    for (const note of task.notes) {
      lines.push(isZh ? `- 注意：${note}` : `- Note: ${note}`);
    }
    for (const item of task.evidence) {
      lines.push(isZh ? `- 证据：${item}` : `- Evidence: ${item}`);
    }

    const header = isZh ? "## 当前任务状态" : "## Current Task State";
    const rule = isZh
      ? "当前对话里的新信息优先于这里的状态。"
      : "New information in the current conversation takes priority over this state.";
    return `${header}\n\n${rule}\n${lines.join("\n")}`;
  }
}
