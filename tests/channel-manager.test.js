/**
 * ChannelManager 单元测试
 *
 * 测试频道 CRUD、成员管理、新 agent 频道初始化，以及频道专家生命周期绑定。
 * 使用临时目录模拟文件系统操作。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock debug-log to prevent file I/O
import { vi } from "vitest";
vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({
    log: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { ChannelManager } from "../core/channel-manager.js";

// ── Helpers ──

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channel-test-"));
}

function writeChannelMd(channelsDir, name, members, intro = "") {
  const lines = ["---"];
  lines.push(`members: [${members.join(", ")}]`);
  if (intro) lines.push(`intro: "${intro}"`);
  lines.push("---", "");
  fs.writeFileSync(path.join(channelsDir, `${name}.md`), lines.join("\n"), "utf-8");
}

function readMembers(channelsDir, name) {
  const content = fs.readFileSync(path.join(channelsDir, `${name}.md`), "utf-8");
  const match = content.match(/members:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return match[1].split(",").map(s => s.trim()).filter(Boolean);
}

function writeAgent(agentsDir, agentId, extraYaml = "") {
  const agentDir = path.join(agentsDir, agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "config.yaml"),
    [
      "agent:",
      `  name: ${agentId}`,
      "  yuan: hanako",
      extraYaml.trim() ? extraYaml.trimEnd() : "",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(agentDir, "channels.md"), "", "utf-8");
  return agentDir;
}

function readConfig(agentsDir, agentId) {
  return fs.readFileSync(path.join(agentsDir, agentId, "config.yaml"), "utf-8");
}

function makeManager({ channelsDir, agentsDir, userDir, deleteAgent } = {}) {
  return new ChannelManager({
    channelsDir,
    agentsDir,
    userDir,
    getHub: () => null,
    deleteAgent,
  });
}

// ── Tests ──

describe("ChannelManager", () => {
  let tmpDir, channelsDir, agentsDir, userDir, manager;

  beforeEach(() => {
    tmpDir = mktemp();
    channelsDir = path.join(tmpDir, "channels");
    agentsDir = path.join(tmpDir, "agents");
    userDir = path.join(tmpDir, "user");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    manager = makeManager({ channelsDir, agentsDir, userDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createChannel", () => {
    it("marks spawned experts with channel ownership", () => {
      writeAgent(agentsDir, "lynn");
      writeAgent(agentsDir, "expert-a", "expert:\n  slug: financial-analyst");

      const channelId = manager.createChannel({
        name: "Planning",
        members: ["lynn", "expert-a"],
        intro: "test intro",
        spawnedExpertIds: ["expert-a"],
      });

      expect(fs.existsSync(path.join(channelsDir, `${channelId}.md`))).toBe(true);
      expect(readConfig(agentsDir, "expert-a")).toContain(`spawnedForChannel: ${channelId}`);
    });
  });

  describe("deleteChannelByName", () => {
    it("deletes channel file", async () => {
      writeChannelMd(channelsDir, "test-ch", ["a", "b"]);
      expect(fs.existsSync(path.join(channelsDir, "test-ch.md"))).toBe(true);

      await manager.deleteChannelByName("test-ch");
      expect(fs.existsSync(path.join(channelsDir, "test-ch.md"))).toBe(false);
    });

    it("throws on non-existent channel", async () => {
      await expect(manager.deleteChannelByName("nope")).rejects.toThrow("error.channelNotFoundById");
    });

    it("cleans up agent bookmark references", async () => {
      writeChannelMd(channelsDir, "general", ["agent-a"]);
      writeAgent(agentsDir, "agent-a");
      fs.writeFileSync(path.join(agentsDir, "agent-a", "channels.md"), "# 频道\n\n- general (last: never)\n", "utf-8");
      fs.writeFileSync(path.join(userDir, "channel-bookmarks.md"), "# 频道\n\n- general (last: never)\n", "utf-8");

      await manager.deleteChannelByName("general");

      expect(fs.existsSync(path.join(channelsDir, "general.md"))).toBe(false);
      expect(fs.readFileSync(path.join(agentsDir, "agent-a", "channels.md"), "utf-8")).not.toContain("general");
      expect(fs.readFileSync(path.join(userDir, "channel-bookmarks.md"), "utf-8")).not.toContain("general");
    });

    it("cascade deletes experts spawned for the deleted channel", async () => {
      writeChannelMd(channelsDir, "strategy", ["lynn", "expert-a", "expert-b"]);
      writeAgent(agentsDir, "lynn");
      writeAgent(agentsDir, "expert-a", "expert:\n  slug: financial-analyst\n  spawnedForChannel: strategy");
      writeAgent(agentsDir, "expert-b", "expert:\n  slug: psychologist");

      const deletedAgents = [];
      const managerWithDelete = makeManager({
        channelsDir,
        agentsDir,
        userDir,
        deleteAgent: async (agentId) => {
          deletedAgents.push(agentId);
          fs.rmSync(path.join(agentsDir, agentId), { recursive: true, force: true });
        },
      });

      const result = await managerWithDelete.deleteChannelByName("strategy");

      expect(result.deletedAgentIds).toEqual(["expert-a"]);
      expect(result.failedAgentIds).toEqual([]);
      expect(deletedAgents).toEqual(["expert-a"]);
      expect(fs.existsSync(path.join(agentsDir, "expert-a"))).toBe(false);
      expect(fs.existsSync(path.join(agentsDir, "expert-b"))).toBe(true);
    });
  });

  describe("setupChannelsForNewAgent", () => {
    it("creates ch_crew channel if not exists", () => {
      writeAgent(agentsDir, "new-agent");

      manager.setupChannelsForNewAgent("new-agent");

      expect(fs.existsSync(path.join(channelsDir, "ch_crew.md"))).toBe(true);
      const members = readMembers(channelsDir, "ch_crew");
      expect(members).toContain("new-agent");
    });

    it("adds to existing ch_crew channel", () => {
      writeChannelMd(channelsDir, "ch_crew", ["existing-agent"]);
      writeAgent(agentsDir, "new-agent");

      manager.setupChannelsForNewAgent("new-agent");

      const members = readMembers(channelsDir, "ch_crew");
      expect(members).toContain("existing-agent");
      expect(members).toContain("new-agent");
    });

    it("does NOT create DM channels (DM is separate system now)", () => {
      writeAgent(agentsDir, "alice");
      writeAgent(agentsDir, "bob");

      manager.setupChannelsForNewAgent("bob");

      const files = fs.readdirSync(channelsDir);
      const dmFiles = files.filter(f => !f.startsWith("ch_"));
      expect(dmFiles).toHaveLength(0);
    });

    it("writes channels.md for new agent with ch_crew", () => {
      writeAgent(agentsDir, "new-agent");

      manager.setupChannelsForNewAgent("new-agent");

      const channelsMd = fs.readFileSync(path.join(agentsDir, "new-agent", "channels.md"), "utf-8");
      expect(channelsMd).toContain("ch_crew");
    });
  });

  describe("cleanupAgentFromChannels", () => {
    it("removes agent from channel members", () => {
      writeChannelMd(channelsDir, "crew", ["alice", "bob", "charlie"]);

      manager.cleanupAgentFromChannels("bob");

      const members = readMembers(channelsDir, "crew");
      expect(members).toContain("alice");
      expect(members).toContain("charlie");
      expect(members).not.toContain("bob");
    });

    it("deletes channel when members drop to 1 or fewer", () => {
      writeChannelMd(channelsDir, "alice-bob", ["alice", "bob"]);

      manager.cleanupAgentFromChannels("bob");

      expect(fs.existsSync(path.join(channelsDir, "alice-bob.md"))).toBe(false);
    });

    it("no-ops when channelsDir does not exist", () => {
      const badManager = makeManager({
        channelsDir: "/nonexistent",
        agentsDir,
        userDir,
      });

      expect(() => badManager.cleanupAgentFromChannels("x")).not.toThrow();
    });
  });

  describe("listOrphanedChannelExperts", () => {
    it("finds experts whose bound channel no longer exists", () => {
      writeAgent(agentsDir, "expert-a", "expert:\n  spawnedForChannel: ch_missing");
      writeAgent(agentsDir, "expert-b", "expert:\n  spawnedForChannel: ch_live");
      writeChannelMd(channelsDir, "ch_live", ["expert-b"]);

      expect(manager.listOrphanedChannelExperts()).toEqual(["expert-a"]);
    });

    it("treats experts missing from their bound channel members as orphaned", () => {
      writeAgent(agentsDir, "expert-a", "expert:\n  spawnedForChannel: ch_live");
      writeChannelMd(channelsDir, "ch_live", ["lynn"]);

      expect(manager.listOrphanedChannelExperts()).toEqual(["expert-a"]);
    });
  });
});
