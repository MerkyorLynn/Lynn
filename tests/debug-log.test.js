import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initDebugLog } from "../lib/debug-log.js";

describe("debug log filtering and spans", () => {
  const dirs = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempLogDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-debug-log-"));
    dirs.push(dir);
    return dir;
  }

  it("filters persistent logs by module level", () => {
    vi.stubEnv("LYNN_LOG", "ws=warn,*=error");
    const logger = initDebugLog(tempLogDir());

    logger.log("ws", "skip ws info");
    logger.warn("ws", "keep ws warn");
    logger.debug("api", "skip api debug");
    logger.error("api", "keep api error");

    const content = fs.readFileSync(logger.filePath, "utf-8").replace(/\\/g, "/");
    expect(content).not.toContain("skip ws info");
    expect(content).not.toContain("skip api debug");
    expect(content).toContain("keep ws warn");
    expect(content).toContain("keep api error");
  });

  it("writes scrubbed span fields", () => {
    vi.stubEnv("LYNN_LOG", "ws=debug");
    const logger = initDebugLog(tempLogDir());

    logger.span("turn_end", {
      sessionPath: path.join(os.homedir(), "Downloads", "session.jsonl"),
      reason: "timeout",
    }, { module: "ws", level: "DEBUG" });

    const content = fs.readFileSync(logger.filePath, "utf-8");
    expect(content).toContain("[span:turn_end]");
    expect(content).toContain("reason=timeout");
    expect(content).toContain("~/Downloads/session.jsonl");
    expect(content).not.toContain(os.homedir());
  });
});
