/**
 * tool-wrapper.js — 工具沙盒包装（三模式安全策略）
 *
 * 在 Pi SDK 工具的 execute 外面套一层路径校验。
 * 被拦截时返回 LLM 可读的文本错误，不抛异常。
 *
 * 三种沙盒模式：
 *   - standard (safe mode): 危险操作直接拒绝
 *   - authorized: 危险操作暂停→查白名单→弹确认→等用户决定
 *   - full-access: 不包装
 *
 * macOS/Linux: bash 安全边界在 OS 沙盒（seatbelt/bwrap），preflight 只优化体验。
 * Windows: 无 OS 沙盒，bash 额外做路径提取 + PathGuard 校验作为安全层。
 */

import path from "path";
import { t } from "../../shared/i18n-runtime.js";
import { createSnapshot, isDangerousCommand } from "./snapshot.js";
import type { PathGuardOperation } from "./path-guard.js";

interface ToolContent {
  type?: string;
  text?: string;
}

interface ToolResult {
  isError?: boolean;
  content?: ToolContent[];
}

interface ToolLike {
  parameters?: ParameterSchema;
  execute: (...args: never[]) => Promise<ToolResult>;
}

interface ParameterSchema {
  properties?: Record<string, unknown>;
  required?: unknown;
  [key: string]: unknown;
}

interface GuardLike {
  check: (absolutePath: string, operation: PathGuardOperation) => { allowed: boolean; reason?: string };
}

interface AllowlistLike {
  check: (entryOrCategory: unknown, identifier?: unknown, options?: { path?: string | null; trustedRoot?: string | null }) => boolean;
  add: (entryOrCategory: unknown, identifier?: unknown, options?: { trustedRoot?: string | null }) => boolean;
}

interface ConfirmResult {
  action?: string;
}

interface ConfirmStoreLike {
  create: (
    kind: string,
    payload: Record<string, unknown>,
    sessionPath?: string | null,
  ) => { confirmId: string; promise: Promise<ConfirmResult> };
}

interface AuthOptions {
  mode?: "authorized" | string;
  agentId?: string;
  allowlist?: AllowlistLike;
  sessionAllowlist?: AllowlistLike;
  confirmStore?: unknown;
  sessionPath?: string | null;
  getSessionPath?: () => string | null | undefined;
  emitEvent?: (...args: unknown[]) => unknown;
  trustedRoots?: string[] | null;
}

interface AuthorizationRequest {
  category: string;
  identifier: string;
  command: string;
  reason: string;
  description: string;
  allowlist?: AllowlistLike;
  sessionAllowlist?: AllowlistLike;
  confirmStore?: unknown;
  sessionPath?: string | null;
  emitEvent?: (...args: unknown[]) => unknown;
  path?: string | null;
  trustedRoots?: string[] | null;
}

type PreflightEntry = [RegExp, () => string, string, string, (() => string)?];

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isConfirmStore(value: unknown): value is ConfirmStoreLike {
  return !!value && typeof value === "object" && typeof (value as { create?: unknown }).create === "function";
}

function blockedResult(reason: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: t("sandbox.blocked", { reason }) }],
  };
}

function missingBashCommandResult(): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: "参数缺失：bash 工具需要 command 字段。Lynn 已兼容 query/cmd/shell/script 作为 command 别名；如果仍看到这条消息，说明模型没有给出可执行命令。",
    }],
  };
}

function blockedBroadHomeSearchResult(command: unknown): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: [
        "命令被提前停止：它会从用户主目录根部扫描大量文件，容易拖满超时并卡住会话。",
        "请改成更具体的路径，例如当前项目、Downloads、Desktop，或让用户提供实际工程目录后再查找。",
        `原命令：${String(command || "").slice(0, 240)}`,
      ].join("\n"),
    }],
  };
}

