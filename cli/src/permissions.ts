import fs from "node:fs/promises";
import path from "node:path";
import { getStringFlag, type ParsedArgs } from "./args.js";
import { resolveDataDir } from "./session/store.js";
import { t } from "./i18n.js";
import {
  DEFAULT_PERMISSION_PROFILE,
  isFullAccessPermission,
  normalizeApprovalMode,
  normalizePermissionProfile,
  normalizeSandboxMode,
  type LynnApprovalMode,
  type LynnPermissionProfile,
  type LynnSandboxMode,
} from "../../shared/permission-profile.js";

export type ApprovalMode = LynnApprovalMode;
export type SandboxMode = LynnSandboxMode;

export type PermissionProfile = LynnPermissionProfile;

export interface EffectivePermissions extends PermissionProfile {
  source: "flags" | "env" | "gui-profile" | "default";
  dataDir: string;
  profilePath: string;
  guiProfileFound: boolean;
}

export interface SavedPermissions extends EffectivePermissions {
  saved: true;
}

export async function resolveEffectivePermissions(args: ParsedArgs): Promise<EffectivePermissions> {
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const profilePath = path.join(dataDir, "permissions", "cli.json");
  const guiProfile = await readPermissionProfile(profilePath);
  const envProfile = readEnvProfile();
  const flagApproval = normalizeApproval(getStringFlag(args.flags, "approval"));
  const flagSandbox = normalizeSandbox(getStringFlag(args.flags, "sandbox"));

  const approval = flagApproval || envProfile.approval || guiProfile?.approval || DEFAULT_PERMISSION_PROFILE.approval;
  const inferredYoloSandbox = approval === "yolo" && !flagSandbox && (flagApproval === "yolo" || (!envProfile.sandbox && !guiProfile?.sandbox))
    ? "danger-full-access"
    : undefined;
  const sandbox = flagSandbox || inferredYoloSandbox || envProfile.sandbox || guiProfile?.sandbox || DEFAULT_PERMISSION_PROFILE.sandbox;
  const source = flagApproval || flagSandbox
    ? "flags"
    : envProfile.approval || envProfile.sandbox
      ? "env"
      : guiProfile
        ? "gui-profile"
        : "default";

  return {
    approval,
    sandbox,
    source,
    dataDir,
    profilePath,
    guiProfileFound: !!guiProfile,
  };
}

export async function savePermissionProfile(args: ParsedArgs): Promise<SavedPermissions> {
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const profilePath = path.join(dataDir, "permissions", "cli.json");
  const current = await readPermissionProfile(profilePath);
  const approval = normalizeApproval(getStringFlag(args.flags, "approval")) || current?.approval || DEFAULT_PERMISSION_PROFILE.approval;
  const sandbox = normalizeSandbox(getStringFlag(args.flags, "sandbox")) || current?.sandbox || DEFAULT_PERMISSION_PROFILE.sandbox;

  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await fs.writeFile(profilePath, `${JSON.stringify({ approval, sandbox }, null, 2)}\n`, "utf8");

  return {
    approval,
    sandbox,
    source: "gui-profile",
    dataDir,
    profilePath,
    guiProfileFound: true,
    saved: true,
  };
}

export function renderPermissions(perms: EffectivePermissions): string {
  const warning = isFullAccessPermission(perms)
    ? `\n${t("permissions.warning")}`
    : "";
  return [
    t("permissions.title"),
    "",
    `${t("permissions.approval")}: ${perms.approval}`,
    `${t("permissions.sandbox")}:  ${perms.sandbox}`,
    `${t("permissions.source")}:   ${perms.source}`,
    `${t("permissions.dataDir")}: ${perms.dataDir}`,
    `${t("permissions.profile")}:  ${perms.guiProfileFound ? perms.profilePath : t("permissions.profile.missing", { path: perms.profilePath })}`,
    "",
    t("permissions.precedence"),
    t("permissions.interop"),
    warning,
  ].filter(Boolean).join("\n");
}

async function readPermissionProfile(profilePath: string): Promise<PermissionProfile | null> {
  try {
    return normalizePermissionProfile(JSON.parse(await fs.readFile(profilePath, "utf8")));
  } catch {
    return null;
  }
}

function readEnvProfile(): Partial<PermissionProfile> {
  const approval = normalizeApproval(process.env.LYNN_CLI_APPROVAL || process.env.LYNN_APPROVAL);
  const sandbox = normalizeSandbox(process.env.LYNN_CLI_SANDBOX || process.env.LYNN_SANDBOX);
  return {
    ...(approval ? { approval } : {}),
    ...(sandbox ? { sandbox } : {}),
  };
}

function normalizeApproval(value: unknown): ApprovalMode | null {
  return normalizeApprovalMode(value);
}

function normalizeSandbox(value: unknown): SandboxMode | null {
  return normalizeSandboxMode(value);
}
