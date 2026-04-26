/**
 * desk-manager.js — Desk 目录管理
 *
 * Desk（書桌）是 agent 的工作台，存放：
 * - cron-jobs.json：定时任务
 * - cron-runs/：执行历史
 * - jian-registry.json：笺指纹注册表
 * - plugins/{pluginId}/：各插件的独立工作区（v0.77 新增）
 */

import fs from "fs";
import path from "path";

/**
 * 创建 Desk 管理器
 * @param {string} deskDir - desk 目录路径（{agentDir}/desk/）
 */
export function createDeskManager(deskDir) {
  const runsDir = path.join(deskDir, "cron-runs");
  const pluginsDir = path.join(deskDir, "plugins");

  return {
    /** desk 目录路径 */
    deskDir,

    /** 插件工作区根目录 */
    pluginsDir,

    /**
     * 确保 desk 目录结构存在
     */
    ensureDir() {
      fs.mkdirSync(deskDir, { recursive: true });
      fs.mkdirSync(runsDir, { recursive: true });
      fs.mkdirSync(pluginsDir, { recursive: true });
    },

    /**
     * 获取/创建某个插件的独立工作区
     * @param {string} pluginId
     * @returns {string} 插件工作区绝对路径
     */
    ensurePluginWorkspace(pluginId) {
      const dir = path.join(pluginsDir, pluginId);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },

    /**
     * 列出所有插件工作区
     * @returns {Array<{pluginId: string, absPath: string}>}
     */
    listPluginWorkspaces() {
      if (!fs.existsSync(pluginsDir)) return [];
      return fs.readdirSync(pluginsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => ({
          pluginId: e.name,
          absPath: path.join(pluginsDir, e.name),
        }));
    },
  };
}
