/**
 * security-mode.js — 三模式安全策略常量 + 配置
 *
 * 三个模式：
 *   authorized — 默认，无沙盒限制（等同原 full-access），危险命令仅日志记录
 *   plan       — 只读规划，不执行任何工具
 *   safe       — 严格沙盒，危险操作直接拒绝
 *
 * 设计原则：默认信任、实时透明、一键回滚
 */

/** 安全模式枚举 */
export const SecurityMode = {
  AUTHORIZED: "authorized",
  PLAN: "plan",
  SAFE: "safe",
};

/** 默认安全模式 */
export const DEFAULT_SECURITY_MODE = SecurityMode.AUTHORIZED;

/** 所有合法的安全模式值 */
export const VALID_SECURITY_MODES = new Set([
  SecurityMode.AUTHORIZED,
  SecurityMode.PLAN,
  SecurityMode.SAFE,
]);

/** 校验安全模式值是否合法，不合法则返回默认值 */
export function normalizeSecurityMode(mode) {
  if (VALID_SECURITY_MODES.has(mode)) return mode;
  // 迁移：旧版 full-access 映射到新版 authorized（行为一致）
  if (mode === "full-access") return SecurityMode.AUTHORIZED;
  return DEFAULT_SECURITY_MODE;
}

/**
 * 模式配置映射
 *
 * sandboxMode: 对应底层沙盒策略
 *   - "full-access"  — 不启用 OS 沙盒，PathGuard 仅日志
 *   - "standard"     — OS 沙盒 + PathGuard 严格拦截
 *
 * toolsRestricted: 是否限制为只读工具
 * allowConfirmation: 是否允许弹授权确认
 */
export const SECURITY_MODE_CONFIG = {
  [SecurityMode.AUTHORIZED]: {
    sandboxMode: "full-access",
    toolsRestricted: false,
    allowConfirmation: false,
  },
  [SecurityMode.PLAN]: {
    sandboxMode: "standard",
    toolsRestricted: true,
    allowConfirmation: false,
  },
  [SecurityMode.SAFE]: {
    sandboxMode: "standard",
    toolsRestricted: false,
    allowConfirmation: false,
  },
};
