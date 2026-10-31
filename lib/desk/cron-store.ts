/**
 * cron-store.ts — 定时任务存储
 *
 * 管理 cron job 的 CRUD 和运行历史。
 * 调度逻辑在 cron-scheduler.js，这里只负责持久化。
 *
 * 参考 OpenClaw：jobs.json + runs/<jobId>.jsonl
 *
 * Job 类型：
 * - "at"：一次性任务（schedule = ISO 时间字符串）
 * - "every"：间隔任务（schedule = 毫秒数，如 3600000 = 1小时）
 * - "cron"：标准 cron 表达式（schedule = "0 7 * * *"）
 */

import fs from "fs";
import path from "path";
import { normalizeAutomationExecutor, type AutomationExecutor } from "../../shared/automation-executor.js";

export interface Job {
  executor?: AutomationExecutor;
  id: string;
  type: "at" | "every" | "cron";
  schedule: string | number;
  prompt: string;
  mode: string;
  label: string;
  model: string;
  workspace: string;
  enabled: boolean;
  consecutiveErrors: number;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface RunRecord {
  status: string;
  startedAt: string;
  finishedAt: string;
  error?: string;
  timestamp: string;
  [key: string]: any;
}

export interface AddJobOptions {
  executor?: AutomationExecutor;
  type: "at" | "every" | "cron";
  schedule: string | number;
  prompt: string;
  mode?: string;
  label?: string;
  model?: string;
  workspace?: string;
}

export interface UpdateJobPatch {
  executor?: AutomationExecutor;
  label?: string;
  model?: string;
  schedule?: string | number;
  prompt?: string;
  enabled?: boolean;
  workspace?: string;
}

interface JobsData {
  jobs: Job[];
  nextNum: number;
}

export class CronStore {
  /** 退避表（毫秒）：0/1m/5m/15m/60m */
  static BACKOFF = [0, 60_000, 300_000, 900_000, 3_600_000];

  private _jobsPath: string;
  private _runsDir: string;
  private _jobs: Job[];
  private _nextNum: number;

  /**
   * @param jobsPath - cron-jobs.json 路径
   * @param runsDir  - cron-runs/ 目录路径
   */
  constructor(jobsPath: string, runsDir: string) {
    this._jobsPath = jobsPath;
    this._runsDir = runsDir;
    this._jobs = [];
    this._nextNum = 1;
    this._load();
  }

  // ════════════════════════════
  //  持久化
  // ════════════════════════════

