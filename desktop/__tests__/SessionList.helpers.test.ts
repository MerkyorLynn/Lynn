import { describe, expect, it } from "vitest";
import {
  parseModifiedTime,
  normalizeLegacyWorkspacePath,
  formatWorkspaceTitle,
  groupSessionsByWorkspace,
  formatProviderLabel,
  inferSessionFallbackYuan,
} from "../src/react/components/SessionList.helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sess = (o: Record<string, unknown>) => o as any;

describe("parseModifiedTime", () => {
  it("parses ISO dates, zeroes invalid/empty", () => {
    expect(parseModifiedTime("2026-06-03T00:00:00Z")).toBe(Date.parse("2026-06-03T00:00:00Z"));
    expect(parseModifiedTime("garbage")).toBe(0);
    expect(parseModifiedTime(null)).toBe(0);
  });
});

describe("normalizeLegacyWorkspacePath", () => {
  it("rewrites the legacy openhanako root to Lynn, passes others through", () => {
    expect(normalizeLegacyWorkspacePath("/Users/lynn/openhanako/x")).toBe("/Users/lynn/Lynn/x");
    expect(normalizeLegacyWorkspacePath("/Users/lynn/openhanako")).toBe("/Users/lynn/Lynn");
    expect(normalizeLegacyWorkspacePath("/other/path")).toBe("/other/path");
    expect(normalizeLegacyWorkspacePath("")).toBeNull();
  });
});

describe("formatWorkspaceTitle", () => {
  it("uses the last path segment, falls back when empty", () => {
    expect(formatWorkspaceTitle("/a/b/myproj", "fb")).toBe("myproj");
    expect(formatWorkspaceTitle(null, "fb")).toBe("fb");
  });
});

describe("groupSessionsByWorkspace", () => {
  it("groups by normalized cwd, agent-root first, newest workspace next, pins on top", () => {
    const groups = groupSessionsByWorkspace([
      sess({ id: "1", cwd: "/Users/lynn/Lynn", modified: "2026-06-01T00:00:00Z" }),
      sess({ id: "2", cwd: "/Users/lynn/Lynn", modified: "2026-06-03T00:00:00Z", pinned: true }),
      sess({ id: "3", cwd: null, modified: "2026-06-02T00:00:00Z" }),
      sess({ id: "4", cwd: "/Users/lynn/openhanako", modified: "2026-06-02T00:00:00Z" }),
    ], "Agent");
    // 3 groups: agent-root, /Lynn, /Lynn (legacy folds into same key as #1/#2)
    expect(groups[0].kind).toBe("agent"); // agent-root first
    const lynnGroup = groups.find((g) => g.path === "/Users/lynn/Lynn")!;
    expect(lynnGroup.title).toBe("Lynn");
    expect(lynnGroup.items.map((s) => s.id)).toEqual(["2", "4", "1"]); // pinned #2 first, then newest→oldest (06-02, 06-01)
  });
});

describe("formatProviderLabel / inferSessionFallbackYuan", () => {
  it("title-cases dash/underscore provider ids", () => {
    expect(formatProviderLabel("open-ai")).toBe("Open Ai");
    expect(formatProviderLabel("local_qwen")).toBe("Local Qwen");
    expect(formatProviderLabel(null)).toBe("");
  });
  it("maps agent names to fallback yuan", () => {
    expect(inferSessionFallbackYuan("Hanako")).toBe("hanako");
    expect(inferSessionFallbackYuan("花子")).toBe("hanako");
    expect(inferSessionFallbackYuan("Butter")).toBe("butter");
    expect(inferSessionFallbackYuan("kong")).toBe("kong");
    expect(inferSessionFallbackYuan("whatever")).toBe("lynn");
  });
});
