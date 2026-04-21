const PSEUDO_TOOL_TAG_RE = /<(?:\/)?(?:tool[\w:-]*|lynn_tool_progress[\w:-]*|execute[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b|<(?:function|parameter)=/iu;
const PSEUDO_SHELL_LINE_RE = /^\s*(?:(?:shell|bash|terminal|cmd|powershell)(?:\s*[:：])?\s*(?:[>》〉»›≫$#]+)|(?:\$|#)\s+(?:(?:ls|find|grep|rg|cat|pwd|read|python|node|npm|git|bash|sh)\b)).*$/iu;
const BARE_PSEUDO_COMMAND_LINE_RE = /^\s*(?:(?:find|ls|grep|rg|cat|pwd|glob|read|read_file|invoke|exec|bash)\b.*(?:\/Users\/|[A-Za-z]:\\|2>\/dev\/null|\|\||&&|-maxdepth|-name\b|pattern=|path=|command=).*)$/iu;
const READ_TOOL_LEAK_RE = /^\s*(?:read_tool(?:_missing_error)?(?:>|:)?|read_tool_missing_error)\b/iu;
const REPEATED_READ_TOOL_ERROR_RE = /(?:read_tool_missing_error\s*){2,}/giu;
const KNOWN_TOOL_NAMES = new Set([
  "apply_patch",
  "ask_agent",
  "bash",
  "browser",
  "channel",
  "close_agent",
  "create_artifact",
  "cron",
  "delete_file",
  "delegate",
  "dm",
  "edit",
  "edit-diff",
  "execute",
  "execute_command",
  "fetch",
  "find",
  "glob",
  "grep",
  "image_gen",
  "install_skill",
  "list_dir",
  "ls",
  "message_agent",
  "notify",
  "pin_memory",
  "present_files",
  "preview_url",
  "read",
  "read_file",
  "recall_experience",
  "record_experience",
  "replace_in_file",
  "request_user_input",
  "resume_agent",
  "search_content",
  "search_memory",
  "send_input",
  "sports_score",
  "spawn_agent",
  "stock_market",
  "todo",
  "unpin_memory",
  "update_settings",
  "view_image",
  "wait_agent",
  "weather",
  "web_fetch",
  "web_search",
  "live_news",
  "write",
  "write_to_file",
]);
const KNOWN_TOOL_PREFIXES = [
  "web_",
  "search_",
  "pin_",
  "unpin_",
  "record_",
  "recall_",
  "create_",
  "message_",
  "request_",
  "spawn_",
  "send_",
  "wait_",
  "close_",
  "resume_",
];

function stripToolCodeMarkup(raw) {
  return String(raw || "")
    .replace(/<tool_code\b[\s\S]*?<\/tool_code>\s*/gi, "")
    .replace(/<tool\b[\s\S]*?<\/tool>\s*/gi, "")
    .replace(/<lynn_tool_progress\b[\s\S]*?<\/lynn_tool_progress>\s*/gi, "")
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>\s*/gi, "")
    .replace(/<execute\b[\s\S]*?<\/execute>\s*/gi, "")
    .replace(/<minimax:tool_call\b[\s\S]*?<\/minimax:tool_call>\s*/gi, "")
    .replace(/<invoke\b[\s\S]*?<\/invoke>\s*/gi, "")
    .replace(/<read\b[\s\S]*?<\/read>\s*/gi, "")
    .replace(/<read_file\b[\s\S]*?<\/read_file>\s*/gi, "");
}

function looksLikeKnownToolName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return false;
  if (KNOWN_TOOL_NAMES.has(normalized)) return true;
  return KNOWN_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function stripLeadingPseudoArgs(line) {
  return line
    .replace(
      /^\s*(?:[a-z_][\w:-]*)(?:\s+[a-z_][\w:-]*=(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s]+))+\s*/i,
      "",
    )
    .replace(/^\s*\/?(?:[a-z_][\w:-]*)\s*$/i, "");
}

function looksLikeStandalonePseudoToolCall(paragraph) {
  const text = String(paragraph || "").trim();
  if (!text || text.startsWith("```") || text.startsWith(">")) return false;

  const openParen = text.indexOf("(");
  const closeParen = text.lastIndexOf(")");
  if (openParen <= 0 || closeParen !== text.length - 1) return false;

  const name = text.slice(0, openParen).trim();
  if (!/^[a-z][a-z0-9_.-]*$/i.test(name)) return false;
  if (!looksLikeKnownToolName(name)) return false;

  const args = text.slice(openParen + 1, -1).trim();
  if (!args) return false;

  return /(?:^|[,(]\s*)(?:[a-z_][a-z0-9_]*|querys|queries)\s*=|\[|\]|\{|\}/i.test(args);
}

function cleanPseudoToolLine(line) {
  let cleaned = String(line ?? "");
  if (READ_TOOL_LEAK_RE.test(cleaned)) return "";
  if (PSEUDO_SHELL_LINE_RE.test(cleaned) || BARE_PSEUDO_COMMAND_LINE_RE.test(cleaned)) return "";
  if (looksLikeStandalonePseudoToolCall(cleaned)) return "";
  if (!PSEUDO_TOOL_TAG_RE.test(cleaned)) return cleaned;

  cleaned = cleaned
    .replace(/<\/?(?:tool[\w:-]*|lynn_tool_progress[\w:-]*|execute[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b[^>\n]*(?:>|$)/giu, "")
    .replace(/<(?:function|parameter)=[^>\n]*(?:>|$)/giu, "");

  return stripLeadingPseudoArgs(cleaned);
}

export function countPseudoToolMarkers(raw) {
  const text = String(raw || "");
  if (!text) return 0;

  const tagMatches = text.match(/<(?:\/)?(?:tool[\w:-]*|lynn_tool_progress[\w:-]*|execute[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b|<(?:function|parameter)=/giu) || [];
  const argLineMatches = text.match(/^\s*(?:list_dir|glob|read|read_file|invoke|exec|bash)\b[\s\S]*?(?:path=|pattern=|command=|limit=)/gim) || [];
  const shellLineMatches = text.match(/^\s*(?:(?:shell|bash|terminal|cmd|powershell)(?:\s*[:：])?\s*(?:[>》〉»›≫$#]+)|(?:\$|#)\s+(?:(?:ls|find|grep|rg|cat|pwd|read|python|node|npm|git|bash|sh)\b)).*$/gimu) || [];
  const bareCommandMatches = text.match(/^\s*(?:(?:find|ls|grep|rg|cat|pwd|glob|read|read_file|invoke|exec|bash)\b.*(?:\/Users\/|[A-Za-z]:\\|2>\/dev\/null|\|\||&&|-maxdepth|-name\b|pattern=|path=|command=).*)$/gimu) || [];
  const readToolLeakMatches = text.match(/^\s*(?:read_tool(?:_missing_error)?(?:>|:)?|read_tool_missing_error)\b.*$/gimu) || [];
  const functionCallMatches = stripToolCodeMarkup(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .filter((paragraph) => looksLikeStandalonePseudoToolCall(paragraph));
  return tagMatches.length
    + argLineMatches.length
    + shellLineMatches.length
    + bareCommandMatches.length
    + readToolLeakMatches.length
    + functionCallMatches.length;
}

export function containsPseudoToolSimulation(raw) {
  const text = String(raw || "");
  if (!text) return false;
  if (READ_TOOL_LEAK_RE.test(text) || REPEATED_READ_TOOL_ERROR_RE.test(text)) return true;
  if (PSEUDO_TOOL_TAG_RE.test(text)) return true;
  if (PSEUDO_SHELL_LINE_RE.test(text)) return true;
  if (BARE_PSEUDO_COMMAND_LINE_RE.test(text)) return true;
  const cleaned = stripToolCodeMarkup(text).trim();
  if (!cleaned) return false;
  if (/^\s*(?:list_dir|glob|read|read_file|invoke|exec|bash)\b[\s\S]*?(?:path=|pattern=|command=|limit=)/im.test(cleaned)) {
    return true;
  }
  return cleaned
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .some((paragraph) => looksLikeStandalonePseudoToolCall(paragraph));
}

export function stripPseudoToolCallMarkup(raw) {
  let text = stripToolCodeMarkup(raw);
  if (!text) return "";

  // Strip Qwen-style tool call markup: <|tool_calls_section_begin|>...<|tool_calls_section_end|>
  text = text.replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, "");
  // Strip partial/unclosed Qwen tool tags
  text = text.replace(/<\|tool_call(?:s_section)?_(?:begin|end)\|>/g, "");
  text = text.replace(/<\|tool_call_argument_(?:begin|end)\|>/g, "");

  text = text
    .replace(REPEATED_READ_TOOL_ERROR_RE, "")
    .split("\n")
    .map(cleanPseudoToolLine)
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !looksLikeStandalonePseudoToolCall(paragraph))
    .join("\n\n");

  return text;
}
