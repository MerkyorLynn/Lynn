/**
 * v0.77 Feature Flags · 默认全关,生产用户零感知
 *
 * 启用方式 (开发/测试):
 *   LYNN_RAG_ENABLED=true npm run server         # 全开
 *   LYNN_RAG_USERS=user-id-1,user-id-2 npm run server  # 仅指定用户
 *   LYNN_ASR_ENABLED=true npm run server         # 仅语音
 *
 * 生产 .env (不要设这些 = 默认关):
 *   # LYNN_RAG_ENABLED=
 *   # LYNN_ASR_ENABLED=
 */

const RAG_ENABLED = process.env.LYNN_RAG_ENABLED === "true";
const ASR_ENABLED = process.env.LYNN_ASR_ENABLED === "true";
const RAG_USERS = (process.env.LYNN_RAG_USERS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

/**
 * 给定 userId,判断是否启用 RAG
 * - flag 全关 → false
 * - flag 全开 + 无白名单 → true
 * - flag 全开 + 有白名单 → 仅白名单用户 true
 */
export function isRAGEnabledForUser(userId) {
  if (!RAG_ENABLED) return false;
  if (RAG_USERS.length === 0) return true;
  return userId ? RAG_USERS.includes(userId) : false;
}

export function isASREnabledForUser(_userId) {
  if (!ASR_ENABLED) return false;
  return true;
}

export const v077Flags = {
  RAG_ENABLED,
  ASR_ENABLED,
  RAG_USERS,
  isRAGEnabledForUser,
  isASREnabledForUser,
};

if (process.env.NODE_ENV !== "production") {
  console.log(`[v0.77 flags] RAG=${RAG_ENABLED}, ASR=${ASR_ENABLED}, users=[${RAG_USERS.join(",")}]`);
}
