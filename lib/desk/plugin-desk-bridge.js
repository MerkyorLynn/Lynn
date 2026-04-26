/**
 * plugin-desk-bridge.js — 插件与书桌（Desk）的集成桥接器
 *
 * 为每个插件在书桌下创建独立工作区：
 *   {agentDir}/desk/plugins/{pluginId}/
 *
 * 心跳巡检扫描到该目录有新文件时，通过 EventBus 通知对应插件，
 * 实现「书桌文件变化 → 插件自动响应」的闭环。
 */

import fs from "fs";
import path from "path";

/**
 * 创建插件书桌桥接器
 * @param {{ deskDir: string, bus: object, log?: function }} opts
 */
export function createPluginDeskBridge({ deskDir, bus, log = () => {} }) {
  const pluginsDir = path.join(deskDir, "plugins");

  function ensurePluginWorkspace(pluginId) {
    const dir = path.join(pluginsDir, pluginId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function listPluginWorkspaces() {
    if (!fs.existsSync(pluginsDir)) return [];
    return fs.readdirSync(pluginsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => ({
        pluginId: e.name,
        absPath: path.join(pluginsDir, e.name),
      }));
  }

  function scanPluginWorkspace(pluginId) {
    const dir = path.join(pluginsDir, pluginId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith("."))
      .map(e => {
        const fp = path.join(dir, e.name);
        const stat = fs.statSync(fp);
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      });
  }

  /**
   * 心跳调用：扫描所有插件工作区，发现变化则 emit 事件
   */
  function heartbeatScan() {
    const workspaces = listPluginWorkspaces();
    const changes = [];
    for (const ws of workspaces) {
      const files = scanPluginWorkspace(ws.pluginId);
      if (files.length > 0) {
        changes.push({ pluginId: ws.pluginId, files });
      }
    }
    if (changes.length > 0 && bus) {
      for (const ch of changes) {
        try {
          bus.emit("plugin:desk:files", ch);
        } catch (err) {
          log(`[plugin-desk-bridge] emit error: ${err.message}`);
        }
      }
    }
    return changes;
  }

  return {
    pluginsDir,
    ensurePluginWorkspace,
    listPluginWorkspaces,
    scanPluginWorkspace,
    heartbeatScan,
  };
}
