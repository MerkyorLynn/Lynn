import type { BrainStreamEvent } from "./brain-client.js";
import { t } from "./i18n.js";
import { brightCyan, cyan, dim, green, red, supportsColor, yellow } from "./terminal-style.js";
import { renderCard } from "./terminal-spinner.js";
import { normalizeUsageTelemetry, renderUsageTelemetry } from "./usage-telemetry.js";

export interface HumanBrainRenderState {
  provider?: string;
  toolDetails?: ToolDetail[];
}

export interface ToolDetail {
  id: number;
  name: string;
  summary?: string;
  details: string[];
  ms?: number;
  ok?: boolean;
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
    stream.write(`\n${renderCard({
      kind: "info",
      title: `route: ${providerLabel(event.activeProvider, color)}`,
      body: fallback ? [fallback.trim()] : undefined,
    }, color)}\n`);
    return;
  }
  if (event.type === "tool_progress") {
    if (event.event === "start") {
      stream.write(`${renderCard({
        kind: "tool",
        title: `${toolIcon(event.name)} ${event.name} · running`,
      }, color)}\n`);
      return;
    }
    if (event.event === "end") {
      const status = event.ok === false ? "failed" : "done";
      const timing = typeof event.ms === "number" ? ` ${formatDuration(event.ms)}` : "";
      const detailId = rememberToolDetail(state, event);
      const body = [
        ...toolPreviewLines(event, color),
        toolDetailHint(event, detailId),
      ];
      stream.write(`${renderCard({
        kind: event.ok === false ? "error" : "ok",
        title: `${toolIcon(event.name)} ${event.name} · ${status}${timing}`,
        body: body.length ? body : undefined,
      }, color)}\n`);
      return;
    }
    stream.write(`${renderCard({
      kind: "tool",
      title: `${toolIcon(event.name)} ${event.name} · ${event.event}`,
    }, color)}\n`);
    return;
  }
  if (event.type === "brain.error") {
    stream.write(`\n${formatBrainErrorForHuman(event.error, event.code)}\n`);
  }
}

function providerLabel(provider: string, color: boolean): string {
  if (provider.includes("step-3.7")) return brightCyan("StepFun 3.7 Flash", color);
  if (provider.includes("mimo")) return cyan("MiMo V2.5 Pro", color);
  if (provider.includes("spark") || provider.includes("apex")) return yellow("Spark Qwen 3.6 35B A3B", color);
  return provider;
}

function toolIcon(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("search")) return "🔎";
  if (normalized.includes("fetch") || normalized.includes("web")) return "🌐";
  if (normalized.includes("stock") || normalized.includes("finance")) return "📈";
  if (normalized.includes("weather")) return "🌦";
  if (normalized.includes("file") || normalized.includes("read")) return "📄";
  return "🔧";
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return `${ms}ms`;
}

export function formatBrainErrorForHuman(error: string, code?: string): string {
  if (/all providers failed/i.test(error)) return t("brain.error.allProvidersFailed");
  return `Brain error: ${error}${code ? ` (${code})` : ""}`;
}

function rememberToolDetail(state: HumanBrainRenderState, event: Extract<BrainStreamEvent, { type: "tool_progress" }>): number {
  const details = event.details?.filter((line) => line.trim()) || [];
  const list = state.toolDetails || (state.toolDetails = []);
  const id = list.length + 1;
  list.push({
    id,
    name: event.name,
    summary: event.summary,
    details,
    ms: event.ms,
    ok: event.ok,
  });
  return id;
}

function toolPreviewLines(event: Extract<BrainStreamEvent, { type: "tool_progress" }>, color: boolean): string[] {
  const lines: string[] = [];
  const add = (line: string | undefined) => {
    const clean = oneLine(line || "", 180);
    if (!clean || lines.includes(clean)) return;
    lines.push(clean);
  };
  add(event.summary);
  for (const detail of event.details || []) {
    if (lines.length >= 2) break;
    add(previewDetailLine(detail, color));
  }
  return lines;
}

