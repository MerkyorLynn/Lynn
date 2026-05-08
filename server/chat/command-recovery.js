/**
 * Command Recovery — pseudo bash command extraction + local file mutation command rebuild
 *
 * Extracted from server/routes/chat.js (v0.77.9 Phase B).
 */
import path from "path";
import os from "os";
import { classifyRequestedLocalMutation } from "./turn-retry-policy.js";

// ════════════════════════════
//  Layer A — pure text utilities
// ════════════════════════════

export function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

export function isMeaningfulRecoveredBashCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed || trimmed.length > 2000) return false;
  if (/^[<>/\\\s]+$/.test(trimmed)) return false;
  if (/^<\/?[a-zA-Z0-9_.:-]+\s*\/?>$/.test(trimmed)) return false;
  if (/^```(?:bash|sh|shell)?$/i.test(trimmed)) return false;
  return /[A-Za-z0-9_$~\'\""` .-]/.test(trimmed);
}

export function isInsidePath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

export function extractPseudoBashCommand(text) {
  const raw = String(text || "");
  const patterns = [
    /<\|tool_code_begin\|>\s*bash\s*([\s\S]*?)(?:<\|tool_code_end\|>|$)/i,
    /<tool_call>\s*<bash[^>]*>([\s\S]*?)(?:<\/bash>|$)/i,
    /<bash[^>]*>([\s\S]*?)<\/bash>/i,
    /<tool_call>\s*bash\s*\n([\s\S]*?)(?:<\/tool_call>|$)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const command = String(match?.[1] || "").replace(/<\/?[^>]+>/g, "").trim();
    if (isMeaningfulRecoveredBashCommand(command)) return command;
  }
  return "";
}

export function extractPseudoRemovePath(text) {
  const raw = String(text || "");
  const patterns = [
    /<remove[^>]*>\s*\(([^)]+)\)\s*<\/remove>/i,
    /<(?:remove|remove_file|delete|delete_file)[^>]*>\s*(?:<path>)?\s*([^<\n]+?)\s*(?:<\/path>)?\s*<\/(?:remove|remove_file|delete|delete_file)>/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const target = String(match?.[1] || "").trim();
    if (target && target.length <= 1000) return target;
  }
  return "";
}

