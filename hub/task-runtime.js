import path from "path";
import { TaskStore, TASK_STATUS } from "../lib/tasks/task-store.js";
import { runAgentSession } from "./agent-executor.js";
import { getLocale } from "../server/i18n.js";

const TERMINAL_TASK_STATUSES = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
]);

const APPROVAL_ACTIONS = new Set([
  "confirmed",
  "confirmed_once",
  "confirmed_session",
  "confirmed_persistent",
  "rejected",
  "timeout",
  "aborted",
]);

function isZh() {
  return getLocale().startsWith("zh");
}

function pluralize(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.join("\n");
}

function summarizeText(text, max = 180) {
  if (typeof text !== "string") return null;
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function latestTaskOutput(task) {
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    if (artifact?.type === "text" && typeof artifact.text === "string") {
      return artifact.text;
    }
  }
  return null;
}

function cloneRunner(runner) {
  if (!runner || typeof runner !== "object") return { kind: "generic", payload: {} };
  return structuredClone(runner);
}

function taskQueuedLabel(task) {
  if (task?.runner?.kind === "review") {
    return isZh() ? "等待复查" : "Queued for review";
  }
  return isZh() ? "等待执行" : "Queued";
}

function taskRunningLabel(task) {
  if (task?.runner?.kind === "review") {
    return isZh() ? "复查中" : "Reviewing";
  }
  return isZh() ? "执行中" : "Running";
}

function taskWaitingApprovalLabel() {
  return isZh() ? "等待授权" : "Waiting for approval";
}

function approvalSummary(entry) {
  const payload = entry?.payload && typeof entry.payload === "object" ? entry.payload : null;
  return payload?.description || payload?.reason || payload?.category || entry?.confirmId || null;
}

export class TaskRuntime {
  constructor({ hub, engine, lynnHome, reviewRouteFactory, reviewRunner } = {}) {
    this._hub = hub;
    this._engine = engine;
    this._reviewRouteFactory = reviewRouteFactory || null;
    this._reviewRunner = reviewRunner || null;
    this._store = new TaskStore(path.join(lynnHome, "tasks", "tasks.json"));
    this._running = new Map();
    this._confirmIndex = new Map();
    this._sessionIndex = new Map();
    this._wiredConfirmStore = null;
  }

  get store() {
    return this._store;
  }

  listTasks() {
    return this._store.list();
  }

  getTask(taskId) {
    return this._store.get(taskId);
  }

  bindConfirmStore(confirmStore) {
    if (!confirmStore || this._wiredConfirmStore === confirmStore) return;
    this._wiredConfirmStore = confirmStore;

    const originalCreate = confirmStore.create.bind(confirmStore);
    confirmStore.create = (kind, payload, sessionPath, timeoutMs) => {
      const created = originalCreate(kind, payload, sessionPath, timeoutMs);
      const taskId = this._resolveTaskIdForConfirmation(payload, sessionPath);
      if (taskId) {
        this._confirmIndex.set(created.confirmId, taskId);
        this._store.appendApproval(taskId, {
          confirmId: created.confirmId,
          kind,
          status: "pending",
          payload: this._sanitizeApprovalPayload(payload),
        });
        this._store.update(taskId, {
          status: TASK_STATUS.WAITING_APPROVAL,
          progress: this._withProgress(taskId, { currentLabel: taskWaitingApprovalLabel() }),
        });
        this._emitTaskUpdate(taskId);
      }
      return created;
    };

    const originalResolve = confirmStore.resolve.bind(confirmStore);
    confirmStore.resolve = (confirmId, action, value) => {
      const resolved = originalResolve(confirmId, action, value);
      if (resolved) this._markApprovalResolution(confirmId, action, value);
      return resolved;
    };

    const previousResolved = confirmStore.onResolved;
    confirmStore.onResolved = (confirmId, action) => {
      try {
        previousResolved?.(confirmId, action);
      } finally {
        this._markApprovalResolution(confirmId, action, null);
      }
    };
  }

  createTask(input = {}) {
    const task = this._store.create(input);
    this._emitTaskUpdate(task.id);
    return task;
  }

  async runTask(taskId) {
    if (this._running.has(taskId)) return this._running.get(taskId).promise;
    const task = this._store.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const controller = new AbortController();
    const runnerPromise = this._executeTask(taskId, controller)
      .finally(() => {
        this._running.delete(taskId);
      });

    this._running.set(taskId, { controller, promise: runnerPromise });
    return runnerPromise;
  }

