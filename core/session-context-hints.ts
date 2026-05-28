import fs from "fs";
import os from "os";
import path from "path";
import { getLocale } from "../server/i18n.js";
import {
  buildRouteIntentSystemHint,
  normalizeRouteIntent,
  ROUTE_INTENTS,
} from "../shared/task-route-intent.js";
import { buildScenarioContractHintForText } from "../shared/scenario-contracts.js";

type AnyRecord = Record<string, any>;
export type PromptImage = { data: string; mimeType?: string };

export function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话，无需 MOOD）\n" : "(Interjection, no MOOD needed)\n";
}

export function buildKnownFolderAliasPrompt(isZh: boolean) {
  const home = os.homedir();
  const downloads = path.join(home, "Downloads");
  const desktop = path.join(home, "Desktop");
  const documents = path.join(home, "Documents");
  return isZh
    ? [
        "【本机常用目录别名】",
        `用户说「下载文件夹」「下载目录」「Downloads」时，默认指 ${downloads}，不是当前代码目录或 ${path.join(downloads, "Lynn")}。`,
        `用户说「桌面」时，默认指 ${desktop}；用户说「文稿」或「Documents」时，默认指 ${documents}。`,
        "涉及删除/清理文件时，先列出匹配文件和数量；除非用户已经二次确认，或系统弹出确认卡并得到确认，否则不要直接删除。",
      ].join(" ")
    : [
        "[Known local folder aliases]",
        `When the user says "Downloads" or the download folder, use ${downloads}, not the current repo or ${path.join(downloads, "Lynn")}.`,
        `When the user says Desktop, use ${desktop}. When the user says Documents, use ${documents}.`,
        "For delete/cleanup requests, list matching files and counts first; do not delete until the user confirms or the system confirmation card is accepted.",
      ].join(" ");
}

export function buildRouteAndScenarioHint(text: string, routeIntent: string, opts: { locale?: string; imagesCount?: number } = {}) {
  const locale = opts.locale || getLocale();
  return buildRouteIntentSystemHint(routeIntent, locale);
}

export function buildScenarioHintContext(text: string, opts: { locale?: string; imagesCount?: number; attachmentsCount?: number; audioCount?: number } = {}) {
  return buildScenarioContractHintForText(text, {
    locale: opts.locale || getLocale(),
    imagesCount: opts.imagesCount || 0,
    attachmentsCount: opts.attachmentsCount || 0,
    audioCount: opts.audioCount || 0,
  });
}

export function shouldInjectLocalRoutePromptHints() {
  return false;
}

export function toSessionPromptOptions(images?: PromptImage[]) {
  if (!images?.length) return undefined;
  return {
    images: images.map((img: PromptImage) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType || "image/png",
      source: {
        type: "base64",
        mediaType: img.mimeType || "image/png",
        data: img.data,
      },
    })),
  };
}

export function stripUnsupportedPromptImagesForModel(opts: { images?: PromptImage[] } | null | undefined, modelOwner: AnyRecord, resolveModelOverrides?: (model: unknown, overrides: unknown) => AnyRecord | null | undefined) {
  const resolved = resolveModelOverrides?.(modelOwner?.model, modelOwner?.config?.models?.overrides);
  if (opts?.images?.length && resolved?.vision === false) {
    opts.images = undefined;
  }
  return opts?.images;
}

function buildSkillToolCompatibilityHint(skillName: string | null | undefined) {
  const isZh = getLocale().startsWith("zh");
  const toolNames = "read, write, edit, bash, grep, find, ls";
  if (isZh) {
    return [
      "【Lynn 技能执行兼容说明】",
      `- 这是已启用技能「${skillName || "unknown"}」的执行指令，不是普通参考资料。`,
      `- 如果技能正文或 frontmatter 提到 Read / Write / Edit / Bash，请映射为当前 Lynn 工具名：${toolNames}。`,
      "- 需要读写文件、运行脚本、整理项目时，必须调用真实工具；不要把工具调用写成正文，也不要只口头说“我会去做”。",
      "- 如果当前模型或执行模式没有对应工具，先明确说明缺少哪个工具或权限，再给用户下一步选择。",
    ].join("\n");
  }
  return [
    "[Lynn skill execution compatibility]",
    `- These are executable instructions for the enabled skill "${skillName || "unknown"}", not just reference text.`,
    `- If the skill body or frontmatter mentions Read / Write / Edit / Bash, map them to the current Lynn tool names: ${toolNames}.`,
    "- When the task requires reading/writing files, running scripts, or organizing a project, use real tool calls. Do not print pseudo tool calls as plain text.",
    "- If the current model or execution mode lacks a required tool, say which tool/permission is missing and ask for the next step.",
  ].join("\n");
}