function toolDetailHint(event: Extract<BrainStreamEvent, { type: "tool_progress" }>, detailId: number): string {
  const sources = sourceSummary(event.details || []);
  if (sources.count) {
    const hostText = sources.hosts.length ? ` · ${sources.hosts.join(", ")}` : "";
    return `sources: /tool ${detailId} · ${sources.count} link${sources.count === 1 ? "" : "s"}${hostText}`;
  }
  return `details: /tool ${detailId}`;
}

function previewDetailLine(line: string, color: boolean): string {
  const citation = line.match(/^\[([^\]]+)\]\(([^)]+)\):\s*(.*)$/);
  if (citation) {
    const [, title, url, summary] = citation;
    const host = hostFromUrl(url);
    const label = host ? `${title} · ${host}` : title;
    return `${cyan(label, color)}${summary ? dim(` — ${summary}`, color) : ""}`;
  }
  return dim(line, color);
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function renderToolDetailsList(state: HumanBrainRenderState, color: boolean): string {
  const details = state.toolDetails || [];
  if (!details.length) return dim("No tool details yet.", color);
  return details.map((detail) => {
    const status = detail.ok === false ? red("failed", color) : green("done", color);
    const timing = typeof detail.ms === "number" ? ` · ${formatDuration(detail.ms)}` : "";
    const sources = sourceSummary(detail.details);
    const sourceText = sources.count
      ? ` — ${sources.count} source${sources.count === 1 ? "" : "s"}${sources.hosts.length ? `: ${sources.hosts.join(", ")}` : ""}`
      : "";
    const summary = sourceText || ` — ${detail.summary || t("tool.details.unavailable.short")}`;
    return `${cyan(`/tool ${detail.id}`, color)} ${toolIcon(detail.name)} ${detail.name} · ${status}${timing}${summary}`;
  }).join("\n");
}

export function renderToolDetail(state: HumanBrainRenderState, id: number, color: boolean): string {
  const detail = (state.toolDetails || []).find((item) => item.id === id);
  if (!detail) return red(`No tool detail #${id}.`, color);
  const lines = [
    renderCard({
      kind: detail.ok === false ? "error" : "info",
      title: `${toolIcon(detail.name)} ${detail.name} · detail #${detail.id}`,
      body: detail.summary ? [detail.summary] : undefined,
    }, color),
  ];
  const body = detail.details.length ? detail.details : detail.summary ? [detail.summary] : [t("tool.details.unavailable")];
  for (const line of body) lines.push(`│   ${renderDetailLine(line, color)}`);
  return lines.join("\n");
}

function renderDetailLine(line: string, color: boolean): string {
  const citation = line.match(/^\[([^\]]+)\]\(([^)]+)\):\s*(.*)$/);
  if (!citation) return dim(line, color);
  const [, title, url, summary] = citation;
  const label = terminalLink(title, url, color);
  return `${label}${summary ? dim(` — ${summary}`, color) : ""}`;
}

function terminalLink(text: string, url: string, enabled: boolean): string {
  if (!enabled) return `${text} (${url})`;
  return `\x1b]8;;${url}\x1b\\${cyan(text, true)}\x1b]8;;\x1b\\`;
}

function sourceSummary(lines: string[]): { count: number; hosts: string[] } {
  const hosts: string[] = [];
  let count = 0;
  for (const line of lines) {
    const citation = line.match(/^\[[^\]]+\]\(([^)]+)\):/);
    if (!citation) continue;
    count += 1;
    const host = hostFromUrl(citation[1]);
    if (host && !hosts.includes(host) && hosts.length < 3) hosts.push(host);
  }
  return { count, hosts };
}

export interface UsageSummaryOptions {
  durationMs?: number;
}

export function summarizeUsage(usage: unknown, options: UsageSummaryOptions = {}): string | null {
  return renderUsageTelemetry(normalizeUsageTelemetry(usage, options));
}
