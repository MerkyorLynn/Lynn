import { describe, expect, it } from "vitest";
import { detectCliAgents } from "../src/agent-registry.js";
import { buildAgentsHeadlessContract } from "../src/commands/agents.js";

describe("agent registry", () => {
  it("marks Lynn CLI as current and detects external binaries on PATH", () => {
    const agents = detectCliAgents({
      pathEnv: "/bin",
      platform: "linux",
      fileExists: (file) => file === "/bin/codex",
    });
    expect(agents.find((agent) => agent.id === "lynn-cli")).toMatchObject({ available: true, availability: "current binary", kind: "built-in" });
    expect(agents.find((agent) => agent.id === "mimo-vl")).toMatchObject({ available: true, availability: "built-in profile - vision", kind: "built-in" });
    expect(agents.find((agent) => agent.id === "stepfun-flash")).toMatchObject({
      available: false,
      availability: "requires: Lynn providers set --preset stepfun --api-key <api-key>",
      kind: "built-in",
      requiresPreset: "stepfun",
    });
    expect(agents.find((agent) => agent.id === "codex-cli")).toMatchObject({ available: true, availability: "/bin/codex", kind: "external" });
    expect(agents.find((agent) => agent.id === "claude-code")).toMatchObject({ available: false, availability: "not found on PATH", kind: "external" });
  });

  it("marks the StepFun worker ready only when the StepFun BYOK preset is configured", () => {
    const agents = detectCliAgents({
      pathEnv: "",
      configuredPreset: "stepfun",
    });

    expect(agents.find((agent) => agent.id === "stepfun-flash")).toMatchObject({
      available: true,
      availability: "built-in profile - BYOK preset stepfun",
      requiresPreset: "stepfun",
    });
  });

  it("exposes copyable headless commands for other agents", () => {
    const contract = buildAgentsHeadlessContract("https://download.example/lynn-cli-0.80.4.tgz");

    expect(contract.node).toContain("Node.js 20");
    expect(contract.install).toBe("npm install -g --force https://download.example/lynn-cli-0.80.4.tgz");
    expect(contract.launch).toContain("Lynn agents");
    expect(contract.headless).toContain('Lynn code -p "fix tests" --json --cwd /repo --approval yolo --sandbox danger-full-access --save-session');
    expect(contract.headless).toContain("Lynn worker run --brief task.md --worktree /repo --jsonl --approval yolo --sandbox danger-full-access");
  });
});
