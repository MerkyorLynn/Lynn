/**
 * ChannelManager — 频道管理
 *
 * 从 Engine 提取，负责频道 CRUD、成员管理、新 agent 频道初始化。
 * 不持有 engine 引用，通过构造器注入依赖。
 *
 * Channel ID 化：文件名为 ch_{id}.md，frontmatter 含 id/name/description/members。
 */
import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { createModuleLogger } from "../lib/debug-log.js";
import { saveConfig } from "../lib/memory/config-loader.js";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { t } from "../server/i18n.js";
import {
  createChannel as createChannelFile,
  addBookmarkEntry,
  addChannelMember,
  getChannelMembers,
  getChannelMeta,
  removeChannelMember,
  removeBookmarkEntry,
  deleteChannel,
  setChannelArchived,
} from "../lib/channels/channel-store.js";

const log = createModuleLogger("channel");

export class ChannelManager {
  /**
   * @param {object} deps
   * @param {string} deps.channelsDir - 频道目录
   * @param {string} deps.agentsDir  - agents 根目录
   * @param {string} deps.userDir    - 用户数据目录
   * @param {() => object|null} deps.getHub - 返回 Hub（可能为 null）
   * @param {(agentId: string) => Promise<void>} [deps.deleteAgent] - 删除 agent 的回调（可选）
   */
  constructor(deps) {
    this._channelsDir = deps.channelsDir;
    this._agentsDir = deps.agentsDir;
    this._userDir = deps.userDir;
    this._getHub = deps.getHub;
    this._deleteAgent = deps.deleteAgent || null;
  }

  /**
   * 统一创建频道：写入频道文件 + 成员/用户 bookmark + 绑定频道专家
   */
  createChannel({ name, description, members, intro, spawnedExpertIds = [] }) {
    const { id: channelId } = createChannelFile(this._channelsDir, {
      name,
      description: description || undefined,
      members,
      intro: intro || undefined,
    });

    for (const memberId of members || []) {
      const memberDir = path.join(this._agentsDir, memberId);
      if (!fs.existsSync(memberDir)) continue;
      addBookmarkEntry(path.join(memberDir, "channels.md"), channelId);
    }

    addBookmarkEntry(this._userBookmarkPath(), channelId);
    this.markAgentsSpawnedForChannel(spawnedExpertIds, channelId);
    log.log(`已创建频道: ${channelId} members=[${(members || []).join(",")}]`);
    return channelId;
  }

  /**
   * 从所有频道中清理被删除的 agent
   * - 从每个频道的 members 中移除
   * - 移除后只剩 ≤1 人的频道直接删除
   * - 清理相关 bookmark
   */
  cleanupAgentFromChannels(agentId) {
    if (!this._channelsDir || !fs.existsSync(this._channelsDir)) return;

    const channelFiles = fs.readdirSync(this._channelsDir).filter(f => f.endsWith(".md"));
    const deletedChannels = [];

    for (const f of channelFiles) {
      const filePath = path.join(this._channelsDir, f);
      const channelId = f.replace(".md", "");
      const members = getChannelMembers(filePath);

      if (!members.includes(agentId)) continue;

      try {
        removeChannelMember(filePath, agentId);
        const remaining = getChannelMembers(filePath);
        if (remaining.length <= 1) {
          deleteChannel(filePath);
          deletedChannels.push(channelId);
          log.log(`频道 "${channelId}" 成员不足，已删除`);
        }
      } catch (err) {
        log.error(`清理频道 "${channelId}" 失败: ${err.message}`);
      }
    }

    if (deletedChannels.length > 0) {
      this._cleanupBookmarks(deletedChannels, agentId);
    }
  }

