import { afterEach, describe, expect, it, vi } from "vitest";
import { stdin, stdout } from "node:process";
import { readBoxedInputLine } from "../src/boxed-input.js";
import { HistoryNavigator } from "../src/history.js";

vi.mock("node:process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:process")>();
  const { PassThrough } = await import("node:stream");
  return {
    ...original,
    stdin: Object.assign(new PassThrough(), {
      isTTY: true, isRaw: false, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn(),
    }),
    stdout: Object.assign(new PassThrough(), { isTTY: true, columns: 82, write: vi.fn() }),
  };
});

const commands = ["/ask", "/model", "/mode", "/think", "/help", "/tools", "/exit", "/quit", "/tool"];
const key = (text: string) => stdin.emit("data", Buffer.from(text));

afterEach(() => {
  // Also restore raw mode/listeners if an assertion fails before Enter.
  if (stdin.listenerCount("data")) key("\x03");
  vi.clearAllMocks();
});

describe("boxed slash palette keyboard interaction", () => {
  it("selects with Down and fills the selected command with Tab", async () => {
    const result = readBoxedInputLine({ completions: commands, history: new HistoryNavigator(["old prompt"]) });
    key("/"); key("\x1b[B"); key("\t"); key("\r");
    expect(await result).toBe("/model ");
    expect(vi.mocked(stdout.write).mock.calls.flat().join("")).toContain("› /model");
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("wraps Up to the last visible command and skips hidden aliases", async () => {
    const result = readBoxedInputLine({ completions: commands });
    key("/"); key("\x1b[A"); key("\t"); key("\r");
    expect(await result).toBe("/exit ");
  });

  it("uses Enter to fill an incomplete prefix and a second Enter to submit", async () => {
    const result = readBoxedInputLine({ completions: commands });
    key("/mo"); key("\x1b[B"); key("\r");
    expect(stdin.listenerCount("data")).toBe(1);
    key("\r");
    expect(await result).toBe("/mode ");
  });

  it("submits a complete command immediately", async () => {
    const result = readBoxedInputLine({ completions: commands });
    key("/help"); key("\r");
    expect(await result).toBe("/help");
  });

  it("resets selection after typing filters the command list", async () => {
    const result = readBoxedInputLine({ completions: commands });
    key("/"); key("\x1b[A"); key("mo"); key("\t"); key("\r");
    expect(await result).toBe("/model ");
  });

  it("supports fullwidth slash completion", async () => {
    const result = readBoxedInputLine({ completions: commands });
    key("／he"); key("\t"); key("\r");
    expect(await result).toBe("/help ");
  });

  it("keeps history navigation when the palette is closed", async () => {
    const result = readBoxedInputLine({ completions: commands, history: new HistoryNavigator(["old prompt"]) });
    key("\x1b[A"); key("\r");
    expect(await result).toBe("old prompt");
  });

  it("does not complete arguments or consume a multiline paste as a command", async () => {
    const result = readBoxedInputLine({ completions: commands });
    key("\x1b[200~/model custom\nsecond line\x1b[201~"); key("\t"); key("\r");
    expect(await result).toBe("/model custom\nsecond line");
  });
});
