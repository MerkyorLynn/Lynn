/**
 * security-mode.js — 三模式安全策略常量 + 配置
 *
 * 三个模式：
 *   authorized — 默认，沙盒基础规则生效，危险操作弹确认卡片
 *   plan       — 只读规划，不执行任何工具（原 plan-mode）
 *   safe       — 严格沙盒，危险操作直接拒绝
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
  return DEFAULT_SECURITY_MODE;
}

/**
 * 模式配置映射
 *
 * sandboxMode: 对应底层沙盒策略
 *   - "standard"     — OS 沙盒 + PathGuard 严格拦截
 *   - "authorized"   — OS 沙盒 + PathGuard 授权确认
 *   - "full-access"  — 不启用沙盒
 *
 * toolsRestricted: 是否限制为只读工具
 * allowConfirmation: 是否允许弹授权确认（authorized 模式独有）
 */
export const SECURITY_MODE_CONFIG = {
  [SecurityMode.AUTHORIZED]: {
    sandboxMode: "authorized",
    toolsRestricted: false,
    allowConfirmation: true,
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
