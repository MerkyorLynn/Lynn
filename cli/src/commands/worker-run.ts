import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  FLEET_EVENT_SCHEMA_VERSION,
  type FleetChangedFile,
  type FleetWorkerEvent,
  parseFleetJsonLine,
  validateFleetWorkerEvent,
} from "../../../shared/fleet-events.js";
import { annotateChangedFiles, evaluateScope } from "../../../shared/fleet-scope.js";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat } from "../brain-client.js";
import { buildImageContentParts } from "../media.js";
import { parseReasoningOptions } from "../reasoning.js";
import { runCode } from "./code.js";
import { buildVisionPrompt, type VisionCommand } from "./vision.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { readEnvProviderProfile, resolveCliProviderProfile } from "../provider-profile.js";
import { resolveEffectivePermissions, type PermissionProfile } from "../permissions.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";
export { extractGroundingBoxes } from "../vision-result.js";
import { extractGroundingBoxes } from "../vision-result.js";

export interface WorkerBrief {
  title: string;
  objective: string;
  owned: string[];
  forbidden: string[];
  centerLocks: string[];
  tests: string[];
  taskType: "code" | VisionCommand;
  image?: string;
  resumePath?: string;
}

export interface WorkerDiffSummary {
  files: number;
  insertions: number;
  deletions: number;
  changedFiles: FleetChangedFile[];
}

const execFileAsync = promisify(execFile);

