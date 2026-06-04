import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAutoVerifyPlan, runAutoVerify, formatAutoVerifyFeedback, buildAutoVerifyEvent, type AutoVerifyPlan } from "../src/code-autoverify.js";

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-av-")); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

describe("resolveAutoVerifyPlan", () => {
  it("is disabled when LYNN_CLI_AUTOVERIFY=0", () => {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
    expect(resolveAutoVerifyPlan(cwd, { LYNN_CLI_AUTOVERIFY: "0" }).enabled).toBe(false);
  });

  it("honors a custom command but marks it non-deterministic (no auto-rollback on its own)", () => {
    const plan = resolveAutoVerifyPlan(cwd, { LYNN_CLI_AUTOVERIFY_CMD: "make check" });
    expect(plan.enabled).toBe(true);
    expect(plan.command).toEqual(["make", "check"]);
    expect(plan.deterministic).toBe(false);
  });

  it("prefers the project's own typecheck script (deterministic — rollback-eligible)", () => {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
    const plan = resolveAutoVerifyPlan(cwd, {});
    expect(plan.enabled).toBe(true);
    expect(plan.command).toContain("typecheck");
    expect(plan.label).toBe("typecheck");
    expect(plan.deterministic).toBe(true);
  });

  it("falls back to tsc --noEmit when only a tsconfig exists (deterministic)", () => {
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}");
    const plan = resolveAutoVerifyPlan(cwd, {});
    expect(plan.enabled).toBe(true);
    expect(plan.command).toContain("tsc");
    expect(plan.deterministic).toBe(true);
  });

  it("is disabled for a project with no detectable check", () => {
    expect(resolveAutoVerifyPlan(cwd, {}).enabled).toBe(false);
  });
});

describe("runAutoVerify", () => {
  const node = process.execPath;

  it("does not run a disabled plan", async () => {
    const outcome = await runAutoVerify({ enabled: false, command: [], label: "x", timeoutMs: 1000 }, cwd);
    expect(outcome.ran).toBe(false);
    expect(outcome.ok).toBe(true);
  });

  it("reports ok for an exit-0 command", async () => {
    const plan: AutoVerifyPlan = { enabled: true, command: [node, "-e", "process.exit(0)"], label: "typecheck", timeoutMs: 10_000 };
    const outcome = await runAutoVerify(plan, cwd);
    expect(outcome.ran).toBe(true);
    expect(outcome.ok).toBe(true);
  });

  it("reports failure + captures output for a non-zero command", async () => {
    const plan: AutoVerifyPlan = { enabled: true, command: [node, "-e", "console.error('TS2304: boom'); process.exit(2)"], label: "typecheck", timeoutMs: 10_000 };
    const outcome = await runAutoVerify(plan, cwd);
    expect(outcome.ran).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("TS2304");
  });
});

describe("buildAutoVerifyEvent", () => {
  const plan: AutoVerifyPlan = { enabled: true, command: ["npm", "run", "--silent", "typecheck"], label: "typecheck", timeoutMs: 1000 };

  it("on pass: carries command + attempt, no blockedFinish, no output", () => {
    const ev = buildAutoVerifyEvent({ ran: true, ok: true, label: "typecheck", output: "noise" }, plan, 1);
    expect(ev).toMatchObject({ label: "typecheck", ok: true, ran: true, attempt: 1, blockedFinish: false });
    expect(ev.command).toBe("npm run --silent typecheck");
    expect(ev.output).toBeUndefined(); // success events stay clean for CI
  });

  it("on fail: blockedFinish=true and includes the errors for CI", () => {
    const ev = buildAutoVerifyEvent({ ran: true, ok: false, label: "typecheck", output: "src/x.ts(1,1): error TS2322" }, plan, 2);
    expect(ev.ok).toBe(false);
    expect(ev.blockedFinish).toBe(true);
    expect(ev.attempt).toBe(2);
    expect(ev.output).toContain("TS2322");
  });

  it("when the check did not run: not blocking, no output", () => {
    const ev = buildAutoVerifyEvent({ ran: false, ok: true, label: "typecheck", output: "" }, plan, 1);
    expect(ev.ran).toBe(false);
    expect(ev.blockedFinish).toBe(false);
    expect(ev.output).toBeUndefined();
  });
});

describe("formatAutoVerifyFeedback", () => {
  it("returns null when the check passed or did not run", () => {
    expect(formatAutoVerifyFeedback({ ran: true, ok: true, label: "typecheck", output: "" })).toBeNull();
    expect(formatAutoVerifyFeedback({ ran: false, ok: true, label: "typecheck", output: "" })).toBeNull();
  });

  it("reports deterministic verification errors when failed", () => {
    const msg = formatAutoVerifyFeedback({ ran: true, ok: false, label: "typecheck", output: "TS2304: Cannot find name 'x'" });
    expect(msg).toContain("Auto-verification (typecheck) failed");
    expect(msg).toContain("workspace check");
    expect(msg).toContain("TS2304");
    expect(msg).not.toContain("NOT done");
    expect(msg).not.toContain(["Do", "not", "give"].join(" "));
  });
});
