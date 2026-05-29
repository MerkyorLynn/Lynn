/**
 * permissions.ts - read-only view of the CLI permission profile for the GUI (B2).
 * The CLI writes ~/.lynn/permissions/cli.json ({ approval, sandbox }) via
 * `lynn permissions set`. The GUI only READS it; it never mutates the profile or
 * the user's shell config. Defaults to "guarded mode" when no profile exists.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PermissionStatus {
  exists: boolean;
  path: string;
  approval: string;
  sandbox: string;
}

const DEFAULT_APPROVAL = "ask";
const DEFAULT_SANDBOX = "workspace-write";

export function permissionProfilePath(home?: string): string {
  const raw = home || process.env.LYNN_HOME || path.join(os.homedir(), ".lynn");
  const base = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.join(base, "permissions", "cli.json");
}

export async function readPermissionStatus(
  opts: { profilePath?: string; readFile?: (p: string) => Promise<string> } = {},
): Promise<PermissionStatus> {
  const p = opts.profilePath ?? permissionProfilePath();
  const read = opts.readFile ?? ((f: string) => fs.readFile(f, "utf8"));
  try {
    const parsed = JSON.parse(await read(p)) as { approval?: string; sandbox?: string };
    return {
      exists: true,
      path: p,
      approval: parsed.approval || DEFAULT_APPROVAL,
      sandbox: parsed.sandbox || DEFAULT_SANDBOX,
    };
  } catch {
    return { exists: false, path: p, approval: DEFAULT_APPROVAL, sandbox: DEFAULT_SANDBOX };
  }
}
