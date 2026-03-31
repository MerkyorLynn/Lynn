/**
 * user-profile.js — 用户行为画像
 *
 * 轻量 JSON profile，纯统计聚合（不调 LLM）。
 * 追踪工具使用频率、编程语言偏好、活跃时段。
 *
 * 存储：{agentDir}/memory/user-profile.json
 */

import fs from "fs";
import path from "path";

/**
 * Profile 数据结构：
 * {
 *   sessionCount: number,
 *   toolUsage: Record<string, number>,    // toolName → total count
 *   languages: Record<string, number>,    // language → session mention count
 *   hourDistribution: number[24],         // 24 小时分布
 *   totalTurns: number,
 *   updatedAt: string,
 * }
 */

const EMPTY_PROFILE = {
  sessionCount: 0,
  toolUsage: {},
  languages: {},
  hourDistribution: new Array(24).fill(0),
  totalTurns: 0,
  updatedAt: null,
};

/** sessionCount 阈值：低于此值不输出画像（避免样本不足导致不准确） */
const MIN_SESSIONS_FOR_OUTPUT = 3;

export class UserProfile {
  /**
   * @param {object} opts
   * @param {string} opts.profilePath - user-profile.json 路径
   */
  constructor({ profilePath }) {
    this._profilePath = profilePath;
    this._profile = null; // lazy load
  }

  /**
   * 加载 profile（lazy + 内存缓存）
   */
  _load() {
    if (this._profile) return this._profile;

    try {
      if (fs.existsSync(this._profilePath)) {
        this._profile = JSON.parse(fs.readFileSync(this._profilePath, "utf-8"));
        // 确保字段完整（兼容旧版本）
        this._profile = { ...EMPTY_PROFILE, ...this._profile };
      } else {
        this._profile = { ...EMPTY_PROFILE };
      }
    } catch {
      this._profile = { ...EMPTY_PROFILE };
    }

    return this._profile;
  }

  /**
   * 保存 profile 到磁盘
   */
  _save() {
    if (!this._profile) return;
    try {
      const dir = path.dirname(this._profilePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._profilePath, JSON.stringify(this._profile, null, 2), "utf-8");
    } catch (err) {
      console.error(`[user-profile] save failed: ${err.message}`);
    }
  }

  /**
   * 从 session 统计数据增量更新
   *
   * @param {{ toolUsage: Record<string, number>, languages: Record<string, number>, hour: number|null, turnCount: number }} stats
   */
  updateFromSession(stats) {
    if (!stats) return;

    const profile = this._load();

    profile.sessionCount++;
    profile.totalTurns += stats.turnCount || 0;
    profile.updatedAt = new Date().toISOString();

    // 合并工具使用计数
    if (stats.toolUsage) {
      for (const [tool, count] of Object.entries(stats.toolUsage)) {
        profile.toolUsage[tool] = (profile.toolUsage[tool] || 0) + count;
      }
    }

    // 合并语言偏好
    if (stats.languages) {
      for (const [lang, count] of Object.entries(stats.languages)) {
        profile.languages[lang] = (profile.languages[lang] || 0) + count;
      }
    }

    // 更新时段分布
    if (stats.hour != null && stats.hour >= 0 && stats.hour < 24) {
      if (!Array.isArray(profile.hourDistribution) || profile.hourDistribution.length !== 24) {
        profile.hourDistribution = new Array(24).fill(0);
      }
      profile.hourDistribution[stats.hour]++;
    }

    this._save();
  }

  /**
   * 格式化为 prompt 注入文本（≤80 tokens）
   *
   * 仅在 sessionCount ≥ 3 后输出（避免不准确）
   *
   * @param {boolean} isZh - 是否中文
   * @returns {string} - 格式化文本（空字符串表示无需注入）
   */
  formatForPrompt(isZh) {
    const profile = this._load();

    if (profile.sessionCount < MIN_SESSIONS_FOR_OUTPUT) return "";

    const parts = [];

    // 常用工具（top-3，排除内部/基础工具）
    const INTERNAL_TOOLS = new Set(["read_file", "write_file", "edit_file", "list_files", "search_files"]);
    const topTools = Object.entries(profile.toolUsage)
      .filter(([name]) => !INTERNAL_TOOLS.has(name))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    if (topTools.length > 0) {
      parts.push(isZh
        ? `常用工具：${topTools.join("、")}`
        : `Preferred tools: ${topTools.join(", ")}`
      );
    }

    // 常用语言（top-2）
    const topLangs = Object.entries(profile.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([lang]) => lang);

    if (topLangs.length > 0) {
      parts.push(isZh
        ? `常用语言：${topLangs.join("、")}`
        : `Primary languages: ${topLangs.join(", ")}`
      );
    }

    // 活跃时段
    if (Array.isArray(profile.hourDistribution)) {
      const maxHour = profile.hourDistribution.indexOf(Math.max(...profile.hourDistribution));
      if (profile.hourDistribution[maxHour] > 0) {
        const period = maxHour < 6 ? (isZh ? "深夜" : "late night")
          : maxHour < 12 ? (isZh ? "上午" : "morning")
          : maxHour < 18 ? (isZh ? "下午" : "afternoon")
          : (isZh ? "晚上" : "evening");
        parts.push(isZh
          ? `活跃时段：${period}`
          : `Active hours: ${period}`
        );
      }
    }

    if (parts.length === 0) return "";

    return parts.join(" | ");
  }

  /**
   * 获取原始 profile 数据（调试/API 用）
   */
  getRawProfile() {
    return this._load();
  }
}