export function buildSkillHintContext(suggestions: AnyRecord[]) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return "";
  const isZh = getLocale().startsWith("zh");

  const bestSkill = suggestions[0];
  let skillContent = "";
  if (bestSkill?.filePath) {
    try {
      skillContent = fs.readFileSync(bestSkill.filePath, "utf-8").trim();
      if (skillContent.length > 3000) skillContent = skillContent.slice(0, 3000) + "\n...(truncated)";
    } catch {}
  }

  if (skillContent) {
    return [
      isZh
        ? `【技能已加载】当前请求匹配技能「${bestSkill.name}」，以下是完整指令，请严格按照指令执行：`
        : `[Skill Loaded] Request matches skill "${bestSkill.name}". Follow these instructions:`,
      "",
      buildSkillToolCompatibilityHint(bestSkill.name),
      "",
      skillContent,
    ].join("\n");
  }

  if (isZh) {
    return [
      "【技能候选提示】当前请求很可能匹配以下已启用技能：",
      ...suggestions.map((skill: AnyRecord) => {
        const matches = skill.matchedTokens?.length ? `（命中：${skill.matchedTokens.join("、")}）` : "";
        return `- ${skill.name}${skill.description ? `：${skill.description}` : ""}${matches}`;
      }),
      "请先用 read 工具打开最相关技能的 SKILL.md，再按里面的步骤执行。",
    ].join("\n");
  }

  return [
    "[Skill Hint] This request likely matches these enabled skills:",
    ...suggestions.map((skill: AnyRecord) => {
      const matches = skill.matchedTokens?.length ? ` (matched: ${skill.matchedTokens.join(", ")})` : "";
      return `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}${matches}`;
    }),
    "Read the most relevant skill's SKILL.md first, then follow its workflow.",
  ].join("\n");
}

export function shouldAttachSkillHint(routeIntent: string) {
  return normalizeRouteIntent(routeIntent) !== ROUTE_INTENTS.UTILITY;
}

const FILE_MENTION_PATTERN = /\b([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|css|json|md|py|rs|go|java|vue|svelte|swift|kt|kts|c|cc|cpp|h|hpp|m|mm|sql|yaml|yml|toml|sh))\b/gi;

export function buildAtInjectionPromptHint(text: string) {
  if (!text || /@\S+/.test(text)) return "";
  if (/\[(附件|目录|参考文档|Git 上下文)\]/.test(text)) return "";

  const files = [...new Set(Array.from(text.matchAll(FILE_MENTION_PATTERN)).map((match: RegExpMatchArray) => match[1]).filter(Boolean))].slice(0, 3);
  if (files.length === 0) return "";

  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return [
      "【上下文引导】如果用户提到了具体文件，但你还没看到文件内容，请先用一句很短的人话提醒用户把文件给你看，再继续分析。",
      `优先引导格式：输入 ${files.map((file) => `@${file}`).join("、")}，或直接把文件拖到输入框。`,
      "只在确实缺文件内容时提示一次，不要重复说教。",
    ].join("\n");
  }

  return [
    "[Context Guidance] If the user mentions a specific file but you have not seen its contents yet, first give one short, natural sentence asking them to share it before you continue.",
    `Prefer guidance like: type ${files.map((file) => `@${file}`).join(", ")} or drag the file into the composer.`,
    "Only do this when file contents are genuinely missing, and do not over-explain.",
  ].join("\n");
}
