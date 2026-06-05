import { describe, expect, it } from "vitest";
import {
  FLEET_EVENT_SCHEMA_VERSION,
  FLEET_WORKER_EVENT_TYPES,
  isFleetWorkerEventType,
  makeFleetProgressEvent,
  parseFleetJsonLine,
  validateFleetWorkerEvent,
} from "../fleet-events.js";

describe("fleet-events protocol", () => {
  it("accepts a valid worker.started event", () => {
    const result = validateFleetWorkerEvent({
      schemaVersion: FLEET_EVENT_SCHEMA_VERSION,
      type: "worker.started",
      workerId: "w1",
      agent: "lynn-cli",
      cwd: "/repo",
      worktree: "/repo/worktrees/w1",
      branch: "cli-1/task",
      pid: 123,
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("accepts StepFun as a first-class Fleet worker agent", () => {
    const result = validateFleetWorkerEvent({
      schemaVersion: FLEET_EVENT_SCHEMA_VERSION,
      type: "worker.started",
      workerId: "w-stepfun",
      agent: "stepfun-flash",
      cwd: "/repo",
      worktree: "/repo/worktrees/stepfun",
      branch: "fleet/stepfun",
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects missing required fields", () => {
    const result = validateFleetWorkerEvent({
      type: "test.finished",
      command: "npm test",
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("ok");
  });

  it("parses valid JSONL lines", () => {
    const parsed = parseFleetJsonLine(JSON.stringify({
      type: "worker.finished",
      ok: true,
      exitCode: 0,
      summary: "done",
    }));

    expect(parsed.ok).toBe(true);
    expect(parsed.event?.type).toBe("worker.finished");
  });

  it("keeps invalid JSON as a recoverable parse result", () => {
    const parsed = parseFleetJsonLine("not-json");

    expect(parsed.ok).toBe(false);
    expect(parsed.raw).toBe("not-json");
    expect(parsed.errors[0]).toContain("invalid fleet JSONL");
  });

  it("exposes known event types and progress helper", () => {
    expect(FLEET_WORKER_EVENT_TYPES).toContain("worker.violation");
    expect(FLEET_WORKER_EVENT_TYPES).toContain("worker.visual_result");
    expect(isFleetWorkerEventType("git.diff")).toBe(true);
    expect(isFleetWorkerEventType("unknown")).toBe(false);
    expect(makeFleetProgressEvent("hello", { workerId: "w2" })).toEqual({
      type: "worker.progress",
      message: "hello",
      workerId: "w2",
    });
  });

  it("accepts structured visual worker results", () => {
    const result = validateFleetWorkerEvent({
      type: "worker.visual_result",
      workerId: "w-vision",
      agent: "lynn-cli",
      taskType: "ground",
      image: "/tmp/shot.png",
      summary: "Submit button is near the lower-right corner.",
      boxes: [{ label: "Submit", x: 0.71, y: 0.82, width: 0.12, height: 0.05, confidence: 0.91 }],
      files: [{ path: "desktop/src/react/App.tsx", kind: "suggested" }],
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("requires a visual result summary", () => {
    const result = validateFleetWorkerEvent({
      type: "worker.visual_result",
      taskType: "see",
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("summary");
  });
});
