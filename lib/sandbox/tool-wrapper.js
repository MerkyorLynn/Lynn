/**
 * tool-wrapper.js — 工具沙盒包装
 *
 * 在 Pi SDK 工具的 execute 外面套一层路径校验。
 * 被拦截时返回 LLM 可读的文本错误，不抛异常。
 *
 * macOS/Linux: bash 安全边界在 OS 沙盒（seatbelt/bwrap），preflight 只优化体验。
 * Windows: 无 OS 沙盒，bash 额外做路径提取 + PathGuard 校验作为安全层。
 */

import path from "path";

/** 构造被拦截时返回给 LLM 的结果 */
function blockedResult(reason) {
  return {
    content: [{ type: "text", text: `[安全策略] ${reason}\n\n此操作被 Hanako 的沙盒安全策略阻止。这不是程序错误，而是安全保护机制在工作。请告知用户操作被安全策略阻止，并说明具体原因。用户可以在设置中调整沙盒策略。` }],
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
 */
const PREFLIGHT_UNIX = [
  [/\bsudo\s/, "禁止使用 sudo"],
  [/\bsu\s+\w/, "禁止使用 su 切换用户"],
  [/\bchmod\s/, "禁止修改文件权限"],
  [/\bchown\s/, "禁止修改文件所有者"],
];

const PREFLIGHT_WIN32 = [
  [/\bdel\s+\/s/i, "禁止递归删除文件 (del /s)"],
  [/\brmdir\s+\/s/i, "禁止递归删除目录 (rmdir /s)"],
  [/\breg\s+(delete|add)\b/i, "禁止修改注册表"],
  [/\btakeown\b/i, "禁止夺取文件所有权"],
  [/\bicacls\b/i, "禁止修改文件 ACL 权限"],
  [/\bnet\s+(user|localgroup)\b/i, "禁止用户/组管理操作"],
  [/\bschtasks\s+\/create\b/i, "禁止创建计划任务"],
  [/\bsc\s+(create|delete)\b/i, "禁止操作系统服务"],
  [/powershell.*-e(xecutionpolicy)?\s*(bypass|unrestricted)/i, "禁止绕过 PowerShell 执行策略"],
  [/\bformat\s+[a-z]:/i, "禁止格式化磁盘"],
  [/\bbcdedit\b/i, "禁止修改启动配置"],
  [/\bwmic\b/i, "禁止 WMI 命令"],
];

const PREFLIGHT_PATTERNS = process.platform === "win32"
  ? [...PREFLIGHT_UNIX, ...PREFLIGHT_WIN32]
  : PREFLIGHT_UNIX;

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
 * 包装路径类工具（read, write, edit, grep, find, ls）
 */
export function wrapPathTool(tool, guard, operation, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const rawPath = params.path;
      const absolutePath = resolvePath(rawPath, cwd);
      const checkPath = absolutePath || cwd;
      const result = guard.check(checkPath, operation);

      if (!result.allowed) {
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
 */
export function wrapBashTool(tool, guard, cwd) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      // preflight
      for (const [pattern, reason] of PREFLIGHT_PATTERNS) {
        if (pattern.test(params.command)) {
          return blockedResult(reason);
        }
      }

      // 路径校验：从命令中提取绝对路径，检查 PathGuard
      if (guard && cwd) {
        const paths = extractPaths(params.command);
        for (const p of paths) {
          const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
          const result = guard.check(abs, "read");
          if (!result.allowed) {
            return blockedResult(`命令访问了受限路径：${p}`);
          }
        }
      }

      try {
        const result = await tool.execute(toolCallId, params, ...rest);

        // 成功路径的错误翻译（exitCode 0 但 stderr 有 sandbox 拒绝）
        const text = result?.content?.[0]?.text;
        if (text && text.includes("Operation not permitted")) {
          result.content[0].text += "\n\n[安全策略] 文件系统写入被限制在工作空间内。此操作被沙盒安全策略阻止，请告知用户。";
        }

        return result;
      } catch (err) {
        // Pi SDK 对非零退出 throw Error，错误消息里包含 stderr 输出。
        // 如果是沙盒拦截导致的，追加友好提示。
        if (err.message?.includes("Operation not permitted")) {
          err.message += "\n\n[安全策略] 文件系统写入被限制在工作空间内。此操作被沙盒安全策略阻止，请告知用户。";
        }
        throw err;
      }
    },
  };
}
