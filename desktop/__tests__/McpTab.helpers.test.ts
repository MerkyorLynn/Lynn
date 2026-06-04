import { describe, expect, it } from "vitest";
import {
  argsFromText,
  headersFromText,
  buildPayload,
  draftFromServer,
  emptyDraft,
  BUILTIN_FALLBACKS,
  PRESETS,
} from "../src/react/settings/tabs/McpTab.helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("argsFromText", () => {
  it("splits on newlines and commas, trims, drops empties", () => {
    expect(argsFromText("a\nb,c\n\n  d ")).toEqual(["a", "b", "c", "d"]);
    expect(argsFromText("")).toEqual([]);
  });
});

describe("headersFromText", () => {
  it("parses JSON object headers", () => {
    expect(headersFromText('{"X-Key":"1","Y":2}')).toEqual({ "X-Key": "1", Y: "2" });
  });
  it("parses colon-delimited line headers", () => {
    expect(headersFromText("Authorization: Bearer t\nX: y")).toEqual({ Authorization: "Bearer t", X: "y" });
  });
  it("returns {} for empty input", () => {
    expect(headersFromText("   ")).toEqual({});
  });
});

describe("buildPayload", () => {
  it("builds an stdio payload (command/args/cwd)", () => {
    const draft = emptyDraft() as any;
    draft.transport = "stdio"; draft.command = " cmd "; draft.argsText = "a\nb"; draft.cwd = " /c "; draft.disabled = true;
    expect(buildPayload(draft)).toEqual({ command: "cmd", args: ["a", "b"], cwd: "/c", disabled: true });
  });
  it("builds an sse payload (url/headers/messageUrl)", () => {
    const draft = emptyDraft() as any;
    draft.transport = "sse"; draft.url = " http://x "; draft.headersText = '{"A":"1"}'; draft.messageUrl = " http://m "; draft.disabled = false;
    expect(buildPayload(draft)).toEqual({ transport: "sse", url: "http://x", headers: { A: "1" }, messageUrl: "http://m", disabled: false });
  });
});

describe("draftFromServer", () => {
  it("null server yields an empty draft (name='')", () => {
    expect(draftFromServer(null).name).toBe("");
  });
  it("maps a server into an editable draft", () => {
    const d = draftFromServer({ name: "s", transport: "stdio", command: "c", args: ["a", "b"], cwd: "/w", disabled: true } as any);
    expect(d.name).toBe("s");
    expect(d.command).toBe("c");
    expect(d.argsText).toBe("a\nb");
    expect(d.disabled).toBe(true);
  });
});

describe("constants", () => {
  it("BUILTIN_FALLBACKS + PRESETS are non-empty", () => {
    expect(Array.isArray(BUILTIN_FALLBACKS)).toBe(true);
    expect(BUILTIN_FALLBACKS.length).toBeGreaterThan(0);
    expect(PRESETS.length).toBeGreaterThan(0);
    // each preset builds a draft
    for (const p of PRESETS) expect(typeof p.build()).toBe("object");
  });
});
