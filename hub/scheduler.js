/**
 * Scheduler — Heartbeat + Cron 调度（v2）
 *
 * Heartbeat：只跑当前 active agent（有书桌才有心跳）
 * Cron：所有 agent 独立并发，不随 active agent 切换而中断
 *
 * Agent 切换时只 reload heartbeat，cron 持续跑。
 *
 * 通知策略：后台自动任务和笺巡检完成后，scheduler 会发出轻量系统通知。
 */

import fs from "fs";
import path from "path";
import { createHeartbeat } from "../lib/desk/heartbeat.js";
import { createCronScheduler } from "../lib/desk/cron-scheduler.js";
import { CronStore } from "../lib/desk/cron-store.js";
import { appendRecentExecutionToJian } from "../lib/desk/jian-runtime.js";
import { getLocale } from "../server/i18n.js";

export class Scheduler {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
    this._heartbeat = null;
    this._agentCrons = new Map(); // agentId → CronScheduler
    this._executingJobs = new Map(); // jobId → AbortController（per-job 锁 + abort 控制）
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  /** 暴露 heartbeat（给 desk route 的 triggerNow 用） */
  get heartbeat() { return this._heartbeat; }

  /** 暴露某个 agent 的 cronScheduler */
  getCronScheduler(agentId) {
    return this._agentCrons.get(agentId ?? this._engine.currentAgentId) ?? null;
  }

  /** @deprecated 兼容旧访问 */
  get cronScheduler() { return this.getCronScheduler(); }

  // ──────────── 生命周期 ────────────

  start() {
    this.startHeartbeat();
    this._startAllCrons();
  }

  async stop() {
    await this.stopHeartbeat();
    for (const sched of this._agentCrons.values()) {
      await sched.stop();
    }
    this._agentCrons.clear();
  }

  /** 启动某个 agent 的 cron（幂等，已有则跳过） */
  startAgentCron(agentId) { this._startAgentCron(agentId); }

  /** 立即执行一次指定 cron 任务（不改调度，仅手动触发） */
  triggerCronJob(agentId, jobId) {
    const agent = this._engine.getAgent(agentId);
    const job = agent?.cronStore?.getJob?.(jobId);
    if (!job) throw new Error(`cron job not found: ${jobId}`);
    if (!job.enabled) throw new Error(`cron job disabled: ${jobId}`);
    if (this._executingJobs.has(job.id)) throw new Error(`cron job already running: ${jobId}`);
    void this._executeCronJobForAgent(agentId, job).catch((err) => {
      console.error(`\x1b[90m[scheduler] 手动执行 cron 失败 ${job.id}: ${err.message}\x1b[0m`);
    });
    return job;
  }

  /** 停止并移除某个 agent 的 cron */
  async removeAgentCron(agentId) {
    const sched = this._agentCrons.get(agentId);
    if (sched) {
      await sched.stop();
      this._agentCrons.delete(agentId);
    }
  }

  /** Agent 切换：只重建 heartbeat，cron 不中断 */
  async reloadHeartbeat() {
    await this.stopHeartbeat();
    this.startHeartbeat();
  }

  startHeartbeat() {
    const engine = this._engine;
    const agent = engine.agent;
    if (!agent.deskManager || !agent.cronStore) return;

    const hbInterval = agent.config?.desk?.heartbeat_interval;
    const hbEnabled = agent.config?.desk?.heartbeat_enabled !== false;
    this._heartbeat = createHeartbeat({
      getDeskFiles: () => engine.listDeskFiles(),
      getWorkspacePath: () => engine.homeCwd,
      registryPath: path.join(agent.deskDir, "jian-registry.json"),
      overwatchPath: path.join(agent.deskDir, "overwatch.md"),
      onBeat: (prompt) => this._executeActivity(prompt, "heartbeat"),
      onJianBeat: (prompt, cwd) => {
        const isZh = getLocale().startsWith("zh");
        this._executeActivity(prompt, "heartbeat", `${isZh ? "笺" : "jian"}:${path.basename(cwd)}`, { cwd });
      },
      onJianSchedule: ({ dirPath, schedule, taskText, rawTask, label }) => {
        const store = agent.cronStore;
        if (!store || !schedule || !taskText) return null;
        const existing = store.listJobs().find((job) => (
          job.workspace === dirPath
          && String(job.schedule) === String(schedule)
          && normalizeJobPrompt(job.prompt) === normalizeJobPrompt(taskText)
        ));
        if (existing) return existing;
        return store.addJob({
          type: "cron",
          schedule,
          workspace: dirPath,
          label: label || taskText.slice(0, 32),
          prompt: isZhTask(taskText)
            ? `根据笺里的定时待办执行：${rawTask || taskText}`
            : `Execute this scheduled jian task: ${rawTask || taskText}`,
        });
      },
      intervalMinutes: hbInterval,
      emitDevLog: (text, level) => engine.emitDevLog(text, level),
      locale: agent.config?.locale,
    });
    if (hbEnabled) this._heartbeat.start();
  }

