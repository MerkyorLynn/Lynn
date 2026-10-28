import { describe, expect, it } from "vitest";
import {
  localQwenListenerInvocation,
  localQwenProcessListInvocation,
  parseProcessCommandLines,
  parseWindowsListenerPids,
  selectQwen35ProcessPids,
} from "../server/routes/local-qwen35.js";

const MODEL_PATH = "C:\\Users\\me\\.lynn\\models\\Q4_LynnStyle\\Q4-imatrix-MTP-00001-of-00004.gguf";

describe("local qwen35 process listing", () => {
  it("matches complete numeric port arguments, not prefixes or unrelated URLs", () => {
    const rows = [
      { pid: 11, command: "llama-server --port 18099 -m other.gguf" },
      { pid: 12, command: "llama-server --port=1809 -m other.gguf" },
      { pid: 13, command: 'llama-server --port "1809" -m other.gguf' },
      { pid: 14, command: "llama-server --url http://localhost:1809" },
    ];
    expect(selectQwen35ProcessPids(rows, "1809", [])).toEqual([12, 13]);
    expect(selectQwen35ProcessPids(rows, "1809.*", [])).toEqual([]);
  });
  it("keeps the Unix ps command and does not use it on Windows", () => {
    expect(localQwenProcessListInvocation("linux")).toMatchObject({
      file: "ps",
      args: ["-axo", "pid=,command="],
      options: { windowsHide: true, timeout: 2_000 },
    });
    expect(localQwenProcessListInvocation("darwin").file).toBe("ps");
    expect(localQwenProcessListInvocation("darwin").args).toEqual(["-axo", "pid=,command="]);

    const windows = localQwenProcessListInvocation("win32");
    expect(windows.file.replaceAll("/", "\\").toLowerCase()).toMatch(
      /system32\\windowspowershell\\v1\.0\\powershell\.exe$/,
    );
    expect(windows.file.toLowerCase()).not.toContain("anaconda");
    expect(windows.args).not.toContain("ps");
    expect(windows.args.join(" ")).not.toMatch(/(^|\s)ps(\s|$)/);
    expect(windows.options.windowsHide).toBe(true);
    expect(windows.options.timeout).toBe(15000);
    expect(windows.options.stdio).toEqual(["ignore", "pipe", "pipe"]);

    const encoded = windows.args[windows.args.indexOf("-EncodedCommand") + 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("Get-CimInstance");
    expect(script).toContain("Win32_Process");
    expect(script).toContain("llama-server");
    expect(script).not.toContain("ps -axo");
  });

  it("uses System32 netstat for Windows listeners and lsof elsewhere", () => {
    const windows = localQwenListenerInvocation("18099", "win32");
    expect(windows.file.replaceAll("/", "\\").toLowerCase()).toMatch(/system32\\netstat\.exe$/);
    expect(windows.args).toEqual(["-ano", "-p", "TCP"]);
    expect(windows.options.windowsHide).toBe(true);

    expect(localQwenListenerInvocation("18099", "linux")).toMatchObject({
      file: "lsof",
      args: ["-nP", "-iTCP:18099", "-sTCP:LISTEN", "-t"],
    });
    expect(localQwenListenerInvocation("18099", "darwin").file).toBe("lsof");
  });

  it("parses Windows listeners without depending on the localized state word", () => {
    const stdout = [
      "  协议  本地地址          外部地址        状态           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1456",
      "  TCP    127.0.0.1:18099        0.0.0.0:0              侦听            4242",
      "  TCP    [::1]:18099            [::]:0                 LISTENING       4242",
      "  TCP    127.0.0.1:18099        127.0.0.1:51000        ESTABLISHED     9999",
      "  TCP    127.0.0.1:180990       0.0.0.0:0              LISTENING       7777",
      "  UDP    0.0.0.0:18099          *:*                                    8888",
    ].join("\r\n");

    expect(parseWindowsListenerPids(stdout, "18099")).toEqual([4242]);
  });

  it("selects llama-server rows from ps output and Windows command lines", () => {
    const processes = parseProcessCommandLines([
      "  12 /usr/bin/node server.js",
      "  34 /opt/llama/llama-server --port 18099 -m /models/other.gguf",
      "  56 llama-server --port 18100 -m /models/Q4-imatrix-MTP-00001-of-00004.gguf",
      "  78 llama-server --host 127.0.0.1",
      "ps: unknown option -- x",
    ].join("\n"));

    expect(selectQwen35ProcessPids(processes, "18099", [MODEL_PATH])).toEqual([34, 56]);

    const windows = parseProcessCommandLines(
      `4242\t"C:\\llama\\llama-server.exe" --port 18099 -m ${MODEL_PATH}\r\n`,
    );
    expect(selectQwen35ProcessPids(windows, "18099", [MODEL_PATH])).toEqual([4242]);
  });
});
