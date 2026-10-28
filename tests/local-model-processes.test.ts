import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ stdout: "", error: null as Error | null, calls: [] as unknown[][] }));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    probe.calls.push(args.slice(0, -1));
    const callback = args.at(-1) as (error: Error | null, result: { stdout: string }) => void;
    callback(probe.error, { stdout: probe.stdout });
  },
}));
const { localListenerPids, localLlamaProcesses } = await import("../server/local-model-processes.js");

beforeEach(() => { probe.stdout = ""; probe.error = null; probe.calls = []; });

describe("local model native process probes", () => {
  it("never invokes PATH ps/lsof on Windows and hides every repeated query", async () => {
    for (let iteration = 0; iteration < 13; iteration += 1) {
      probe.stdout = '123\t"C:\\模型\\llama-server.exe" --port 8081';
      expect(await localLlamaProcesses("win32")).toHaveLength(1);
      probe.stdout = " TCP 127.0.0.1:8081 0.0.0.0:0 LISTENING 123\r\n TCP [::]:8081 [::]:0 LISTENING 123\r\n TCP 127.0.0.1:18081 0.0.0.0:0 LISTENING 456\r\n";
      expect(await localListenerPids("8081", "win32")).toEqual([123]);
    }
    expect(probe.calls).toHaveLength(26);
    for (const [executable, , options] of probe.calls) {
      expect(executable).toMatch(/^[A-Z]:\\.*\\System32\\(?:netstat\.exe|WindowsPowerShell\\v1\.0\\powershell\.exe)$/i);
      expect(options).toMatchObject({ windowsHide: true, timeout: String(executable).endsWith("netstat.exe") ? 2000 : 15000 });
    }
    expect(probe.calls[0][1]).toContain("-NonInteractive");
    expect(probe.calls[0][1]).toContain("-EncodedCommand");
  });
  it("parses empty, multiple and inaccessible Windows command lines", async () => {
    expect(await localLlamaProcesses("win32")).toEqual([]);
    probe.stdout = '7\tllama-server.exe --port=8081\n8\t\n-1\tbad';
    expect(await localLlamaProcesses("win32")).toEqual([{ pid: 7, command: "llama-server.exe --port=8081" }]);
    probe.stdout = "invalid JSON";
    expect(await localLlamaProcesses("win32")).toEqual([]);
  });
  it("retains POSIX behavior and validates port input before execution", async () => {
    probe.stdout = " 12 /usr/bin/llama-server --port 8081\n 13 unrelated\n";
    expect(await localLlamaProcesses("darwin")).toEqual([{ pid: 12, command: "/usr/bin/llama-server --port 8081" }]);
    expect(probe.calls[0][0]).toBe("ps");
    probe.calls = [];
    expect(await localListenerPids("8081;echo bad", "win32")).toEqual([]);
    expect(probe.calls).toEqual([]);
    probe.error = new Error("access denied");
    expect(await localLlamaProcesses("win32")).toEqual([]);
  });
});
