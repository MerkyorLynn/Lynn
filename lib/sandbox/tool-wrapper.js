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
import { t } from "../../server/i18n.js";
import { createSnapshot, isDangerousCommand } from "./snapshot.js";

function blockedResult(reason) {
  return {
    content: [{ type: "text", text: t("sandbox.blocked", { reason }) }],
  };
}

function missingBashCommandResult() {
  return {
    content: [{
      type: "text",
      text: "参数缺失：bash 工具需要 command 字段。Lynn 已兼容 query/cmd/shell/script 作为 command 别名；如果仍看到这条消息，说明模型没有给出可执行命令。",
    }],
  };
}

function normalizeBashParams(params) {
  const next = params && typeof params === "object" && !Array.isArray(params) ? { ...params } : {};
  if (typeof next.command === "string" && next.command.trim()) return next;

  for (const key of ["query", "cmd", "shell", "script"]) {
    if (typeof next[key] === "string" && next[key].trim()) {
      next.command = next[key];
      return next;
    }
  }

  return next;
}

function buildBashParameterSchema(parameters = {}) {
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
    ? parameters.required.filter((key) => key !== "command")
    : undefined;

  return {
    ...parameters,
    properties,
    ...(required ? { required } : {}),
  };
}

function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function normalizePathKey(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isInsideRoot(targetPath, rootPath) {
  const target = normalizePathKey(path.resolve(targetPath));
  const root = normalizePathKey(path.resolve(rootPath));
  return target === root || target.startsWith(root + path.sep);
}

function findTrustedRootForPath(targetPath, trustedRoots = []) {
  if (!targetPath) return null;
  const matches = (trustedRoots || []).filter((root) => isInsideRoot(targetPath, root));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0];
}

const PREFLIGHT_UNIX = [
  [/\bsudo\s/, () => t("sandbox.noSudo"), "elevated_command", "sudo",
    () => t("sandbox.authDesc.sudo")],
  [/\bsu\s+\w/, () => t("sandbox.noSu"), "elevated_command", "su",
    () => t("sandbox.authDesc.su")],
  [/\bchmod\s/, () => t("sandbox.noChmod"), "elevated_command", "chmod",
    () => t("sandbox.authDesc.chmod")],
  [/\bchown\s/, () => t("sandbox.noChown"), "elevated_command", "chown",
    () => t("sandbox.authDesc.chown")],
];

