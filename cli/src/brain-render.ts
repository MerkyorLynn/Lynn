import type { BrainStreamEvent } from "./brain-client.js";
import { t } from "./i18n.js";
import { bold, cyan, dim, green, red, supportsColor, yellow } from "./terminal-style.js";
import { normalizeUsageTelemetry, renderUsageTelemetry } from "./usage-telemetry.js";

export interface HumanBrainRenderState {
  provider?: string;
}

export function renderBrainEventForHuman(
  event: BrainStreamEvent,
  state: HumanBrainRenderState,
  stream: NodeJS.WriteStream,
): void {
  const color = supportsColor(stream);
  if (event.type === "provider") {
    state.provider = event.activeProvider;
    const fallback = event.fallbackFrom?.length
      ? ` fallback: ${event.fallbackFrom.map((entry) => `${entry.id}${entry.reason ? `(${entry.reason})` : ""}`).join(" -> ")} -> `
      : "";
    stream.write(`\n${cyan("◇", color)} ${bold("route", color)}: ${dim(fallback, color)}${event.activeProvider}\n`);
    return;
  }
  if (event.type === "tool_progress") {
    if (event.event === "start") {
      stream.write(`\n${cyan("╭─", color)} ${bold("tool", color)} ${event.name}\n${cyan("│", color)} ${dim("running", color)}\n${cyan("╰─", color)}\n`);
      return;
    }
    if (event.event === "end") {
      const status = event.ok === false ? "failed" : "done";
      const timing = typeof event.ms === "number" ? ` ${event.ms}ms` : "";
      const icon = event.ok === false ? red("×", color) : green("✓", color);
      const label = event.ok === false ? red(status, color) : green(status, color);
      stream.write(`${icon} ${bold("tool", color)} ${event.name} ${label}${dim(timing, color)}\n`);
      return;
    }
    stream.write(`\n${yellow("•", color)} ${bold("tool", color)} ${event.name} ${event.event}\n`);
    return;
  }
  if (event.type === "brain.error") {
    stream.write(`\n${formatBrainErrorForHuman(event.error, event.code)}\n`);
  }
}

export function formatBrainErrorForHuman(error: string, code?: string): string {
  if (/all providers failed/i.test(error)) return t("brain.error.allProvidersFailed");
  return `Brain error: ${error}${code ? ` (${code})` : ""}`;
}

export interface UsageSummaryOptions {
  durationMs?: number;
}

export function summarizeUsage(usage: unknown, options: UsageSummaryOptions = {}): string | null {
  return renderUsageTelemetry(normalizeUsageTelemetry(usage, options));
}
