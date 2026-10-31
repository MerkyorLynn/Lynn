import { isSafePathSegment } from "../../shared/path-segment.js";
/**
 * channels.ts — 频道 REST API
 *
 * Channel ID 化：文件名为 ch_{id}.md，frontmatter 含 id/name/description/members。
 *
 * 端点：
 * GET    /channels              — 列出所有频道 + 用户 bookmark + 未读数
 * POST   /channels              — 创建新频道
 * GET    /channels/:id          — 获取频道消息 + 成员列表
 * POST   /channels/:id/messages — 用户发送群聊消息
 * POST   /channels/:id/read     — 更新用户已读 bookmark
 * POST   /channels/:id/archive  — 归档频道
 * DELETE /channels/:id          — 删除频道
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { debugLog } from "../../lib/debug-log.js";
import {
  parseChannel,
  appendMessage,
  readBookmarks,
  updateBookmark,
  addBookmarkEntry,
  addChannelMember,
  getChannelMeta,
} from "../../lib/channels/channel-store.js";

type ChannelMeta = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  members?: unknown;
  archived?: unknown;
  archivedAt?: unknown;
  [key: string]: unknown;
};

type ChannelMessage = {
  sender?: string;
  timestamp: string;
  body?: string;
};

type ParsedChannel = {
  meta: ChannelMeta;
  messages: ChannelMessage[];
};

type ChannelSummary = {
  id: string;
  name: unknown;
  description: unknown;
  members: unknown[];
  messageCount: number;
  newMessageCount: number;
  lastMessage: string;
  lastSender: string;
  lastTimestamp: string;
  archived: boolean;
  archivedAt: unknown;
};

type CreateChannelBody = {
  name?: unknown;
  description?: unknown;
  members?: unknown;
  intro?: unknown;
  spawnedExpertIds?: unknown;
};

type SendMessageBody = {
  body?: string;
};

type ReadBookmarkBody = {
  timestamp?: string;
};

type AddMembersBody = {
  add?: string[];
};

type ToggleChannelsBody = {
  enabled?: unknown;
};

type RouteAgent = {
  id: string;
  name?: string;
};

type DeleteChannelResult = {
  deletedAgentIds?: string[];
  failedAgentIds?: string[];
};

type ArchiveChannelResult = {
  archivedAt?: unknown;
  alreadyArchived?: unknown;
};

type CreateChannelInput = {
  name: string;
  description?: unknown;
  members: string[];
  intro?: unknown;
  spawnedExpertIds: unknown[];
};

type ChannelsRouteEngine = {
  channelsDir: string;
  userDir: string;
  agentsDir: string;
  userName?: string;
  createChannel(input: CreateChannelInput): string;
  deleteChannelByName(channelId: string): DeleteChannelResult | Promise<DeleteChannelResult>;
  archiveChannelByName(channelId: string): ArchiveChannelResult | Promise<ArchiveChannelResult>;
  listAgents?: () => RouteAgent[];
};

type ChannelEventBus = {
  emit(event: unknown, target?: unknown): unknown;
};

type ChannelsRouteHub = {
  eventBus?: ChannelEventBus;
  triggerChannelConclusion?: (channelName: string) => Promise<unknown> | undefined;
  triggerChannelTriage(channelName: string, opts?: { mentionedAgents: string[] }): Promise<unknown> | undefined;
  toggleChannels(enabled: boolean): Promise<unknown> | unknown;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasUsableChannelMeta(meta: ChannelMeta | null | undefined, fallbackId = ""): boolean {
  const members = Array.isArray(meta?.members) ? meta.members.filter(Boolean) : [];
  const id = typeof meta?.id === "string" && meta.id.trim() ? meta.id.trim() : fallbackId;
  return Boolean(id) && members.length > 0;
}

export function createChannelsRoute(engine: ChannelsRouteEngine, hub: ChannelsRouteHub): Hono {
  const route = new Hono();

  /** 用户 bookmark 文件路径 */
  function userBookmarkPath(): string {
    return path.join(engine.userDir, "channel-bookmarks.md");
  }

  /** 安全路径校验：id 不能穿越出 channelsDir */
  function safeChannelPath(id: string): string | null {
    const filePath = path.join(engine.channelsDir, `${id}.md`);
    const resolved = path.resolve(filePath);
    const base = path.resolve(engine.channelsDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return null;
    }
    return resolved;
  }

  function getArchivedState(meta: ChannelMeta = {}): { archived: boolean; archivedAt: unknown } {
    return {
      archived: meta.archived === true || meta.archived === "true",
      archivedAt: meta.archivedAt || "",
    };
  }

  // ── 列出所有频道 ──
  route.get("/channels", async (c) => {
    try {
      const channelsDir = engine.channelsDir;
      if (!channelsDir || !fs.existsSync(channelsDir)) {
        return c.json({ channels: [], bookmarks: {} });
      }

      const files = fs.readdirSync(channelsDir).filter((f) => f.endsWith(".md"));
      const bookmarks = readBookmarks(userBookmarkPath()) as Map<string, string>;

      const channels: ChannelSummary[] = [];
      for (const f of files) {
        const channelId = f.replace(".md", "");
        const filePath = path.join(channelsDir, f);
        const content = fs.readFileSync(filePath, "utf-8");
        const { meta, messages } = parseChannel(content) as ParsedChannel;
        if (!hasUsableChannelMeta(meta, channelId)) {
          debugLog()?.warn?.("api", `skip malformed channel file: ${f}`);
          continue;
        }
        const members = Array.isArray(meta.members) ? meta.members : [];
        const { archived, archivedAt } = getArchivedState(meta);

        const lastMsg = messages[messages.length - 1];
        const bookmark = bookmarks.get(channelId);

        let newMessageCount = 0;
        if (bookmark && bookmark !== "never") {
          newMessageCount = messages.filter((m) => m.timestamp > bookmark).length;
        } else {
          newMessageCount = messages.length;
        }

        channels.push({
          id: channelId,
          name: meta.name || channelId,
          description: meta.description || "",
          members,
          messageCount: messages.length,
          newMessageCount,
          lastMessage: lastMsg?.body?.slice(0, 60) || "",
          lastSender: lastMsg?.sender || "",
          lastTimestamp: lastMsg?.timestamp || "",
          archived,
          archivedAt,
        });
      }

      channels.sort((a, b) =>
        (b.lastTimestamp || "").localeCompare(a.lastTimestamp || "")
      );

      const bookmarksObj: Record<string, string> = {};
      for (const [k, v] of bookmarks) bookmarksObj[k] = v;

      return c.json({ channels, bookmarks: bookmarksObj });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ── 创建新频道 ──
  route.post("/channels", async (c) => {
    try {
      const body = await safeJson<CreateChannelBody>(c);
      const { name, description, members, intro, spawnedExpertIds } = body;

      if (!name || typeof name !== "string") {
        return c.json({ error: "name is required" }, 400);
      }
      if (!Array.isArray(members) || members.length < 2) {
        return c.json({ error: "members must be an array with at least 2 items" }, 400);
      }

      fs.mkdirSync(engine.channelsDir, { recursive: true });

      const channelId = engine.createChannel({
        name,
        description: description || undefined,
        members: members as string[],
        intro: intro || undefined,
        spawnedExpertIds: Array.isArray(spawnedExpertIds) ? spawnedExpertIds : [],
      });

      debugLog()?.log("api", `POST /channels — created "${channelId}" (${name}) members=[${members}]`);
      return c.json({ ok: true, id: channelId, name, members });
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("已存在")) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 500);
    }
  });

  // ── 获取频道消息 ──
  route.get("/channels/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      if (!fs.existsSync(filePath)) {
        return c.json({ error: "Channel not found" }, 404);
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const { meta, messages } = parseChannel(content) as ParsedChannel;
      if (!hasUsableChannelMeta(meta, name)) {
        return c.json({ error: "Channel file is malformed" }, 409);
      }
      const members = Array.isArray(meta.members) ? meta.members : [];
      const { archived, archivedAt } = getArchivedState(meta);

      return c.json({
        id: meta.id || name,
        name: meta.name || name,
        description: meta.description || "",
        messages,
        members,
        archived,
        archivedAt,
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ── 用户发送消息 ──
  route.post("/channels/:name/messages", async (c) => {
    try {
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      const reqBody = await safeJson<SendMessageBody>(c);
      const { body } = reqBody;

      if (!body) {
        return c.json({ error: "body is required" }, 400);
      }

      if (!fs.existsSync(filePath)) {
        return c.json({ error: "Channel not found" }, 404);
      }

      const channelMeta = getChannelMeta(filePath) as ChannelMeta;
      if (!hasUsableChannelMeta(channelMeta, name)) {
        return c.json({ error: "Channel file is malformed" }, 409);
      }
      const { archived } = getArchivedState(channelMeta);
      if (archived) {
        return c.json({ error: "Channel is archived" }, 409);
      }

      const senderName = engine.userName || "user";

      // 检测 /结论 /总结 /conclusion 斜杠命令
      const trimmed = body.trim();
      const isConclusionCmd = /^\/(?:结论|总结|conclusion|summary)$/i.test(trimmed);

      const result = appendMessage(filePath, senderName, isConclusionCmd ? "📋 请总结讨论并给出结论" : body);

      debugLog()?.log("api", `POST /channels/${name}/messages${isConclusionCmd ? " [conclusion]" : ""}`);

      if (isConclusionCmd) {
        // 触发结论生成
        hub.triggerChannelConclusion?.(name)?.catch((err: unknown) =>
          console.error(`[channel] 触发结论生成失败: ${errorMessage(err)}`)
        );
      } else {
        // 提取 @ 提及
        const atMatches = body.match(/@(\S+)/g) || [];
        const channelMembers = Array.isArray(channelMeta.members) ? channelMeta.members as string[] : [];

        for (const memberId of channelMembers) {
          if (!isSafePathSegment(memberId)) continue;
          addBookmarkEntry(path.join(engine.agentsDir, memberId, "channels.md"), name);
        }

        const mentionedAgents: string[] = [];
        if (atMatches.length > 0) {
          const allAgents = engine.listAgents?.() || [];
          const seen = new Set<string>();
          for (const at of atMatches) {
            const atName = at
              .slice(1)
              .trim()
              .replace(/[，。！？：；,.:;!?、)\]）】》〉>]+$/u, "");
            if (!atName) continue;
            for (const agent of allAgents) {
              if (!channelMembers.includes(agent.id)) continue;
              if (agent.name !== atName && agent.id !== atName) continue;
              if (seen.has(agent.id)) continue;
              seen.add(agent.id);
              mentionedAgents.push(agent.id);
            }
          }
        }

        hub.triggerChannelTriage(name, { mentionedAgents })?.catch((err: unknown) =>
          console.error(`[channel] 触发立即 triage 失败: ${errorMessage(err)}`)
        );
      }

      return c.json({ ok: true, timestamp: result.timestamp, isConclusion: isConclusionCmd });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ── 更新用户已读 bookmark ──
  route.post("/channels/:name/read", async (c) => {
    try {
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      const body = await safeJson<ReadBookmarkBody>(c);
      const { timestamp } = body;

      if (!timestamp) {
        return c.json({ error: "timestamp is required" }, 400);
      }

      updateBookmark(userBookmarkPath(), name, timestamp);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ── 归档频道 ──
  route.post("/channels/:name/archive", async (c) => {
    try {
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      if (!fs.existsSync(filePath)) {
        return c.json({ error: "Channel not found" }, 404);
      }

      const result = await engine.archiveChannelByName(name);
      hub.eventBus?.emit({
        type: "channel_archived",
        channelName: name,
        archived: true,
        archivedAt: result?.archivedAt || "",
      }, null);
      debugLog()?.log("api", `POST /channels/${name}/archive`);
      return c.json({
        ok: true,
        archived: true,
        alreadyArchived: !!result?.alreadyArchived,
        archivedAt: result?.archivedAt || "",
      });
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("不存在")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 500);
    }
  });

  // ── 删除频道 ──
  route.delete("/channels/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      const result = await engine.deleteChannelByName(name);
      debugLog()?.log("api", `DELETE /channels/${name}`);
      return c.json({ ok: true, deletedAgentIds: result?.deletedAgentIds || [], failedAgentIds: result?.failedAgentIds || [] });
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("不存在")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 500);
    }
  });

  // ── 添加频道成员 ──
  route.patch("/channels/:name/members", async (c) => {
    try {
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      if (!fs.existsSync(filePath)) {
        return c.json({ error: "Channel not found" }, 404);
      }

      const channelMeta = getChannelMeta(filePath) as ChannelMeta;
      if (channelMeta.archived === true || channelMeta.archived === "true") {
        return c.json({ error: "Channel is archived" }, 409);
      }

      const body = await safeJson<AddMembersBody>(c);
      const { add } = body;

      if (!Array.isArray(add) || add.length === 0) {
        return c.json({ error: "add must be a non-empty array of member IDs" }, 400);
      }

      // 逐个添加成员到频道
      for (const memberId of add) {
        addChannelMember(filePath, memberId);
      }

      // 给每个新成员的 channels.md 添加 bookmark
      const agentsDir = engine.agentsDir;
      for (const memberId of add) {
        const memberDir = path.join(agentsDir, memberId);
        if (fs.existsSync(memberDir)) {
          const memberChannelsMd = path.join(memberDir, "channels.md");
          addBookmarkEntry(memberChannelsMd, name);
        }
      }

      // 读取更新后的成员列表
      const meta = getChannelMeta(filePath) as ChannelMeta;
      const members = Array.isArray(meta.members) ? meta.members : [];

      debugLog()?.log("api", `PATCH /channels/${name}/members — added [${add}]`);
      return c.json({ ok: true, members });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  // ── 频道开关（启停 channelTicker）──
  route.post("/channels/toggle", async (c) => {
    const body = await safeJson<ToggleChannelsBody>(c);
    const { enabled } = body;
    await hub.toggleChannels(!!enabled);
    debugLog()?.log("api", `POST /channels/toggle enabled=${!!enabled}`);
    return c.json({ ok: true, enabled: !!enabled });
  });

  return route;
}