const PREFLIGHT_WIN32 = [
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

// ── ClawAegis: 数据外传检测（跨平台） ──

const PREFLIGHT_EXFIL = [
  [/curl\s.*-[dF]\s.*[@<]/, () => t("sandbox.exfilCurlUpload") || "检测到 curl 上传本地文件",
    "data_exfiltration", "curl_upload",
    () => t("sandbox.authDesc.exfilCurlUpload") || "curl 正在上传本地文件到远程服务器"],
  [/curl\s.*\.(env|ssh|aws|key|pem|crt)\b/i, () => t("sandbox.exfilCurlSensitive") || "检测到 curl 访问敏感文件",
    "data_exfiltration", "curl_sensitive",
    () => t("sandbox.authDesc.exfilCurlSensitive") || "curl 正在访问敏感凭证文件"],
  [/wget\s.*--post-(data|file)/, () => t("sandbox.exfilWget") || "检测到 wget 上传数据",
    "data_exfiltration", "wget_upload",
    () => t("sandbox.authDesc.exfilWget") || "wget 正在上传本地数据到远程服务器"],
  [/\b(nc|ncat|netcat)\s.*-[elp]/, () => t("sandbox.exfilNetcat") || "检测到 netcat 监听/连接",
    "data_exfiltration", "netcat",
    () => t("sandbox.authDesc.exfilNetcat") || "netcat 可能用于网络数据传输或反弹 shell"],
  [/base64.*\|\s*(curl|wget|nc)/, () => t("sandbox.exfilBase64") || "检测到 base64 编码后外传",
    "data_exfiltration", "base64_exfil",
    () => t("sandbox.authDesc.exfilBase64") || "数据经 base64 编码后通过网络传输"],
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

const PREFLIGHT_INSTALL = [
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
  ? [...PREFLIGHT_INSTALL, ...PREFLIGHT_UNIX, ...PREFLIGHT_WIN32, ...PREFLIGHT_EXFIL]
  : [...PREFLIGHT_INSTALL, ...PREFLIGHT_UNIX, ...PREFLIGHT_EXFIL];

export { PREFLIGHT_PATTERNS };

const WIN_ABS_PATH = /[A-Za-z]:[\\\/][^\s"'|<>&;]+/g;
const UNIX_ABS_PATH = /(?:^|\s)(\/[^\s"'|<>&;]+)/g;
const QUOTED_PATH = /["']([A-Za-z]:[\\\/][^"']+)["']/g;

function extractPaths(command) {
  const paths = new Set();
  for (const re of [WIN_ABS_PATH, QUOTED_PATH]) {
    for (const m of command.matchAll(re)) {
      paths.add(m[1] || m[0]);
    }
  }
  if (process.platform !== "win32") {
    for (const m of command.matchAll(UNIX_ABS_PATH)) {
      paths.add(m[1] || m[0]);
    }
  }
  return [...paths];
}

async function requestAuthorization({
  category, identifier, command, reason, description,
  allowlist, sessionAllowlist, confirmStore, sessionPath, emitEvent,
  path: targetPath,
  trustedRoots = [],
}) {
  const trustedRoot = targetPath ? findTrustedRootForPath(targetPath, trustedRoots) : null;

  if (sessionAllowlist?.check({ category, identifier, path: targetPath, trustedRoot })) {
    return { allowed: true };
  }

  if (allowlist?.check(category, identifier, { path: targetPath })) {
    return { allowed: true };
  }

  if (!confirmStore) {
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
    sessionAllowlist?.add({ category, identifier, trustedRoot });
    return { allowed: true };
  }

  if (result.action === "confirmed_persistent") {
    allowlist?.add({ category, identifier, trustedRoot });
    return { allowed: true };
  }

  return { allowed: false };
}

export function wrapPathTool(tool, guard, operation, cwd, authOpts) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const rawPath = params.path;
      const absolutePath = resolvePath(rawPath, cwd);
      const checkPath = absolutePath || cwd;
      const result = guard.check(checkPath, operation);

      if (!result.allowed) {
        if (authOpts?.mode === "authorized") {
          const authResult = await requestAuthorization({
            category: `path_${operation}`,
            identifier: checkPath,
            command: `${operation} ${rawPath || cwd}`,
            reason: result.reason,
            description: t("sandbox.authDesc.pathOp", { op: operation, path: rawPath || cwd }),
            allowlist: authOpts.allowlist,
            sessionAllowlist: authOpts.sessionAllowlist,
            confirmStore: authOpts.confirmStore,
            sessionPath: authOpts.getSessionPath?.() || authOpts.sessionPath || null,
            emitEvent: authOpts.emitEvent,
            path: checkPath,
            trustedRoots: authOpts.trustedRoots,
          });
          if (authResult.allowed) {
            return tool.execute(toolCallId, params, ...rest);
          }
        }
        return blockedResult(result.reason);
      }

      return tool.execute(toolCallId, params, ...rest);
    },
  };
}

export function wrapBashTool(tool, guard, cwd, authOpts) {
  return {
    ...tool,
    parameters: buildBashParameterSchema(tool.parameters),
    execute: async (toolCallId, params, ...rest) => {
      params = normalizeBashParams(params);
      if (typeof params.command !== "string" || !params.command.trim()) {
        return missingBashCommandResult();
      }

      // ── Auto-snapshot: 危险命令前自动快照工作区 ──
      if (cwd && isDangerousCommand(params.command)) {
        try {
          const agentId = authOpts?.agentId || "default";
          createSnapshot(cwd, agentId, `dangerous command: ${params.command.slice(0, 80)}`);
        } catch (err) {
          console.warn("[snapshot] auto-snapshot failed:", err.message);
        }
      }

      for (const [pattern, reasonFn, category, identifier, descFn] of PREFLIGHT_PATTERNS) {
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
            });
            if (authResult.allowed) break;
            return blockedResult(reasonFn());
          }
          return blockedResult(reasonFn());
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
        const result = await tool.execute(toolCallId, params, ...rest);
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content[0].text += "\n\n" + t("sandbox.writeRestricted");
        }
        return result;
      } catch (err) {
        if (err.message?.includes("Operation not permitted")) {
          err.message += "\n\n" + t("sandbox.writeRestricted");
        }
        throw err;
      }
    },
  };
}
