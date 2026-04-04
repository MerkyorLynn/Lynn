import fs from "fs";
import path from "path";
import crypto from "crypto";

const MAX_TASKS = 500;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export const TASK_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  WAITING_APPROVAL: "waiting_approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

export class TaskStore {
  constructor(filePath) {
    this._filePath = filePath;
    this._tasks = [];
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._filePath, "utf-8"));
      this._tasks = asArray(raw?.tasks);
    } catch {
      this._tasks = [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    const tmpPath = `${this._filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ tasks: this._tasks }, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, this._filePath);
  }

  _trim() {
    if (this._tasks.length <= MAX_TASKS) return;
    this._tasks = this._tasks
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
      .slice(0, MAX_TASKS);
  }

  list() {
    return this._tasks
      .slice()
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
      .map((task) => clone(task));
  }

  get(taskId) {
    const task = this._tasks.find((entry) => entry.id === taskId);
    return task ? clone(task) : null;
  }

  create(input = {}) {
    const createdAt = nowIso();
    const task = {
      id: input.id || `task_${crypto.randomUUID()}`,
      type: input.type || "generic",
      title: input.title || input.type || "Task",
      status: input.status || TASK_STATUS.PENDING,
      scope: input.scope || "agent",
      agentId: input.agentId || null,
      sessionPath: input.sessionPath || null,
      source: input.source || "manual",
      createdAt,
      updatedAt: createdAt,
      startedAt: input.startedAt || null,
      finishedAt: input.finishedAt || null,
      resultSummary: input.resultSummary || null,
      error: input.error || null,
      interruptible: input.interruptible !== false,
      runKey: input.runKey || null,
      runner: input.runner || {
        kind: input.type || "generic",
        payload: {},
      },
      progress: input.progress || {
        total: null,
        completed: 0,
        currentLabel: null,
      },
      review: input.review || null,
      approvals: input.approvals || [],
      events: input.events || [],
      metadata: input.metadata || {},
      artifacts: input.artifacts || [],
      snapshot: input.snapshot || null,
    };

    this._tasks.unshift(task);
    this._trim();
    this._save();
    return clone(task);
  }

  update(taskId, updater) {
    const index = this._tasks.findIndex((entry) => entry.id === taskId);
    if (index === -1) return null;

    const current = this._tasks[index];
    const partial = typeof updater === "function" ? updater(clone(current)) : updater;
    if (!partial || typeof partial !== "object") return clone(current);

    const next = {
      ...current,
      ...partial,
      updatedAt: nowIso(),
    };
    this._tasks[index] = next;
    this._save();
    return clone(next);
  }

  appendEvent(taskId, event) {
    return this.update(taskId, (task) => ({
      events: [
        ...asArray(task.events),
        {
          ts: nowIso(),
          type: event?.type || "log",
          level: event?.level || "info",
          message: event?.message || "",
          data: event?.data ?? null,
        },
      ].slice(-400),
    }));
  }

  appendApproval(taskId, approval) {
    return this.update(taskId, (task) => ({
      approvals: [
        ...asArray(task.approvals),
        {
          ts: nowIso(),
          ...approval,
        },
      ].slice(-100),
    }));
  }

  addArtifact(taskId, artifact) {
    return this.update(taskId, (task) => ({
      artifacts: [
        ...asArray(task.artifacts),
        {
          ts: nowIso(),
          ...artifact,
        },
      ].slice(-100),
    }));
  }
}