  /**
   * 删除频道及其所有关联数据
   * - 先识别该频道 spawn 出来的专家
   * - 删除频道文件和 bookmark
   * - 再级联删除频道专家 agent
   */
  async deleteChannelByName(channelId) {
    const filePath = path.join(this._channelsDir, `${channelId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(t("error.channelNotFoundById", { id: channelId }));
    }

    const members = getChannelMembers(filePath);
    const scopedExperts = this._getChannelScopedExperts(channelId, members);

    deleteChannel(filePath);
    this._cleanupBookmarks([channelId]);

    const deletedAgentIds = [];
    const failedAgentIds = [];

    for (const agentId of scopedExperts) {
      try {
        await this._deleteScopedAgent(agentId);
        deletedAgentIds.push(agentId);
      } catch (err) {
        failedAgentIds.push(agentId);
        log.error(`删除频道专家失败 (${agentId} @ ${channelId}): ${err.message}`);
      }
    }

    log.log(`已删除频道: ${channelId}${deletedAgentIds.length ? `，级联清理专家 [${deletedAgentIds.join(",")}]` : ""}`);
    return { deletedAgentIds, failedAgentIds };
  }

  /**
   * 归档频道：保留历史消息并切换为只读
   */
  archiveChannelByName(channelId) {
    const filePath = path.join(this._channelsDir, `${channelId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(t("error.channelNotFoundById", { id: channelId }));
    }

    const meta = getChannelMeta(filePath);
    const alreadyArchived = meta.archived === true || meta.archived === "true";
    if (!alreadyArchived) {
      setChannelArchived(filePath, true);
    }

    const updatedMeta = getChannelMeta(filePath);
    log.log(`已归档频道: ${channelId}`);
    return {
      archived: true,
      alreadyArchived,
      archivedAt: updatedMeta.archivedAt || meta.archivedAt || null,
    };
  }

  /**
   * 触发频道立即 triage（用户发消息后调用）
   */
  async triggerChannelTriage(channelName, opts) {
    return this._getHub()?.triggerChannelTriage(channelName, opts);
  }

  /**
   * 为新 agent 设置默认频道
   * - 确保 ch_crew 频道存在并加入
   * - 写 agent 的 channels.md
   */
  setupChannelsForNewAgent(agentId) {
    const channelsMdPath = path.join(this._agentsDir, agentId, "channels.md");

    // 确保 ch_crew 频道存在
    const crewFile = path.join(this._channelsDir, "ch_crew.md");
    if (!fs.existsSync(crewFile)) {
      const chName = t("error.defaultChannelName");
      const chDesc = t("error.defaultChannelDesc");
      createChannelFile(this._channelsDir, {
        id: "ch_crew",
        name: chName,
        description: chDesc,
        members: [agentId],
        intro: chDesc,
      });
    } else {
      addChannelMember(crewFile, agentId);
    }

    // 写 agent 的 channels.md（扫描所有频道，加入包含该 agent 的）
    const allChannels = ["ch_crew"];
    try {
      const files = fs.readdirSync(this._channelsDir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const channelId = f.replace(".md", "");
        if (channelId === "ch_crew") continue;
        const members = getChannelMembers(path.join(this._channelsDir, f));
        if (members.includes(agentId)) {
          allChannels.push(channelId);
        }
      }
    } catch {}

    for (const ch of allChannels) {
      addBookmarkEntry(channelsMdPath, ch);
    }
  }

  /** 给 spawn 出的专家写入频道归属，便于删频道时级联清理 */
  markAgentSpawnedForChannel(agentId, channelId) {
    if (!agentId || !channelId) return false;
    const configPath = path.join(this._agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(configPath)) return false;
    saveConfig(configPath, { expert: { spawnedForChannel: channelId } });
    return true;
  }

  markAgentsSpawnedForChannel(agentIds, channelId) {
    if (!Array.isArray(agentIds) || !channelId) return [];
    return agentIds.filter((agentId) => this.markAgentSpawnedForChannel(agentId, channelId));
  }

  /** 扫描所有 agent，找出绑定了不存在频道的孤儿专家 */
  listOrphanedChannelExperts() {
    if (!this._agentsDir || !fs.existsSync(this._agentsDir)) return [];

    const orphaned = [];
    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    for (const entry of agentDirs) {
      const agentId = entry.name;
      const cfg = this._readAgentConfig(agentId);
      const boundChannelId = cfg?.expert?.spawnedForChannel;
      if (!boundChannelId || typeof boundChannelId !== "string") continue;

      const channelFile = path.join(this._channelsDir, `${boundChannelId}.md`);
      if (!fs.existsSync(channelFile)) {
        orphaned.push(agentId);
        continue;
      }

      const members = getChannelMembers(channelFile);
      if (!members.includes(agentId)) {
        orphaned.push(agentId);
      }
    }

    return orphaned;
  }

  _getChannelScopedExperts(channelId, members) {
    return (members || []).filter((agentId) => {
      const cfg = this._readAgentConfig(agentId);
      return cfg?.expert?.spawnedForChannel === channelId;
    });
  }

  _readAgentConfig(agentId) {
    const configPath = path.join(this._agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(configPath)) return null;
    return safeReadYAMLSync(configPath, {}, YAML);
  }

  async _deleteScopedAgent(agentId) {
    if (this._deleteAgent) {
      await this._deleteAgent(agentId);
      return;
    }
    fs.rmSync(path.join(this._agentsDir, agentId), { recursive: true, force: true });
  }

  _userBookmarkPath() {
    return path.join(this._userDir, "channel-bookmarks.md");
  }

  /** 清理被删频道的 bookmark（从其他 agent 和用户的 bookmark 中移除） */
  _cleanupBookmarks(deletedChannels, excludeAgentId) {
    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== excludeAgentId);

    for (const d of agentDirs) {
      const channelsMd = path.join(this._agentsDir, d.name, "channels.md");
      for (const ch of deletedChannels) {
        try {
          removeBookmarkEntry(channelsMd, ch);
        } catch (err) {
          log.error(`清理 ${d.name} bookmark "${ch}" 失败: ${err.message}`);
        }
      }
    }

    const userBookmarkPath = this._userBookmarkPath();
    for (const ch of deletedChannels) {
      try {
        removeBookmarkEntry(userBookmarkPath, ch);
      } catch (err) {
        log.error(`清理用户 bookmark "${ch}" 失败: ${err.message}`);
      }
    }
  }
}
