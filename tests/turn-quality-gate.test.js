import { describe, expect, it } from "vitest";

import {
  __turnQualityRulesForTest,
  createTurnQualitySnapshot,
  evaluateForcedTurnFallback,
  evaluatePostTurnEndQuality,
  evaluatePreTurnEndQuality,
} from "../server/chat/turn-quality-gate.js";

describe("turn quality gate", () => {
  it("declares explicit, non-overlapping rule priorities in evaluation order", () => {
    const seen = new Set();
    let previous = -Infinity;

    for (const rule of __turnQualityRulesForTest) {
      expect(rule.name).toBeTruthy();
      expect(seen.has(rule.name)).toBe(false);
      seen.add(rule.name);
      expect(Number.isFinite(rule.priority)).toBe(true);
      expect(rule.priority).toBeGreaterThan(previous);
      previous = rule.priority;
    }
  });

  it("emits a fallback for inactive/background empty turns instead of relying on retry", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: false,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "chat",
      originalPromptText: "随便答一句",
      effectivePromptText: "随便答一句",
      internalRetryCounts: {},
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: false, sessionPath: "/sessions/bg.jsonl" });

    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("本轮模型没有生成可见答案");
  });

  it("summarizes successful tools when the model produced no final answer", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: true,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "files",
      lastSuccessfulTools: [{ name: "bash", command: "mkdir -p 表格 && mv *.xlsx 表格/" }],
      originalPromptText: "把 Excel 移到表格文件夹",
      effectivePromptText: "把 Excel 移到表格文件夹",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: false, sessionPath: "/sessions/bg.jsonl" });

    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("已完成本轮本地操作");
    expect(decision.text).toContain("mkdir -p");
  });

  it("continues local mutation tasks before summarizing a partial mkdir as success", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: true,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "files",
      internalRetryCounts: {},
      lastSuccessfulTools: [{ name: "bash", command: "mkdir -p /Users/lynn/Desktop/Claude" }],
      originalPromptText: "把我桌面的HTML移动到桌面Claude文件夹",
      effectivePromptText: "把我桌面的HTML移动到桌面Claude文件夹",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: true, sessionPath: "/sessions/current.jsonl" });

    expect(snapshot.shouldRetryLocalMutationContinuation).toBe(true);
    expect(decision).toMatchObject({ type: "retry", reason: "tool_continuation" });
    expect(decision.prompt).toContain("现在必须继续调用真实工具完成变更");
  });

  it("marks successful tool turns with only a lead-in for final-answer retry", () => {
    const ss = {
      hasOutput: true,
      hasToolCall: true,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "coding",
      internalRetryCounts: {},
      lastSuccessfulTools: [
        { name: "bash", command: "sed -n '1,120p' main.py", outputPreview: "from nodes import NODE_CLASS_MAPPINGS" },
        { name: "bash", command: "sed -n '1,80p' custom_nodes/foo.py", outputPreview: "class Foo:" },
      ],
      originalPromptText: "ComfyUI main.py ImportError，请帮我修",
      effectivePromptText: "ComfyUI main.py ImportError，请帮我修",
    };
    const visible = "先看一下出问题的两个文件。";
    const snapshot = createTurnQualitySnapshot(ss, visible);
    const decision = evaluatePreTurnEndQuality(ss, snapshot, {
      isActive: true,
      sessionPath: "/sessions/current.jsonl",
      visibleTextBeforeReset: visible,
    });

    expect(snapshot.isToolSuccessLeadInOnly).toBe(true);
    expect(snapshot.shouldRetryToolFinalize).toBe(true);
    expect(decision).toMatchObject({ type: "mark", flag: "toolFinalizationRetryAttempted" });
  });

  it("asks coding tool-finalization retries to include a verification command", () => {
    const ss = {
      hasOutput: true,
      hasToolCall: true,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "coding",
      internalRetryCounts: {},
      lastSuccessfulTools: [
        { name: "bash", command: "sed -n '1,120p' main.py", outputPreview: "from nodes import NODE_CLASS_MAPPINGS" },
      ],
      originalPromptText: "我跑 ComfyUI 的 main.py 报 ImportError，请帮我修",
      effectivePromptText: "我跑 ComfyUI 的 main.py 报 ImportError，请帮我修",
    };
    const visible = "这个报错很明确。先定位你的 ComfyUI 目录，看看相关文件：";
    const snapshot = createTurnQualitySnapshot(ss, visible);
    const decision = evaluatePostTurnEndQuality(ss, snapshot, {
      sessionPath: "/sessions/current.jsonl",
      visibleTextBeforeReset: visible,
    });

    expect(snapshot.isToolSuccessLeadInOnly).toBe(true);
    expect(decision).toMatchObject({ type: "retry", reason: "tool_finalization" });
    expect(decision.prompt).toContain("python main.py");
    expect(decision.prompt).toContain("请运行验证");
    expect(decision.prompt).toContain("不要说“已修复”");
  });

  it("emits a coding diagnostic fallback when tool failure ends the turn", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: true,
      hasThinking: true,
      hasError: true,
      hasFailedTool: true,
      routeIntent: "coding",
      lastFailedTools: ["bash"],
      internalRetryCounts: {},
      originalPromptText: "我跑 ComfyUI 的 main.py 报 ImportError: cannot import name 'FooNode'，请帮我修",
      effectivePromptText: "我跑 ComfyUI 的 main.py 报 ImportError: cannot import name 'FooNode'，请帮我修",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluateForcedTurnFallback(ss, snapshot, {
      sessionPath: "/sessions/current.jsonl",
    });

    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("FooNode");
    expect(decision.text).toContain("python main.py");
    expect(decision.text).toContain("请运行验证");
    expect(decision.text).not.toContain("已修复");
  });

  it("appends a verification command to coding diagnostics that stop before the verify step", () => {
    const ss = {
      hasOutput: true,
      hasToolCall: false,
      hasThinking: true,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "coding",
      internalRetryCounts: {},
      originalPromptText: "我跑 ComfyUI 的 main.py 报 ImportError: cannot import name 'FooNode'，请帮我修",
      effectivePromptText: "我跑 ComfyUI 的 main.py 报 ImportError: cannot import name 'FooNode'，请帮我修",
    };
    const visible = [
      "这个报错很明确：nodes.py 第 5 行试图从 custom_nodes.foo 导入 FooNode，但那个模块里没有这个名字。",
      "诊断两个可能：foo.py 不存在，或者 foo.py 存在但类名不是 FooNode。",
      "修复步骤：先确认文件是否存在，然后对齐类名或删除错误导入。",
    ].join("\n");
    const snapshot = createTurnQualitySnapshot(ss, visible);
    const decision = evaluatePreTurnEndQuality(ss, snapshot, {
      isActive: true,
      sessionPath: "/sessions/current.jsonl",
      visibleTextBeforeReset: visible,
    });

    expect(snapshot.isCodingDiagnosticMissingVerification).toBe(true);
    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("python main.py");
    expect(decision.text).toContain("请运行验证");
    expect(decision.text).not.toContain("已修复");
  });

  it("retries local mutation tasks that produced prose without any real tool call", () => {
    const ss = {
      hasOutput: true,
      hasToolCall: false,
      hasThinking: false,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "files",
      internalRetryCounts: {},
      lastSuccessfulTools: [],
      originalPromptText: "把我桌面的HTML移动到桌面Claude文件夹",
      effectivePromptText: "把我桌面的HTML移动到桌面Claude文件夹",
    };
    const visible = "根据搜索结果，Claude AI 可以通过 Anthropic 的官方网站获取。";
    const snapshot = createTurnQualitySnapshot(ss, visible);
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: true, sessionPath: "/sessions/current.jsonl", visibleTextBeforeReset: visible });

    expect(snapshot.shouldRetryLocalMutationWithoutTool).toBe(true);
    expect(decision).toMatchObject({ type: "retry", reason: "local_mutation_no_tool" });
    expect(decision.prompt).toContain("上一段可见文本");
  });

  it("does not expose internal fallback kind labels in flow fallback", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: false,
      hasThinking: true,
      hasError: false,
      hasFailedTool: false,
      routeIntent: "chat",
      originalPromptText: "时间",
      effectivePromptText: "时间",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluatePreTurnEndQuality(ss, snapshot, { isActive: false, sessionPath: "/sessions/bg.jsonl" });

    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).not.toContain("thinking_only");
    expect(decision.text).toContain("流程提前结束");
  });

  it("forces a failed-tool fallback when a stream is closed by a watchdog", () => {
    const ss = {
      hasOutput: false,
      hasToolCall: true,
      hasThinking: false,
      hasError: false,
      hasFailedTool: true,
      routeIntent: "news",
      lastFailedTools: ["live_news"],
      originalPromptText: "今天科技新闻",
      effectivePromptText: "今天科技新闻",
    };
    const snapshot = createTurnQualitySnapshot(ss, "");
    const decision = evaluateForcedTurnFallback(ss, snapshot, { sessionPath: "/sessions/bg.jsonl" });

    // evaluateForcedTurnFallback 不在 brain v1 nuke 范围内(watchdog forced fallback 仍 active)
    expect(decision).toMatchObject({ type: "fallback" });
    expect(decision.text).toContain("工具调用失败");
    expect(decision.text).toContain("live_news");
  });
});