function sectionLines(markdown: string, title: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${title}`.toLowerCase());
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] || "";
    if (/^##\s+/.test(line)) break;
    out.push(line);
  }
  return out;
}

function bulletValues(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim().match(/^[-*]\s+(.*)$/)?.[1]?.trim() || "")
    .filter(Boolean);
}

function firstSectionValue(markdown: string, title: string): string {
  return sectionLines(markdown, title)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)[0] || "";
}

function preambleObjective(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("# ")) continue;
    if (/^##\s+/.test(line)) break;
    if (line.trim()) out.push(line.trim());
  }
  return out.join("\n").trim();
}

function normalizeTaskType(raw: string): WorkerBrief["taskType"] {
  const value = raw.trim().toLowerCase();
  if (value === "see" || value === "ground" || value === "ui2code") return value;
  return "code";
}

export function parseWorkerBrief(markdown: string): WorkerBrief {
  const title = markdown.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() || "Untitled worker task";
  const objective = sectionLines(markdown, "Objective").join("\n").trim() || preambleObjective(markdown);
  const owned = bulletValues(sectionLines(markdown, "Owned files"));
  const forbidden = bulletValues(sectionLines(markdown, "Forbidden files"));
  const centerLocks = [
    ...bulletValues(sectionLines(markdown, "Center locks")),
    ...bulletValues(sectionLines(markdown, "Center locked files")),
    ...bulletValues(sectionLines(markdown, "Center-locked files")),
  ];
  const tests = bulletValues(sectionLines(markdown, "Test commands"));
  const taskType = normalizeTaskType(firstSectionValue(markdown, "Task Type") || firstSectionValue(markdown, "Type"));
  const image = firstSectionValue(markdown, "Image") || firstSectionValue(markdown, "Screenshot") || undefined;
  const resumePath = firstSectionValue(markdown, "Resume") || firstSectionValue(markdown, "Session") || undefined;
  return { title, objective, owned, forbidden, centerLocks, tests, taskType, image, resumePath };
}

function emit(event: FleetWorkerEvent): void {
  const enriched = { schemaVersion: FLEET_EVENT_SCHEMA_VERSION, ts: nowIso(), ...event } as FleetWorkerEvent;
  const validation = validateFleetWorkerEvent(enriched);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  writeJsonLine(enriched);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const WORKER_GUARDRAIL = [
  "You are running as a Lynn Fleet worker.",
  "Follow the task brief exactly and keep all edits inside the assigned worktree and owned files.",
  "Some Fleet briefs are answer-only smoke or coordination tasks. If the brief explicitly says not to inspect files, not to run tools, or to reply/output exactly, answer directly and finish without repository exploration.",
  "Do not download model weights, BF16/GGUF files, datasets, training packages, or large binary artifacts to this Mac.",
  "Report progress concisely; Lynn will inspect git diff, tests, and scope after you finish.",
].join("\n");

export function buildWorkerPrompt(taskText: string): string {
  return `${WORKER_GUARDRAIL}\n\n${taskText}`;
}

export function buildDefaultAgentCommand(agent: string, briefPath: string, worktree: string, taskText: string): string | null {
  const prompt = buildWorkerPrompt(taskText);
  switch (agent) {
    case "claude-internal":
      return [
        "claude-internal",
        "-p",
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--include-partial-messages",
        "--permission-mode bypassPermissions",
        shellQuote(prompt),
      ].join(" ");
    case "claude-code":
      return [
        "claude",
        "-p",
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--verbose",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
        shellQuote(prompt),
      ].join(" ");
    case "codex-cli":
      return [
        "codex exec",
        "--cd",
        shellQuote(worktree),
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        shellQuote(prompt),
      ].join(" ");
    case "opencode":
    case "opencode-cli":
    case "open-code":
      return `opencode run --format json --cwd ${shellQuote(worktree)} ${shellQuote(prompt)}`;
    case "qwen-cli":
      return [
        "qwen",
        "-p",
        shellQuote(prompt),
        "--add-dir",
        shellQuote(worktree),
        "--output-format stream-json",
        "--include-partial-messages",
        "--approval-mode yolo",
        "--yolo",
      ].join(" ");
    case "kimi-cli":
      return [
        "kimi",
        "--work-dir",
        shellQuote(worktree),
        "--print",
        "--output-format stream-json",
        "--yolo",
        "--afk",
        "-p",
        shellQuote(prompt),
      ].join(" ");
    case "codebuddy":
      return [
        "codebuddy",
        "-p",
        "--output-format stream-json",
        "--include-partial-messages",
        "--add-dir",
        shellQuote(worktree),
        "--permission-mode bypassPermissions",
        "-y",
        shellQuote(prompt),
      ].join(" ");
    default:
      return null;
  }
}

function mergeEventDefaults(event: FleetWorkerEvent, workerId: string, agent: string): FleetWorkerEvent {
  return { workerId, agent, ...event } as FleetWorkerEvent;
}

export { externalJsonEvents } from "../worker-external-events.js";
import { externalJsonEvents } from "../worker-external-events.js";
function actionFromStatus(code: string): FleetChangedFile["action"] {
  if (code.includes("R")) return "rename";
  if (code.includes("D")) return "delete";
  if (code.includes("A") || code.includes("?")) return "add";
  return "edit";
}

function parseStatusPath(raw: string): string {
  const pathPart = raw.slice(3).trim();
  const renameTarget = pathPart.split(" -> ").pop();
  return renameTarget || pathPart;
}

function parseNumstat(raw: string): Map<string, { insertions: number; deletions: number }> {
  const out = new Map<string, { insertions: number; deletions: number }>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [insertionsRaw, deletionsRaw, ...pathParts] = line.split(/\t/);
    const filePath = pathParts.join("\t").trim();
    if (!filePath) continue;
    const insertions = Number.parseInt(insertionsRaw || "0", 10);
    const deletions = Number.parseInt(deletionsRaw || "0", 10);
    out.set(filePath, {
      insertions: Number.isFinite(insertions) ? insertions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return out;
}

async function countUntrackedInsertions(worktree: string, filePath: string): Promise<number> {
  const absolute = path.resolve(worktree, filePath);
  const root = path.resolve(worktree);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return 0;
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) return 0;
  const text = await fs.readFile(absolute, "utf8").catch(() => "");
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

async function gitOutput(worktree: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", worktree, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return String(stdout);
}

export async function collectGitDiff(worktree: string, ignorePaths: ReadonlySet<string> = new Set()): Promise<WorkerDiffSummary> {
  const [statusRaw, unstagedNumstatRaw, stagedNumstatRaw] = await Promise.all([
    gitOutput(worktree, ["status", "--porcelain=v1"]),
    gitOutput(worktree, ["diff", "--numstat"]),
    gitOutput(worktree, ["diff", "--cached", "--numstat"]),
  ]);
  const numstat = new Map([...parseNumstat(unstagedNumstatRaw), ...parseNumstat(stagedNumstatRaw)]);
  const changedFiles: FleetChangedFile[] = [];
  for (const line of statusRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const filePath = parseStatusPath(line);
    if (ignorePaths.has(filePath)) continue;
    const stats = numstat.get(filePath) || (code.includes("?")
      ? { insertions: await countUntrackedInsertions(worktree, filePath), deletions: 0 }
      : { insertions: 0, deletions: 0 });
    changedFiles.push({
      path: filePath,
      action: actionFromStatus(code),
      insertions: stats.insertions,
      deletions: stats.deletions,
    });
  }
  return {
    files: changedFiles.length,
    insertions: changedFiles.reduce((sum, file) => sum + (file.insertions || 0), 0),
    deletions: changedFiles.reduce((sum, file) => sum + (file.deletions || 0), 0),
    changedFiles,
  };
}

async function collectDiffBaseline(worktree: string): Promise<Set<string>> {
  try {
    return new Set((await collectGitDiff(worktree)).changedFiles.map((file) => file.path));
  } catch {
    return new Set();
  }
}

async function emitGitDiff(workerId: string, agent: string, worktree: string, brief?: Pick<WorkerBrief, "forbidden" | "centerLocks">, baseline: ReadonlySet<string> = new Set()): Promise<boolean> {
  try {
    const diff = await collectGitDiff(worktree, baseline);
    const changedPaths = diff.changedFiles.map((file) => file.path);
    const verdict = evaluateScope(changedPaths, brief?.forbidden || [], brief?.centerLocks || []);
    emit({
      type: "git.diff",
      workerId,
      agent,
      ...diff,
      changedFiles: annotateChangedFiles(diff.changedFiles, brief?.forbidden || [], brief?.centerLocks || []),
    });
    for (const filePath of verdict.forbiddenPaths) {
      emit({
        type: "worker.violation",
        workerId,
        agent,
        code: "forbidden_file",
        path: filePath,
        message: `worker changed forbidden file: ${filePath}`,
        severity: "error",
      });
    }
    for (const filePath of verdict.centerLockPaths) {
      emit({
        type: "worker.violation",
        workerId,
        agent,
        code: "center_lock",
        path: filePath,
        message: `worker changed center-locked file: ${filePath}`,
        severity: "error",
      });
    }
    return verdict.ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "worker.progress", workerId, agent, level: "warning", message: `git diff inspection failed: ${message}` });
    emit({ type: "git.diff", workerId, agent, files: 0, insertions: 0, deletions: 0, changedFiles: [] });
    return true;
  }
}

async function runCommand(command: string, cwd: string): Promise<{ ok: boolean; exitCode: number; ms: number; summary: string; output?: string; truncated?: boolean }> {
  const started = Date.now();
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LYNN_NO_MODEL_DOWNLOADS: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
  const output = redactSecrets(`${stdout}${stderr}`.trim());
  const summary = output.split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
  const maxOutputChars = 32_000;
  const truncated = output.length > maxOutputChars;
  return {
    ok: exitCode === 0,
    exitCode,
    ms: Date.now() - started,
    summary: summary || `exit ${exitCode}`,
    output: output ? output.slice(-maxOutputChars) : undefined,
    truncated,
  };
}

async function runBriefTests(workerId: string, agent: string, worktree: string, tests: readonly string[]): Promise<boolean> {
  let ok = true;
  for (const command of tests) {
    emit({ type: "test.started", workerId, agent, command });
    const result = await runCommand(command, worktree);
    if (!result.ok) ok = false;
    emit({ type: "test.finished", workerId, agent, command, ok: result.ok, summary: result.summary, ms: result.ms, data: { output: result.output, truncated: result.truncated } });
  }
  if (tests.length) emit({ type: "gate.finished", workerId, agent, ok, summary: ok ? "all test commands passed" : "one or more test commands failed" });
  return ok;
}

function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|tp|ak)-[A-Za-z0-9_=-]{12,}\b/g, "$1-[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s]{8,}/gi, "$1=[REDACTED]");
}

async function runExternalWorker(input: {
  command: string;
  worktree: string;
  workerId: string;
  agent: string;
}): Promise<number> {
  emit({ type: "shell.started", workerId: input.workerId, agent: input.agent, command: input.command, approval: "auto" });
  const child = spawn(input.command, {
    cwd: input.worktree,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LYNN_WORKER_ID: input.workerId,
      LYNN_WORKER_AGENT: input.agent,
      LYNN_NO_MODEL_DOWNLOADS: "1",
    },
  });

  const started = Date.now();
  const handleLine = (line: string, stream: "stdout" | "stderr"): void => {
    if (!line.trim()) return;
    const parsed = parseFleetJsonLine(line);
    if (parsed.ok && parsed.event) {
      emit(mergeEventDefaults(parsed.event, input.workerId, input.agent));
    } else {
      const events = externalJsonEvents(line, input.workerId, input.agent);
      if (events.length) {
        for (const event of events) emit(event);
      } else {
        emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: line, level: stream === "stderr" ? "warning" : "info" });
      }
    }
  };

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || "";
    lines.forEach((line) => handleLine(line, "stdout"));
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    const lines = stderr.split(/\r?\n/);
    stderr = lines.pop() || "";
    lines.forEach((line) => handleLine(line, "stderr"));
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
  handleLine(stdout, "stdout");
  handleLine(stderr, "stderr");
  const ok = exitCode === 0;
  emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: input.command, ok, exitCode, ms: Date.now() - started });
  if (!ok) {
    emit({ type: "worker.error", workerId: input.workerId, agent: input.agent, code: "worker_exit_nonzero", message: `worker exited with ${exitCode}`, recoverable: true });
  }
  return exitCode;
}

function buildLynnCodeWorkerTask(brief: WorkerBrief): string {
  return [
    `Fleet task: ${brief.title}`,
    "",
    "Task type:",
    brief.taskType,
    "",
    ...(brief.image ? ["Image:", brief.image, ""] : []),
    "Objective:",
    brief.objective || brief.title,
    "",
    "Owned files:",
    ...(brief.owned.length ? brief.owned.map((p) => `- ${p}`) : ["- (not specified)"]),
    "",
    "Forbidden files:",
    ...(brief.forbidden.length ? brief.forbidden.map((p) => `- ${p}`) : ["- (none)"]),
    "",
    "Center-locked files:",
    ...(brief.centerLocks.length ? brief.centerLocks.map((p) => `- ${p}`) : ["- (none)"]),
    "",
    "Test commands expected by the task:",
    ...(brief.tests.length ? brief.tests.map((cmd) => `- ${cmd}`) : ["- (not specified)"]),
    "",
    "Stay inside the owned files. Do not touch forbidden files. Prefer apply_patch for edits.",
  ].join("\n");
}

function isBuiltInLynnWorker(agent: string): boolean {
  return agent === "lynn-cli" || agent === "mimo-vl" || agent === "mimo-pro" || agent === "mimo-fast" || agent === "stepfun-flash";
}

export function isAnswerOnlyWorkerBrief(brief: Pick<WorkerBrief, "title" | "objective" | "tests">): boolean {
  if (brief.tests.length) return false;
  const text = `${brief.title}\n${brief.objective}`.toLowerCase();
  return [
    /\breply exactly\b/,
    /\boutput exactly\b/,
    /\banswer only\b/,
    /\bno tools?\b/,
    /\bwithout tools?\b/,
    /\bdo not\b[\s\S]{0,80}\b(inspect|read|run|use|call|edit|modify)\b[\s\S]{0,80}\b(tool|tools|file|files|command|commands|repo|repository)\b/,
    /只回复/,
    /只输出/,
    /不要[\s\S]{0,40}(工具|读文件|读取|运行|修改|编辑|检查)/,
    /无需[\s\S]{0,40}(工具|读文件|读取|运行|修改|编辑|检查)/,
  ].some((pattern) => pattern.test(text));
}

function isVisionTask(taskType: WorkerBrief["taskType"]): taskType is "see" | "ground" {
  return taskType === "see" || taskType === "ground";
}

export function workerProfileDefaults(agent: string): { reasoning?: "off" | "high" | "xhigh"; maxSteps?: string; long?: boolean; best?: boolean } {
  if (agent === "mimo-fast") return { reasoning: "off", maxSteps: "6" };
  if (agent === "mimo-pro") return { reasoning: "high", maxSteps: "100", long: true };
  if (agent === "mimo-vl") return { reasoning: "high" };
  if (agent === "stepfun-flash") return { reasoning: "high", maxSteps: "300", long: true };
  return {};
}

async function runLynnCliWorker(input: {
  args: ParsedArgs;
  brief: WorkerBrief;
  worktree: string;
  workerId: string;
  agent: string;
  permissions: PermissionProfile;
}): Promise<number> {
  if (isAnswerOnlyWorkerBrief(input.brief)) {
    return runLynnAnswerOnlyWorker(input);
  }

  const task = buildLynnCodeWorkerTask(input.brief);
  emit({ type: "shell.started", workerId: input.workerId, agent: input.agent, command: "Lynn code", approval: "auto" });
  const started = Date.now();
  const profileDefaults = workerProfileDefaults(input.agent);
  const flags: Record<string, string | boolean> = {
    cwd: input.worktree,
    approval: getStringFlag(input.args.flags, "approval") || input.permissions.approval,
    sandbox: getStringFlag(input.args.flags, "sandbox") || input.permissions.sandbox,
    "max-steps": getStringFlag(input.args.flags, "max-steps", "steps") || profileDefaults.maxSteps || "100",
    "save-session": true,
    title: input.brief.title,
    json: true,
  };
  if (profileDefaults.long || hasFlag(input.args.flags, "long", "endurance")) flags.long = true;
  if (profileDefaults.best || hasFlag(input.args.flags, "best", "exhaustive")) flags.best = true;
  const brainUrl = getStringFlag(input.args.flags, "brain-url");
  if (brainUrl) flags["brain-url"] = brainUrl;
  const reasoning = getStringFlag(input.args.flags, "reasoning") || profileDefaults.reasoning;
  if (reasoning) flags.reasoning = reasoning;
  const showReasoning = getStringFlag(input.args.flags, "show-reasoning");
  if (showReasoning) flags["show-reasoning"] = showReasoning;
  if (input.brief.resumePath) {
    flags.resume = path.isAbsolute(input.brief.resumePath)
      ? input.brief.resumePath
      : path.resolve(input.worktree, input.brief.resumePath);
  }
  if (input.brief.image) {
    flags.image = path.isAbsolute(input.brief.image)
      ? input.brief.image
      : path.resolve(input.worktree, input.brief.image);
  }
  const preset = workerProviderPreset(input.agent);
  if (preset && !readEnvProviderProfile() && !getStringFlag(input.args.flags, "preset") && !getStringFlag(input.args.flags, "base-url", "api-base") && !getStringFlag(input.args.flags, "model")) {
    flags.preset = preset;
  }
  copyProviderFlags(input.args.flags, flags);
  const exitCode = await runCode({ command: "code", positionals: [task], flags });
  const ok = exitCode === 0;
  emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: "Lynn code", ok, exitCode, ms: Date.now() - started });
  if (!ok) {
    emit({ type: "worker.error", workerId: input.workerId, agent: input.agent, code: "worker_exit_nonzero", message: `lynn-cli worker exited with ${exitCode}`, recoverable: true });
  }
  return exitCode;
}

async function runLynnAnswerOnlyWorker(input: {
  args: ParsedArgs;
  brief: WorkerBrief;
  worktree: string;
  workerId: string;
  agent: string;
  permissions: PermissionProfile;
}): Promise<number> {
  emit({ type: "shell.started", workerId: input.workerId, agent: input.agent, command: "Lynn answer", approval: "auto" });
  const started = Date.now();
  const brainUrl = await resolveDefaultBrainUrl(input.args);
  const profileDefaults = workerProfileDefaults(input.agent);
  const reasoning = parseReasoningOptions({
    ...input.args,
    flags: {
      ...input.args.flags,
      ...(getStringFlag(input.args.flags, "reasoning") ? {} : profileDefaults.reasoning ? { reasoning: profileDefaults.reasoning } : {}),
    },
  });
  const cliProvider = await resolveCliProviderProfile(argsWithWorkerPreset(input.args, input.agent));
  let assistantText = "";
  try {
    for await (const event of streamBrainChat({
      brainUrl,
      reasoning,
      prompt: buildAnswerOnlyWorkerPrompt(input.brief),
      fallbackProvider: cliProvider?.profile,
    })) {
      if (event.type === "assistant.delta") {
        assistantText += event.text;
        emit({ type: "assistant.delta", workerId: input.workerId, agent: input.agent, text: event.text });
      } else if (event.type === "reasoning.delta") {
        emit({ type: "reasoning.delta", workerId: input.workerId, agent: input.agent, text: event.text, hidden: event.hidden });
      } else if (event.type === "provider") {
        emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: `provider: ${event.activeProvider}`, data: event });
      } else if (event.type === "usage") {
        emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: "usage", data: usageWithDuration(event.usage, Date.now() - started) });
      } else if (event.type === "brain.error") {
        throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
      }
    }
    const ok = !!assistantText.trim();
    emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: "Lynn answer", ok, exitCode: ok ? 0 : 1, ms: Date.now() - started });
    if (!ok) {
      emit({ type: "worker.error", workerId: input.workerId, agent: input.agent, code: "answer_worker_empty", message: "answer-only worker returned no visible text", recoverable: true });
    }
    return ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "worker.error", workerId: input.workerId, agent: input.agent, code: "answer_worker_failed", message, recoverable: true });
    emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: "Lynn answer", ok: false, exitCode: 1, ms: Date.now() - started });
    return 1;
  }
}

function buildAnswerOnlyWorkerPrompt(brief: WorkerBrief): string {
  return [
    "You are a Lynn Fleet worker handling an answer-only task.",
    "Do not inspect files. Do not call tools. Do not run commands.",
    "Follow the objective exactly. If it asks for an exact phrase, output only that phrase.",
    "",
    `Title: ${brief.title}`,
    "",
    "Objective:",
    brief.objective || brief.title,
  ].join("\n");
}

export function workerProviderPreset(agent: string): string | null {
  if (agent === "stepfun-flash") return "stepfun";
  return null;
}

function argsWithWorkerPreset(args: ParsedArgs, agent: string): ParsedArgs {
  const preset = workerProviderPreset(agent);
  if (!preset || readEnvProviderProfile() || getStringFlag(args.flags, "preset") || getStringFlag(args.flags, "base-url", "api-base") || getStringFlag(args.flags, "model")) return args;
  return { ...args, flags: { ...args.flags, preset } };
}

async function runLynnVisionWorker(input: {
  args: ParsedArgs;
  brief: WorkerBrief;
  worktree: string;
  workerId: string;
  agent: string;
  permissions: PermissionProfile;
}): Promise<number> {
  if (!isVisionTask(input.brief.taskType)) return runLynnCliWorker(input);
  if (!input.brief.image) {
    emit({
      type: "worker.error",
      workerId: input.workerId,
      agent: input.agent,
      code: "vision_image_missing",
      message: "MiMo vision worker requires an Image section in the brief",
      recoverable: true,
    });
    return 2;
  }

  const imagePath = path.isAbsolute(input.brief.image) ? input.brief.image : path.resolve(input.worktree, input.brief.image);
  const prompt = buildVisionPrompt(input.brief.taskType, input.brief.objective || input.brief.title);
  const content = await buildImageContentParts(imagePath, prompt);
  const brainUrl = await resolveDefaultBrainUrl(input.args);
  const profileDefaults = workerProfileDefaults(input.agent);
  const reasoning = parseReasoningOptions({
    ...input.args,
    flags: {
      ...input.args.flags,
      ...(getStringFlag(input.args.flags, "reasoning") ? {} : profileDefaults.reasoning ? { reasoning: profileDefaults.reasoning } : {}),
    },
  });
  const cliProvider = await resolveCliProviderProfile(input.args);
  emit({ type: "shell.started", workerId: input.workerId, agent: input.agent, command: `Lynn ${input.brief.taskType}`, approval: "auto" });
  const started = Date.now();
  let assistantText = "";
  try {
    for await (const event of streamBrainChat({
      brainUrl,
      reasoning,
      messages: [{ role: "user", content }],
      fallbackProvider: cliProvider?.profile,
    })) {
      if (event.type === "assistant.delta") {
        assistantText += event.text;
        emit({ type: "assistant.delta", workerId: input.workerId, agent: input.agent, text: event.text });
      }
      else if (event.type === "reasoning.delta") emit({ type: "reasoning.delta", workerId: input.workerId, agent: input.agent, text: event.text, hidden: event.hidden });
      else if (event.type === "provider") emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: `provider: ${event.activeProvider}`, data: event });
      else if (event.type === "tool_progress") emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: `${event.name}: ${event.event}`, data: event });
      else if (event.type === "usage") emit({ type: "worker.progress", workerId: input.workerId, agent: input.agent, message: "usage", data: usageWithDuration(event.usage, Date.now() - started) });
      else if (event.type === "brain.error") throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
    }
    emit({
      type: "worker.visual_result",
      workerId: input.workerId,
      agent: input.agent,
      taskType: input.brief.taskType,
      image: input.brief.image,
      summary: assistantText.trim() || "MiMo vision worker completed without visible text.",
      ...(input.brief.taskType === "ground" ? { boxes: extractGroundingBoxes(assistantText) } : {}),
    });
    emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: `Lynn ${input.brief.taskType}`, ok: true, exitCode: 0, ms: Date.now() - started });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "worker.error", workerId: input.workerId, agent: input.agent, code: "vision_worker_failed", message, recoverable: true });
    emit({ type: "shell.finished", workerId: input.workerId, agent: input.agent, command: `Lynn ${input.brief.taskType}`, ok: false, exitCode: 1, ms: Date.now() - started });
    return 1;
  }
}

function copyProviderFlags(from: Record<string, string | boolean>, to: Record<string, string | boolean>): void {
  for (const key of ["provider", "preset", "base-url", "api-base", "api-key", "model", "data-dir"]) {
    const value = from[key];
    if (typeof value === "string" && value) to[key] = value;
  }
}

function canRunDefaultExternalWorker(permissions: PermissionProfile): boolean {
  return permissions.approval === "yolo" && permissions.sandbox === "danger-full-access";
}

function emitExternalWorkerPermissionError(workerId: string, agent: string, permissions: PermissionProfile): void {
  emit({
    type: "worker.error",
    workerId,
    agent,
    code: "external_worker_requires_yolo",
    message: `default external worker adapter requires --approval yolo --sandbox danger-full-access (current: ${permissions.approval}/${permissions.sandbox})`,
    recoverable: true,
  });
  emit({
    type: "gate.finished",
    workerId,
    agent,
    ok: false,
    summary: "external worker blocked before launch: explicit YOLO/full-access approval required",
  });
}

function usageWithDuration(usage: unknown, durationMs: number): unknown {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { duration_ms: durationMs };
  return { ...(usage as Record<string, unknown>), duration_ms: durationMs };
}

export async function runWorker(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] || "";
  if (subcommand && subcommand !== "run") {
    throw new Error(`unsupported worker command: ${subcommand}`);
  }

  const briefPath = getStringFlag(args.flags, "brief", "task");
  const worktree = getStringFlag(args.flags, "worktree") || process.cwd();
  const workerId = getStringFlag(args.flags, "id") || `worker-${Date.now()}`;
  const agent = getStringFlag(args.flags, "agent") || "lynn-cli";
  const branch = path.basename(worktree) || "worker";
  const mock = hasFlag(args.flags, "mock");

  if (!briefPath) throw new Error("--brief is required");
  const markdown = await fs.readFile(briefPath, "utf8");
  const brief = parseWorkerBrief(markdown);
  const permissions = await resolveEffectivePermissions(args);
  const diffBaseline = await collectDiffBaseline(worktree);

  emit({
    type: "worker.started",
    workerId,
    agent,
    cwd: process.cwd(),
    worktree,
    branch,
    pid: process.pid,
    approval: permissions.approval,
    sandbox: permissions.sandbox,
  });
  emit({ type: "worker.claims", workerId, agent, owned: brief.owned, forbidden: brief.forbidden, centerLocks: brief.centerLocks });
  emit({ type: "worker.progress", workerId, agent, message: mock ? `Mock worker loaded: ${brief.title}` : `Worker loaded: ${brief.title}` });

  const explicitAgentCommand = getStringFlag(args.flags, "agent-command");
  const externalCommand = explicitAgentCommand || buildDefaultAgentCommand(agent, path.resolve(briefPath), path.resolve(worktree), markdown);
  if (!mock && isBuiltInLynnWorker(agent)) {
    const exitCode = isVisionTask(brief.taskType)
      ? await runLynnVisionWorker({ args, brief, worktree, workerId, agent, permissions })
      : await runLynnCliWorker({ args, brief, worktree, workerId, agent, permissions });
    const scopeOk = await emitGitDiff(workerId, agent, worktree, brief, diffBaseline);
    const testsOk = await runBriefTests(workerId, agent, worktree, brief.tests);
    const finalExit = exitCode === 0 && scopeOk && testsOk ? 0 : 1;
    emit({ type: "worker.finished", workerId, agent, ok: finalExit === 0, exitCode: finalExit, summary: finalExit === 0 ? "lynn-cli worker completed" : "lynn-cli worker failed" });
    return finalExit;
  }
  if (!mock && externalCommand) {
    if (!explicitAgentCommand && !canRunDefaultExternalWorker(permissions)) {
      emitExternalWorkerPermissionError(workerId, agent, permissions);
      return 2;
    }
    const exitCode = await runExternalWorker({ command: externalCommand, worktree, workerId, agent });
    const scopeOk = await emitGitDiff(workerId, agent, worktree, brief, diffBaseline);
    const testsOk = await runBriefTests(workerId, agent, worktree, brief.tests);
    const finalExit = exitCode === 0 && scopeOk && testsOk ? 0 : 1;
    emit({ type: "worker.finished", workerId, agent, ok: finalExit === 0, exitCode: finalExit, summary: finalExit === 0 ? "external worker completed" : "external worker failed" });
    return finalExit;
  }

  for (const command of brief.tests) {
    emit({ type: "test.started", workerId, agent, command });
    emit({ type: "test.finished", workerId, agent, command, ok: true, summary: mock ? "mock pass" : "not run in scaffold", ms: 0 });
  }

  if (mock && isVisionTask(brief.taskType)) {
    emit({
      type: "worker.visual_result",
      workerId,
      agent,
      taskType: brief.taskType,
      image: brief.image,
      summary: `mock ${brief.taskType} result for ${brief.image || "image"}`,
    });
  }

  emit({
    type: "git.diff",
    workerId,
    agent,
    files: 0,
    insertions: 0,
    deletions: 0,
    changedFiles: [],
  });
  emit({ type: "worker.finished", workerId, agent, ok: true, exitCode: 0, summary: mock ? "mock worker completed" : "worker scaffold completed" });
  return 0;
}

export function parseWorkerEventLine(line: string): ReturnType<typeof parseFleetJsonLine> {
  return parseFleetJsonLine(line);
}
