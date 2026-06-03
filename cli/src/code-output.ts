import { parseReasoningOptions } from "./reasoning.js";
import { renderMode, type ChatMode } from "./commands/chat.js";
import { modelLabelWithId } from "./provider-presets.js";
import type { CliProviderProfile } from "./provider-profile.js";
import { box, displayCwd, padLine } from "./startup.js";
import { dangerLine, dim, supportsColor } from "./terminal-style.js";
import { t } from "./i18n.js";
import type { CodeContext } from "./code-context.js";
import type { ToolRunContext } from "./tools/types.js";
import { readVersionInfo } from "./version.js";

export function renderAssistantBlock(text: string, footer?: string): string {
  const lines = text.replace(/\s+$/g, "").split(/\r?\n/);
  const body = lines.map((line, index) => `${index === 0 ? "• " : "  "}${line}`).join("\n");
  return `${body}${footer ? `\n\n${footer}` : ""}\n`;
}

export function renderCodeIntro(
  mode: ChatMode,
  reasoning = parseReasoningOptions({ command: "code", positionals: [], flags: {} }),
  options: { color?: boolean; modelLabel?: string } = {},
): string {
  const color = !!options.color;
  const version = readVersionInfo().version;
  const lines = [
    `Lynn Code (${version})`,
    "",
    padLine(t("banner.label.model"), options.modelLabel || t("banner.model.default"), t("banner.hint.model")),
    padLine(t("banner.label.dir"), displayCwd(process.cwd())),
  ];
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  return [
    box(lines),
    "",
    dangerous
      ? `  ${dangerLine(t("code.danger.warning"), color)}`
      : `  ${t("code.tip")}`,
    "",
  ].join("\n");
}

export function renderCodeTaskHeader(inputData: {
  cwd: string;
  approval: ToolRunContext["approval"];
  sandbox: NonNullable<ToolRunContext["sandbox"]>;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  maxSteps: number;
  mockBrain?: boolean;
  fallbackProvider?: CliProviderProfile;
}): string {
  const route = codeRouteLabel(!!inputData.mockBrain, inputData.fallbackProvider);
  return [
    box([
      `Lynn Code · ${route}`,
      "",
      padLine(t("banner.label.dir"), displayCwd(inputData.cwd)),
      padLine(t("banner.label.mode"), `${inputData.approval} / ${inputData.sandbox}`),
      padLine(t("code.label.think"), `${inputData.reasoning.effort} · ${t("code.maxsteps", { n: inputData.maxSteps })}`),
    ]),
    "",
  ].join("\n");
}

export function renderCodeFooter(inputData: {
  context: CodeContext;
  mode: ChatMode;
  mockBrain: boolean;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  fallbackProvider?: CliProviderProfile;
  usage?: string | null;
}): string {
  const color = supportsColor(process.stdout);
  const model = inputData.mockBrain
    ? "mock Brain"
    : inputData.fallbackProvider
      ? `CLI BYOK:${modelLabelWithId(inputData.fallbackProvider.model)}`
      : "StepFun 3.7 Flash→MiMo V2.5 Pro";
  const mode = renderMode(inputData.mode);
  return dim([
    model,
    displayCwd(inputData.context.cwd),
    mode,
    `think ${inputData.reasoning.effort}`,
    inputData.usage,
  ].filter(Boolean).join(" · "), color);
}

export function codeRouteLabel(mockBrain: boolean, fallbackProvider?: CliProviderProfile): string {
  if (mockBrain) return t("code.route.mock");
  if (fallbackProvider) return `CLI BYOK: ${modelLabelWithId(fallbackProvider.model)}`;
  return t("code.route.brain");
}
