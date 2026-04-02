/**
 * sandbox/index.js — 沙盒入口（无状态工厂）
 *
 * 每次 buildTools 调用时创建 session 级的 PathGuard + OS 沙盒 exec。
 * 不持有 engine 级状态，天然支持多 agent 并发。
 *
 * 支持三种模式：
 *   - full-access: 不包装
 *   - standard (safe mode): PathGuard + OS 沙盒，危险操作直接拦截
 *   - authorized: PathGuard + OS 沙盒，危险操作弹确认卡片
 */

import { deriveSandboxPolicy } from "./policy.js";
import { PathGuard } from "./path-guard.js";
import { detectPlatform, checkAvailability } from "./platform.js";
import { createSeatbeltExec } from "./seatbelt.js";
import { createBwrapExec } from "./bwrap.js";
import { createWin32Exec } from "./win32-exec.js";
import { wrapPathTool, wrapBashTool } from "./tool-wrapper.js";
import { createEnhancedReadFile } from "./read-enhanced.js";
import { SecurityAllowlist } from "./allowlist.js";
import { t } from "../../server/i18n.js";
import { constants } from "fs";
import { access as fsAccess } from "fs/promises";
import { extname } from "path";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";

/** 全局单例白名单（跨 session 共享） */
let _globalAllowlist = null;

function getGlobalAllowlist(lynnHome) {
  if (!_globalAllowlist) {
    _globalAllowlist = new SecurityAllowlist(lynnHome);
  }
  return _globalAllowlist;
}

/** 导出白名单单例（供 API 路由使用） */
export function getAllowlist(lynnHome) {
  return getGlobalAllowlist(lynnHome);
}

/**
 * 为一个 session 创建沙盒包装后的工具集
 *
 * 每次调用独立，不共享状态。
 *
 * @param {string} cwd  工作目录
 * @param {object[]} customTools  自定义工具
 * @param {object} opts
 * @param {string} opts.agentDir
 * @param {string|null} opts.workspace
 * @param {string} opts.lynnHome
 * @param {"standard"|"authorized"|"full-access"} opts.mode
 * @param {object} [opts.confirmStore]  ConfirmStore 实例（authorized 模式需要）
 * @param {function} [opts.emitEvent]  事件发射器（authorized 模式需要）
 * @param {function} [opts.getSessionPath]  获取当前 sessionPath（authorized 模式需要）
 * @returns {{ tools: object[], customTools: object[] }}
 */
export function createSandboxedTools(cwd, customTools, { agentDir, workspace, lynnHome, mode, confirmStore, emitEvent, getSessionPath }) {
  // authorized 模式底层仍走 standard 沙盒策略（OS 沙盒兜底）
  const policyMode = mode === "authorized" ? "standard" : mode;
  const policy = deriveSandboxPolicy({ agentDir, workspace, lynnHome, mode: policyMode });

  // 增强 readFile：xlsx 解析 + 编码检测，保留 PI SDK 默认的 access / detectImageMimeType
  const IMAGE_MIMES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const readOps = {
    readFile: createEnhancedReadFile(),
    access: (p) => fsAccess(p, constants.R_OK),
    detectImageMimeType: async (p) => IMAGE_MIMES[extname(p).toLowerCase()] || undefined,
  };

  // full-access: 不包装，直接返回原始工具
  // Windows 即使 full-access 也要用自定义 exec（PI SDK 默认的 detached 导致空输出 + shell 查找不含内嵌 Git）
  if (policy.mode === "full-access") {
    const isWin32 = process.platform === "win32";
    const bashTool = isWin32
      ? createBashTool(cwd, { operations: { exec: createWin32Exec() } })
      : createBashTool(cwd);
    return {
      tools: [
        createReadTool(cwd, { operations: readOps }),
        createWriteTool(cwd),
        createEditTool(cwd),
        bashTool,
        createGrepTool(cwd),
        createFindTool(cwd),
        createLsTool(cwd),
      ],
      customTools,
    };
  }

  // standard / authorized: PathGuard + OS 沙盒 exec
  const platform = detectPlatform();
  const guard = new PathGuard(policy);

  // 构建授权模式选项（仅 authorized 模式使用）
  const authOpts = mode === "authorized" ? {
    mode: "authorized",
    allowlist: getGlobalAllowlist(lynnHome),
    confirmStore,
    getSessionPath,
    emitEvent,
  } : undefined;

  // Windows: PathGuard 包装生效，bash 用自定义 exec（避免 detached 导致空输出）
  if (platform === "win32-full-access") {
    const win32BashOps = { exec: createWin32Exec() };
    return {
      tools: [
        wrapPathTool(createReadTool(cwd, { operations: readOps }), guard, "read", cwd, authOpts),
        wrapPathTool(createWriteTool(cwd), guard, "write", cwd, authOpts),
        wrapPathTool(createEditTool(cwd), guard, "write", cwd, authOpts),
        wrapBashTool(createBashTool(cwd, { operations: win32BashOps }), guard, cwd, authOpts),
        wrapPathTool(createGrepTool(cwd), guard, "read", cwd, authOpts),
        wrapPathTool(createFindTool(cwd), guard, "read", cwd, authOpts),
        wrapPathTool(createLsTool(cwd), guard, "read", cwd, authOpts),
      ],
      customTools,
    };
  }

  if (!checkAvailability(platform)) {
    throw new Error(t("sandbox.osRequired", { platform }));
  }

  const sandboxExec = platform === "seatbelt"
    ? createSeatbeltExec(policy)
    : createBwrapExec(policy);
  const bashOps = { exec: sandboxExec };

  return {
    tools: [
      wrapPathTool(createReadTool(cwd, { operations: readOps }), guard, "read", cwd, authOpts),
      wrapPathTool(createWriteTool(cwd), guard, "write", cwd, authOpts),
      wrapPathTool(createEditTool(cwd), guard, "write", cwd, authOpts),
      wrapBashTool(createBashTool(cwd, { operations: bashOps }), undefined, undefined, authOpts),
      wrapPathTool(createGrepTool(cwd), guard, "read", cwd, authOpts),
      wrapPathTool(createFindTool(cwd), guard, "read", cwd, authOpts),
      wrapPathTool(createLsTool(cwd), guard, "read", cwd, authOpts),
    ],
    customTools,
  };
}
