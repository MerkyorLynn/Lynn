export interface ExternalMcpArmConfig {
  id: string;
  command: string;
  args: string[];
  capability: "gui" | "browser" | "device" | "custom";
  description?: string;
}

export interface ExternalMcpArmValidation {
  ok: boolean;
  errors: string[];
  arm: ExternalMcpArmConfig | null;
}

export function validateExternalMcpArmConfig(value: unknown): ExternalMcpArmValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["config must be an object"], arm: null };
  }
  const record = value as Record<string, unknown>;
  const id = stringField(record.id);
  const command = stringField(record.command);
  const args = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === "string") : [];
  const capability = normalizeCapability(record.capability);
  const description = stringField(record.description);

  if (!id) errors.push("id is required");
  if (!command) errors.push("command is required");
  if (Array.isArray(record.args) && args.length !== record.args.length) errors.push("args must contain only strings");
  if (!capability) errors.push("capability must be gui, browser, device, or custom");
  if (command && /[;&|`$<>]/.test(command)) errors.push("command must be a binary name/path, not a shell string");

  return {
    ok: errors.length === 0,
    errors,
    arm: errors.length ? null : {
      id,
      command,
      args,
      capability: capability || "custom",
      ...(description ? { description } : {}),
    },
  };
}

export function gelabZeroMcpArmExample(): ExternalMcpArmConfig {
  return {
    id: "gelab-zero",
    command: "python",
    args: ["mcp_server/detailed_gelab_mcp_server.py"],
    capability: "device",
    description: "StepFun GELab GUI/phone grounding arm exposed through MCP. Lynn treats it as an external arm; do not merge its Python code into the CLI.",
  };
}

export function renderExternalMcpArmContract(arm = gelabZeroMcpArmExample()): string {
  return [
    "External MCP arm contract:",
    `- id: ${arm.id}`,
    `- command: ${arm.command} ${arm.args.join(" ")}`.trimEnd(),
    `- capability: ${arm.capability}`,
    "- role: external specialist arm. Lynn/StepFun does planning; the MCP arm performs domain-specific actions.",
    "- boundary: do not merge external Python/ADB/device code into Lynn CLI; call it through MCP only.",
    "- gate: Fleet still trusts Lynn-side JSONL, ownership checks, tests, and merge gates, not the external arm's self-report.",
  ].join("\n");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCapability(value: unknown): ExternalMcpArmConfig["capability"] | null {
  if (value === "gui" || value === "browser" || value === "device" || value === "custom") return value;
  return null;
}
