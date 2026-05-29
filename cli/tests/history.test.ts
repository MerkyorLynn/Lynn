import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryNavigator, appendHistory, loadHistory } from "../src/history.js";

const file = path.join(os.tmpdir(), "lynn-cli-history.test");
afterEach(() => {
  try {
    fs.rmSync(file);
  } catch {
    /* ignore */
  }
});

describe("history persistence", () => {
  it("appends, loads, and skips consecutive duplicates", () => {
    appendHistory("a", file);
    appendHistory("b", file);
    appendHistory("b", file); // consecutive dupe ignored
    appendHistory("c", file);
    expect(loadHistory(file)).toEqual(["a", "b", "c"]);
  });

  it("ignores blank entries", () => {
    appendHistory("   ", file);
    expect(loadHistory(file)).toEqual([]);
  });

  it("caps to max, keeping the most recent", () => {
    for (let i = 0; i < 10; i += 1) appendHistory(`line${i}`, file, 3);
    expect(loadHistory(file, 3)).toEqual(["line7", "line8", "line9"]);
  });
});

describe("HistoryNavigator", () => {
  it("walks older with prev and newer with next, clamped at the ends", () => {
    const nav = new HistoryNavigator(["one", "two", "three"]);
    expect(nav.prev("draft")).toBe("three");
    expect(nav.prev("draft")).toBe("two");
    expect(nav.prev("draft")).toBe("one");
    expect(nav.prev("draft")).toBe("one"); // clamped at oldest
    expect(nav.next()).toBe("two");
    expect(nav.next()).toBe("three");
    expect(nav.next()).toBe(""); // past newest -> empty draft line
  });

  it("returns the current draft when there is no history", () => {
    const nav = new HistoryNavigator([]);
    expect(nav.prev("draft")).toBe("draft");
    expect(nav.next()).toBe("");
  });
});
