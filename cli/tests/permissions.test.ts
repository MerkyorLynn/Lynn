import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { setLang } from "../src/i18n.js";
import { renderPermissions, resolveEffectivePermissions, savePermissionProfile } from "../src/permissions.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-permissions-"));
  setLang("zh");
});

afterEach(async () => {
  setLang(null);
  delete process.env.LYNN_CLI_APPROVAL;
  delete process.env.LYNN_CLI_SANDBOX;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("CLI permission profile", () => {
  it("defaults to guarded workspace-write mode", async () => {
    const permissions = await resolveEffectivePermissions(parseArgs(["permissions", "--data-dir", tmp]));

    expect(permissions.approval).toBe("ask");
    expect(permissions.sandbox).toBe("workspace-write");
    expect(permissions.source).toBe("default");
    expect(permissions.guiProfileFound).toBe(false);
  });

  it("reads future GUI profile files", async () => {
    const dir = path.join(tmp, "permissions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "cli.json"), JSON.stringify({ approval: "never", sandbox: "read-only" }), "utf8");

    const permissions = await resolveEffectivePermissions(parseArgs(["permissions", "--data-dir", tmp]));

    expect(permissions.approval).toBe("never");
    expect(permissions.sandbox).toBe("read-only");
    expect(permissions.source).toBe("gui-profile");
    expect(permissions.guiProfileFound).toBe(true);
  });

  it("lets flags override env and GUI profile", async () => {
    process.env.LYNN_CLI_APPROVAL = "never";
    process.env.LYNN_CLI_SANDBOX = "read-only";

    const permissions = await resolveEffectivePermissions(parseArgs([
      "permissions",
      "--data-dir",
      tmp,
      "--approval",
      "yolo",
      "--sandbox",
      "danger-full-access",
    ]));

    expect(permissions.approval).toBe("yolo");
    expect(permissions.sandbox).toBe("danger-full-access");
    expect(permissions.source).toBe("flags");
    expect(renderPermissions(permissions)).toContain("警告");
  });

  it("infers danger-full-access for explicit headless yolo when sandbox is omitted", async () => {
    const dir = path.join(tmp, "permissions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "cli.json"), JSON.stringify({ approval: "ask", sandbox: "workspace-write" }), "utf8");

    const permissions = await resolveEffectivePermissions(parseArgs([
      "permissions",
      "--data-dir",
      tmp,
      "--approval",
      "yolo",
    ]));

    expect(permissions.approval).toBe("yolo");
    expect(permissions.sandbox).toBe("danger-full-access");
    expect(permissions.source).toBe("flags");
  });

  it("respects an explicit sandbox even when approval is yolo", async () => {
    const permissions = await resolveEffectivePermissions(parseArgs([
      "permissions",
      "--data-dir",
      tmp,
      "--approval",
      "yolo",
      "--sandbox",
      "workspace-write",
    ]));

    expect(permissions.approval).toBe("yolo");
    expect(permissions.sandbox).toBe("workspace-write");
    expect(permissions.source).toBe("flags");
  });

  it("renders English when LYNN_LANG is set to en", async () => {
    setLang("en");
    const permissions = await resolveEffectivePermissions(parseArgs(["permissions", "--data-dir", tmp]));

    expect(renderPermissions(permissions)).toContain("Lynn CLI Permissions");
    expect(renderPermissions(permissions)).toContain("approval: ask");
  });

  it("writes the shared CLI/GUI permission profile", async () => {
    const saved = await savePermissionProfile(parseArgs([
      "permissions",
      "set",
      "--data-dir",
      tmp,
      "--approval",
      "yolo",
      "--sandbox",
      "danger-full-access",
    ]));

    expect(saved.saved).toBe(true);
    expect(saved.profilePath).toBe(path.join(tmp, "permissions", "cli.json"));

    const permissions = await resolveEffectivePermissions(parseArgs(["permissions", "--data-dir", tmp]));
    expect(permissions.approval).toBe("yolo");
    expect(permissions.sandbox).toBe("danger-full-access");
    expect(permissions.source).toBe("gui-profile");
  });

  it("preserves unspecified fields when updating the shared profile", async () => {
    await savePermissionProfile(parseArgs([
      "permissions",
      "set",
      "--data-dir",
      tmp,
      "--approval",
      "never",
      "--sandbox",
      "read-only",
    ]));

    await savePermissionProfile(parseArgs([
      "permissions",
      "set",
      "--data-dir",
      tmp,
      "--approval",
      "ask",
    ]));

    const permissions = await resolveEffectivePermissions(parseArgs(["permissions", "--data-dir", tmp]));
    expect(permissions.approval).toBe("ask");
    expect(permissions.sandbox).toBe("read-only");
  });
});