  async stopHeartbeat() {
    if (this._heartbeat) {
      await this._heartbeat.stop();
      this._heartbeat = null;
    }
  }

  // ──────────── Per-agent Cron ────────────

  _startAllCrons() {
    const engine = this._engine;
    let entries;
    try {
      entries = fs.readdirSync(engine.agentsDir, { withFileTypes: true });
    } catch { return; }

    for (const e of entries) {
      if (e.isDirectory()) this._startAgentCron(e.name);
    }
  }

  _startAgentCron(agentId) {
    if (this._agentCrons.has(agentId)) return;
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const deskDir = path.join(agentDir, "desk");

    let cronStore;
    try {
      cronStore = new CronStore(
        path.join(deskDir, "cron-jobs.json"),
        path.join(deskDir, "cron-runs"),
      );
    } catch { return; }

    const sched = createCronScheduler({
      cronStore,
      executeJob: (job) => this._executeCronJobForAgent(agentId, job),
      abortJob: (jobId) => {
        const ac = this._executingJobs.get(jobId);
        if (ac) { ac.abort(); console.log(`\x1b[90m[scheduler] cron abort ${jobId} (timeout)\x1b[0m`); }
      },
      onJobDone: (job, result) => {
        this._hub.eventBus.emit(
          { type: "cron_job_done", jobId: job.id, label: job.label, agentId, result },
          null,
        );
      },
    });
    this._agentCrons.set(agentId, sched);
    sched.start();
    console.log(`\x1b[90m[scheduler] cron 已启动: ${agentId}\x1b[0m`);
  }

  // ──────────── 执行 ────────────

  /**
   * 执行某个 agent 的 cron 任务（active 或非 active 均可）
   * 同一 agent 同时只运行一个 cron，防止并发写冲突
   */
  async _executeCronJobForAgent(agentId, job) {
    // per-job 锁：同一 job 不并发，但同一 agent 的不同 job 可以并行
    if (this._executingJobs.has(job.id)) {
      console.log(`\x1b[90m[scheduler] cron 跳过 ${job.id}：上一次仍在执行\x1b[0m`);
      const err = new Error(`cron job ${job.id} 仍在执行，跳过`);
      err.skipped = true;
      throw err;
    }
    const ac = new AbortController();
    this._executingJobs.set(job.id, ac);
    try {
      const isZh = getLocale().startsWith("zh");
      const prompt = isZh
        ? [
            `[定时任务 ${job.id}: ${job.label}]`,
            "",
            "**注意：这是系统自动触发的定时任务，不是用户发来的。**",
            "**不要在执行过程中创建新的定时任务。**",
            ...(job.workspace ? ["", `[工作目录] ${job.workspace}`] : []),
            "",
            job.prompt,
          ].join("\n")
        : [
            `[Cron job ${job.id}: ${job.label}]`,
            "",
            "**Note: This is an automated cron job, NOT a user message.**",
            "**Do not create new cron jobs during execution.**",
            ...(job.workspace ? ["", `[Workspace] ${job.workspace}`] : []),
            "",
            job.prompt,
          ].join("\n");
      await this._executeActivityForAgent(agentId, prompt, "cron", job.label, {
        jobId: job.id,
        model: job.model || undefined,
        cwd: job.workspace || undefined,
        signal: ac.signal,
      });
    } finally {
      this._executingJobs.delete(job.id);
    }
  }

