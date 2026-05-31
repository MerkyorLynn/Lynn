import { readVersionInfo } from "./version.js";
import { displayCwd } from "./startup.js";

export interface RuntimeAnswerContext {
  routeLabel: string;
  brainUrl: string;
  cwd: string;
  mode?: string;
  reasoning?: string;
}

const VERSION_PATTERNS = [
  /(^|\s)\/(?:version|about)(\s|$)/i,
  /(?:lynn\s*)?(?:cli\s*)?(?:版本号|version|about)/i,
  /(?:你|当前|现在).{0,8}(?:版本|version)/i,
];

export function isLocalRuntimeQuestion(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return VERSION_PATTERNS.some((pattern) => pattern.test(value));
}

export function renderLocalRuntimeAnswer(input: RuntimeAnswerContext, locale: "zh" | "en" = "zh"): string {
  const version = readVersionInfo();
  const build = version.build ? ` (${version.build})` : "";
  if (locale === "en") {
    return [
      `Lynn CLI version: ${version.version}${build}`,
      `Runtime route: ${input.routeLabel}`,
      `Brain: ${input.brainUrl}`,
      `Directory: ${displayCwd(input.cwd)}`,
      input.mode ? `Permissions: ${input.mode}` : "",
      input.reasoning ? `Reasoning: ${input.reasoning}` : "",
      "",
    "Use `Lynn version` for the local CLI version, `/model` for the Brain model route, and `Lynn providers` for BYOK settings.",
    ].filter(Boolean).join("\n");
  }
  return [
    `Lynn CLI 版本:${version.version}${build}`,
    `模型路由:${input.routeLabel}`,
    `Brain:${input.brainUrl}`,
    `目录:${displayCwd(input.cwd)}`,
    input.mode ? `权限:${input.mode}` : "",
    input.reasoning ? `思考:${input.reasoning}` : "",
    "",
    "提示:`Lynn version` 查看本地 CLI 版本,`/model` 查看 Brain 模型路由,`Lynn providers` 查看 BYOK 设置。",
  ].filter(Boolean).join("\n");
}

export function localeForText(text: string): "zh" | "en" {
  return /[\u3400-\u9fff]/.test(text) ? "zh" : "en";
}
