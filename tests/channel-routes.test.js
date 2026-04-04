import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createChannelsRoute } from "../server/routes/channels.js";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function writeChannel(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

describe("channels route", () => {
  let tmpDir;
  let channelsDir;
  let userDir;
  let app;
  let engine;
  let hub;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-channels-route-"));
    channelsDir = path.join(tmpDir, "channels");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    engine = {
      channelsDir,
      userDir,
      agentsDir: path.join(tmpDir, "agents"),
      userName: "Lynn User",
      createChannel: vi.fn(),
      deleteChannelByName: vi.fn(async () => ({ deletedAgentIds: [], failedAgentIds: [] })),
      archiveChannelByName: vi.fn((channelId) => {
        const filePath = path.join(channelsDir, `${channelId}.md`);
        const raw = fs.readFileSync(filePath, "utf-8");
        const alreadyArchived = raw.includes("archived: true");
        if (!alreadyArchived) {
          const archivedAt = "2026-04-02 08:00:00";
          fs.writeFileSync(filePath, raw.replace("members: [alpha, beta]", `members: [alpha, beta]\narchived: true\narchivedAt: ${archivedAt}`), "utf-8");
          return { archived: true, alreadyArchived: false, archivedAt };
        }
        return { archived: true, alreadyArchived: true, archivedAt: "2026-04-02 08:00:00" };
      }),
      listAgents: vi.fn(() => []),
    };
    hub = {
      eventBus: { emit: vi.fn() },
      triggerChannelConclusion: vi.fn(),
      triggerChannelTriage: vi.fn(),
      toggleChannels: vi.fn(),
    };

    app = new Hono();
    app.route("/api", createChannelsRoute(engine, hub));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /channels 返回 archived 和 archivedAt", async () => {
    writeChannel(path.join(channelsDir, "ch_archived.md"), [
      "---",
      "id: ch_archived",
      "name: Archived Room",
      "members: [alpha, beta]",
      "archived: true",
      "archivedAt: 2026-04-01 12:00:00",
      "---",
      "",
      "### Alpha | 2026-04-01 11:59:00",
      "",
      "hello",
      "",
      "---",
      "",
    ].join("\n"));

    const res = await app.request("/api/channels");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.channels).toEqual([
      expect.objectContaining({
        id: "ch_archived",
        archived: true,
        archivedAt: "2026-04-01 12:00:00",
      }),
    ]);
  });

  it("GET /channels 会跳过缺少成员 frontmatter 的坏频道文件", async () => {
    writeChannel(path.join(channelsDir, "ch_broken.md"), [
      "### Alpha | 2026-04-01 11:59:00",
      "",
      "hello",
      "",
      "---",
      "",
    ].join("\n"));

    writeChannel(path.join(channelsDir, "ch_ok.md"), [
      "---",
      "id: ch_ok",
      "name: Healthy",
      "members: [alpha, beta]",
      "---",
      "",
      "### Alpha | 2026-04-01 12:00:00",
      "",
      "hi",
      "",
      "---",
      "",
    ].join("\n"));

    const res = await app.request("/api/channels");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.channels).toHaveLength(1);
    expect(data.channels[0]).toEqual(expect.objectContaining({ id: "ch_ok" }));
  });

  it("GET /channels/:name 返回 archived 元数据", async () => {
    writeChannel(path.join(channelsDir, "ch_archived.md"), [
      "---",
      "id: ch_archived",
      "name: Archived Room",
      "members: [alpha, beta]",
      "archived: true",
      "archivedAt: 2026-04-01 12:00:00",
      "---",
      "",
      "### Alpha | 2026-04-01 11:59:00",
      "",
      "hello",
      "",
      "---",
      "",
    ].join("\n"));

    const res = await app.request("/api/channels/ch_archived");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.archived).toBe(true);
    expect(data.archivedAt).toBe("2026-04-01 12:00:00");
  });

  it("POST /channels/:name/archive 归档频道并广播事件", async () => {
    writeChannel(path.join(channelsDir, "ch_general.md"), [
      "---",
      "id: ch_general",
      "name: General",
      "members: [alpha, beta]",
      "---",
      "",
      "### Alpha | 2026-04-01 11:59:00",
      "",
      "hello",
      "",
      "---",
      "",
    ].join("\n"));

    const res = await app.request("/api/channels/ch_general/archive", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      ok: true,
      archived: true,
      alreadyArchived: false,
      archivedAt: "2026-04-02 08:00:00",
    });
    expect(engine.archiveChannelByName).toHaveBeenCalledWith("ch_general");
    expect(hub.eventBus.emit).toHaveBeenCalledWith({
      type: "channel_archived",
      channelName: "ch_general",
      archived: true,
      archivedAt: "2026-04-02 08:00:00",
    }, null);
  });

  it("POST /channels/:name/messages 会补齐成员书签并把同名 @ 映射到全部匹配成员", async () => {
    fs.mkdirSync(path.join(engine.agentsDir, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(engine.agentsDir, "beta"), { recursive: true });
    fs.writeFileSync(path.join(engine.agentsDir, "alpha", "channels.md"), "# 频道\n\n", "utf-8");

    writeChannel(path.join(channelsDir, "ch_general.md"), [
      "---",
      "id: ch_general",
      "name: General",
      "members: [alpha, beta]",
      "---",
      "",
      "### Alpha | 2026-04-01 11:59:00",
      "",
      "hello",
      "",
      "---",
      "",
    ].join("\n"));

    engine.listAgents = vi.fn(() => [
      { id: "alpha", name: "Hanako" },
      { id: "beta", name: "Hanako" },
      { id: "gamma", name: "Other" },
    ]);

    const res = await app.request("/api/channels/ch_general/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "@Hanako 都在吗" }),
    });

    expect(res.status).toBe(200);
    expect(hub.triggerChannelTriage).toHaveBeenCalledWith("ch_general", {
      mentionedAgents: ["alpha", "beta"],
    });
    expect(fs.readFileSync(path.join(engine.agentsDir, "alpha", "channels.md"), "utf-8")).toContain("- ch_general (last: never)");
    expect(fs.readFileSync(path.join(engine.agentsDir, "beta", "channels.md"), "utf-8")).toContain("- ch_general (last: never)");
  });
});