  /**
   * 执行活动（任意 agent，统一走 executeIsolated）
   */
  async _executeActivityForAgent(agentId, prompt, type, label, opts = {}) {
    const engine = this._engine;
    const agentDir = path.join(engine.agentsDir, agentId);
    const activityDir = path.join(agentDir, "activity");
    const startedAt = Date.now();
    const id = `${type === "heartbeat" ? "hb" : "cron"}_${startedAt}`;

    // 所有 agent 统一走 executeIsolated（支持 agentId + signal 参数）
    const { signal, ...restOpts } = opts;
    const result = await engine.executeIsolated(prompt, {
      agentId,
      persist: activityDir,
      signal,
      ...restOpts,
    });
    const { sessionPath, error } = result;

    const finishedAt = Date.now();
    const failed = !!error;

    // 取 agentName（从长驻实例获取，fallback agentId）
    const ag = engine.getAgent(agentId);
    const agentName = ag?.agentName || agentId;

    // 生成摘要
    let summary = null;
    if (typeof sessionPath === "string" && sessionPath) {
      try {
        summary = await engine.summarizeActivity(sessionPath);
      } catch {}
    }

    let outputFile = null;
    const jianDir = typeof restOpts.cwd === "string" && restOpts.cwd.trim()
      ? restOpts.cwd.trim()
      : null;
    if (type === "cron" && jianDir) {
      try {
        outputFile = persistCronResultFile({
          cwd: jianDir,
          label,
          locale: getLocale(),
          startedAt,
          finishedAt,
          sessionPath,
          summary,
          error,
        });
      } catch (err) {
        engine.emitDevLog(`[${type}] 写入任务结果文件失败: ${err.message}`, "error");
      }
    }

    const entry = {
      id,
      type,
      jobId: restOpts.jobId || null,
      label: label || null,
      agentId,
      agentName,
      workspace: jianDir,
      startedAt,
      finishedAt,
      outputFile,
      summary: (() => {
        const isZhS = getLocale().startsWith("zh");
        const hbLabel = isZhS ? "日常巡检" : "routine patrol";
        const cronLabel = isZhS ? "定时任务" : "cron job";
        const failSuffix = isZhS ? "执行失败" : "execution failed";
        const workspaceName = jianDir ? path.basename(jianDir) : "";
        if (failed) return `${label || (type === "heartbeat" ? hbLabel : cronLabel)} ${failSuffix}`;
        if (summary) {
          return workspaceName
            ? `${summary} · ${isZhS ? "工作区" : "Workspace"} ${workspaceName}`
            : summary;
        }
        if (type === "heartbeat") {
          return workspaceName
            ? `${isZhS ? "已巡检" : "Patrolled"} ${workspaceName}`
            : hbLabel;
        }
        return workspaceName
          ? `${label || cronLabel} · ${workspaceName}`
          : (label || cronLabel);
      })(),
      sessionFile: typeof sessionPath === "string" ? path.basename(sessionPath) : null,
      status: failed ? "error" : "done",
      error: error || null,
    };
    if (!failed && jianDir) {
      try {
        appendRecentExecutionToJian(jianDir, {
          summary: entry.summary,
          type,
          label,
          at: finishedAt,
          locale: getLocale(),
        });
      } catch (err) {
        engine.emitDevLog(`[${type}] 写回笺失败: ${err.message}`, "error");
      }
    }

    // 写入对应 agent 的 ActivityStore
    engine.getActivityStore(agentId).add(entry);

    // WS 广播
    this._hub.eventBus.emit({ type: "activity_update", activity: entry }, null);

    const notification = buildActivityNotification({
      entry,
      failed,
      error,
      locale: getLocale(),
    });
    if (notification) {
      this._hub.eventBus.emit({
        type: "notification",
        title: notification.title,
        body: notification.body,
      }, null);
    }

    if (failed) {
      const isZhR = getLocale().startsWith("zh");
      const reason = error || (isZhR ? "后台任务未生成 session" : "background task produced no session");
      engine.emitDevLog(`[${type}] ${label || "后台任务"} 失败: ${reason}`, "error");
      throw new Error(reason);
    }

    engine.emitDevLog(`活动记录: ${entry.summary}`, "heartbeat");
  }

  /**
   * active agent 的心跳活动（保留向后兼容）
   */
  _executeActivity(prompt, type, label, opts = {}) {
    return this._executeActivityForAgent(this._engine.currentAgentId, prompt, type, label, opts);
  }
}

