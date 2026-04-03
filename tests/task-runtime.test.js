import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_STATUS } from "../lib/tasks/task-store.js";

vi.mock("../hub/agent-executor.js", () => ({
  runAgentSession: vi.fn(async () => "background result"),
}));

const { TaskRuntime } = await import("../hub/task-runtime.js");
const { runAgentSession } = await import("../hub/agent-executor.js");

function makeHub() {
  return {
    eventBus: {
      emit: vi.fn(),
    },
  };
}

function makeEngine(homeDir) {
  return {
    currentAgentId: "lynn",
    currentSessionPath: "/sessions/current.jsonl",
    listAgents: () => [],
    getAgent: (id) => ({ agentName: id, agentDir: path.join(homeDir, "agents", id) }),
    summarizeActivity: vi.fn(async () => "summary"),
  };
}

describe("TaskRuntime", () => {
  let tmpDir;
  let runtime;
  let hub;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-task-runtime-"));
    hub = makeHub();
    runtime = new TaskRuntime({
      hub,
      engine: makeEngine(tmpDir),
      lynnHome: tmpDir,
      reviewRouteFactory: () => ({
        runDetachedReview: vi.fn(async () => ({
          content: "review output",
          reviewerName: "Hanako",
        })),
      }),
    });
  });

  it("creates and completes a delegate task", async () => {
    const task = runtime.createDelegateTask({
      title: "Long task",
      prompt: "Inspect repo",
      autoRun: false,
    });

    await runtime.runTask(task.id);

    const stored = runtime.getTask(task.id);
    expect(stored?.status).toBe(TASK_STATUS.COMPLETED);
    expect(stored?.artifacts?.[0]?.text).toBe("background result");
    expect(runAgentSession).toHaveBeenCalled();
    expect(hub.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task_update" }),
      "/sessions/current.jsonl",
    );
  });

  it("tracks approval-linked confirm cards and flips task status back to running on approval", async () => {
    const task = runtime.createTask({
      type: "delegate",
      title: "Needs approval",
      sessionPath: "/sessions/current.jsonl",
      runner: { kind: "delegate", payload: { prompt: "test" } },
    });

    const pending = new Map();
    const confirmStore = {
      create: vi.fn((_kind, _payload) => {
        const confirmId = "confirm-1";
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        pending.set(confirmId, resolve);
        return { confirmId, promise };
      }),
      resolve: vi.fn((confirmId, action, value) => {
        const resolve = pending.get(confirmId);
        if (!resolve) return false;
        pending.delete(confirmId);
        resolve({ action, value });
        return true;
      }),
    };

    runtime.bindConfirmStore(confirmStore);

    const created = confirmStore.create("tool_authorization", {
      taskId: task.id,
      command: "chmod +x script.sh",
    }, "/sessions/current.jsonl");

    expect(runtime.getTask(task.id)?.status).toBe("waiting_approval");
    confirmStore.resolve(created.confirmId, "confirmed_session");
    await created.promise;

    expect(runtime.getTask(task.id)?.status).toBe("running");
    expect(runtime.getTask(task.id)?.approvals?.length).toBe(2);
  });

  it("persists tasks and can reload them", async () => {
    const created = runtime.createTask({
      type: "delegate",
      title: "Persist me",
      sessionPath: "/sessions/current.jsonl",
      runner: { kind: "delegate", payload: { prompt: "persisted" } },
    });

    const reloaded = new TaskRuntime({
      hub: makeHub(),
      engine: makeEngine(tmpDir),
      lynnHome: tmpDir,
    });

    expect(reloaded.getTask(created.id)?.title).toBe("Persist me");
  });

  it("creates a review follow-up delegate task with execution metadata", () => {
    const task = runtime.createReviewFollowUpTask({
      reviewId: "review-1",
      title: "Handle findings",
      prompt: "Validate the finding, patch it, then rerun the relevant tests.",
      structuredReview: {
        summary: "One issue found.",
        verdict: "concerns",
        workflowGate: "follow_up",
        findings: [{
          severity: "medium",
          title: "Missing edge case",
          detail: "Nil path is missing.",
          suggestion: "Add a guard.",
        }],
      },
      contextPack: { request: "Review this patch." },
      followUpPrompt: "Fix the finding and rerun tests.",
      reviewerName: "Hanako",
    });

    expect(task.source).toBe("review_follow_up");
    expect(task.runner.payload.readOnly).toBe(false);
    expect(task.runner.payload.prompt).toBe("Validate the finding, patch it, then rerun the relevant tests.");
    expect(task.metadata.reviewId).toBe("review-1");
    expect(task.metadata.findingsCount).toBe(1);
  });

  it("records completed review follow-up tasks into activity stream", async () => {
    const activityEntries = [];
    runtime = new TaskRuntime({
      hub,
      engine: {
        ...makeEngine(tmpDir),
        getActivityStore: () => ({ add: (entry) => activityEntries.push(entry) }),
      },
      lynnHome: tmpDir,
      reviewRouteFactory: () => ({
        runDetachedReview: vi.fn(async () => ({ content: "review output", reviewerName: "Hanako" })),
      }),
    });

    const task = runtime.createDelegateTask({
      title: "Handle review findings",
      prompt: "Fix the reported issue",
      source: "review_follow_up",
      readOnly: false,
      autoRun: false,
      metadata: { autoRun: true },
    });

    await runtime.runTask(task.id);

    expect(activityEntries).toHaveLength(1);
    expect(activityEntries[0]).toEqual(expect.objectContaining({
      type: "review_follow_up",
      taskId: task.id,
      status: "done",
      source: "review_follow_up",
    }));
  });

});