export function extractExplicitDeleteTargetFromPrompt(prompt) {
  const text = String(prompt || "");
  const match = text.match(/(?:删除|删掉|移除|delete|remove)\s*(?:当前目录下|当前目录中|当前文件夹下|current directory|current folder)?\s*[`"'“”]?([A-Za-z0-9][A-Za-z0-9._ -]{0,180}\.[A-Za-z0-9]{1,16})[`"'“”]?/i);
  const target = String(match?.[1] || "").trim();
  if (!target || target.includes("/") || target.includes("\\") || /[*?[\]{}$`;&|<>]/.test(target)) return "";
  return target;
}

export function extractPromptDeleteExtensionRequest(prompt) {
  const text = String(prompt || "");
  if (!/(?:删除|删掉|清理|移除|delete|remove)/i.test(text)) return null;
  const wantsDownloads = /(?:下载文件夹|下载目录|Downloads?|download folder)/i.test(text);
  if (!wantsDownloads) return null;
  const extMatch = text.match(/(?:后缀(?:是|为)?|扩展名(?:是|为)?|extension\s*)[：:\s.'"]*([A-Za-z0-9]{1,32})\b/i)
    || text.match(/(?:所有|全部|all)[\s\S]{0,24}\.([A-Za-z0-9]{1,32})\b/i)
    || text.match(/\.([A-Za-z0-9]{1,32})\s*(?:文件|files?)/i)
    || text.match(/\b(zip|rar|7z|xlsx?|csv|pdf|docx?|pptx?)\b/i);
  const extension = String(extMatch?.[1] || "").toLowerCase();
  if (!extension || /[^a-z0-9]/i.test(extension)) return null;
  return {
    folder: path.join(os.homedir(), "Downloads"),
    extension,
  };
}

export function buildDeleteExtensionCommand(request) {
  if (!request?.folder || !request?.extension) return "";
  const quotedFolder = shellQuote(request.folder);
  const pattern = "*." + request.extension;
  return [
    "dir=" + quotedFolder,
    'matches=$(find "$dir" -maxdepth 1 -type f -iname ' + shellQuote(pattern) + ' -print)',
    "if [ -z \"$matches\" ]; then echo '下载文件夹中没有 " + request.extension + " 文件。'",
    "else printf '%s\\n' \"$matches\"; printf '%s\\n' \"$matches\" | while IFS= read -r file; do rm -f \"$file\"; done; echo '=== 删除完成 ==='",
    "fi",
  ].join("; ");
}

export function normalizeMoveExtensionToken(token = "") {
  const raw = String(token || "").trim().toLowerCase();
  if (!raw) return [];
  if (/^(?:html?|网页)$/.test(raw)) return ["html", "htm"];
  if (/^(?:excel|表格|xlsx?|xlsm|csv)$/.test(raw)) return ["xlsx", "xls", "xlsm", "csv"];
  if (/^(?:pdf)$/.test(raw)) return ["pdf"];
  if (/^(?:图片|image|images?|照片|photo|photos?)$/.test(raw)) {
    return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tiff", "svg"];
  }
  if (/^[a-z0-9]{1,32}$/i.test(raw)) return [raw];
  return [];
}

export function resolveKnownFolderFromText(text = "", fallback = "") {
  const raw = String(text || "");
  if (/(?:下载文件夹|下载目录|Downloads?|download folder)/i.test(raw)) return path.join(os.homedir(), "Downloads");
  if (/(?:桌面|Desktop)/i.test(raw)) return path.join(os.homedir(), "Desktop");
  if (/(?:文稿|文档|Documents?)/i.test(raw)) return path.join(os.homedir(), "Documents");
  return fallback || "";
}

export function sanitizeFolderName(name = "") {
  const cleaned = String(name || "")
    .replace(/["'`“”]/g, "")
    .replace(/(?:的)?(?:文件夹|目录|folder)(?:里|中|内)?$/i, "")
    .replace(/^(?:到|至|进|进入|放进|放到|移动到|移到|挪到|拷贝到|复制到)\s*/i, "")
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "")
    .slice(0, 80);
  if (/^(?:一?个)?(?:新的?|新建(?:的)?|另?一个新的?)$/i.test(cleaned)) return "";
  return cleaned;
}

export function extractTargetFolderName(text = "") {
  const raw = String(text || "");
  const patterns = [
    /(?:移动到|移到|挪到|放到|放进|放入|归档到|整理到|复制到|拷贝到)\s*([^\n，。；;,.!?！？]{1,80})/i,
    /(?:都|全部|所有)[\s\S]{0,30}(?:放进|放到|移动到|移到|挪到)\s*([^\n，。；;,.!?！？]{1,80})/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const name = sanitizeFolderName(match?.[1] || "");
    if (name) return name;
  }
  return "";
}

export function extractPromptMoveExtensionRequest(prompt) {
  const text = String(prompt || "");
  const requirement = classifyRequestedLocalMutation(text);
  if (!requirement?.requiresMove) return null;

  const sourceFolder = resolveKnownFolderFromText(text);
  if (!sourceFolder) return null;

  const extMatch = text.match(/(?:后缀(?:是|为)?|扩展名(?:是|为)?|extension\s*)[：:\s.'"]*([A-Za-z0-9]{1,32})\b/i)
    || text.match(/(?:所有|全部|all)[\s\S]{0,28}\.([A-Za-z0-9]{1,32})\b/i)
    || text.match(/\b(html?|xlsx?|xlsm|csv|pdf|png|jpe?g|gif|webp|bmp|heic|svg)\b/i)
    || text.match(/(HTML?|Excel|表格|PDF|图片|照片)/i);
  const extensions = normalizeMoveExtensionToken(extMatch?.[1] || "");
  if (!extensions.length) return null;

  let targetName = extractTargetFolderName(text);
  if (!targetName) {
    targetName = extensions[0] === "pdf" ? "pdf"
      : extensions.includes("xlsx") ? "表格"
      : extensions.includes("html") ? "HTML"
      : extensions.includes("png") ? "图片"
      : extensions[0] + "文件";
  }

  let targetBase = sourceFolder;
  if (/^(?:桌面|Desktop)/i.test(targetName)) {
    targetBase = path.join(os.homedir(), "Desktop");
    targetName = sanitizeFolderName(targetName.replace(/^(?:桌面|Desktop)\s*/i, ""));
  } else if (/^(?:下载文件夹|下载目录|Downloads?|download folder)/i.test(targetName)) {
    targetBase = path.join(os.homedir(), "Downloads");
    targetName = sanitizeFolderName(targetName.replace(/^(?:下载文件夹|下载目录|Downloads?|download folder)\s*/i, ""));
  }
  if (!targetName) return null;

  return {
    sourceFolder,
    targetFolder: path.join(targetBase, targetName),
    extensions,
  };
}

export function buildMoveExtensionCommand(request) {
  if (!request?.sourceFolder || !request?.targetFolder || !Array.isArray(request.extensions) || !request.extensions.length) {
    return "";
  }
  const quotedSource = shellQuote(request.sourceFolder);
  const quotedTarget = shellQuote(request.targetFolder);
  const findPatterns = request.extensions
    .map((ext) => "-iname " + shellQuote("*." + ext))
    .join(" -o ");
  const label = request.extensions.join("/");
  return [
    "src=" + quotedSource,
    "dst=" + quotedTarget,
    'mkdir -p "$dst"',
    'matches=$(find "$src" -maxdepth 1 -type f \\( ' + findPatterns + ' \\) -print)',
    "if [ -z \"$matches\" ]; then echo '源文件夹中没有 " + label + " 文件。'; else printf '%s\\n' \"$matches\"; printf '%s\\n' \"$matches\" | while IFS= read -r file; do [ -n \"$file\" ] || continue; mv -n \"$file\" \"$dst/\"; done; echo '=== 移动命令已执行 ==='; find \"$dst\" -maxdepth 1 -type f \\( " + findPatterns + " \\) -print",
    "fi",
  ].join("; ");
}

// ════════════════════════════
//  Layer C — probe detection
// ════════════════════════════

export function looksLikeIncompleteLocalMutationProbe(toolName, args, resultText = "") {
  const name = String(toolName || "");
  if (name !== "bash" && name !== "find" && name !== "ls") return false;
  const command = String(args?.command || args?.query || args?.cmd || "").trim();
  if (!command) return true;
  if (/^(?:find|ls|pwd)\s*$/i.test(command)) return true;
  if (/^[<>/\\\s]+$/.test(command)) return true;
  const output = String(resultText || "");
  return /(?:usage:|illegal option|missing argument|unknown primary|No such file or directory|参数缺失)/i.test(output)
    && !/(?:\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\b-delete\b)/i.test(command);
}

export function looksLikeLocalMutationProbeCommand(toolRecord) {
  const name = String(toolRecord?.name || "");
  const command = String(toolRecord?.command || "").trim();
  if (name !== "bash" && name !== "find" && name !== "ls") return false;
  if (!command) return true;
  if (/\b(?:rm|mv|cp|trash|unlink|rmdir)\b|(?:^|\s)-delete(?:\s|$)/i.test(command)) return false;
  return /^(?:find|ls|pwd|mkdir\b)/i.test(command);
}

// ════════════════════════════
//  Layer B — orchestration (needs ss/session/engine)
// ════════════════════════════

function resolveCwd(session, engine) {
  return session?.sessionManager?.getCwd?.() || engine?.cwd || process.cwd();
}

function promptTextFromSS(ss) {
  return ss?.originalPromptText || ss?.effectivePromptText || "";
}

export function extractRecoverablePseudoBashCommand(text, ss, session, engine) {
  const requirement = classifyRequestedLocalMutation(promptTextFromSS(ss));
  if (!requirement) return "";

  const explicitPromptCommand = buildExplicitPromptMutationCommand(ss, session, engine);
  if (explicitPromptCommand) return explicitPromptCommand;

  const bashCommand = extractPseudoBashCommand(text);
  if (isMeaningfulRecoveredBashCommand(bashCommand)) return bashCommand;

  if (!requirement.requiresDelete) return "";
  const removePath = extractPseudoRemovePath(text);
  if (!removePath) return "";

  const cwd = resolveCwd(session, engine);
  const resolved = path.resolve(cwd, removePath);
  if (!isInsidePath(resolved, cwd)) return "";
  return "rm -f " + shellQuote(resolved) + " && ls -la " + shellQuote(path.dirname(resolved));
}

export function buildExplicitPromptDeleteCommand(ss, session, engine) {
  const requirement = classifyRequestedLocalMutation(promptTextFromSS(ss));
  if (!requirement?.requiresDelete) return "";
  const prompt = promptTextFromSS(ss);
  const extensionRequest = extractPromptDeleteExtensionRequest(prompt);
  if (extensionRequest) return buildDeleteExtensionCommand(extensionRequest);
  const target = extractExplicitDeleteTargetFromPrompt(prompt);
  if (!target) return "";
  const cwd = resolveCwd(session, engine);
  const resolved = path.resolve(cwd, target);
  if (!isInsidePath(resolved, cwd)) return "";
  const command = "rm -f " + shellQuote(resolved) + " && ls -la " + shellQuote(cwd);
  return isMeaningfulRecoveredBashCommand(command) ? command : "";
}

export function buildExplicitPromptMoveCommand(ss) {
  const prompt = promptTextFromSS(ss);
  const request = extractPromptMoveExtensionRequest(prompt);
  if (!request) return "";
  return buildMoveExtensionCommand(request);
}

export function buildExplicitPromptMutationCommand(ss, session, engine) {
  return buildExplicitPromptDeleteCommand(ss, session, engine)
    || buildExplicitPromptMoveCommand(ss, session, engine);
}
