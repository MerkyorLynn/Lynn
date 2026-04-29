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

function toModelRef(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, provider: null } : null;
  }
  if (typeof value === "object" && value !== null) {
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!id) return null;
    const provider = typeof value.provider === "string" && value.provider.trim()
      ? value.provider.trim()
      : null;
    return { id, provider };
  }
  return null;
}

function taskQueuedLabel(task) {
  if (task?.runner?.kind === "review") {
    return isZh() ? "等待复查" : "Queued for review";
  }
  if (task?.runner?.kind === "plan") {
    return isZh() ? "等待规划" : "Queued for planning";
  }
  return isZh() ? "等待执行" : "Queued";
}

function taskRunningLabel(task) {
  if (task?.runner?.kind === "review") {
    return isZh() ? "复查中" : "Reviewing";
  }
  if (task?.runner?.kind === "plan") {
    return isZh() ? "规划中" : "Planning";
  }
  return isZh() ? "执行中" : "Running";
}

function taskWaitingApprovalLabel() {
  return isZh() ? "等待授权" : "Waiting for approval";
}

function planSystemAppend() {
  if (isZh()) {
    return [
      "你是一个任务策划人。",
      "请先澄清目标，再产出一个可执行的长任务计划。",
      "要求：",
      "- 直接输出计划，不要寒暄。",
      "- 标出目标、假设、执行步骤、风险、复查点。",
      "- 如果信息不足，明确写出缺口与保守假设。",
      "- 不要执行操作，也不要假装已经完成。",
    ].join("\n");
  }
  return [
    "You are a planning specialist.",
    "Clarify the goal first, then produce an actionable long-running task plan.",
    "Requirements:",
    "- Output the plan directly with no pleasantries.",
    "- Include objective, assumptions, execution steps, risks, and review checkpoints.",
    "- If context is missing, call out the gaps and make conservative assumptions.",
    "- Do not execute actions or claim work is already done.",
  ].join("\n");
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
    const task = this._store.create({
      ...input,
      snapshot: this._captureSnapshot(input),
    });
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

  _runTaskDetached(taskId, source = "background") {
    void this.runTask(taskId).catch((err) => {
      const message = err?.message || String(err);
      console.error(`[task-runtime] detached runTask failed (${source}) ${taskId}:`, message);
      try {
        this._store.appendEvent(taskId, {
          type: "task.detached_error",
          level: "error",
          message,
          data: { source },
        });
        this._emitTaskUpdate(taskId);
      } catch {
        // The task may have been deleted while the detached runner was failing.
      }
    });
  }

  resumePendingTasks() {
    const resumable = this._store.list().filter((task) =>
      [TASK_STATUS.PENDING, TASK_STATUS.RUNNING, TASK_STATUS.WAITING_APPROVAL].includes(task.status),
    );

    for (const task of resumable) {
      this._restoreSessionLinks(task);
      this._store.appendEvent(task.id, {
        type: "task.resume",
        message: isZh() ? "已从上次运行状态恢复" : "Recovered from previous run",
      });
      this._refreshTaskSnapshot(task.id, { resumedAt: new Date().toISOString() });
      if (task.status === TASK_STATUS.WAITING_APPROVAL) {
        this._emitTaskUpdate(task.id);
        continue;
      }
      this._store.update(task.id, {
        progress: this._withProgress(task.id, { currentLabel: isZh() ? "恢复中" : "Resuming" }),
      });
      this._emitTaskUpdate(task.id);
      this._runTaskDetached(task.id, "resume");
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
      this._refreshTaskSnapshot(taskId, { cancelledAt: updated.finishedAt || new Date().toISOString() });
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
        metadata,
      });
    }

    if (runner.kind === "plan") {
      return this.createPlanTask({
        title: task.title,
        prompt: runner.payload?.prompt || "",
        agentId: runner.payload?.agentId || task.agentId || this._engine.currentAgentId,
        sessionPath: task.sessionPath || null,
        source: task.source || "retry",
        model: runner.payload?.model || null,
        systemAppend: runner.payload?.systemAppend || null,
        noMemory: !!runner.payload?.noMemory,
        cwdOverride: runner.payload?.cwdOverride || null,
        metadata,
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
    this._refreshTaskSnapshot(taskId);
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
          // Auto verify-fix loop: after delegate tasks, optionally run review → fix cycles
          if (task.metadata?.autoVerify !== false && this._reviewRunner) {
            result = await this._autoVerifyFixLoop(taskId, result, controller.signal);
          }
          break;
        case "plan":
          result = await this._runPlanTask(taskId, controller.signal);
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
      this._refreshTaskSnapshot(taskId);
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
      this._refreshTaskSnapshot(taskId, { aborted });
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
        this._refreshTaskSnapshot(taskId, { runtimeSessionPath: sessionPath });
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

  async _runPlanTask(taskId, signal) {
    const task = this._store.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const runner = task.runner?.payload || {};
    const agentId = runner.agentId || this._engine.currentAgentId;
    const promptText = typeof runner.prompt === "string" ? runner.prompt : "";
    if (!promptText.trim()) {
      throw new Error(isZh() ? "规划提示词为空" : "Planning prompt is empty");
    }

    const systemAppend = [runner.systemAppend, planSystemAppend()].filter(Boolean).join("\n\n");
    const rounds = [{ text: promptText, capture: true }];
    const result = await runAgentSession(agentId, rounds, {
      engine: this._engine,
      signal,
      sessionSuffix: "tasks",
      keepSession: true,
      systemAppend,
      readOnly: true,
      noMemory: !!runner.noMemory,
      noTools: true,
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
          label: isZh() ? "规划会话" : "Planning session",
          sessionPath,
          sessionFile: path.basename(sessionPath),
        });
        this._refreshTaskSnapshot(taskId, { runtimeSessionPath: sessionPath });
        this._emitTaskUpdate(taskId);
      },
    });

    const summary = summarizeText(result) || (isZh() ? "已生成计划" : "Plan generated");
    this._store.addArtifact(taskId, {
      type: "text",
      label: isZh() ? "规划结果" : "Planning output",
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

  /**
   * Auto Verify→Fix loop (max 3 iterations).
   * After a delegate task completes, run review; if review finds issues, auto-fix and re-verify.
   */
  async _autoVerifyFixLoop(taskId, executeResult, signal, maxIterations = 3) {
    const reviewRunner = this._reviewRunner || this._reviewRouteFactory?.()?.runDetachedReview;
    if (typeof reviewRunner !== "function") return executeResult;

    let currentResult = executeResult;
    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) break;

      // Verify step
      const iterLabel = isZh()
        ? `自动验证 (${i + 1}/${maxIterations})`
        : `Auto-verify (${i + 1}/${maxIterations})`;
      this._store.update(taskId, {
        progress: this._withProgress(taskId, { currentLabel: iterLabel }),
      });
      this._store.appendEvent(taskId, {
        type: "task.verify_start",
        message: iterLabel,
      });
      this._emitTaskUpdate(taskId);

      let reviewResult;
      try {
        reviewResult = await reviewRunner({
          context: currentResult?.text || currentResult?.summary || "",
          reviewerKind: "hanako",
          taskId,
          signal,
          sessionPath: this._store.get(taskId)?.sessionPath || null,
        });
      } catch (err) {
        this._store.appendEvent(taskId, {
          type: "task.verify_error",
          level: "warn",
          message: isZh() ? `验证失败: ${err.message}` : `Verify failed: ${err.message}`,
        });
        break;
      }

      const structured = reviewResult?.structured;
      const gate = structured?.workflowGate || "clear";

      this._store.appendEvent(taskId, {
        type: "task.verify_done",
        message: isZh()
          ? `验证结果: ${structured?.verdict || "unknown"} (${structured?.findings?.length || 0} 项发现)`
          : `Verify result: ${structured?.verdict || "unknown"} (${structured?.findings?.length || 0} findings)`,
        data: { verdict: structured?.verdict, findingsCount: structured?.findings?.length || 0, gate },
      });
      this._emitTaskUpdate(taskId);

      // If clear, loop ends
      if (gate === "clear" || !structured?.findings?.length) {
        this._store.appendEvent(taskId, {
          type: "task.verify_passed",
          message: isZh() ? "验证通过" : "Verification passed",
        });
        break;
      }

      // Fix step
      if (signal?.aborted) break;
      const fixLabel = isZh()
        ? `自动修复 (${i + 1}/${maxIterations})`
        : `Auto-fix (${i + 1}/${maxIterations})`;
      this._store.update(taskId, {
        progress: this._withProgress(taskId, { currentLabel: fixLabel }),
      });
      this._store.appendEvent(taskId, {
        type: "task.fix_start",
        message: fixLabel,
      });
      this._emitTaskUpdate(taskId);

      // Build fix prompt from findings
      const { buildReviewFollowUpTaskPrompt } = await import("../server/review-follow-up.js");
      const fixPrompt = buildReviewFollowUpTaskPrompt({
        structuredReview: structured,
        contextPack: null,
        followUpPrompt: reviewResult?.followUpPrompt || null,
        reviewerName: reviewResult?.reviewerName || null,
      }, { zh: isZh() });

      try {
        const task = this._store.get(taskId);
        const runner = task?.runner?.payload || {};
        const agentId = runner.agentId || this._engine.currentAgentId;
        const fixResult = await runAgentSession(agentId, [{ text: fixPrompt, capture: true }], {
          engine: this._engine,
          signal,
          sessionSuffix: "tasks",
          keepSession: true,
          readOnly: false,
          sessionPath: runner.runtimeSessionPath || null,
        });

        currentResult = {
          summary: summarizeText(fixResult) || (isZh() ? "修复完成" : "Fix applied"),
          text: fixResult,
        };

        this._store.addArtifact(taskId, {
          type: "text",
          label: isZh() ? `修复结果 #${i + 1}` : `Fix output #${i + 1}`,
          text: fixResult,
        });
        this._store.appendEvent(taskId, {
          type: "task.fix_done",
          message: isZh() ? "修复完成，准备重新验证" : "Fix done, re-verifying",
        });
        this._emitTaskUpdate(taskId);
      } catch (err) {
        this._store.appendEvent(taskId, {
          type: "task.fix_error",
          level: "error",
          message: isZh() ? `修复失败: ${err.message}` : `Fix failed: ${err.message}`,
        });
        break;
      }
    }

    return currentResult;
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
    if (autoRun) this._runTaskDetached(task.id, "delegate:autoRun");
    return task;
  }

  createPlanTask({
    autoRun = true,
    title,
    prompt,
    agentId = null,
    sessionPath = null,
    source = "planner",
    model = null,
    systemAppend = null,
    noMemory = false,
    cwdOverride = null,
    metadata = {},
  } = {}) {
    const task = this.createTask({
      type: "plan",
      title: title || (isZh() ? "规划任务" : "Planning task"),
      source,
      agentId: agentId || this._engine.currentAgentId,
      sessionPath: sessionPath || this._engine.currentSessionPath || null,
      metadata: {
        ...(metadata || {}),
        autoRun: metadata?.autoRun === undefined ? !!autoRun : !!metadata.autoRun,
      },
      runner: {
        kind: "plan",
        payload: {
          agentId: agentId || this._engine.currentAgentId,
          prompt,
          model,
          systemAppend,
          noMemory,
          cwdOverride,
          runtimeSessionPath: null,
        },
      },
      progress: {
        total: null,
        completed: 0,
        currentLabel: taskQueuedLabel({ runner: { kind: "plan" } }),
      },
    });
    if (autoRun) this._runTaskDetached(task.id, "plan:autoRun");
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
    sourceResponse = null,
    executionResolution = null,
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
        sourceResponse,
        executionResolution,
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
    this._runTaskDetached(task.id, "review:autoRun");
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
      this._refreshTaskSnapshot(taskId, {
        approvalAction: action,
        lastConfirmId: confirmId,
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
      snapshot: task.snapshot || null,
    };
  }

  _captureSnapshot(taskLike = {}, extra = {}) {
    const runnerPayload = taskLike?.runner?.payload || {};
    const sessionPath = runnerPayload.runtimeSessionPath || taskLike.sessionPath || this._engine.currentSessionPath || null;
    const runtimeSession = sessionPath ? this._engine.getSessionByPath?.(sessionPath) : null;
    const sharedModels = this._engine.getSharedModels?.() || {};
    const utilityConfig = this._engine.resolveUtilityConfig?.() || {};
    const currentModel = this._engine.currentModel
      ? {
          id: this._engine.currentModel.id || null,
          provider: this._engine.currentModel.provider || null,
          name: this._engine.currentModel.name || this._engine.currentModel.id || null,
        }
      : null;

    return {
      capturedAt: new Date().toISOString(),
      agentId: taskLike.agentId || this._engine.currentAgentId || null,
      agentName: this._engine.getAgent?.(taskLike.agentId || this._engine.currentAgentId)?.agentName || null,
      sessionPath,
      runtimeSessionPath: runnerPayload.runtimeSessionPath || null,
      cwd: runtimeSession?.sessionManager?.getCwd?.()
        || runnerPayload.cwdOverride
        || (sessionPath && sessionPath === this._engine.currentSessionPath ? this._engine.cwd : null)
        || null,
      securityMode: this._engine.getSecurityMode?.() || null,
      planMode: !!this._engine.planMode,
      currentModel,
      taskModel: toModelRef(runnerPayload.model),
      defaultChatModel: toModelRef(this._engine.config?.models?.chat),
      utilityModel: toModelRef(sharedModels.utility || utilityConfig.utility || null),
      utilityLargeModel: toModelRef(sharedModels.utility_large || utilityConfig.utility_large || null),
      promptPreview: summarizeText(runnerPayload.prompt || null, 220),
      ...extra,
    };
  }

  _refreshTaskSnapshot(taskId, extra = {}) {
    const task = this._store.get(taskId);
    if (!task) return null;
    return this._store.update(taskId, {
      snapshot: this._captureSnapshot(task, extra),
    });
  }

  _recordTaskActivity(task) {
    if (!task?.id) return;
    if (task.metadata?.activityRecorded) return;

    const startedAt = task.startedAt ? Date.parse(task.startedAt) : Date.now();
    const finishedAt = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
    const failed = task.status === TASK_STATUS.FAILED;
    const cancelled = task.status === TASK_STATUS.CANCELLED;
    const type = task.source === "review_follow_up"
      ? "review_follow_up"
      : task.runner?.kind === "plan"
        ? "plan"
        : "delegate";
    const summary = task.resultSummary
      || task.title
      || (task.runner?.kind === "plan"
        ? (isZh() ? "规划任务" : "Planning task")
        : (isZh() ? "后台任务" : "Background task"));
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
