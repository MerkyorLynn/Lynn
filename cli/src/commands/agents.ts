import type { ParsedArgs } from "../args.js";
import { detectCliAgents } from "../agent-registry.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { presetNameForProviderProfile } from "../provider-presets.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";
import { readVersionInfo } from "../version.js";

function installUrl(): string {
  const version = readVersionInfo().version || "0.80.0";
  return `https://download.merkyorlynn.com/downloads/cli/lynn-cli-${version}.tgz`;
}

export interface AgentsHeadlessContract {
  node: string;
  install: string;
  launch: string[];
  headless: string[];
}

export function buildAgentsHeadlessContract(url = installUrl()): AgentsHeadlessContract {
  return {
    node: "Node.js 20 LTS or 22 LTS with npm",
    install: `npm install -g --force ${url}`,
    launch: [
      "Lynn",
      "Lynn code",
      "Lynn agents",
    ],
    headless: [
      'Lynn code -p "fix tests" --json --cwd /repo --approval yolo --sandbox danger-full-access --save-session',
      "Lynn worker run --brief task.md --worktree /repo --jsonl --approval yolo --sandbox danger-full-access",
      'Lynn worker run --brief task.md --worktree /repo --agent custom --agent-command "your command" --jsonl',
    ],
  };
}

export async function runAgents(args: ParsedArgs, json: boolean): Promise<number> {
  const profile = await resolveCliProviderProfile(args);
  const configuredPreset = presetNameForProviderProfile(profile?.profile);
  const agents = detectCliAgents({ configuredPreset });
  const contract = buildAgentsHeadlessContract();
  if (json) {
    writeJsonLine({ type: "agents", ts: nowIso(), agents, contract });
    return 0;
  }

  const lines = [t("agents.title"), ""];
  for (const agent of agents) {
    const status = agent.available ? "OK" : "--";
    const kind = agent.kind === "built-in" ? "profile" : "external";
    lines.push(`${status} ${agent.id.padEnd(16)} ${kind.padEnd(8)} ${agent.label.padEnd(30)} ${agent.availability}`);
  }
  lines.push("", t("agents.headless.title"));
  lines.push(`  ${t("agents.node.prereq")}`);
  lines.push(`  ${t("agents.install.title")}`);
  lines.push(`  ${contract.install}`);
  lines.push("");
  lines.push(`  ${t("agents.launch.title")}`);
  for (const command of contract.launch) lines.push(`  ${command}`);
  lines.push("");
  lines.push(`  ${t("agents.headless.commands")}`);
  for (const command of contract.headless) lines.push(`  ${command}`);
  lines.push("", t("agents.tip"));
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
