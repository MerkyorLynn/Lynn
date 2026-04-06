/**
 * experts.js — 专家 REST API
 *
 * 端点：
 * GET    /experts              — 列出所有可用专家预设
 * GET    /experts/:slug        — 获取专家详情
 * POST   /experts/:slug/spawn  — 实例化专家（创建 Agent）
 * POST   /roundtable           — 创建圆桌（多专家频道）
 */

import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";

export function createExpertsRoute(engine) {
  const app = new Hono();

  // ── 列出所有专家预设 ──
  app.get("/experts", (c) => {
    const locale = c.req.query("locale") || engine.config?.locale || "zh";
    const experts = engine.listExperts(locale);
    return c.json({ experts });
  });

  // ── 获取专家头像 ──
  app.get("/experts/:slug/avatar", async (c) => {
    const slug = c.req.param("slug");
    const expert = engine.getExpert(slug);
    if (!expert?._dir) {
      return c.json({ error: "Expert not found" }, 404);
    }

    const avatarsDir = path.join(expert._dir, "avatars");
    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
    for (const name of ["avatar", "agent"]) {
      for (const ext of ["png", "jpg", "jpeg", "webp"]) {
        const filePath = path.join(avatarsDir, `${name}.${ext}`);
        try {
          await fs.access(filePath);
          const buf = await fs.readFile(filePath);
          c.header("Content-Type", mimeMap[ext] || "image/png");
          c.header("Cache-Control", "no-cache");
          return c.body(buf);
        } catch {}
      }
    }

    return c.json({ error: "Expert avatar not found" }, 404);
  });

  // ── 获取专家详情 ──
  app.get("/experts/:slug", (c) => {
    const slug = c.req.param("slug");
    const locale = c.req.query("locale") || engine.config?.locale || "zh";
    const expert = engine.getExpert(slug, locale);
    if (!expert) {
      return c.json({ error: "Expert not found" }, 404);
    }
    return c.json({ expert });
  });

  // ── 实例化专家（创建 Agent） ──
  app.post("/experts/:slug/spawn", async (c) => {
    const slug = c.req.param("slug");
    const body = await safeJson(c);

    try {
      const result = await engine.spawnExpert(slug, {
        userId: body.userId || "local",
        persistent: body.persistent !== false,
        channelId: body.channelId,
        modelId: body.modelId,
        provider: body.provider,
      });

      // 刷新 agent list 缓存
      engine.invalidateAgentListCache();

      return c.json({
        ok: true,
        agentId: result.agentId,
        name: result.name,
      });
    } catch (err) {
      const status = err.message === "Insufficient credits" ? 402 : 400;
      return c.json({ error: err.message }, status);
    }
  });

  // ── 创建圆桌（多专家频道） ──
  app.post("/roundtable", async (c) => {
    const body = await safeJson(c);
    const { expertSlugs, topic, name } = body;

    if (!Array.isArray(expertSlugs) || expertSlugs.length === 0) {
      return c.json({ error: "expertSlugs is required" }, 400);
    }

    try {
      // 逐个 spawn 专家
      const spawnedAgents = [];
      for (const slug of expertSlugs) {
        const result = await engine.spawnExpert(slug, {
          userId: body.userId || "local",
        });
        spawnedAgents.push(result);
      }

      // 创建频道，成员为所有 spawned agents
      const channelName = name || topic || `Roundtable-${Date.now().toString(36)}`;
      const members = spawnedAgents.map(a => a.agentId);
      const intro = topic
        ? `圆桌讨论主题: ${topic}\n\n参与专家: ${spawnedAgents.map(a => a.name).join("、")}`
        : `圆桌讨论 — 参与专家: ${spawnedAgents.map(a => a.name).join("、")}`;

      // 通过 channel API 创建
      const channelId = engine.createChannel({
        name: channelName,
        members,
        intro,
        spawnedExpertIds: members,
      });

      engine.invalidateAgentListCache();

      return c.json({
        ok: true,
        channelId,
        channelName,
        agents: spawnedAgents,
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return app;
}