  private _load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this._jobsPath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // 首次启动，文件不存在，静默处理
        this._jobs = [];
        this._nextNum = 1;
        return;
      }
      console.error("[CronStore] 读取 jobs 文件失败:", err.message);
      this._jobs = [];
      this._nextNum = 1;
      return;
    }

    let data: JobsData;
    try {
      data = JSON.parse(raw);
    } catch {
      // JSON 损坏，尝试从 .tmp 恢复
      const tmpPath = this._jobsPath + ".tmp";
      try {
        const tmpRaw = fs.readFileSync(tmpPath, "utf-8");
        data = JSON.parse(tmpRaw);
        console.error("[CronStore] 主文件 JSON 损坏，已从 .tmp 恢复");
      } catch {
        console.error("[CronStore] JSON 解析失败且无可用 .tmp，重置为空");
        this._jobs = [];
        this._nextNum = 1;
        return;
      }
    }

    this._jobs = Array.isArray(data.jobs) ? data.jobs : [];
    this._nextNum = data.nextNum ?? (this._jobs.length + 1);

    // 旧数据清洗
    let dirty = false;
    for (const job of this._jobs) {
      // model 对象转 string
      if (typeof job.model === "object" && job.model !== null) {
        job.model = (job.model as any).id || "";
        dirty = true;
      }
      if (job.workspace === undefined) {
        job.workspace = "";
        dirty = true;
      }
      // every 类型最小间隔 clamp
      if (job.type === "every" && typeof job.schedule === "number" && job.schedule < 60000) {
        job.schedule = 60000;
        dirty = true;
      }
      // consecutiveErrors 缺失补 0
      if (job.consecutiveErrors === undefined) {
        job.consecutiveErrors = 0;
        dirty = true;
      }
    }
    if (dirty) {
      this._save();
    }
  }

  private _save(): void {
    fs.mkdirSync(path.dirname(this._jobsPath), { recursive: true });
    const data = JSON.stringify({
      jobs: this._jobs,
      nextNum: this._nextNum,
    }, null, 2) + "\n";
    // atomic write: tmp + rename，防止写到一半崩溃损坏文件
    const tmpPath = this._jobsPath + ".tmp";
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, this._jobsPath);
  }

  // ════════════════════════════
  //  Job CRUD
  // ════════════════════════════

  /**
   * 添加任务
   * @param opts - 任务配置
   * @returns 新建的 job
   */
  addJob({ type, schedule, prompt, mode = "isolated", label = "", model = "", workspace = "", executor }: AddJobOptions): Job {
    const normalizedExecutor = normalizeAutomationExecutor(executor);
    // type 枚举校验
    const VALID_TYPES = new Set(["at", "every", "cron"]);
    if (!VALID_TYPES.has(type)) {
      throw new Error(`无效的 job type: "${type}"，必须是 at / every / cron`);
    }

    // every 类型最小间隔 clamp
    if (type === "every") {
      const ms = typeof schedule === "number" ? schedule : parseInt(schedule as string, 10);
      if (ms < 60000) schedule = 60000;
    }

    // at 类型校验
    if (type === "at") {
      const target = new Date(schedule as string);
      if (isNaN(target.getTime())) {
        throw new Error(`无效的 at schedule: "${schedule}"，无法解析为日期`);
      }
      if (target <= new Date()) {
        throw new Error(`at schedule 已过期: "${schedule}"，必须是未来时间`);
      }
    }

    const id = `job_${this._nextNum++}`;
    const now = new Date().toISOString();

    const job: Job = {
      executor: normalizedExecutor,
      id,
      type,
      schedule,
      prompt,
      mode,
      label: label || prompt.slice(0, 30),
      model: (typeof model === "object" && model !== null ? (model as any).id : model) || "",
      workspace: String(workspace || "").trim(),
      enabled: true,
      consecutiveErrors: 0,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: this._calcNextRun(type, schedule, now),
    };

    this._jobs.push(job);
    this._save();
    return job;
  }

  /**
   * 删除任务
   * @param id - 任务 ID
   * @returns 是否成功删除
   */
  removeJob(id: string): boolean {
    const idx = this._jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this._jobs.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * 获取单个任务
   * @param id - 任务 ID
   * @returns 任务对象或 null
   */
  getJob(id: string): Job | null {
    return this._jobs.find(j => j.id === id) || null;
  }

  /**
   * 列出所有任务（每次从磁盘重读，确保跨实例的写入都能被感知）
   * @returns 任务数组
   */
  listJobs(): Job[] {
    this._load();
    return [...this._jobs];
  }

  /**
   * 更新任务字段
   * @param id - 任务 ID
   * @param partial - 部分更新字段
   * @returns 更新后的任务或 null
   */
  updateJob(id: string, partial: UpdateJobPatch): Job | null {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;

    if (partial.executor !== undefined) partial = { ...partial, executor: normalizeAutomationExecutor(partial.executor) };
    const ALLOWED = new Set(["label", "model", "schedule", "prompt", "enabled", "workspace", "executor"]);

    for (const key of Object.keys(partial)) {
      if (!ALLOWED.has(key)) continue;
      let value = (partial as any)[key];

      if (key === "model" && typeof value === "object" && value !== null) {
        value = (value as any).id || "";
      }

      (job as any)[key] = value;
    }

    // schedule 变更时重新计算 nextRunAt
    if ("schedule" in partial && ALLOWED.has("schedule")) {
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
    }

    this._save();
    return job;
  }

  /**
   * 切换任务启用/禁用
   * @param id - 任务 ID
   * @returns 更新后的任务或 null
   */
  toggleJob(id: string): Job | null {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return null;
    job.enabled = !job.enabled;
    if (job.enabled) {
      // 重新计算下次执行时间
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
    }
    this._save();
    return job;
  }

  /**
   * 标记任务已执行，更新 lastRunAt + nextRunAt
   * @param id - 任务 ID
   * @param opts - 执行选项
   */
  markRun(id: string, { success = true }: { success?: boolean } = {}): void {
    const job = this._jobs.find(j => j.id === id);
    if (!job) return;
    const now = new Date().toISOString();
    job.lastRunAt = now;

    if (success) {
      job.consecutiveErrors = 0;
      job.nextRunAt = this._calcNextRun(job.type, job.schedule, now);
    } else {
      job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
      const normalNext = this._calcNextRun(job.type, job.schedule, now);
      const backoffIdx = Math.min(job.consecutiveErrors, CronStore.BACKOFF.length - 1);
      const backoffMs = CronStore.BACKOFF[backoffIdx];
      const backoffNext = new Date(Date.now() + backoffMs).toISOString();
      job.nextRunAt = normalNext && normalNext > backoffNext ? normalNext : backoffNext;
    }

    // "at" 类型执行一次后自动禁用
    if (job.type === "at") {
      job.enabled = false;
    }

    this._save();
  }

  // ════════════════════════════
  //  运行历史
  // ════════════════════════════

  /**
   * 记录一次运行
   * @param jobId - 任务 ID
   * @param run - 运行记录
   */
  logRun(jobId: string, run: RunRecord): void {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    const line = JSON.stringify({ ...run, timestamp: new Date().toISOString() }) + "\n";
    fs.mkdirSync(this._runsDir, { recursive: true });
    fs.appendFileSync(filePath, line, "utf-8");

    // 修剪：超过 500 行时只留最后 300 行
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");
      if (lines.length > 500) {
        fs.writeFileSync(filePath, lines.slice(-300).join("\n") + "\n", "utf-8");
      }
    } catch { /* 修剪失败不影响主流程 */ }
  }

  /**
   * 读取运行历史
   * @param jobId - 任务 ID
   * @param limit - 限制数量
   * @returns 运行记录数组
   */
  getRunHistory(jobId: string, limit = 20): RunRecord[] {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  调度计算
  // ════════════════════════════

  /**
   * 计算下次执行时间
   * @param type - 调度类型
   * @param schedule - 调度参数
   * @param fromISO - 基准时间（ISO string）
   * @returns ISO string 或 null
   */
  private _calcNextRun(type: "at" | "every" | "cron", schedule: string | number, fromISO: string): string | null {
    const from = new Date(fromISO);

    switch (type) {
      case "at": {
        // 一次性：schedule 就是目标时间
        const target = new Date(schedule as string);
        if (isNaN(target.getTime())) return null;
        return target > from ? target.toISOString() : null;
      }

      case "every": {
        // 间隔：从现在起 schedule 毫秒后
        const ms = typeof schedule === "number" ? schedule : parseInt(schedule as string, 10);
        if (isNaN(ms) || ms <= 0) return null;
        return new Date(from.getTime() + ms).toISOString();
      }

      case "cron": {
        // 完整 5 字段 cron 解析
        return this._parseSimpleCron(schedule as string, from);
      }

      default:
        return null;
    }
  }

  /**
   * 完整 cron 解析：支持标准 5 字段 cron 表达式
   *
   * 字段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6, 0=周日, 7也=周日)
   * 语法：数字 | * | *\/N | N-M | N-M/S | N,M,...
   *
   * @param expr - cron 表达式
   * @param from - 基准时间
   * @returns ISO string 或 null
   */
  private _parseSimpleCron(expr: string, from: Date): string | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const ranges = [
      [0, 59],  // 分
      [0, 23],  // 时
      [1, 31],  // 日
      [1, 12],  // 月
      [0, 6],   // 周（0=周日）
    ];

    const fields: Set<number>[] = [];
    for (let i = 0; i < 5; i++) {
      const set = this._parseCronField(parts[i], ranges[i][0], ranges[i][1], i === 4);
      if (!set) return null;
      fields.push(set);
    }

    const [minutes, hours, days, months, weekdays] = fields;

    // 从下一分钟开始搜索，上限 366 天（覆盖年度 cron）
    const start = new Date(from);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    const limit = 366 * 24 * 60;
    for (let i = 0; i < limit; i++) {
      const t = new Date(start.getTime() + i * 60_000);
      if (!months.has(t.getMonth() + 1)) continue;
      const dayMatches = days.has(t.getDate());
      const weekdayMatches = weekdays.has(t.getDay());
      const dayWildcard = parts[2].startsWith("*");
      const weekdayWildcard = parts[4].startsWith("*");
      if (dayWildcard || weekdayWildcard ? !(dayMatches && weekdayMatches) : !(dayMatches || weekdayMatches)) continue;
      if (!hours.has(t.getHours())) continue;
      if (!minutes.has(t.getMinutes())) continue;
      return t.toISOString();
    }

    return null;
  }

  /**
   * 解析单个 cron 字段为值集合
   * @param field - 字段字符串
   * @param min - 最小值
   * @param max - 最大值
   * @param isWeekday - 是否为周字段（7→0）
   * @returns 值集合或 null
   */
  private _parseCronField(field: string, min: number, max: number, isWeekday = false): Set<number> | null {
    const values = new Set<number>();

    for (const segment of field.split(",")) {
      // */N — 步进
      if (segment.startsWith("*/")) {
        const step = parseInt(segment.slice(2), 10);
        if (isNaN(step) || step <= 0) return null;
        for (let v = min; v <= max; v += step) values.add(v);
        continue;
      }

      // * — 全部
      if (segment === "*") {
        for (let v = min; v <= max; v++) values.add(v);
        continue;
      }

      // N-M 或 N-M/S — 范围（可选步进）
      const rangeMatch = segment.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
        if (isNaN(lo) || isNaN(hi) || isNaN(step) || step <= 0) return null;
        if (lo > hi) return null;  // 反向范围
        const effectiveMax = isWeekday ? 7 : max;
        if (lo < min || hi > effectiveMax) return null;  // 越界
        for (let v = lo; v <= hi; v += step) values.add(isWeekday && v === 7 ? 0 : v);
        continue;
      }

      // 纯数字
      const num = parseInt(segment, 10);
      if (isNaN(num)) return null;
      const effectiveMax = isWeekday ? 7 : max;
      if (num < min || num > effectiveMax) return null;  // 越界
      values.add(isWeekday && num === 7 ? 0 : num);
    }

    return values.size > 0 ? values : null;
  }

  /** 任务数量 */
  get size(): number {
    return this._jobs.length;
  }

  /** 启用的任务数量 */
  get enabledCount(): number {
    return this._jobs.filter(j => j.enabled).length;
  }
}
