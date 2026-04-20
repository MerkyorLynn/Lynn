import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Hono } from "hono";
import { createFsRoute } from "../server/routes/fs.js";

let tmpDir;
let engine;
let app;

function makeEngine() {
  return {
    lynnHome: tmpDir,
    skillsDir: path.join(tmpDir, "skills"),
    learnedSkillsDir: path.join(tmpDir, "learned-skills"),
    homeCwd: tmpDir,
    config: { last_cwd: tmpDir, cwd_history: [tmpDir] },
    getPreferences: () => ({ home_folder: tmpDir, external_skill_paths: [] }),
    agent: { deskManager: { deskDir: path.join(tmpDir, "desk") } },
    editRollbackStore: {
      get(id) {
        if (id !== "rollback-1") return null;
        return {
          rollbackId: id,
          filePath: path.join(tmpDir, "workspace", "note.txt"),
          originalContent: "before change\n",
        };
      },
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-fs-rollback-"));
  fs.mkdirSync(path.join(tmpDir, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "learned-skills"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "desk"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "workspace", "note.txt"), "after change\n", "utf8");

  engine = makeEngine();
  app = new Hono();
  app.route("/api", createFsRoute(engine));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("fs route rollback", () => {
  it("restores the original file content from rollback snapshot", async () => {
    const res = await app.request("/api/fs/revert-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rollbackId: "rollback-1" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(expect.objectContaining({
      ok: true,
      rollbackId: "rollback-1",
      filePath: path.join(tmpDir, "workspace", "note.txt"),
      bytesWritten: Buffer.byteLength("before change\n", "utf8"),
    }));
    expect(fs.readFileSync(path.join(tmpDir, "workspace", "note.txt"), "utf8")).toBe("before change\n");
  });

  it("returns 404 when rollback snapshot is missing", async () => {
    const res = await app.request("/api/fs/revert-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rollbackId: "missing" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "rollback not found" });
  });

  it("detects untracked files as external additions", async () => {
    const workspace = path.join(tmpDir, "workspace");
    execGit(workspace, ["init"]);
    const untrackedPath = path.join(workspace, "new-note.md");
    fs.writeFileSync(untrackedPath, "new file line\n", "utf8");

    const res = await app.request("/api/fs/external-diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: untrackedPath }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(expect.objectContaining({
      ok: true,
      hasChanges: true,
      filePath: untrackedPath,
      rollbackId: null,
    }));
    expect(json.diff).toContain("+new file line");
  });
});

function execGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}