export function normalizeBashCommandForExecution(command: unknown): string {
  const text = String(command || "");
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (!/^mkdir\s+/i.test(trimmed)) return text;
  if (/^mkdir\s+-/i.test(trimmed)) return text;
  // Only normalize a plain mkdir invocation. Anything compound stays untouched
  // so we do not rewrite user/model shell logic in surprising ways.
  if (/[\n;&|`$<>]/.test(trimmed)) return text;
  return text.replace(/^(\s*)mkdir\s+/i, "$1mkdir -p ");
}

function normalizeBashParams(params: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = params && typeof params === "object" && !Array.isArray(params)
    ? { ...(params as Record<string, unknown>) }
    : {};
  if (typeof next.command === "string" && next.command.trim()) {
    next.command = normalizeBashCommandForExecution(next.command);
    return next;
  }

  for (const key of ["query", "cmd", "shell", "script"]) {
    if (typeof next[key] === "string" && next[key].trim()) {
      next.command = normalizeBashCommandForExecution(next[key]);
      return next;
    }
  }

  return next;
}

export function looksLikeBroadHomeSearchCommand(command: unknown): boolean {
  const text = String(command || "").trim();
  if (!/^find\s+/i.test(text)) return false;
  const home = process.env.HOME || osHomeFallback();
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const homePatterns = [
    new RegExp(`^find\\s+(?:['"])?${escapedHome}(?:['"])?(?:\\s|$)`, "i"),
    /^find\s+(?:['"])?~(?:['"])?(?:\s|$)/i,
  ];
  if (!homePatterns.some((re) => re.test(text))) return false;
  // Allow explicitly scoped common folders; block only the home-root sweep.
  if (new RegExp(`^find\\s+(?:['"])?${escapedHome}/(?:Desktop|Downloads|Documents|Downloads/Lynn)(?:['"])?(?:\\s|$)`, "i").test(text)) {
    return false;
  }
  return true;
}

function osHomeFallback(): string {
  return process.platform === "win32"
    ? (process.env.USERPROFILE || "")
    : (process.env.HOME || "");
}

function buildBashParameterSchema(parameters: ParameterSchema = {}): ParameterSchema {
  const properties = parameters && typeof parameters.properties === "object"
    ? { ...parameters.properties }
    : {};
  properties.query = properties.query || {
    type: "string",
    description: "Alias for command. Prefer command when possible.",
  };
  properties.cmd = properties.cmd || {
    type: "string",
    description: "Alias for command. Prefer command when possible.",
  };
  properties.shell = properties.shell || {
    type: "string",
    description: "Alias for command. Prefer command when possible.",
  };
  properties.script = properties.script || {
    type: "string",
    description: "Alias for command. Prefer command when possible.",
  };

  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((key): key is string => typeof key === "string" && key !== "command")
    : undefined;

  return {
    ...parameters,
    properties,
    ...(required ? { required } : {}),
  };
}

function resolvePath(rawPath: unknown, cwd: string): string | null {
  if (typeof rawPath !== "string" || !rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function normalizePathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const target = normalizePathKey(path.resolve(targetPath));
  const root = normalizePathKey(path.resolve(rootPath));
  return target === root || target.startsWith(root + path.sep);
}

function findTrustedRootForPath(targetPath: string | null | undefined, trustedRoots: string[] | null | undefined = []): string | null {
  if (!targetPath) return null;
  const matches = (trustedRoots || []).filter((root) => isInsideRoot(targetPath, root));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0];
}

const PREFLIGHT_UNIX: PreflightEntry[] = [
  [/\bsudo\s/, () => t("sandbox.noSudo"), "elevated_command", "sudo",
    () => t("sandbox.authDesc.sudo")],
  [/\bsu\s+\w/, () => t("sandbox.noSu"), "elevated_command", "su",
    () => t("sandbox.authDesc.su")],
  [/\bchmod\s/, () => t("sandbox.noChmod"), "elevated_command", "chmod",
    () => t("sandbox.authDesc.chmod")],
  [/\bchown\s/, () => t("sandbox.noChown"), "elevated_command", "chown",
    () => t("sandbox.authDesc.chown")],
];

const PREFLIGHT_WIN32: PreflightEntry[] = [
  [/\bdel\s+\/s/i, () => t("sandbox.noDelRecursive"), "elevated_command", "del_recursive",
    () => t("sandbox.authDesc.delRecursive")],
  [/\brmdir\s+\/s/i, () => t("sandbox.noRmdirRecursive"), "elevated_command", "rmdir_recursive",
    () => t("sandbox.authDesc.rmdirRecursive")],
  [/\breg\s+(delete|add)\b/i, () => t("sandbox.noRegEdit"), "elevated_command", "reg_edit",
    () => t("sandbox.authDesc.regEdit")],
  [/\btakeown\b/i, () => t("sandbox.noTakeown"), "elevated_command", "takeown",
    () => t("sandbox.authDesc.takeown")],
  [/\bicacls\b/i, () => t("sandbox.noIcacls"), "elevated_command", "icacls",
    () => t("sandbox.authDesc.icacls")],
  [/\bnet\s+(user|localgroup)\b/i, () => t("sandbox.noNetUser"), "elevated_command", "net_user",
    () => t("sandbox.authDesc.netUser")],
  [/\bschtasks\s+\/create\b/i, () => t("sandbox.noSchtasks"), "elevated_command", "schtasks",
    () => t("sandbox.authDesc.schtasks")],
  [/\bsc\s+(create|delete)\b/i, () => t("sandbox.noScService"), "elevated_command", "sc_service",
    () => t("sandbox.authDesc.scService")],
  [/powershell.*-e(xecutionpolicy)?\s*(bypass|unrestricted)/i, () => t("sandbox.noPsExecutionBypass"), "elevated_command", "ps_bypass",
    () => t("sandbox.authDesc.psBypass")],
  [/\bformat\s+[a-z]:/i, () => t("sandbox.noFormat"), "elevated_command", "format",
    () => t("sandbox.authDesc.format")],
  [/\bbcdedit\b/i, () => t("sandbox.noBcdedit"), "elevated_command", "bcdedit",
    () => t("sandbox.authDesc.bcdedit")],
  [/\bwmic\b/i, () => t("sandbox.noWmic"), "elevated_command", "wmic",
    () => t("sandbox.authDesc.wmic")],
];

const PREFLIGHT_DELETE: PreflightEntry[] = [
  [/\brm\s+(?:-[^\s]*\s+)?(?:["']?~?[/.]|["']?[^|;&\n\r]+)/i,
    () => t("sandbox.noDeleteFiles"),
    "delete_files", "rm",
    () => t("sandbox.authDesc.deleteFiles")],
  [/\bfind\b[\s\S]{0,260}\s-delete\b/i,
    () => t("sandbox.noFindDelete"),
    "delete_files", "find_delete",
    () => t("sandbox.authDesc.findDelete")],
  [/\b(?:trash|trash-put|gio\s+trash)\s+/i,
    () => t("sandbox.noTrashFiles"),
    "delete_files", "trash",
    () => t("sandbox.authDesc.trashFiles")],
  [/\bmv\b[\s\S]{0,260}(?:~\/\.Trash|\/\.Trash(?:\/|$))/i,
    () => t("sandbox.noTrashFiles"),
    "delete_files", "move_to_trash",
    () => t("sandbox.authDesc.trashFiles")],
  [/\bpython3?\b[\s\S]{0,520}\b(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree|Path\([^)]*\)\.(?:unlink|rmdir))\b/i,
    () => t("sandbox.noDeleteFiles"),
    "delete_files", "python_delete",
    () => t("sandbox.authDesc.deleteFiles")],
  [/\bnode\b[\s\S]{0,520}\bfs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b/i,
    () => t("sandbox.noDeleteFiles"),
    "delete_files", "node_delete",
    () => t("sandbox.authDesc.deleteFiles")],
];

// ── ClawAegis: 数据外传检测（跨平台） ──

const PREFLIGHT_EXFIL: PreflightEntry[] = [
  [/\bcurl\b[\s\S]{0,1000}(?:-(?:d|F|T)\b|--(?:data(?:-ascii|-binary|-raw|-urlencode)?|form|string|upload-file)\b)[\s\S]{0,600}(?:@|<|\$\(|`)/i, () => t("sandbox.exfilCurlUpload") || "检测到 curl 上传本地文件",
    "data_exfiltration", "curl_upload",
    () => t("sandbox.authDesc.exfilCurlUpload") || "curl 正在上传本地文件到远程服务器"],
  [/\bcurl\b[\s\S]{0,1000}(?:\.env\b|\.ssh(?:\/|\\)|\.aws(?:\/|\\)|id_(?:rsa|ed25519|ecdsa)\b|\.(?:key|pem|p12|pfx|crt)\b|server-info\.json\b)/i, () => t("sandbox.exfilCurlSensitive") || "检测到 curl 访问敏感文件",
    "data_exfiltration", "curl_sensitive",
    () => t("sandbox.authDesc.exfilCurlSensitive") || "curl 正在访问敏感凭证文件"],
  [/\bwget\b[\s\S]{0,1000}--(?:post-data|post-file|body-data|body-file)\b/i, () => t("sandbox.exfilWget") || "检测到 wget 上传数据",
    "data_exfiltration", "wget_upload",
    () => t("sandbox.authDesc.exfilWget") || "wget 正在上传本地数据到远程服务器"],
  [/\b(nc|ncat|netcat)\s.*-[elp]/, () => t("sandbox.exfilNetcat") || "检测到 netcat 监听/连接",
    "data_exfiltration", "netcat",
    () => t("sandbox.authDesc.exfilNetcat") || "netcat 可能用于网络数据传输或反弹 shell"],
  [/\b(?:cat|head|tail|sed|awk|grep|base64|env|printenv)\b[\s\S]{0,1200}\|[\s\S]{0,120}\b(?:curl|wget|nc|ncat|netcat)\b/i, () => t("sandbox.exfilBase64") || "检测到本地数据经管道外传",
    "data_exfiltration", "base64_exfil",
    () => t("sandbox.authDesc.exfilBase64") || "数据经 base64 编码后通过网络传输"],
  [/\bcurl\b[\s\S]{0,1000}(?:\$\([\s\S]{0,500}\b(?:cat|env|printenv|base64)\b|`[\s\S]{0,500}\b(?:cat|env|printenv|base64)\b)/i,
    () => "检测到 curl 使用本地命令输出构造网络请求",
    "data_exfiltration", "curl_command_substitution",
    () => "curl 请求包含本地文件或环境变量的命令替换，可能把凭证静默发送到远程服务器"],
  [/\bpython3?\b(?=[\s\S]{0,3600}(?:open\s*\(|os\.environ|Path\s*\())(?=[\s\S]{0,3600}(?:requests\.|urllib\.|http\.client|socket\.))[\s\S]{0,3600}/i,
    () => "检测到 Python 读取本地数据并访问网络",
    "data_exfiltration", "python_exfil",
    () => "Python 脚本同时读取本地文件/环境变量并访问网络，可能造成数据外传"],
  [/\bnode\b(?=[\s\S]{0,3600}(?:require\s*\(\s*['"](?:node:)?fs['"]|from\s+['"](?:node:)?fs['"]|process\.env))(?=[\s\S]{0,3600}(?:fetch\s*\(|require\s*\(\s*['"](?:node:)?https?['"]|from\s+['"](?:node:)?https?['"]|https?\.|net\.|dgram\.))[\s\S]{0,3600}/i,
    () => "检测到 Node.js 读取本地数据并访问网络",
    "data_exfiltration", "node_exfil",
    () => "Node.js 脚本同时读取本地文件/环境变量并访问网络，可能造成数据外传"],
  [/\bpowershell(?:\.exe)?\b(?=[\s\S]{0,3600}(?:Get-Content|\$env:))(?=[\s\S]{0,3600}(?:Invoke-WebRequest|Invoke-RestMethod|System\.Net\.WebClient))[\s\S]{0,3600}/i,
    () => "检测到 PowerShell 读取本地数据并访问网络",
    "data_exfiltration", "powershell_exfil",
    () => "PowerShell 命令同时读取本地文件/环境变量并访问网络，可能造成数据外传"],
  [/\/dev\/tcp\//, () => t("sandbox.exfilDevTcp") || "检测到 /dev/tcp 连接",
    "data_exfiltration", "dev_tcp",
    () => t("sandbox.authDesc.exfilDevTcp") || "bash /dev/tcp 可用于反弹 shell 或数据外传"],
  [/\bscp\s+(?!.*localhost).*:/, () => t("sandbox.exfilScp") || "检测到 scp 远程传输",
    "data_exfiltration", "scp",
    () => t("sandbox.authDesc.exfilScp") || "scp 正在向远程服务器传输文件"],
  [/python3?\s.*-m\s*http\.server/, () => t("sandbox.exfilPyServer") || "检测到 Python HTTP 服务器",
    "data_exfiltration", "python_http",
    () => t("sandbox.authDesc.exfilPyServer") || "Python HTTP 服务器可能暴露当前目录下的所有文件"],
];

const PREFLIGHT_INSTALL: PreflightEntry[] = [
  [/\b(?:brew\s+(?:install|upgrade)|apt(?:-get)?\s+install|yum\s+install|dnf\s+install|pacman\s+-S|pip3?\s+install|npm\s+install(?:\s+-g)?|pnpm\s+add(?:\s+-g)?|yarn\s+(?:global\s+add|add)|cargo\s+install|go\s+install|uv\s+tool\s+install|uvx\b)/i,
    () => "即将安装或升级软件/依赖",
    "package_install", "package_install",
    () => "将安装或升级软件、依赖或命令行工具。请确认来源可信，并留意可能修改系统环境或 PATH。"],
  [/\b(?:curl|wget)\b[\s\S]{0,220}\|\s*(?:sh|bash|zsh)\b/i,
    () => "即将执行远程安装脚本",
    "script_install", "script_install",
    () => "将下载并直接执行远程脚本。这类安装方式风险较高，请先确认脚本来源可信。"],
];

const PREFLIGHT_PATTERNS = process.platform === "win32"
  ? [...PREFLIGHT_DELETE, ...PREFLIGHT_INSTALL, ...PREFLIGHT_UNIX, ...PREFLIGHT_WIN32, ...PREFLIGHT_EXFIL]
  : [...PREFLIGHT_DELETE, ...PREFLIGHT_INSTALL, ...PREFLIGHT_UNIX, ...PREFLIGHT_EXFIL];

export { PREFLIGHT_PATTERNS };

const WIN_ABS_PATH = /[A-Za-z]:[\\\/][^\s"'|<>&;]+/g;
const UNIX_ABS_PATH = /(?:^|\s)(\/[^\s"'|<>&;]+)/g;
const QUOTED_PATH = /["']([A-Za-z]:[\\\/][^"']+)["']/g;
const QUOTED_UNIX_PATH = /["'](\/[^"']+)["']/g;

function extractPaths(command: string): string[] {
  const paths = new Set<string>();
  for (const re of [WIN_ABS_PATH, QUOTED_PATH]) {
    for (const m of command.matchAll(re)) {
      paths.add(m[1] || m[0]);
    }
  }
  if (process.platform !== "win32") {
    for (const m of command.matchAll(QUOTED_UNIX_PATH)) {
      paths.add(m[1] || m[0]);
    }
    for (const m of command.matchAll(UNIX_ABS_PATH)) {
      paths.add(m[1] || m[0]);
    }
  }
  return [...paths];
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const rel = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function shouldSnapshotCommandCwd(command: string, cwd?: string | null): boolean {
  if (!cwd || !isDangerousCommand(command)) return false;
  const paths = extractPaths(command);

  // If a dangerous command has no concrete absolute target, snapshot the cwd
  // because the mutation is likely relative to the current workspace.
  if (!paths.length) return true;

  // Only snapshot cwd when the dangerous target is actually inside cwd. This
  // avoids blocking user-approved Downloads/Desktop cleanups by snapshotting
  // the entire Lynn repo, which cannot protect those outside targets anyway.
  return paths.some((p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    return isPathInside(abs, cwd);
  });
}

export async function requestAuthorization({
  category, identifier, command, reason, description,
  allowlist, sessionAllowlist, confirmStore, sessionPath, emitEvent,
  path: targetPath,
  trustedRoots = [],
}: AuthorizationRequest): Promise<{ allowed: boolean }> {
  const trustedRoot = targetPath ? findTrustedRootForPath(targetPath, trustedRoots) : null;

  const reusableAllowed = category.startsWith("path_") && !!targetPath && !!trustedRoot;
  if (reusableAllowed && sessionAllowlist?.check({ category, identifier, path: targetPath, trustedRoot })) {
    return { allowed: true };
  }

  // A permanent command grant must have a concrete workspace boundary.
  const persistentAllowed = reusableAllowed
    && !["data_exfiltration", "remote_script", "script_install", "elevated_command"].includes(category);
  if (persistentAllowed && allowlist?.check(category, identifier, { path: targetPath })) {
    return { allowed: true };
  }

  if (!isConfirmStore(confirmStore)) {
    return { allowed: false };
  }

  const { confirmId, promise } = confirmStore.create(
    "tool_authorization",
    {
      command,
      reason,
      description,
      category,
      identifier,
      path: targetPath || null,
      trustedRoot,
    },
    sessionPath,
  );

  emitEvent?.({
    type: "tool_authorization",
    confirmId,
    command,
    reason,
    description,
    category,
    identifier,
    trustedRoot,
  }, sessionPath);

  const result = await promise;

  if (result.action === "confirmed" || result.action === "confirmed_once") {
    return { allowed: true };
  }

  if (result.action === "confirmed_session") {
    if (reusableAllowed) sessionAllowlist?.add({ category, identifier, trustedRoot });
    return { allowed: true };
  }

  if (result.action === "confirmed_persistent" && persistentAllowed) {
    allowlist?.add({ category, identifier, trustedRoot });
    return { allowed: true };
  }

  if (result.action === "confirmed_persistent") return { allowed: true };

  return { allowed: false };
}

export function wrapPathTool(
  tool: ToolLike,
  guard: GuardLike,
  operation: PathGuardOperation,
  cwd: string,
  authOpts?: AuthOptions,
): ToolLike {
  const execute = tool.execute.bind(tool) as (
    toolCallId: string,
    params: Record<string, unknown>,
    ...rest: unknown[]
  ) => Promise<ToolResult>;
  return {
    ...tool,
    _textCallConfirmation: true,
    execute: async (toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]) => {
      const rawPath = params.path;
      const absolutePath = resolvePath(rawPath, cwd);
      const checkPath = absolutePath || cwd;
      const result = guard.check(checkPath, operation);
      const textToolCall = (rest[0] as { textToolCall?: boolean } | undefined)?.textToolCall === true && operation !== "read";

      if (!result.allowed || textToolCall) {
        if (authOpts?.mode === "authorized") {
          const authResult = await requestAuthorization({
            category: textToolCall ? "text_tool_call" : `path_${operation}`,
            identifier: checkPath,
            command: `${operation} ${rawPath || cwd}`,
            reason: result.reason || "restricted",
            description: t("sandbox.authDesc.pathOp", { op: operation, path: rawPath || cwd }),
            allowlist: textToolCall ? undefined : authOpts.allowlist,
            sessionAllowlist: textToolCall ? undefined : authOpts.sessionAllowlist,
            confirmStore: authOpts.confirmStore,
            sessionPath: authOpts.getSessionPath?.() || authOpts.sessionPath || null,
            emitEvent: authOpts.emitEvent,
            path: checkPath,
            trustedRoots: authOpts.trustedRoots,
          });
          if (authResult.allowed) {
            return execute(toolCallId, params, ...rest);
          }
        }
        return blockedResult(result.reason || "restricted");
      }

      return execute(toolCallId, params, ...rest);
    },
  } as ToolLike;
}

export function wrapBashTool(
  tool: ToolLike,
  guard?: GuardLike,
  cwd?: string,
  authOpts?: AuthOptions,
): ToolLike {
  const execute = tool.execute.bind(tool) as (
    toolCallId: string,
    params: Record<string, unknown>,
    ...rest: unknown[]
  ) => Promise<ToolResult>;
  return {
    ...tool,
    _textCallConfirmation: true,
    parameters: buildBashParameterSchema(tool.parameters),
    execute: async (toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]) => {
      params = normalizeBashParams(params);
      if (typeof params.command !== "string" || !params.command.trim()) {
        return missingBashCommandResult();
      }
      if (looksLikeBroadHomeSearchCommand(params.command)) {
        return blockedBroadHomeSearchResult(params.command);
      }
      const textToolCall = (rest[0] as { textToolCall?: boolean } | undefined)?.textToolCall === true;
      if (textToolCall) {
        const risks = PREFLIGHT_PATTERNS.filter(([pattern]) => pattern.test(params.command as string)).map(([, reason]) => reason());
        const authorization = await requestAuthorization({
          category: "text_tool_call", identifier: "bash", command: params.command,
          reason: risks.join("; ") || "Confirm command proposed through text-tool compatibility",
          description: "Text-tool compatibility requires approval for this command.",
          confirmStore: authOpts?.mode === "authorized" ? authOpts.confirmStore : undefined,
          sessionPath: authOpts?.getSessionPath?.() || authOpts?.sessionPath || null,
          emitEvent: authOpts?.emitEvent,
        });
        if (!authorization.allowed) return blockedResult("Text tool command was not approved");
      }

      let shouldSnapshotDangerousCommand = false;
      for (const [pattern, reasonFn, category, identifier, descFn] of PREFLIGHT_PATTERNS) {
        if (textToolCall) continue; // the complete command and all risks were approved once above
        if (pattern.test(params.command)) {
          if (authOpts?.mode === "authorized") {
            const authResult = await requestAuthorization({
              category: category || "elevated_command",
              identifier: identifier || "unknown",
              command: params.command,
              reason: reasonFn(),
              description: descFn ? descFn() : reasonFn(),
              allowlist: authOpts.allowlist,
              sessionAllowlist: authOpts.sessionAllowlist,
              confirmStore: authOpts.confirmStore,
              sessionPath: authOpts.getSessionPath?.() || authOpts.sessionPath || null,
              emitEvent: authOpts.emitEvent,
              trustedRoots: authOpts.trustedRoots,
              path: cwd || null,
            });
            if (authResult.allowed) continue;
            return blockedResult(reasonFn());
          }
          return blockedResult(reasonFn());
        }
      }
      shouldSnapshotDangerousCommand = shouldSnapshotCommandCwd(params.command, cwd);

      // ── Auto-snapshot: 危险命令授权通过后再快照工作区 ──
      // 快照可能扫描大量文件；必须放在授权之后，否则用户会先等快照，
      // 看不到删除/提权确认卡片，表现为“没弹窗、没反馈”。
      if (shouldSnapshotDangerousCommand && cwd) {
        try {
          const agentId = authOpts?.agentId || "default";
          await createSnapshot(cwd, agentId, `dangerous command: ${params.command.slice(0, 80)}`);
        } catch (err) {
          console.warn("[snapshot] auto-snapshot failed:", errorMessage(err));
        }
      }

      if (guard && cwd) {
        const paths = extractPaths(params.command);
        for (const p of paths) {
          const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
          const result = guard.check(abs, "read");
          if (!result.allowed) {
            if (authOpts?.mode === "authorized") {
              const authResult = await requestAuthorization({
                category: "path_read",
                identifier: abs,
                command: params.command,
                reason: t("sandbox.restrictedPath", { path: p }),
                description: t("sandbox.authDesc.pathOp", { op: "read", path: p }),
                allowlist: authOpts.allowlist,
                sessionAllowlist: authOpts.sessionAllowlist,
                confirmStore: authOpts.confirmStore,
                sessionPath: authOpts.getSessionPath?.() || authOpts.sessionPath || null,
                emitEvent: authOpts.emitEvent,
                path: abs,
                trustedRoots: authOpts.trustedRoots,
              });
              if (authResult.allowed) continue;
            }
            return blockedResult(t("sandbox.restrictedPath", { path: p }));
          }
        }
      }

      try {
        const result = await execute(toolCallId, params, ...rest);
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content![0].text += "\n\n" + t("sandbox.writeRestricted");
        }
        return result;
      } catch (err) {
        if (err instanceof Error && err.message?.includes("Operation not permitted")) {
          err.message += "\n\n" + t("sandbox.writeRestricted");
        }
        throw err;
      }
    },
  } as ToolLike;
}
