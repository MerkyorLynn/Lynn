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

/** 构造被拦截时返回给 LLM 的结果 */
function blockedResult(reason) {
  return {
    content: [{ type: "text", text: t("sandbox.blocked", { reason }) }],
  };
}

/** 解析工具参数中的路径为绝对路径 */
function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

/**
 * 轻量 preflight 模式匹配
 * macOS/Linux: 体验层（OS 沙盒兜底）
 * Windows: 安全层之一（无 OS 沙盒）
 *
 * 每项增加第三个元素：人类可读的授权说明（中/英），帮助小白用户理解这条操作的用途
 */
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

const PREFLIGHT_PATTERNS = process.platform === "win32"
  ? [...PREFLIGHT_UNIX, ...PREFLIGHT_WIN32]
  : PREFLIGHT_UNIX;

/**
 * 导出 PREFLIGHT_PATTERNS 供外部使用（如单元测试）
 */
export { PREFLIGHT_PATTERNS };

/**
 * 从 bash 命令中提取可能的文件路径（启发式）
 * 用于 Windows 无 OS 沙盒时的 PathGuard 校验
 */
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

/**
 * 授权模式核心：暂停→查白名单→弹确认→等用户决定
 *
 * @param {object} opts
 * @param {string} opts.category  白名单类别（如 "elevated_command", "path_write"）
 * @param {string} opts.identifier  白名单标识（如 "sudo", "/some/path"）
 * @param {string} opts.command  原始命令/路径（显示给用户）
 * @param {string} opts.reason  拦截原因
 * @param {string} opts.description  人类可读的说明（帮助小白用户理解）
 * @param {object} opts.allowlist  SecurityAllowlist 实例
 * @param {object} opts.confirmStore  ConfirmStore 实例
 * @param {string|null} opts.sessionPath  当前 session 路径
 * @param {function} opts.emitEvent  事件发射器
 * @returns {Promise<{ allowed: boolean }>}
 */
async function requestAuthorization({
  category, identifier, command, reason, description,
  allowlist, confirmStore, sessionPath, emitEvent,
}) {
  // 1. 查白名单
  if (allowlist?.check(category, identifier)) {
    return { allowed: true };
  }

  // 2. 无 confirmStore → 降级为直接拒绝
  if (!confirmStore) {
    return { allowed: false };
  }

  // 3. 创建确认请求，阻塞等待用户决定
  const { confirmId, promise } = confirmStore.create(
    "tool_authorization",
    {
      command,
      reason,
      description,
      category,
      identifier,
    },
    sessionPath,
  );

  // 4. 发送事件到前端渲染 AuthorizationCard
  emitEvent?.({
    type: "tool_authorization",
    confirmId,
    command,
    reason,
    description,
    category,
    identifier,
  }, sessionPath);

  // 5. 等待用户决定
  const result = await promise;

  if (result.action === "confirmed") {
    // 用户勾选了「以后都允许」
    if (result.value?.alwaysAllow && allowlist) {
      allowlist.add(category, identifier);
    }
    return { allowed: true };
  }

  return { allowed: false };
}

/**
 * 包装路径类工具（read, write, edit, grep, find, ls）
 *
 * @param {object} tool  原始工具
 * @param {object} guard  PathGuard
 * @param {"read"|"write"} operation  操作类型
 * @param {string} cwd  工作目录
 * @param {object} [authOpts]  授权模式选项
 */
export function wrapPathTool(tool, guard, operation, cwd, authOpts) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const rawPath = params.path;
      const absolutePath = resolvePath(rawPath, cwd);
      const checkPath = absolutePath || cwd;
      const result = guard.check(checkPath, operation);

      if (!result.allowed) {
        // Authorized 模式：拦截变为暂停→弹确认
        if (authOpts?.mode === "authorized") {
          const authResult = await requestAuthorization({
            category: `path_${operation}`,
            identifier: checkPath,
            command: `${operation} ${rawPath || cwd}`,
            reason: result.reason,
            description: t("sandbox.authDesc.pathOp", { op: operation, path: rawPath || cwd }),
            allowlist: authOpts.allowlist,
            confirmStore: authOpts.confirmStore,
            sessionPath: authOpts.getSessionPath?.() || authOpts.sessionPath || null,
            emitEvent: authOpts.emitEvent,
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

/**
 * 包装 bash 工具
 *
 * 1. preflight：常见危险命令提前拦截
 * 2. 路径校验：提取命令中的绝对路径，用 PathGuard 检查（Windows 无 OS 沙盒时的安全层）
 * 3. 执行：OS 沙盒在 BashOperations.exec 里生效（macOS/Linux）
 * 4. 错误翻译：OS 沙盒拦截后 stderr 的 Operation not permitted
 *
 * @param {object} tool  原始 bash 工具
 * @param {object} [guard]  PathGuard 实例（Windows 必传，macOS/Linux 可选）
 * @param {string} [cwd]  工作目录
 * @param {object} [authOpts]  授权模式选项
 */
export function wrapBashTool(tool, guard, cwd, authOpts) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      // preflight
      for (const [pattern, reasonFn, category, identifier, descFn] of PREFLIGHT_PATTERNS) {
        if (pattern.test(params.command)) {
          // Authorized 模式：preflight 拦截变为暂停→弹确认
          if (authOpts?.mode === "authorized") {
            const authResult = await requestAuthorization({
              category: category || "elevated_command",
              identifier: identifier || "unknown",
              command: params.command,
              reason: reasonFn(),
              description: descFn ? descFn() : reasonFn(),
              allowlist: authOpts.allowlist,
              confirmStore: authOpts.confirmStore,
              sessionPath: authOpts.getSessionPath?.() || authOpts.sessionPath || null,
              emitEvent: authOpts.emitEvent,
            });
            if (authResult.allowed) break; // 用户已授权，跳过拦截
            return blockedResult(reasonFn());
          }
          // Safe/standard 模式：直接拦截
          return blockedResult(reasonFn());
        }
      }

      // 路径校验：从命令中提取绝对路径，检查 PathGuard
      if (guard && cwd) {
        const paths = extractPaths(params.command);
        for (const p of paths) {
          const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
          const result = guard.check(abs, "read");
          if (!result.allowed) {
            // Authorized 模式：路径拦截也弹确认
            if (authOpts?.mode === "authorized") {
              const authResult = await requestAuthorization({
                category: "path_read",
                identifier: abs,
                command: params.command,
                reason: t("sandbox.restrictedPath", { path: p }),
                description: t("sandbox.authDesc.pathOp", { op: "read", path: p }),
                allowlist: authOpts.allowlist,
                confirmStore: authOpts.confirmStore,
                sessionPath: authOpts.getSessionPath?.() || authOpts.sessionPath || null,
                emitEvent: authOpts.emitEvent,
              });
              if (authResult.allowed) continue; // 该路径已授权
            }
            return blockedResult(t("sandbox.restrictedPath", { path: p }));
          }
        }
      }

      try {
        const result = await tool.execute(toolCallId, params, ...rest);

        // 成功路径的错误翻译（exitCode 0 但 stderr 有 sandbox 拒绝）
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content[0].text += "\n\n" + t("sandbox.writeRestricted");
        }

        return result;
      } catch (err) {
        // Pi SDK 对非零退出 throw Error，错误消息里包含 stderr 输出。
        // 如果是沙盒拦截导致的，追加友好提示。
        if (err.message?.includes("Operation not permitted")) {
          err.message += "\n\n" + t("sandbox.writeRestricted");
        }
        throw err;
      }
    },
  };
}
