/**
 * desk.js — Desk 系统 REST API
 *
 * 提供 cron 任务、工作空间文件的 HTTP 接口。
 * 前端通过这些接口直接操作（不经过 agent/LLM），
 * agent 通过 tool 操作（走 WebSocket 推送更新）。
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { parseSkillMetadata } from "../../lib/skills/skill-metadata.js";
import { t } from "../i18n.js";
import { readGitContext, readGitDiff } from "../git-context.js";
import { getWorkspaceRoots, uniqueTrustedRoots } from "../../shared/trusted-roots.js";

type JsonObject = Record<string, unknown>;

type RouteAgent = {
  id: string;
  name?: string;
};

type ActivityEntry = JsonObject & {
  id: string;
  type?: string;
  label?: string;
  agentId?: string;
  agentName?: string;
  summary?: unknown;
  status?: string;
  error?: unknown;
  startedAt?: number | null;
  finishedAt?: number | null;
  sessionFile?: string | null;
  outputFile?: string | null;
  jobId?: string | null;
  workspace?: string;
};

type ActivityStore = {
  get(activityId: string): ActivityEntry | null | undefined;
  list(): ActivityEntry[];
};

type CronJob = JsonObject & {
  id: string;
  type?: string;
  label?: string;
  workspace?: string;
  enabled?: boolean;
};

type CronStore = {
  listJobs(): CronJob[];
  addJob(params: JsonObject): CronJob;
  removeJob(id: unknown): boolean;
  toggleJob(id: unknown): CronJob | null | undefined;
  getJob(id: unknown): CronJob | null | undefined;
  updateJob(id: unknown, fields: JsonObject): CronJob | null | undefined;
  getRunHistory?(jobId: string, limit: number): unknown[];
};

type SkillDirDef = {
  sub: string;
  label: string;
};

type CwdSkill = {
  name: unknown;
  description: unknown;
  source: string;
  dirPath: string;
  filePath: string;
  baseDir: string;
};

type SkillManager = {
  scanCwdSkills?(dir: string, dirs: SkillDirDef[]): { skills: CwdSkill[]; mtime: number };
  invalidateCwdCache?(dir: string): unknown;
};

type DeskRouteEngine = {
  deskCwd?: string;
  homeCwd?: string;
  config?: JsonObject;
  lynnHome?: string;
  agentsDir: string;
  currentAgentId: string;
  agent: {
    cronStore?: CronStore | null;
  };
  skillManager?: SkillManager | null;
  listAgents(): RouteAgent[];
  getActivityStore(agentId: string): ActivityStore | null | undefined;
  getAgent(agentId: string): { agentName?: string; name?: string } | null | undefined;
  promoteActivitySession(sessionFile: string): string | null | undefined;
  summarizeActivityQuick(id: unknown): Promise<unknown>;
  getDevLogs(): unknown;
  getTrustedRoots?(): string[];
};

type DeskRouteHub = {
  scheduler?: {
    heartbeat?: {
      triggerNow(): unknown;
    };
    triggerCronJob?(agentId: string, jobId: unknown): unknown;
  } | null;
} | null;

type WorkspaceFile = {
  name: string;
  size: number;
  mtime: string;
  isDir: boolean;
};

type SearchResult = {
  name: string;
  path: string;
  rel: string;
  isDir: boolean;
};

type FileActionResult =
  | { src: unknown; error: string }
  | { src: string; name: string }
  | { name: unknown; error: string }
  | { name: unknown; ok: true };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  throw new TypeError(`${label} must be a string`);
}

function safeDecodeURIComponent(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseIntegerInput(value: unknown): number {
  return Number.parseInt(String(value), 10);
}

async function readBody(c: Parameters<typeof safeJson<JsonObject>>[0]): Promise<JsonObject> {
  return safeJson<JsonObject>(c);
}

/** 解析真实路径（跟踪 symlink），失败返回 null */
function realPath(p: string): string | null {
  try { return fs.realpathSync(path.resolve(p)); }
  catch { return null; }
}