function normalizeJobPrompt(prompt) {
  return String(prompt || "")
    .replace(/^根据笺里的定时待办执行：/u, "")
    .replace(/^Execute this scheduled jian task:\s*/u, "")
    .trim();
}

function isZhTask(text) {
  return /[\u3400-\u9fff]/u.test(String(text || ""));
}

function buildActivityNotification({ entry, failed, error, locale }) {
  const isZh = String(locale || "").startsWith("zh");
  const genericHeartbeat = isZh ? "日常巡检" : "routine patrol";
  const genericCron = isZh ? "定时任务" : "cron job";
  const summary = compactNotificationBody(entry.summary, isZh);
  const label = String(entry.label || "").trim();

  if (failed) {
    const fallback = isZh ? "这次没有顺利完成，稍后会再试一次。" : "This run did not finish successfully and will retry later.";
    return {
      title: isZh
        ? `${label || (entry.type === "cron" ? "自动任务" : "巡检")}未完成`
        : `${label || (entry.type === "cron" ? "Automation" : "Patrol")} did not finish`,
      body: compactNotificationBody(error || summary || fallback, isZh),
    };
  }

  if (entry.type === "cron") {
    return {
      title: isZh ? "自动任务已完成" : "Automation finished",
      body: summary || label || genericCron,
    };
  }

  if (label && label !== genericHeartbeat) {
    return {
      title: isZh ? "笺里的安排已更新" : "Jian task updated",
      body: summary || label,
    };
  }

  return null;
}

function compactNotificationBody(text, isZh) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const max = isZh ? 44 : 72;
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

function sanitizeResultFilePart(value, fallback = "task-result") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return cleaned || fallback;
}

function formatResultTimestamp(ts) {
  const date = new Date(ts || Date.now());
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function extractAssistantResultText(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return "";
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    let lastAssistantText = "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type !== "message" || !parsed.message || parsed.message.role !== "assistant") continue;
      const msg = parsed.message;
      const content = Array.isArray(msg.content)
        ? msg.content.filter((block) => block?.type === "text" && block.text).map((block) => block.text).join("")
        : (typeof msg.content === "string" ? msg.content : "");
      const normalized = String(content || "").trim();
      if (normalized) lastAssistantText = normalized;
    }
    return lastAssistantText;
  } catch {
    return "";
  }
}

function buildCronResultDocument({ isZh, label, startedAt, finishedAt, cwd, body, error }) {
  const lines = [
    `# ${isZh ? "自动任务结果" : "Automation Result"}`,
    "",
    `- ${isZh ? "任务" : "Task"}: ${label || (isZh ? "未命名任务" : "Untitled task")}`,
    `- ${isZh ? "开始" : "Started"}: ${new Date(startedAt).toLocaleString(isZh ? "zh-CN" : "en-US")}`,
    `- ${isZh ? "结束" : "Finished"}: ${new Date(finishedAt).toLocaleString(isZh ? "zh-CN" : "en-US")}`,
    `- ${isZh ? "工作区" : "Workspace"}: ${cwd}`,
    `- ${isZh ? "状态" : "Status"}: ${error ? (isZh ? "失败" : "Failed") : (isZh ? "完成" : "Completed")}`,
    "",
    body || (error ? String(error) : (isZh ? "这次没有产出可展示文本。" : "This run did not produce displayable text.")),
    "",
  ];
  return `${lines.join("\n")}`.replace(/\n{3,}/g, "\n\n");
}

function persistCronResultFile({ cwd, label, locale, startedAt, finishedAt, sessionPath, summary, error }) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const isZh = String(locale || "").startsWith("zh");
  const folderName = isZh ? "Lynn-自动任务结果" : "Lynn-Automation-Results";
  const resultDir = path.join(cwd, folderName);
  fs.mkdirSync(resultDir, { recursive: true });
  const body = extractAssistantResultText(sessionPath) || String(summary || "").trim() || String(error || "").trim();
  const fileName = `${formatResultTimestamp(finishedAt || startedAt)}-${sanitizeResultFilePart(label, isZh ? "自动任务" : "automation-task")}.md`;
  const filePath = path.join(resultDir, fileName);
  const doc = buildCronResultDocument({
    isZh,
    label,
    startedAt,
    finishedAt,
    cwd,
    body,
    error,
  });
  fs.writeFileSync(filePath, doc, "utf-8");
  return filePath;
}