  resumePendingTasks() {
    const resumable = this._store.list().filter((task) =>
      [TASK_STATUS.PENDING, TASK_STATUS.RUNNING, TASK_STATUS.WAITING_APPROVAL].includes(task.status),
    );

    for (const task of resumable) {
      this._restoreSessionLinks(task);
      if (task.status === TASK_STATUS.WAITING_APPROVAL) continue;
      void this.runTask(task.id);
    }
  }

  cancelTask(taskId) {
    const task = this._store.get(taskId);
    if (!task) return null;

    const running = this._running.get(taskId);
    if (running) {
      running.controller.abort();
    }

    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return task;
    }

    const updated = this._store.update(taskId, {
      status: TASK_STATUS.CANCELLED,
      finishedAt: new Date().toISOString(),
      progress: this._withProgress(taskId, { currentLabel: isZh() ? "已取消" : "Cancelled" }),
    });
    if (updated) {
      this._store.appendEvent(taskId, {
        type: "task.cancelled",
        message: isZh() ? "任务已取消" : "Task cancelled",
      });
      this._clearSessionLinks(taskId, updated);
      this._emitTaskUpdate(taskId);
    }
    return updated;
  }

  retryTask(taskId) {
    const task = this._store.get(taskId);
    if (!task) return null;

    const runner = cloneRunner(task.runner);
    const metadata = {
      ...(task.metadata || {}),
      retryOf: task.id,
      retriedAt: new Date().toISOString(),
    };

    if (runner.kind === "review") {
      return this.createReviewTask({
        title: task.title,
        context: runner.payload?.context || "",
        reviewerKind: runner.payload?.reviewerKind || "hanako",
        sessionPath: task.sessionPath || null,
        source: task.source || "retry",
        metadata: {
        ...(metadata || {}),
        autoRun: metadata?.autoRun === undefined ? !!autoRun : !!metadata.autoRun,
      },
      });
    }

    return this.createDelegateTask({
      title: task.title,
      prompt: runner.payload?.prompt || "",
      agentId: runner.payload?.agentId || task.agentId || this._engine.currentAgentId,
      sessionPath: task.sessionPath || null,
      source: task.source || "retry",
      readOnly: runner.payload?.readOnly !== false,
      model: runner.payload?.model || null,
      systemAppend: runner.payload?.systemAppend || null,
      noMemory: !!runner.payload?.noMemory,
      noTools: !!runner.payload?.noTools,
      cwdOverride: runner.payload?.cwdOverride || null,
      metadata,
    });
  }

  async _executeTask(taskId, controller) {
    const task = this._store.get(taskId);
    if (!task) return null;

    this._restoreSessionLinks(task);
    this._store.update(taskId, {
      status: TASK_STATUS.RUNNING,
      startedAt: task.startedAt || new Date().toISOString(),
      finishedAt: null,
      error: null,
      progress: this._withProgress(taskId, { currentLabel: taskRunningLabel(task) }),
    });
    this._store.appendEvent(taskId, {
      type: "task.started",
      message: isZh() ? `开始执行：${task.title}` : `Started: ${task.title}`,
    });
    this._emitTaskUpdate(taskId);

    try {
      let result;
      switch (task.runner?.kind) {
        case "delegate":
          result = await this._runDelegateTask(taskId, controller.signal);
          break;
        case "review":
          result = await this._runReviewTask(taskId, controller.signal);
          break;
        default:
          throw new Error(`Unsupported task runner: ${task.runner?.kind || "unknown"}`);
      }

      this._store.update(taskId, {
        status: TASK_STATUS.COMPLETED,
        finishedAt: new Date().toISOString(),
        resultSummary: result?.summary || null,
        error: null,
        progress: this._withProgress(taskId, { currentLabel: isZh() ? "已完成" : "Completed" }),
      });
      this._store.appendEvent(taskId, {
        type: "task.completed",
        message: isZh() ? "任务完成" : "Task completed",
        data: result || null,
      });
      this._emitTaskUpdate(taskId);
      return this._store.get(taskId);
    } catch (err) {
      const aborted = controller.signal.aborted || err?.name === "AbortError";
      this._store.update(taskId, {
        status: aborted ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED,
        finishedAt: new Date().toISOString(),
        error: err?.message || String(err),
        progress: this._withProgress(taskId, {
          currentLabel: aborted
            ? (isZh() ? "已取消" : "Cancelled")
            : (isZh() ? "执行失败" : "Failed"),
        }),
      });
      this._store.appendEvent(taskId, {
        type: aborted ? "task.cancelled" : "task.failed",
        level: aborted ? "info" : "error",
        message: aborted
          ? (isZh() ? "任务被中止" : "Task aborted")
          : (err?.message || String(err)),
      });
      this._emitTaskUpdate(taskId);
      throw err;
    }
  }

  async _runDelegateTask(taskId, signal) {
    const task = this._store.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const runner = task.runner?.payload || {};
    const agentId = runner.agentId || this._engine.currentAgentId;
    const promptText = typeof runner.prompt === "string" ? runner.prompt : "";
    if (!promptText.trim()) {
      throw new Error(isZh() ? "任务提示词为空" : "Task prompt is empty");
    }

    const rounds = [{ text: promptText, capture: true }];
    const result = await runAgentSession(agentId, rounds, {
      engine: this._engine,
      signal,
      sessionSuffix: "tasks",
      keepSession: true,
      systemAppend: runner.systemAppend || null,
      readOnly: runner.readOnly !== false,
      noMemory: !!runner.noMemory,
      noTools: !!runner.noTools,
      cwdOverride: runner.cwdOverride || null,
      sessionPath: runner.runtimeSessionPath || null,
      model: runner.model || null,
      onSessionReady: (sessionPath) => {
        if (!sessionPath) return;
        this._linkSessionToTask(taskId, sessionPath);
        this._store.update(taskId, (current) => ({
          runner: {
            ...current.runner,
            payload: {
              ...(current.runner?.payload || {}),
              runtimeSessionPath: sessionPath,
            },
          },
        }));
        this._store.addArtifact(taskId, {
          type: "session",
          label: isZh() ? "任务会话" : "Task session",
          sessionPath,
          sessionFile: path.basename(sessionPath),
        });
        this._emitTaskUpdate(taskId);
      },
    });

    const summary = summarizeText(result) || (isZh() ? "已生成结果" : "Result generated");
    this._store.addArtifact(taskId, {
      type: "text",
      label: isZh() ? "任务结果" : "Task output",
      text: result,
    });
    this._store.appendEvent(taskId, {
      type: "task.output",
      message: summary,
    });
    return { summary, text: result };
  }

  async _runReviewTask(taskId, signal) {
    const task = this._store.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const runner = task.runner?.payload || {};
    const reviewRunner = this._reviewRunner || this._reviewRouteFactory?.()?.runDetachedReview;
    if (typeof reviewRunner !== "function") {
      throw new Error(isZh() ? "Review 运行器不可用" : "Review runner unavailable");
    }

    const result = await reviewRunner({
      context: runner.context,
      reviewerKind: runner.reviewerKind,
      taskId,
      signal,
      sessionPath: task.sessionPath || null,
    });

    const text = result?.content || "";
    const summary = summarizeText(text) || (isZh() ? "复查已完成" : "Review completed");
    this._store.addArtifact(taskId, {
      type: "text",
      label: isZh() ? "复查结果" : "Review result",
      text,
      reviewerName: result?.reviewerName || null,
    });
    if (result?.structured) {
      this._store.addArtifact(taskId, {
        type: "review",
        label: isZh() ? "结构化复查结果" : "Structured review",
        structured: result.structured,
        followUpPrompt: result.followUpPrompt || null,
        reviewerName: result?.reviewerName || null,
      });
    }
    return {
      summary,
      text,
      reviewerName: result?.reviewerName || null,
      structured: result?.structured || null,
    };
  }

  createDelegateTask({
    autoRun = true,
    title,
    prompt,
    agentId = null,
    sessionPath = null,
    source = "chat",
    readOnly = true,
    model = null,
    systemAppend = null,
    noMemory = false,
    noTools = false,
    cwdOverride = null,
    metadata = {},
  } = {}) {
    const task = this.createTask({
      type: "delegate",
      title: title || (isZh() ? "长任务" : "Long-running task"),
      source,
      agentId: agentId || this._engine.currentAgentId,
      sessionPath: sessionPath || this._engine.currentSessionPath || null,
      metadata: {
        ...(metadata || {}),
        autoRun: metadata?.autoRun === undefined ? !!autoRun : !!metadata.autoRun,
      },
      runner: {
        kind: "delegate",
        payload: {
          agentId: agentId || this._engine.currentAgentId,
          prompt,
          model,
          readOnly,
          systemAppend,
          noMemory,
          noTools,
          cwdOverride,
          runtimeSessionPath: null,
        },
      },
      progress: {
        total: null,
        completed: 0,
        currentLabel: taskQueuedLabel({ runner: { kind: "delegate" } }),
      },
    });
    if (autoRun) void this.runTask(task.id);
    return task;
  }

  createReviewFollowUpTask({
    reviewId = null,
    title = null,
    prompt = null,
    structuredReview = null,
    contextPack = null,
    followUpPrompt = null,
    reviewerName = null,
    sessionPath = null,
    source = "review_follow_up",
    metadata = {},
  } = {}) {
    const findings = Array.isArray(structuredReview?.findings) ? structuredReview.findings : [];
    if (findings.length === 0) {
      throw new Error(isZh() ? "缺少可执行的 review 发现项" : "Missing executable review findings");
    }

    return this.createDelegateTask({
      title: title || (isZh() ? "处理复查发现" : "Address review findings"),
      prompt: typeof prompt === "string" ? prompt : (followUpPrompt || ""),
      agentId: this._engine.currentAgentId,
      sessionPath: sessionPath || this._engine.currentSessionPath || null,
      source,
      readOnly: false,
      metadata: {
        ...metadata,
        source,
        reviewId,
        reviewerName,
        findingsCount: findings.length,
        workflowGate: structuredReview?.workflowGate || null,
        structuredReview,
        contextPack,
        followUpPrompt,
      },
    });
  }

  createReviewTask({
    title,
    context,
    reviewerKind = "hanako",
    sessionPath = null,
    source = "review",
    metadata = {},
  } = {}) {
    const task = this.createTask({
      type: "review",
      title: title || (isZh() ? "复查任务" : "Review task"),
      source,
      agentId: this._engine.currentAgentId,
      sessionPath: sessionPath || this._engine.currentSessionPath || null,
      metadata,
      runner: {
        kind: "review",
        payload: {
          context,
          reviewerKind,
        },
      },
      progress: {
        total: null,
        completed: 0,
        currentLabel: taskQueuedLabel({ runner: { kind: "review" } }),
      },
    });
    void this.runTask(task.id);
    return task;
  }

  buildTaskChatBlock(taskId) {
    const task = this._store.get(taskId);
    if (!task) return null;
    return this._asTaskChatBlock(task);
  }

  injectTaskContext(taskId, lines = []) {
    const task = this._store.get(taskId);
    if (!task) return lines;
    const output = latestTaskOutput(task);
    if (output) {
      lines.push(isZh() ? "上一轮结果：" : "Latest task output:");
      lines.push(output);
    }
    const approvals = Array.isArray(task.approvals)
      ? task.approvals.filter((item) => item?.status && item.status !== "pending")
      : [];
    if (approvals.length > 0) {
      lines.push(isZh() ? "审批记录：" : "Approvals:");
      lines.push(pluralize(approvals.map((item) => `- ${item.status}: ${approvalSummary(item)}`)));
    }
    return lines;
  }

  _resolveTaskIdForConfirmation(payload, sessionPath) {
    return payload?.taskId || payload?.metadata?.taskId || this._sessionIndex.get(sessionPath || "") || null;
  }

  _markApprovalResolution(confirmId, action, value) {
    if (!APPROVAL_ACTIONS.has(action)) return;
    const taskId = this._confirmIndex.get(confirmId);
    if (!taskId) return;

    const terminalFailure = action === "rejected" || action === "timeout" || action === "aborted";
    const task = this._store.update(taskId, (current) => {
      const nextStatus = terminalFailure ? TASK_STATUS.FAILED : TASK_STATUS.RUNNING;
      const nextLabel = nextStatus === TASK_STATUS.RUNNING
        ? taskRunningLabel(current)
        : (isZh() ? "等待处理" : "Needs attention");
      return {
        status: nextStatus,
        finishedAt: terminalFailure ? new Date().toISOString() : null,
        error: action === "rejected"
          ? (isZh() ? "授权被拒绝" : "Authorization rejected")
          : action === "timeout"
            ? (isZh() ? "授权超时" : "Authorization timed out")
            : action === "aborted"
              ? (isZh() ? "授权已取消" : "Authorization aborted")
              : null,
        progress: {
          ...(current.progress || {}),
          currentLabel: nextLabel,
        },
      };
    });

    if (task) {
      this._store.appendApproval(taskId, {
        confirmId,
        status: action,
        value: value ?? null,
      });
      this._store.appendEvent(taskId, {
        type: "task.approval",
        message: `${confirmId}: ${action}`,
        data: { confirmId, action, value: value ?? null },
      });
      this._emitTaskUpdate(taskId);
    }

    if (action !== "pending") this._confirmIndex.delete(confirmId);
  }

  _restoreSessionLinks(task) {
    const sessionPath = task?.runner?.payload?.runtimeSessionPath;
    if (typeof sessionPath === "string" && sessionPath) {
      this._sessionIndex.set(sessionPath, task.id);
    }
  }

  _clearSessionLinks(taskId, task) {
    const sessionPath = task?.runner?.payload?.runtimeSessionPath;
    if (sessionPath && this._sessionIndex.get(sessionPath) === taskId) {
      this._sessionIndex.delete(sessionPath);
    }
  }

  _linkSessionToTask(taskId, sessionPath) {
    if (!sessionPath) return;
    this._sessionIndex.set(sessionPath, taskId);
  }

  _sanitizeApprovalPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    return {
      command: payload.command || null,
      reason: payload.reason || null,
      description: payload.description || null,
      category: payload.category || null,
      identifier: payload.identifier || null,
      trustedRoot: payload.trustedRoot || null,
      title: payload.title || null,
      message: payload.message || null,
    };
  }

  _withProgress(taskId, patch) {
    const task = this._store.get(taskId);
    return {
      ...(task?.progress || {}),
      ...(patch || {}),
    };
  }

  _asTaskChatBlock(task) {
    return {
      type: "task",
      taskId: task.id,
      title: task.title,
      status: task.status,
      source: task.source,
      sessionPath: task.sessionPath || null,
      agentId: task.agentId || null,
      metadata: task.metadata || null,
      resultSummary: task.resultSummary,
      error: task.error,
      currentLabel: task.progress?.currentLabel || null,
      updatedAt: task.updatedAt,
    };
  }

  _recordTaskActivity(task) {
    if (!task?.id) return;
    if (task.metadata?.activityRecorded) return;

    const startedAt = task.startedAt ? Date.parse(task.startedAt) : Date.now();
    const finishedAt = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
    const failed = task.status === TASK_STATUS.FAILED;
    const cancelled = task.status === TASK_STATUS.CANCELLED;
    const type = task.source === "review_follow_up" ? "review_follow_up" : "delegate";
    const summary = task.resultSummary || task.title || (isZh() ? "后台任务" : "Background task");
    const entry = {
      id: `task-${task.id}`,
      type,
      label: task.title || null,
      agentId: task.agentId,
      agentName: this._engine.getAgent?.(task.agentId)?.agentName || task.agentId,
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      finishedAt: Number.isFinite(finishedAt) ? finishedAt : Date.now(),
      summary: failed
        ? `${summary}${isZh() ? " 执行失败" : " failed"}`
        : cancelled
          ? `${summary}${isZh() ? " 已取消" : " cancelled"}`
          : summary,
      sessionFile: null,
      status: failed ? "error" : cancelled ? "cancelled" : "done",
      error: task.error || null,
      taskId: task.id,
      source: task.source || null,
    };

    const store = this._engine.getActivityStore?.(task.agentId);
    store?.add?.(entry);
    this._store.update(task.id, (current) => ({
      metadata: {
        ...(current.metadata || {}),
        activityRecorded: true,
      },
    }));
    this._hub?.eventBus?.emit({ type: "activity_update", activity: entry }, null);
  }

  _emitTaskUpdate(taskId) {
    const task = this._store.get(taskId);
    if (!task) return;
    this._hub?.eventBus?.emit({ type: "task_update", task: this._asTaskChatBlock(task) }, task.sessionPath || null);
    if (task.metadata?.autoRun && TERMINAL_TASK_STATUSES.has(task.status)) {
      this._recordTaskActivity(task);
    }
  }
}