/** 安全路径校验：target 必须在 baseDir 内部（解析 symlink 后比较） */
function isInsidePath(target: unknown, baseDir: string): boolean {
  // Reject null bytes and decode URI components for normalization
  if (typeof target !== "string" || target.includes("\0")) return false;
  let normalized = safeDecodeURIComponent(target);
  // NFC normalization for Unicode consistency
  normalized = normalized.normalize("NFC");

  const base = realPath(baseDir);
  if (!base) return false;
  const resolved = realPath(normalized);
  if (resolved) {
    // Double-check with path.relative to ensure no '..' escape
    const rel = path.relative(base, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return true;
  }
  // 路径不存在（mkdir / rename 目标）：解析父目录 + 保留 basename
  const parentResolved = realPath(path.dirname(normalized));
  if (!parentResolved) return false;
  const full = path.join(parentResolved, path.basename(normalized));
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

/** 校验 dir 覆盖：仅允许 engine 已知的根目录（解析 symlink 后比较） */
function approvedWorkspaceRoots(engine: DeskRouteEngine): string[] {
  return uniqueTrustedRoots([
    engine.deskCwd,
    engine.homeCwd,
    ...getWorkspaceRoots(engine.config || {}, { trusted_roots: engine.getTrustedRoots?.() || [] }),
  ]);
}

function isResolvedInsideRoot(resolved: string, root: string): boolean {
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isApprovedDir(dir: unknown, engine: DeskRouteEngine): boolean {
  if (typeof dir !== "string") return false;
  const resolved = realPath(dir);
  if (!resolved) return false;
  return approvedWorkspaceRoots(engine).some(root => {
    const r = realPath(root);
    if (!r) return false;
    return isResolvedInsideRoot(resolved, r);
  });
}

function isApprovedDirStringOnly(dir: unknown, engine: DeskRouteEngine): boolean {
  if (typeof dir !== "string" || dir.includes("\0")) return false;
  const resolved = path.resolve(dir);
  return approvedWorkspaceRoots(engine)
    .map((root) => path.resolve(root))
    .some((root) => isResolvedInsideRoot(resolved, root));
}

function isInsidePathStringOnly(target: unknown, baseDir: string): boolean {
  if (typeof target !== "string" || target.includes("\0")) return false;
  const base = path.resolve(baseDir);
  const resolved = path.resolve(target);
  const rel = path.relative(base, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 敏感 dot 目录（不允许 upload 从这些目录复制文件） */
const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube"];

function isSensitivePath(srcPath: string, lynnHome?: string): boolean {
  const resolved = realPath(srcPath);
  if (!resolved) return true; // fail-closed
  const home = os.homedir();
  for (const d of SENSITIVE_DIRS) {
    const sensitive = path.join(home, d);
    if (resolved === sensitive || resolved.startsWith(sensitive + path.sep)) return true;
  }
  if (lynnHome) {
    const realHome = realPath(lynnHome);
    if (realHome && (resolved === realHome || resolved.startsWith(realHome + path.sep))) return true;
  }
  return false;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 列出工作空间目录下的文件。这个接口是启动热路径，禁止同步 readdir/stat 卡死主线程。 */
async function listWorkspaceFiles(dir: string): Promise<WorkspaceFile[]> {
  const HOVER_IGNORE_NAMES = new Set([
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    ".pytest_cache",
  ]);
  if (!fs.existsSync(dir)) return [];
  const entries = await withTimeout(
    fsp.readdir(dir, { withFileTypes: true }),
    800,
    [],
  );
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const visibleEntries = entries
    .filter(e => !e.name.startsWith(".") && !HOVER_IGNORE_NAMES.has(e.name))
    .slice(0, 300);
  const now = new Date(0).toISOString();
  const files = await Promise.all(visibleEntries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    const stat = await withTimeout(fsp.stat(fullPath), 300, null);
    return {
      name: entry.name,
      size: stat?.size || 0,
      mtime: stat?.mtime?.toISOString?.() || now,
      isDir: entry.isDirectory(),
    };
  }));
  return files.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
}

export function createDeskRoute(engine: DeskRouteEngine, hub: DeskRouteHub): Hono {
  const route = new Hono();

  function getWorkspaceDir(rawDir: string | undefined): string | undefined {
    return rawDir ? safeDecodeURIComponent(rawDir) : engine.deskCwd;
  }

  /** 从所有 agent 的 activityStore 中按 ID 查找 entry */
  function findActivityEntry(activityId: string): { entry: ActivityEntry | null; agentId: string | null } {
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const entry = store?.get(activityId);
      if (entry) return { entry, agentId: ag.id };
    }
    return { entry: null, agentId: null };
  }

  function findLatestCronActivity(job: CronJob): ActivityEntry | null {
    const store = engine.getActivityStore(engine.currentAgentId);
    const items = store?.list() || [];
    const normalizedLabel = String(job?.label || "").trim();
    const normalizedWorkspace = String(job?.workspace || "").trim();
    return items.find((item) => {
      if (!item || item.type !== "cron") return false;
      if (item.jobId && item.jobId === job.id) return true;
      return String(item.label || "").trim() === normalizedLabel
        && String(item.workspace || "").trim() === normalizedWorkspace;
    }) || null;
  }

  function decorateCronJob(job: CronJob, store: CronStore): JsonObject {
    const latestRunHistory = store?.getRunHistory?.(job.id, 1) || [];
    const latestRun = latestRunHistory[latestRunHistory.length - 1] || null;
    const latestActivity = findLatestCronActivity(job);
    return {
      ...job,
      latestRun,
      latestActivity: latestActivity
        ? {
            id: latestActivity.id,
            jobId: latestActivity.jobId || null,
            summary: latestActivity.summary || "",
            status: latestActivity.status || "",
            error: latestActivity.error || null,
            startedAt: latestActivity.startedAt || null,
            finishedAt: latestActivity.finishedAt || null,
            sessionFile: latestActivity.sessionFile || null,
            outputFile: latestActivity.outputFile || null,
            workspace: latestActivity.workspace || "",
          }
        : null,
    };
  }

  // ════════════════════════════
  //  助手活动
  // ════════════════════════════

  /** 活动列表（合并所有 agent） */
  route.get("/desk/activities", async (c) => {
    const allActivities: ActivityEntry[] = [];
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const items = store?.list() || [];
      for (const a of items) {
        allActivities.push({
          ...a,
          agentId: a.agentId || ag.id,
          agentName: a.agentName || ag.name,
        });
      }
    }
    // 按 startedAt 倒序
    allActivities.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return c.json({ activities: allActivities });
  });

  /** 读取指定活动的 session 对话消息（只读查看用） */
  route.get("/desk/activities/:id/session", async (c) => {
    const id = c.req.param("id");
    // 从所有 agent 的 activityStore 中查找
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return c.json({ error: "activity not found" });
    if (!foundAgentId) return c.json({ error: "activity not found" });
    if (!entry.sessionFile) return c.json({ error: "no session file" });

    const activityDir = path.join(engine.agentsDir, foundAgentId, "activity");
    const sessionPath = path.join(activityDir, entry.sessionFile);
    if (!fs.existsSync(sessionPath)) return c.json({ error: "session file missing" });

    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.trim().split("\n").map(l => {
        try { return JSON.parse(l) as unknown; } catch { return null; }
      }).filter(isJsonObject);

      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!isJsonObject(msg)) continue;
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const content = Array.isArray(msg.content)
          ? msg.content
              .filter((b): b is { type: "text"; text: string } =>
                isJsonObject(b) && b.type === "text" && typeof b.text === "string" && Boolean(b.text)
              )
              .map(b => b.text)
              .join("")
          : (typeof msg.content === "string" ? msg.content : "");

        if (!content) continue;
        messages.push({ role: msg.role, content });
      }

      return c.json({
        activity: {
          id: entry.id,
          type: entry.type,
          label: entry.label || null,
          agentId: entry.agentId || foundAgentId,
          agentName: entry.agentName || engine.getAgent(foundAgentId)?.agentName || foundAgentId,
          summary: entry.summary,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
        },
        messages,
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) });
    }
  });

  /** 将活动 session 提升为正常 session（从 activity/ 移到 sessions/） */
  route.post("/desk/activities/:id/promote", async (c) => {
    const id = c.req.param("id");
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return c.json({ error: "activity not found" });
    if (!entry.sessionFile) return c.json({ error: "no session file" });

    // promote 需要先切到对应 agent（promoteActivitySession 操作当前焦点 agent 的目录）
    if (foundAgentId !== engine.currentAgentId) {
      return c.json({ error: t("error.activeSessionOnly") });
    }

    const newPath = engine.promoteActivitySession(entry.sessionFile);
    if (!newPath) return c.json({ error: "promote failed" });

    return c.json({ ok: true, sessionPath: newPath });
  });

  /** 用小工具模型快速摘要（DevTools 调试用） */
  route.post("/desk/activities/summarize", async (c) => {
    const body = await readBody(c);
    const { id } = body;
    if (!id) return c.json({ error: "id required" });
    try {
      const summary = await engine.summarizeActivityQuick(id);
      return c.json({ summary: summary || null });
    } catch (err) {
      return c.json({ error: errorMessage(err) });
    }
  });

  /** DevTools 日志（历史） */
  route.get("/desk/logs", async (c) => {
    return c.json({ logs: engine.getDevLogs() });
  });

  /** 手动触发心跳巡检（调试用） */
  route.post("/desk/heartbeat", async (c) => {
    const hb = hub?.scheduler?.heartbeat;
    if (!hb) return c.json({ error: "Heartbeat not initialized" });
    setTimeout(() => {
      try {
        hb.triggerNow();
      } catch (err) {
        console.warn("[desk] heartbeat trigger failed:", errorMessage(err));
      }
    }, 0);
    return c.json({ ok: true, message: t("error.heartbeatTriggered") });
  });

  // ════════════════════════════
  //  Cron 任务
  // ════════════════════════════

  /** 列出 cron 任务 */
  route.get("/desk/cron", async (c) => {
    const store = engine.agent.cronStore;
    if (!store) return c.json({ jobs: [] });
    const jobs = store.listJobs().map((job) => decorateCronJob(job, store));
    return c.json({ jobs });
  });

  route.get("/desk/cron/actions", (c) => {
    const manager = (engine as unknown as { pluginManager?: { getAllTools(): Array<{ name: string; _pluginId?: string; description?: string; parameters?: unknown }> } }).pluginManager;
    return c.json({ actions: (manager?.getAllTools() || []).filter(tool => tool._pluginId).map(tool => ({ pluginId: tool._pluginId, toolName: tool.name, description: tool.description || "", schema: tool.parameters || {} })) });
  });

  /** 操作 cron 任务 */
  route.post("/desk/cron", async (c) => {
    const store = engine.agent.cronStore;
    if (!store) return c.json({ error: "Desk not initialized" });

    const body = await readBody(c);
    const { action, ...params } = body;

    switch (action) {
      case "add": {
        if (!params.type || !params.schedule || !params.prompt) {
          return c.json({ error: "type, schedule, prompt required" }, 400);
        }
        const VALID_TYPES = new Set(["at", "every", "cron"]);
        if (typeof params.type !== "string" || !VALID_TYPES.has(params.type)) {
          return c.json({ error: `Invalid type: ${params.type}. Must be at/every/cron.` }, 400);
        }
        if (params.type === "every") {
          const minutes = parseIntegerInput(params.schedule);
          if (isNaN(minutes) || minutes <= 0) {
            return c.json({ error: "every schedule must be a positive number (minutes)" }, 400);
          }
          params.schedule = minutes * 60_000;
        }
        const job = store.addJob({
          ...params,
          workspace: String(params.workspace || "").trim(),
        });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "remove": {
        if (!params.id) return c.json({ error: "id required" });
        const ok = store.removeJob(params.id);
        if (!ok) return c.json({ error: "not found" });
        return c.json({ ok: true, jobs: store.listJobs() });
      }

      case "toggle": {
        if (!params.id) return c.json({ error: "id required" });
        const job = store.toggleJob(params.id);
        if (!job) return c.json({ error: "not found" });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "update": {
        if (!params.id) return c.json({ error: "id required" });
        const { id, ...fields } = params;
        if (fields.workspace !== undefined) {
          fields.workspace = String(fields.workspace || "").trim();
        }
        if (fields.schedule !== undefined) {
          const existingJob = store.getJob(id);
          if (existingJob?.type === "every") {
            const minutes = parseIntegerInput(fields.schedule);
            if (!isNaN(minutes) && minutes > 0) {
              fields.schedule = minutes * 60_000;
            }
          }
        }
        const job = store.updateJob(id, fields);
        if (!job) return c.json({ error: "not found" });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "run": {
        if (!params.id) return c.json({ error: "id required" }, 400);
        const job = store.getJob(params.id);
        if (!job) return c.json({ error: "not found" }, 404);
        if (job.enabled === false) return c.json({ error: "job disabled" }, 400);
        try {
          hub?.scheduler?.triggerCronJob?.(engine.currentAgentId, job.id);
          return c.json({ ok: true, started: true, job: decorateCronJob(job, store) });
        } catch (err) {
          return c.json({ error: errorMessage(err) || "failed to start job" }, 400);
        }
      }

      default:
        return c.json({ error: `unknown action: ${action}` });
    }
  });

  // ════════════════════════════
  //  工作空间文件（直接使用 cwd）
  // ════════════════════════════

  /** 扫描工作空间下的项目级技能（带缓存 + ETag/304） */
  route.get("/desk/skills", async (c) => {
    const rawDir = c.req.query("dir");
    const dir = getWorkspaceDir(rawDir);
    if (!dir) return c.json({ skills: [] });
    if (rawDir && !isApprovedDir(dir, engine)) return c.json({ skills: [] });

    const CWD_SKILL_DIRS: SkillDirDef[] = [
      { sub: ".claude/skills",   label: "Claude Code" },
      { sub: ".codex/skills",    label: "Codex" },
      { sub: ".openclaw/skills", label: "OpenClaw" },
      { sub: ".agents/skills",   label: "Agents" },
      { sub: ".pi/skills",       label: "Pi" },
    ];

    // 使用 SkillManager 的缓存扫描（如果可用）
    const skillManager = engine.skillManager;
    let results: CwdSkill[];
    let mtime: number;
    if (skillManager?.scanCwdSkills) {
      const scan = skillManager.scanCwdSkills(dir, CWD_SKILL_DIRS);
      results = scan.skills;
      mtime = scan.mtime;
    } else {
      // 回退：直接扫描（无缓存）
      results = [];
      mtime = 0;
      for (const { sub, label } of CWD_SKILL_DIRS) {
        const skillsDir = path.join(dir, sub);
        if (!fs.existsSync(skillsDir)) continue;
        try {
          for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
            if (!fs.existsSync(skillFile)) continue;
            try {
              const content = fs.readFileSync(skillFile, "utf-8");
              const meta = parseSkillMetadata(content, entry.name);
              results.push({
                name: meta.name,
                description: meta.description,
                source: label,
                dirPath: skillsDir,
                filePath: skillFile,
                baseDir: path.join(skillsDir, entry.name),
              });
            } catch {
              // Ignore malformed external skill entries.
            }
          }
        } catch {
          // Missing external skill roots are skipped.
        }
      }
    }

    // ETag 支持：基于 mtime 生成标识，无变化返回 304
    if (mtime > 0) {
      const etag = `"cwd-skills-${mtime}"`;
      c.header("ETag", etag);
      c.header("Cache-Control", "no-cache");
      const ifNoneMatch = c.req.header("If-None-Match");
      if (ifNoneMatch === etag) {
        return c.body(null, 304);
      }
    }

    return c.json({ skills: results });
  });

  /**
   * 拖拽安装项目技能
   * 接收文件路径，自动创建 .agents/skills/ 并安装
   * 支持文件夹（直接复制）和 .zip/.skill（解压）
   */
  route.post("/desk/install-skill", async (c) => {
    const body = await readBody(c);
    const { filePath, dir } = body;
    const cwd = stringOrUndefined(dir) || engine.deskCwd;
    const sourcePath = stringOrUndefined(filePath);
    if (!sourcePath || !cwd) {
      return c.json({ error: "filePath and active workspace required" }, 400);
    }
    if (!isApprovedDir(cwd, engine)) return c.json({ error: t("error.dirNotAllowed") }, 403);

    try {
      const stat = fs.statSync(sourcePath);
      const skillsDir = path.join(cwd, ".agents", "skills");

      // 确保 .agents/skills/ 存在
      fs.mkdirSync(skillsDir, { recursive: true });

      // macOS: 隐藏 .agents 目录（chflags hidden）
      if (process.platform === "darwin") {
        const agentsDir = path.join(cwd, ".agents");
        try { execFileSync("chflags", ["hidden", agentsDir], { windowsHide: true }); } catch { /* chflags is cosmetic */ }
      }

      if (stat.isDirectory()) {
        // 直接复制文件夹
        const destName = path.basename(sourcePath);
        const dest = path.join(skillsDir, destName);
        fs.cpSync(sourcePath, dest, { recursive: true });
        engine.skillManager?.invalidateCwdCache?.(cwd);
        return c.json({ ok: true, name: destName });
      }

      const ext = path.extname(sourcePath).toLowerCase();
      if (ext === ".zip" || ext === ".skill") {
        // 解压到 skills 目录
        // 先解压到临时目录确认内容
        const tmpDir = path.join(skillsDir, `_tmp_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        execFileSync("unzip", ["-o", "-q", sourcePath, "-d", tmpDir], { windowsHide: true });

        // 检查解压结果：如果只有一个子目录，用那个；否则用文件名
        const entries = fs.readdirSync(tmpDir).filter(e => !e.startsWith("."));
        let skillName: string;
        const soleEntry = entries[0];
        if (entries.length === 1 && soleEntry && fs.statSync(path.join(tmpDir, soleEntry)).isDirectory()) {
          // 单目录包：移动到 skills
          skillName = soleEntry;
          const dest = path.join(skillsDir, skillName);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
          fs.renameSync(path.join(tmpDir, skillName), dest);
          fs.rmSync(tmpDir, { recursive: true });
        } else {
          // 散文件包：整个 tmp 目录就是技能
          skillName = path.basename(sourcePath, ext);
          const dest = path.join(skillsDir, skillName);
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
          fs.renameSync(tmpDir, dest);
        }
        engine.skillManager?.invalidateCwdCache?.(cwd);
        return c.json({ ok: true, name: skillName });
      }

      return c.json({ error: "Unsupported file type. Use folder, .zip or .skill" }, 400);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  /** 删除项目技能 */
  route.post("/desk/delete-skill", async (c) => {
    const body = await readBody(c);
    const { skillDir } = body;
    const skillDirPath = stringOrUndefined(skillDir);
    if (!skillDirPath) {
      return c.json({ error: "skillDir is required" }, 400);
    }
    // 安全检查：必须在当前工作区的已知技能目录下
    const cwd = engine.deskCwd;
    if (!cwd) {
      return c.json({ error: "No active workspace" }, 400);
    }
    const ALLOWED_SKILL_SUBS = [
      ".claude/skills", ".codex/skills", ".openclaw/skills",
      ".agents/skills", ".pi/skills",
    ];
    const allowed = ALLOWED_SKILL_SUBS.some(sub =>
      isInsidePath(skillDirPath, path.join(cwd, sub))
    );
    if (!allowed) {
      return c.json({ error: "Only skills in current workspace skill directories can be deleted" }, 403);
    }
    try {
      fs.rmSync(skillDirPath, { recursive: true, force: true });
      engine.skillManager?.invalidateCwdCache?.(cwd);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  /** 工作空间路径 */
  route.get("/desk/path", async (c) => {
    const rawDir = c.req.query("dir");
    const dir = getWorkspaceDir(rawDir);
    if (!dir) return c.json({ path: null });
    if (rawDir && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(dir, { recursive: true });
    return c.json({ path: dir });
  });

  /** 读取当前工作目录的本地 Git 上下文 */
  route.get("/desk/git-context", async (c) => {
    const rawDir = c.req.query("dir");
    const dir = getWorkspaceDir(rawDir);
    if (!dir) return c.json({ available: false });
    if (rawDir && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });

    const gitContext = readGitContext(dir);
    return c.json(gitContext);
  });

  route.get("/desk/git-diff", async (c) => {
    const rawDir = c.req.query("dir");
    const rawFile = c.req.query("file");
    const dir = getWorkspaceDir(rawDir);
    const filePath = rawFile ? safeDecodeURIComponent(rawFile) : "";
    if (!dir || !filePath) return c.json({ available: false, filePath: filePath || "" });
    if (rawDir && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    return c.json(readGitDiff(dir, filePath));
  });

  /** 模糊搜索工作空间文件（@mention 用） */
  route.get("/desk/search", async (c) => {
    const rawDir = c.req.query("dir");
    const dir = getWorkspaceDir(rawDir);
    if (!dir) return c.json({ files: [] });
    if (rawDir && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    const searchDir = dir;
    const q = (c.req.query("q") || "").toLowerCase().trim();
    if (!q) return c.json({ files: [] });

    const MAX_RESULTS = 20;
    const MAX_DEPTH = 6;
    const IGNORED = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv"]);
    const results: SearchResult[] = [];

    function walk(dirPath: string, depth: number): void {
      if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) break;
        if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
        const full = path.join(dirPath, entry.name);
        const rel = path.relative(searchDir, full);
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase().includes(q)) {
            results.push({ name: entry.name, path: full, rel, isDir: true });
          }
          walk(full, depth + 1);
        } else {
          if (entry.name.toLowerCase().includes(q) || rel.toLowerCase().includes(q)) {
            results.push({ name: entry.name, path: full, rel, isDir: false });
          }
        }
      }
    }

    walk(dir, 0);
    return c.json({ files: results });
  });

  /** 列出工作空间文件（支持 ?subdir=xxx 浏览子目录, ?dir=xxx 覆盖基目录） */
  route.get("/desk/files", async (c) => {
    const rawDir = c.req.query("dir");
    const dir = getWorkspaceDir(rawDir);
    if (!dir) return c.json({ files: [], subdir: "", basePath: null });
    if (rawDir && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    // 安全：禁止路径穿越
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    return c.json({ files: await listWorkspaceFiles(target), subdir: subdir || "", basePath: dir });
  });

  /** 读取指定目录的 jian.md */
  route.get("/desk/jian", async (c) => {
    const rawDir = c.req.query("dir");
    const dir = getWorkspaceDir(rawDir);
    if (!dir) return c.json({ content: null });
    if (rawDir && !isApprovedDirStringOnly(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePathStringOnly(target, dir)) return c.json({ error: "invalid path" });
    const jianPath = path.join(target, "jian.md");
    const content = await withTimeout(fsp.readFile(jianPath, "utf-8"), 800, null).catch(() => null);
    return c.json({ content });
  });

  /** 保存指定目录的 jian.md（自动创建 / 内容为空时删除） */
  route.post("/desk/jian", async (c) => {
    const body = await readBody(c);
    const bodyDir = stringOrUndefined(body.dir);
    const dir = bodyDir || engine.deskCwd;
    if (!dir) return c.json({ error: t("error.noWorkspace") });
    if (bodyDir && !isApprovedDir(dir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    const { subdir, content } = body;
    const sub = stringOrUndefined(subdir) || "";
    if (sub && (sub.includes("\\") || sub.includes("..") || sub.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = sub ? path.join(dir, sub) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    const jianPath = path.join(target, "jian.md");

    try {
      if (content === null || content === undefined) {
        // 内容为空 → 删除 jian.md
        if (fs.existsSync(jianPath)) fs.unlinkSync(jianPath);
        return c.json({ ok: true, content: null });
      }
      const textContent = requireString(content, "content");
      if (textContent.trim() === "") {
        // 内容为空 → 删除 jian.md
        if (fs.existsSync(jianPath)) fs.unlinkSync(jianPath);
        return c.json({ ok: true, content: null });
      }
      // 确保目录存在
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(jianPath, textContent, "utf-8");
      return c.json({ ok: true, content: textContent });
    } catch (err) {
      return c.json({ error: errorMessage(err) });
    }
  });

  /** 工作空间文件操作（支持 subdir + dir override） */
  route.post("/desk/files", async (c) => {
    const body = await readBody(c);
    const bodyDir = stringOrUndefined(body.dir);
    const baseDir = bodyDir || engine.deskCwd;
    if (!baseDir) return c.json({ error: t("error.noWorkspace") });
    if (bodyDir && !isApprovedDir(baseDir, engine)) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(baseDir, { recursive: true });

    const { action, subdir: sub, paths, name, content, oldName, newName } = body;

    // 解析子目录
    const subdirStr = stringOrUndefined(sub) || "";
    if (subdirStr && (subdirStr.includes("\\") || subdirStr.includes("..") || subdirStr.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const dir = subdirStr ? path.join(baseDir, subdirStr) : baseDir;
    if (!isInsidePath(dir, baseDir)) return c.json({ error: "invalid path" });

    switch (action) {
      case "upload": {
        if (!Array.isArray(paths) || paths.length === 0) {
          return c.json({ error: "paths required" });
        }
        const results: FileActionResult[] = [];
        for (const srcPath of paths) {
          try {
            if (typeof srcPath !== "string" || !path.isAbsolute(srcPath) || !fs.existsSync(srcPath)) {
              results.push({ src: srcPath, error: "invalid path" });
              continue;
            }
            if (isSensitivePath(srcPath, engine.lynnHome)) {
              results.push({ src: srcPath, error: "sensitive path blocked" });
              continue;
            }
            const fname = path.basename(srcPath);
            const dest = path.join(dir, fname);
            const stat = fs.statSync(srcPath);
            if (stat.isDirectory()) {
              fs.cpSync(srcPath, dest, { recursive: true });
            } else {
              fs.copyFileSync(srcPath, dest);
            }
            results.push({ src: srcPath, name: fname });
          } catch (err) {
            results.push({ src: srcPath, error: errorMessage(err) });
          }
        }
        return c.json({ ok: true, results, files: await listWorkspaceFiles(dir) });
      }

      case "create": {
        const fileName = stringOrUndefined(name);
        if (!fileName || content === undefined) {
          return c.json({ error: "name and content required" });
        }
        const createTarget = path.join(dir, path.basename(fileName));
        if (!isInsidePath(createTarget, dir)) return c.json({ error: "invalid name" });
        fs.writeFileSync(createTarget, requireString(content, "content"), "utf-8");
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "mkdir": {
        const fileName = stringOrUndefined(name);
        if (!fileName) return c.json({ error: "name required" });
        const mkTarget = path.join(dir, path.basename(fileName));
        if (!isInsidePath(mkTarget, dir)) return c.json({ error: "invalid name" });
        if (fs.existsSync(mkTarget)) return c.json({ error: "already exists" });
        fs.mkdirSync(mkTarget, { recursive: true });
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "rename": {
        const oldNameStr = stringOrUndefined(oldName);
        const newNameStr = stringOrUndefined(newName);
        if (!oldNameStr || !newNameStr) return c.json({ error: "oldName and newName required" });
        const src = path.join(dir, path.basename(oldNameStr));
        const dest = path.join(dir, path.basename(newNameStr));
        if (!isInsidePath(src, dir) || !isInsidePath(dest, dir)) return c.json({ error: "invalid name" });
        if (!fs.existsSync(src)) return c.json({ error: "not found" });
        if (fs.existsSync(dest)) return c.json({ error: "target already exists" });
        fs.renameSync(src, dest);
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      case "move": {
        const names = body.names;
        const destFolder = stringOrUndefined(body.destFolder);
        if (!Array.isArray(names) || names.length === 0 || !destFolder) {
          return c.json({ error: "names[] and destFolder required" });
        }
        const fileNames = names.filter((n): n is string => typeof n === "string");
        if (fileNames.length !== names.length) {
          return c.json({ error: "names[] and destFolder required" });
        }
        if (fileNames.includes(destFolder)) {
          return c.json({ error: "cannot move folder into itself" });
        }
        const destDir = path.join(dir, path.basename(destFolder));
        if (!isInsidePath(destDir, dir)) return c.json({ error: "invalid destFolder" });
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return c.json({ error: "destFolder is not a directory" });
        }
        const results: FileActionResult[] = [];
        for (const n of fileNames) {
          const src = path.join(dir, path.basename(n));
          const dest = path.join(destDir, path.basename(n));
          if (!isInsidePath(src, dir)) { results.push({ name: n, error: "invalid name" }); continue; }
          if (!fs.existsSync(src)) { results.push({ name: n, error: "not found" }); continue; }
          if (fs.existsSync(dest)) { results.push({ name: n, error: "target already exists" }); continue; }
          try {
            fs.renameSync(src, dest);
            results.push({ name: n, ok: true });
          } catch (err) {
            results.push({ name: n, error: errorMessage(err) });
          }
        }
        return c.json({ ok: true, results, files: await listWorkspaceFiles(dir) });
      }

      case "remove": {
        const fileName = stringOrUndefined(name);
        if (!fileName) return c.json({ error: "name required" });
        const rmTarget = path.join(dir, path.basename(fileName));
        if (!isInsidePath(rmTarget, dir)) return c.json({ error: "invalid name" });
        if (!fs.existsSync(rmTarget)) return c.json({ error: "not found" });
        fs.rmSync(rmTarget, { recursive: true, force: true });
        return c.json({ ok: true, files: await listWorkspaceFiles(dir) });
      }

      default:
        return c.json({ error: `unknown action: ${action}` });
    }
  });

  return route;
}
