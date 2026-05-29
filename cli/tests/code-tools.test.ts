import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { canPromptForDangerousTool, isDangerousClientTool, parseCodeToolRequest, renderCodeIntro, renderCodeTaskHeader, runCode } from "../src/commands/code.js";
import { globToRegExp } from "../src/tools/glob.js";
import { runClientTool } from "../src/tools/registry.js";
import { setLang } from "../src/i18n.js";

let tmp = "";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-tools-"));
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src", "hello.ts"), "export const hello = 'world';\n", "utf8");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("code tools", () => {
  it("reads files inside the workspace", async () => {
    const result = await runClientTool({ cwd: tmp, approval: "ask" }, { name: "read_file", path: "src/hello.ts" });

    expect(result.ok).toBe(true);
    expect(String((result.output as { text: string }).text)).toContain("hello");
  });

  it("blocks path traversal", async () => {
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "read_file", path: "../secret" })).rejects.toThrow("escapes workspace");
  });

  it("blocks symlink escapes for read and write tools", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "nope", "utf8");
    await fs.symlink(outside, path.join(tmp, "linked-out"));

    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "read_file", path: "linked-out/secret.txt" })).rejects.toThrow("escapes workspace");
    await expect(runClientTool({ cwd: tmp, approval: "yolo" }, { name: "write_file", path: "linked-out/new.txt", text: "nope" })).rejects.toThrow("escapes workspace");
  });

  it("greps and globs workspace files", async () => {
    const grep = await runClientTool({ cwd: tmp, approval: "ask" }, { name: "grep", query: "world", path: "src" });
    const glob = await runClientTool({ cwd: tmp, approval: "ask" }, { name: "glob", pattern: "**/*.ts" });

    expect(JSON.stringify(grep.output)).toContain("src/hello.ts");
    expect(JSON.stringify(glob.output)).toContain("src/hello.ts");
    expect(globToRegExp("**/*.ts").test("src/hello.ts")).toBe(true);
  });

  it("requires yolo approval for writes and bash", async () => {
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "write_file", path: "out.txt", text: "x" })).rejects.toThrow("approval yolo");
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "apply_patch", text: "diff --git a/x b/x\n" })).rejects.toThrow("approval yolo");
    await expect(runClientTool({ cwd: tmp, approval: "ask" }, { name: "bash", command: "pwd" })).rejects.toThrow("approval yolo");
  });

  it("blocks dangerous tools in read-only sandbox even with yolo approval", async () => {
    await expect(runClientTool({ cwd: tmp, approval: "yolo", sandbox: "read-only" }, { name: "write_file", path: "out.txt", text: "x" })).rejects.toThrow("read-only sandbox");
    await expect(runClientTool({ cwd: tmp, approval: "yolo", sandbox: "read-only" }, { name: "apply_patch", text: "diff --git a/x b/x\n" })).rejects.toThrow("read-only sandbox");
    await expect(runClientTool({ cwd: tmp, approval: "yolo", sandbox: "read-only" }, { name: "bash", command: "pwd" })).rejects.toThrow("read-only sandbox");
  });

  it("knows which client tools need confirmation", () => {
    expect(isDangerousClientTool("read_file")).toBe(false);
    expect(isDangerousClientTool("grep")).toBe(false);
    expect(isDangerousClientTool("write_file")).toBe(true);
    expect(isDangerousClientTool("apply_patch")).toBe(true);
    expect(isDangerousClientTool("bash")).toBe(true);
    expect(canPromptForDangerousTool({ isTTY: true }, { isTTY: true }, false)).toBe(true);
    expect(canPromptForDangerousTool({ isTTY: true }, { isTTY: true }, true)).toBe(false);
    expect(canPromptForDangerousTool({ isTTY: false }, { isTTY: true }, false)).toBe(false);
  });

  it("parses model-requested tool JSON", () => {
    expect(parseCodeToolRequest('{"tool":"grep","args":{"query":"TODO","path":"src"}}')).toMatchObject({
      tool: "grep",
      args: { query: "TODO", path: "src" },
    });
    expect(parseCodeToolRequest('```json\n{"tool":"apply_patch","args":{"patch":"diff"}}\n```')).toMatchObject({
      tool: "apply_patch",
      args: { text: "diff" },
    });
    expect(parseCodeToolRequest("Here is a normal answer.")).toBeNull();
  });

  it("parses common OpenAI-style and top-level tool JSON variants", () => {
    expect(parseCodeToolRequest('{"name":"grep","arguments":{"query":"MiMo"}}')).toMatchObject({
      tool: "grep",
      args: { query: "MiMo" },
    });
    expect(parseCodeToolRequest('{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}')).toMatchObject({
      tool: "read_file",
      args: { path: "README.md" },
    });
    expect(parseCodeToolRequest('{"tool":"bash","command":"pwd"}')).toMatchObject({
      tool: "bash",
      args: { command: "pwd" },
    });
  });

  it("times out long-running bash commands", async () => {
    const result = await runClientTool({ cwd: tmp, approval: "yolo", timeoutMs: 50 }, { name: "bash", command: "node -e \"setTimeout(()=>{}, 1000)\"" });

    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({ timedOut: true });
  });

  it("applies a git patch inside the workspace", async () => {
    const patch = [
      "diff --git a/src/hello.ts b/src/hello.ts",
      "index 5f836d9..eafb5d8 100644",
      "--- a/src/hello.ts",
      "+++ b/src/hello.ts",
      "@@ -1 +1 @@",
      "-export const hello = 'world';",
      "+export const hello = 'lynn';",
      "",
    ].join("\n");

    const result = await runClientTool({ cwd: tmp, approval: "yolo" }, { name: "apply_patch", text: patch });
    const text = await fs.readFile(path.join(tmp, "src", "hello.ts"), "utf8");

    expect(result.ok).toBe(true);
    expect(text).toContain("lynn");
  });

  it("parses CLI timeout flags for bash tools", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "--tool",
        "bash",
        "--command",
        "node -e \"setTimeout(()=>{}, 1000)\"",
        "--approval",
        "yolo",
        "--timeout-ms",
        "50",
        "--json",
      ]))).resolves.toBe(1);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("\"timedOut\":true");
  });

  it("uses saved CLI permission profile for direct code tools", async () => {
    await fs.mkdir(path.join(tmp, "permissions"), { recursive: true });
    await fs.writeFile(path.join(tmp, "permissions", "cli.json"), JSON.stringify({
      approval: "yolo",
      sandbox: "danger-full-access",
    }));

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "--tool",
        "write_file",
        "--path",
        "out.txt",
        "--text",
        "profile ok",
        "--cwd",
        tmp,
        "--data-dir",
        tmp,
        "--json",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    await expect(fs.readFile(path.join(tmp, "out.txt"), "utf8")).resolves.toBe("profile ok");
    expect(output).toContain("\"ok\":true");
  });

  it("runs code command list-tools", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs(["code", "--list-tools", "--json"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("code.tools");
  });

  it("renders an interactive code-mode intro with MiMo route and permission mode", () => {
    const intro = renderCodeIntro({ approval: "ask", sandbox: "workspace-write" });

    expect(intro).toContain("Lynn Code");
    expect(intro).toContain("MiMo");
    expect(intro).toContain("directory:");
    expect(intro).toContain("/fast");
    expect(intro).toContain("/think");
    expect(intro).toContain("/mode yolo");
    expect(intro).not.toContain(">_");
  });

  it("renders a clear danger warning for YOLO mode", () => {
    const intro = renderCodeIntro({ approval: "yolo", sandbox: "danger-full-access" });

    expect(intro).toContain("YOLO mode can edit files");
    expect(intro).toContain("!!");
  });

  it("renders a code task header with route, cwd, mode, reasoning, and step budget", () => {
    const header = renderCodeTaskHeader({
      cwd: "/repo",
      approval: "ask",
      sandbox: "workspace-write",
      reasoning: { effort: "auto", display: "auto" },
      maxSteps: 8,
    });

    expect(header).toContain("MiMo via local Brain router");
    expect(header).toContain("/repo");
    expect(header).toContain("ask / workspace-write");
    expect(header).toContain("think:");
    expect(header).toContain("auto");
    expect(header).toContain("max steps 8");
  });

  it("runs a read-only code task with repository context", async () => {
    const original = process.stdout.write;
    const originalErr = process.stderr.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(runCode(parseArgs(["code", "review current diff", "--cwd", tmp, "--mock-brain"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }
    expect(output).toContain("Mock code task: review current diff");
    expect(output).toContain("Directory:");
  });
});
