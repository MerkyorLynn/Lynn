import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { classifyTaskRoute, codeArgsForRoute, visionArgsForRoute } from "../src/task-classifier.js";

describe("task classifier", () => {
  it("routes explicit goal commands into long-running code mode", () => {
    const args = parseArgs(["goal", "今晚把 CLI 门禁跑完"]);
    const route = classifyTaskRoute(args);
    const routed = codeArgsForRoute(args, route);

    expect(route).toMatchObject({ kind: "goal" });
    expect(routed.command).toBe("code");
    expect(routed.positionals).toEqual(["今晚把 CLI 门禁跑完"]);
    expect(routed.flags).toMatchObject({
      long: true,
      "save-session": true,
      "max-steps": "300",
    });
  });

  it("detects coding tasks from natural language", () => {
    expect(classifyTaskRoute(parseArgs(["修复", "cli/src/ink-input-line.ts", "输入法错行"]))).toMatchObject({
      kind: "code",
    });
    expect(classifyTaskRoute(parseArgs(["review", "the current diff"]))).toMatchObject({
      kind: "code",
    });
  });

  it("detects long-running goal language even without the goal command", () => {
    const args = parseArgs(["今晚连续工作直到完成 CLI"]);
    const route = classifyTaskRoute(args);
    expect(route.kind).toBe("goal");
    expect(codeArgsForRoute(args, route).flags["max-steps"]).toBe("300");
  });

  it("routes image paths and image flags to vision", () => {
    const imagePositional = parseArgs(["screenshot.png", "这个按钮在哪里"]);
    expect(classifyTaskRoute(imagePositional)).toMatchObject({ kind: "vision" });
    expect(visionArgsForRoute(imagePositional)).toMatchObject({
      command: "see",
      positionals: ["screenshot.png", "这个按钮在哪里"],
    });

    expect(classifyTaskRoute(parseArgs(["hello", "--image", "screen.png"]))).toMatchObject({ kind: "vision" });
  });

  it("keeps ordinary chat prompts on the prompt route", () => {
    expect(classifyTaskRoute(parseArgs(["今天天气怎么样"]))).toMatchObject({
      kind: "prompt",
    });
  });
});
