/**
 * dm.js — DM 私信 REST API
 *
 * DM 文件存在 agents/{agentId}/dm/{peerId}.md
 *
 * 端点：
 * GET  /api/dm           — 列出当前 focus agent 的真实 DM 对话
 * GET  /api/dm/:peerId   — 获取与某个 agent 的 DM 消息
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { parseChannel } from "../../lib/channels/channel-store.js";

export function createDmRoute(engine) {
  const route = new Hono();

  // ── 列出已有 DM 对话（只返回真的聊过的，不做占位） ──
  route.get("/dm", async (c) => {
    try {
      const agent = engine.agent;
      if (!agent) {
        return c.json({ dms: [] });
      }

      const dmDir = path.join(agent.agentDir, "dm");
      if (!fs.existsSync(dmDir)) {
        return c.json({ dms: [] });
      }

      const dms = [];
      for (const f of fs.readdirSync(dmDir).filter((file) => file.endsWith(".md"))) {
        const peerId = f.replace(".md", "");
        const filePath = path.join(dmDir, f);
        const content = fs.readFileSync(filePath, "utf-8");
        const { messages } = parseChannel(content);
        if (!Array.isArray(messages) || messages.length === 0) continue;

        const lastMsg = messages[messages.length - 1];
        const peerAgent = engine.getAgent?.(peerId);
        dms.push({
          peerId,
          peerName: peerAgent?.agentName || peerAgent?.config?.agent?.name || peerId,
          lastMessage: lastMsg?.body?.slice(0, 60) || "",
          lastSender: lastMsg?.sender || "",
          lastTimestamp: lastMsg?.timestamp || "",
          messageCount: messages.length,
        });
      }

      dms.sort((a, b) => (b.lastTimestamp || "").localeCompare(a.lastTimestamp || ""));
      return c.json({ dms });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 获取 DM 消息 ──
  route.get("/dm/:peerId", async (c) => {
    try {
      const peerId = c.req.param("peerId");
      const agent = engine.agent;
      if (!agent) {
        return c.json({ error: "No active agent" }, 400);
      }

      if (/[\/\\]|\.\./.test(peerId)) {
        return c.json({ error: "Invalid peerId" }, 400);
      }

      const dmFile = path.join(agent.agentDir, "dm", `${peerId}.md`);
      if (!fs.existsSync(dmFile)) {
        return c.json({ error: "DM not found" }, 404);
      }

      const content = fs.readFileSync(dmFile, "utf-8");
      const { messages } = parseChannel(content);

      const peerAgent = engine.getAgent(peerId);
      const peerName = peerAgent?.agentName || peerId;

      return c.json({
        peerId,
        peerName,
        messages,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
