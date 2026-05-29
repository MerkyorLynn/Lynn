import os from "node:os";
import path from "node:path";
import { readVersionInfo } from "./version.js";
import { t } from "./i18n.js";

export function displayCwd(cwd: string): string {
  const home = os.homedir();
  const relative = path.relative(home, cwd);
  if (!relative) return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return `~/${relative}`;
  return cwd;
}

export function padLine(label: string, value: string, hint?: string): string {
  const left = `${label}:`.padEnd(11, " ");
  return `${left}${value}${hint ? `   ${hint}` : ""}`;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function wrapVisible(line: string, width: number): string[] {
  if (visibleLength(line) <= width) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && visibleLength(candidate) > width) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

export function box(lines: string[]): string {
  // Cap width so one long line (e.g. BYOK guidance) can't blow the box out to
  // the full terminal width; wrap long lines instead of widening the frame.
  const cap = Math.min(Math.max((process.stdout.columns ?? 80) - 4, 44), 72);
  const wrapped = lines.flatMap((line) => wrapVisible(line, cap));
  const width = Math.max(...wrapped.map((line) => visibleLength(line)), Math.min(51, cap));
  const top = `╭${"─".repeat(width + 2)}╮`;
  const bottom = `╰${"─".repeat(width + 2)}╯`;
  const body = wrapped.map((line) => `│ ${padVisible(line, width)} │`);
  return [top, ...body, bottom].join("\n");
}

export function renderStartupBanner(input: {
  cwd?: string;
  brainUrl?: string;
  brainStatus?: "online" | "offline" | "unknown";
  modeLabel?: string;
  modelLabel?: string;
  byokLabel?: string;
  showTips?: boolean;
} = {}): string {
  const version = readVersionInfo().version;
  const brainUrl = input.brainUrl || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const modelLabel = input.modelLabel || process.env.LYNN_CLI_MODEL_LABEL || "MiMo via Brain router (auto)";
  const byokLabel = input.byokLabel || process.env.LYNN_CLI_BYOK_LABEL || "client GUI Settings > Providers";
  const brainLabel = input.brainStatus && input.brainStatus !== "unknown"
    ? `${input.brainStatus} · ${brainUrl}`
    : brainUrl;
  const lines = [
    `Lynn CLI (v${version})`,
    "",
    padLine("model", modelLabel, "/model to change"),
    padLine("mode", input.modeLabel || "ask / workspace-write", "Shift+Tab to toggle"),
    padLine("BYOK", byokLabel, "Lynn providers"),
    padLine("brain", brainLabel),
    padLine("directory", displayCwd(input.cwd || process.cwd())),
  ];
  const out = [box(lines)];
  if (input.showTips !== false) {
    out.push("", t("tips.banner"));
  }
  return out.join("\n");
}
