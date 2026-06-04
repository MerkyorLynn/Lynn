import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runBrowserAction, isBrowserActionCommand, BROWSER_ACTION_COMMANDS } = require("../browser-actions.cjs");

const SNAP = "__SNAPSHOT_SENTINEL__";
const snapResult = { currentUrl: "https://ex.com/p", title: "Title", text: "SNAPSHOT_TEXT" };

function fakeWc() {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    loadURL: async (url: string) => { calls.push(["loadURL", url]); },
    executeJavaScript: async (script: string) => {
      calls.push(["exec", script]);
      return script === SNAP ? snapResult : "EXEC_RESULT";
    },
    capturePage: async () => ({
      toJPEG: (_q: number) => Buffer.from("JPEGDATA"),
      resize: (_o: unknown) => ({ toJPEG: (_q: number) => Buffer.from("THUMBDATA") }),
    }),
    insertText: async (t: string) => { calls.push(["insertText", t]); },
    sendInputEvent: (e: unknown) => { calls.push(["input", e]); },
  };
}

function deps(wc: ReturnType<typeof fakeWc> | null, env: Record<string, string> = {}) {
  return {
    getWebContents: () => wc,
    snapshotScript: SNAP,
    isAllowedBrowserUrl: (url: string) => /^https?:\/\//.test(url),
    delay: async () => {},
    env,
  };
}

describe("browser-actions: registry", () => {
  it("classifies action vs lifecycle commands", () => {
    expect(isBrowserActionCommand("navigate")).toBe(true);
    expect(isBrowserActionCommand("evaluate")).toBe(true);
    expect(isBrowserActionCommand("launch")).toBe(false);
    expect(isBrowserActionCommand("close")).toBe(false);
    expect(BROWSER_ACTION_COMMANDS.size).toBe(11);
  });
});

describe("browser-actions: guards", () => {
  it("navigate rejects non-http(s) URLs before touching the view", async () => {
    await expect(runBrowserAction("navigate", { url: "file:///etc/passwd" }, deps(fakeWc())))
      .rejects.toThrow("Only http/https URLs are allowed");
  });

  it("throws 'Browser not launched' when no view is active", async () => {
    await expect(runBrowserAction("snapshot", {}, deps(null))).rejects.toThrow("Browser not launched");
  });

  it("throws on an unknown command", async () => {
    await expect(runBrowserAction("teleport", {}, deps(fakeWc()))).rejects.toThrow("Unknown browser command: teleport");
  });
});

describe("browser-actions: view actions over a fake webContents", () => {
  it("navigate loads the URL then returns a snapshot", async () => {
    const wc = fakeWc();
    const out = await runBrowserAction("navigate", { url: "https://ex.com" }, deps(wc));
    expect(wc.calls).toContainEqual(["loadURL", "https://ex.com"]);
    expect(out).toEqual({ url: snapResult.currentUrl, title: snapResult.title, snapshot: snapResult.text });
  });

  it("snapshot returns currentUrl + text", async () => {
    const out = await runBrowserAction("snapshot", {}, deps(fakeWc()));
    expect(out).toEqual({ currentUrl: snapResult.currentUrl, text: snapResult.text });
  });

  it("screenshot / thumbnail base64-encode the captured JPEG", async () => {
    const shot = await runBrowserAction("screenshot", {}, deps(fakeWc()));
    expect(shot).toEqual({ base64: Buffer.from("JPEGDATA").toString("base64") });
    const thumb = await runBrowserAction("thumbnail", {}, deps(fakeWc()));
    expect(thumb).toEqual({ base64: Buffer.from("THUMBDATA").toString("base64") });
  });

  it("click targets the data-hana-ref element then snapshots", async () => {
    const wc = fakeWc();
    const out = await runBrowserAction("click", { ref: 7 }, deps(wc));
    const clickScript = wc.calls.find((c) => c[0] === "exec" && String(c[1]).includes("data-hana-ref"));
    expect(String(clickScript?.[1])).toContain('data-hana-ref="7"');
    expect(out).toEqual({ currentUrl: snapResult.currentUrl, text: snapResult.text });
  });

  it("type inserts text and presses Enter when asked", async () => {
    const wc = fakeWc();
    await runBrowserAction("type", { text: "hello", pressEnter: true }, deps(wc));
    expect(wc.calls).toContainEqual(["insertText", "hello"]);
    expect(wc.calls.some((c) => c[0] === "input" && (c[1] as { keyCode: string }).keyCode === "Return")).toBe(true);
  });

  it("pressKey maps Enter→Return and applies modifiers", async () => {
    const wc = fakeWc();
    await runBrowserAction("pressKey", { key: "Ctrl+Enter" }, deps(wc));
    const down = wc.calls.find((c) => c[0] === "input" && (c[1] as { type: string }).type === "keyDown");
    expect((down?.[1] as { keyCode: string }).keyCode).toBe("Return");
    expect((down?.[1] as { modifiers: string[] }).modifiers).toEqual(["ctrl"]);
  });

  it("scroll / select run a page script then snapshot", async () => {
    const sc = await runBrowserAction("scroll", { direction: "down", amount: 2 }, deps(fakeWc()));
    expect(sc).toEqual({ text: snapResult.text });
    const wc = fakeWc();
    await runBrowserAction("select", { ref: 3, value: "opt" }, deps(wc));
    expect(wc.calls.some((c) => c[0] === "exec" && String(c[1]).includes('"opt"'))).toBe(true);
  });
});

describe("browser-actions: evaluate hardening (P1-3)", () => {
  it("rejects expressions over 4000 chars", async () => {
    await expect(runBrowserAction("evaluate", { expression: "x".repeat(4001) }, deps(fakeWc())))
      .rejects.toThrow("Expression too long");
  });

  it("denies sensitive-storage access only when LYNN_BROWSER_EVAL_DENY_SENSITIVE=1", async () => {
    const expr = "document.cookie";
    await expect(runBrowserAction("evaluate", { expression: expr }, deps(fakeWc(), { LYNN_BROWSER_EVAL_DENY_SENSITIVE: "1" })))
      .rejects.toThrow("accesses sensitive storage");
    // default (flag off) → allowed
    const out = await runBrowserAction("evaluate", { expression: expr }, deps(fakeWc(), {}));
    expect(out).toEqual({ value: "EXEC_RESULT" });
  });

  it("serializes a non-string result as pretty JSON", async () => {
    const wc = fakeWc();
    wc.executeJavaScript = async () => ({ a: 1 });
    const out = await runBrowserAction("evaluate", { expression: "({a:1})" }, deps(wc));
    expect(out).toEqual({ value: JSON.stringify({ a: 1 }, null, 2) });
  });
});
