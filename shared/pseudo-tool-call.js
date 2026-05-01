/**
 * 伪工具调用检测 + 剥离 — 统一 pattern registry
 *
 * 所有检测/计数/剥离都走同一个 PSEUDO_PATTERNS 数组，新增 pattern 只需加一处。
 */

// ── Pattern registry ──
// 每个 pattern: { name, detectRe, strip?(text) => cleanedText }
// detectRe 用于 contains + count; strip 用于全文清理。

const TEMPLATE_TOOL_TAG_NAMES = [
  "tavily", "search", "search_query", "search_result", "search_results",
  "tool_call", "tool_calls", "_calls", "calls", "inv",
  "argument", "arguments", "args", "json",
  "result", "results", "response", "responses",
];
const TEMPLATE_TAG_SOURCE = TEMPLATE_TOOL_TAG_NAMES
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const TEMPLATE_TOOL_TAG_RE = new RegExp(`<(?:\\/)?(?:${TEMPLATE_TAG_SOURCE})\\b`, "iu");
const TEMPLATE_TOOL_TAG_GLOBAL_RE = new RegExp(`<(?:\\/)?(?:${TEMPLATE_TAG_SOURCE})\\b[^>\\n]*(?:>|$)`, "giu");
const TEMPLATE_TOOL_BLOCK_RE = new RegExp(`<(${TEMPLATE_TAG_SOURCE})\\b[\\s\\S]*?<\\/\\1>\\s*`, "giu");
const ORPHAN_TEMPLATE_FRAGMENT_RE = /(?:^|[\s>])(?:t?avily|_?calls?|inv)>\s*/giu;

const PSEUDO_TOOL_TAG_RE = /<(?:\/)?(?:tool[\w:-]*|lynn_tool_progress[\w:-]*|execute[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b|<(?:function|parameter)=/iu;
const PSEUDO_TOOL_TAG_GLOBAL_RE = /<\/?(?:tool[\w:-]*|lynn_tool_progress[\w:-]*|execute[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b[^>\n]*(?:>|$)/giu;
const FUNCTION_PARAM_GLOBAL_RE = /<(?:function|parameter)=[^>\n]*(?:>|$)/giu;

const PIPE_NUMBERED_PSEUDO_TOOL_RE = /\|\|\d+\s*[a-z_][a-z0-9_]*\s*\|\|\s*\{[\s\S]*?\}\s*/giu;
const TRAILING_PIPE_NUM_RE = /\|\|\d+\s*$/u;

const TOOL_PARAMS_FENCE_RE = /```[ \t]*(?:[a-z][\w.-]*\/)?(?:tool_params|tool-params|toolparams)\b[\s\S]*?```/giu;

const PSEUDO_SHELL_LINE_RE = /^\s*(?:(?:shell|bash|terminal|cmd|powershell)(?:\s*[:：])?\s*(?:[>》〉»›≫$#]+)|(?:\$|#)\s+(?:(?:ls|find|grep|rg|cat|pwd|read|python|node|npm|git|bash|sh)\b)).*$/iu;
const BARE_PSEUDO_COMMAND_LINE_RE = /^\s*(?:(?:find|ls|grep|rg|cat|pwd|glob|read|read_file|invoke|exec|bash)\b.*(?:\/Users\/|[A-Za-z]:\\|2>\/dev\/null|\|\||&&|-maxdepth|-name\b|pattern=|path=|command=).*)$/iu;
const ARG_LINE_PSEUDO_RE = /^\s*(?:list_dir|glob|read|read_file|invoke|exec|bash)\b[^\n]*(?:path=|pattern=|command=|limit=)/iu;
const ARG_LINE_PSEUDO_GLOBAL_RE = /^\s*(?:list_dir|glob|read|read_file|invoke|exec|bash)\b[^\n]*(?:path=|pattern=|command=|limit=).*$/gimu;

const READ_TOOL_LEAK_RE = /^\s*(?:read_tool(?:_missing_error)?(?:>|:)?|read_tool_missing_error)\b/iu;
const REPEATED_READ_TOOL_ERROR_RE = /(?:read_tool_missing_error\s*){2,}/giu;

const QWEN_TOOL_CALL_SECTION_RE = /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/giu;
const QWEN_TOOL_CALL_MARKER_RE = /<\|tool_call(?:s_section)?_(?:begin|end)\|>|<\|tool_call_argument_(?:begin|end)\|>/giu;
const QWEN_TOOL_CODE_BLOCK_RE = /<\|tool_code_begin\|>[\s\S]*?<\|tool_code_end\|>/giu;
const QWEN_TOOL_CODE_MARKER_RE = /<\|tool_code_(?:begin|end)\|>/giu;
const THINK_TAG_RE = /<\/?think\b[^>]*>/giu;

const KNOWN_TOOL_NAME_LIST = [
  "apply_patch", "ask_agent", "bash", "browser", "channel", "close_agent",
  "create_artifact", "cron", "delete_file", "delegate", "dm", "edit", "edit-diff",
  "execute", "execute_command", "fetch", "find", "glob", "grep", "image_gen",
  "install_skill", "list_dir", "ls", "message_agent", "notify", "pin_memory",
  "present_files", "preview_url", "read", "read_file", "recall_experience",
  "record_experience", "replace_in_file", "request_user_input", "resume_agent",
  "search_content", "search_memory", "send_input", "sports_score", "spawn_agent",
  "stock_market", "todo", "unpin_memory", "update_settings", "view_image",
  "wait_agent", "weather", "web_fetch", "web_search", "live_news", "write", "write_to_file",
  // File-operation aliases emitted by some model/tool templates.
  "find_files", "list_files", "delete_files", "move_files", "move_file",
  "fs_delete", "fs_move", "fs_list",
];
const KNOWN_TOOL_NAMES = new Set(KNOWN_TOOL_NAME_LIST);
const KNOWN_TOOL_PREFIXES = [
  "web_", "search_", "pin_", "unpin_", "record_", "recall_",
  "create_", "message_", "request_", "spawn_", "send_", "wait_", "close_", "resume_",
];

function escapeRegExpSource(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STREAMING_PSEUDO_XML_EXTRA_TAG_NAMES = [
  "code", "pre", "details", "summary", "think",
  "tool", "function", "parameter", "execute",
];

export const STREAMING_PSEUDO_XML_TAG_NAMES = Object.freeze([
  ...new Set([
    ...KNOWN_TOOL_NAME_LIST,
    ...TEMPLATE_TOOL_TAG_NAMES,
    ...STREAMING_PSEUDO_XML_EXTRA_TAG_NAMES,
  ]),
]);

export const STREAMING_PSEUDO_XML_TAG_SOURCE = STREAMING_PSEUDO_XML_TAG_NAMES
  .map(escapeRegExpSource)
  .join("|");

export function createStreamingPseudoXmlOpenRegex() {
  return new RegExp(`<(${STREAMING_PSEUDO_XML_TAG_SOURCE})\\b[^>\\n]*(?:>|$)`, "iu");
}

export function createStreamingPseudoXmlOrphanCloseRegex() {
  return new RegExp(`</_?(?:${STREAMING_PSEUDO_XML_TAG_SOURCE})\\s*>`, "giu");
}

export function createStreamingPseudoXmlOrphanFragmentRegex() {
  return /(?:^|[\s>])(?:t?avily|_?calls?|inv)>\s*/giu;
}

const KNOWN_TOOL_XML_TAG_SOURCE = KNOWN_TOOL_NAME_LIST
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const KNOWN_TOOL_XML_TAG_GLOBAL_RE = new RegExp(`<(?:\\/)?(?:${KNOWN_TOOL_XML_TAG_SOURCE})\\b[^>\\n]*(?:>|$)`, "giu");
const KNOWN_TOOL_XML_BLOCK_RE = new RegExp(`<(${KNOWN_TOOL_XML_TAG_SOURCE})\\b[\\s\\S]*?<\\/\\1>\\s*`, "giu");
const TOOL_NAME_JSON_ARGS_BLOCK_RE = new RegExp(
  `(?:^|\\n)\\s*(?:${KNOWN_TOOL_XML_TAG_SOURCE})\\s*\\n+\\s*[\\[{][\\s\\S]*?[\\]}]\\s*(?=\\n|$)`,
  "giu",
);

function testPattern(re, text) {
  re.lastIndex = 0;
  const matched = re.test(text);
  re.lastIndex = 0;
  return matched;
}

function looksLikeKnownToolName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return false;
  if (KNOWN_TOOL_NAMES.has(normalized)) return true;
  return KNOWN_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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

// ── Unified pattern array ──
// 每个 entry: { name, detect(text) => boolean, count(text) => number, strip(text) => text }
// count 返回匹配到的伪标记数量（用于 contains 只需 >0 则 true）

const PSEUDO_PATTERNS = [
  {
    name: "qwen_tool_call_markup",
    detect: (t) => (
      testPattern(QWEN_TOOL_CALL_SECTION_RE, t) ||
      testPattern(QWEN_TOOL_CALL_MARKER_RE, t) ||
      testPattern(QWEN_TOOL_CODE_BLOCK_RE, t) ||
      testPattern(QWEN_TOOL_CODE_MARKER_RE, t)
    ),
    count: (t) => {
      const sections = t.match(QWEN_TOOL_CALL_SECTION_RE) || [];
      if (sections.length) return sections.length;
      const codeBlocks = t.match(QWEN_TOOL_CODE_BLOCK_RE) || [];
      if (codeBlocks.length) return codeBlocks.length;
      return (t.match(QWEN_TOOL_CALL_MARKER_RE) || []).length +
        (t.match(QWEN_TOOL_CODE_MARKER_RE) || []).length;
    },
    strip: (t) => t
      .replace(QWEN_TOOL_CALL_SECTION_RE, "")
      .replace(QWEN_TOOL_CODE_BLOCK_RE, "")
      .replace(QWEN_TOOL_CALL_MARKER_RE, "")
      .replace(QWEN_TOOL_CODE_MARKER_RE, ""),
  },
  {
    name: "known_tool_xml_tag",
    detect: (t) => testPattern(KNOWN_TOOL_XML_TAG_GLOBAL_RE, t),
    count: (t) => (t.match(KNOWN_TOOL_XML_TAG_GLOBAL_RE) || []).length,
    strip: (t) => t.replace(KNOWN_TOOL_XML_TAG_GLOBAL_RE, ""),
  },
  {
    name: "tool_name_json_args_block",
    detect: (t) => testPattern(TOOL_NAME_JSON_ARGS_BLOCK_RE, t),
    count: (t) => (t.match(TOOL_NAME_JSON_ARGS_BLOCK_RE) || []).length,
    strip: (t) => t.replace(TOOL_NAME_JSON_ARGS_BLOCK_RE, ""),
  },
  {
    name: "known_tool_xml_block",
    detect: (t) => testPattern(KNOWN_TOOL_XML_BLOCK_RE, t),
    count: (t) => (t.match(KNOWN_TOOL_XML_BLOCK_RE) || []).length,
    strip: (t) => stripToolCodeMarkup(t),
  },
  {
    name: "read_tool_leak",
    detect: (t) => READ_TOOL_LEAK_RE.test(t) || testPattern(REPEATED_READ_TOOL_ERROR_RE, t),
    count: (t) => {
      const line = t.match(/^\s*(?:read_tool(?:_missing_error)?(?:>|:)?|read_tool_missing_error)\b.*$/gimu) || [];
      const repeated = t.match(REPEATED_READ_TOOL_ERROR_RE) || [];
      return line.length + repeated.length;
    },
    strip: (t) => t.replace(REPEATED_READ_TOOL_ERROR_RE, ""),
  },
  {
    name: "pseudo_tool_tag",
    detect: (t) => PSEUDO_TOOL_TAG_RE.test(t),
    count: (t) => (t.match(/<(?:\/)?(?:tool[\w:-]*|lynn_tool_progress[\w:-]*|execute[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b|<(?:function|parameter)=/giu) || []).length,
    strip: (t) => t
      .replace(PSEUDO_TOOL_TAG_GLOBAL_RE, "")
      .replace(FUNCTION_PARAM_GLOBAL_RE, ""),
  },
  {
    name: "template_tool_tag",
    detect: (t) => TEMPLATE_TOOL_TAG_RE.test(t),
    count: (t) => (t.match(TEMPLATE_TOOL_TAG_GLOBAL_RE) || []).length,
    strip: (t) => t.replace(TEMPLATE_TOOL_TAG_GLOBAL_RE, ""),
  },
  {
    name: "template_tool_block",
    detect: (t) => testPattern(TEMPLATE_TOOL_BLOCK_RE, t),
    count: (t) => (t.match(TEMPLATE_TOOL_BLOCK_RE) || []).length,
    strip: (t) => stripToolCodeMarkup(t), // block-level: 委托给统一清理
  },
  {
    name: "orphan_template_fragment",
    detect: (t) => testPattern(ORPHAN_TEMPLATE_FRAGMENT_RE, t),
    count: (t) => (t.match(ORPHAN_TEMPLATE_FRAGMENT_RE) || []).length,
    strip: (t) => t.replace(ORPHAN_TEMPLATE_FRAGMENT_RE, ""),
  },
  {
    name: "pseudo_shell_line",
    detect: (t) => PSEUDO_SHELL_LINE_RE.test(t),
    count: (t) => (t.match(/^\s*(?:(?:shell|bash|terminal|cmd|powershell)(?:\s*[:：])?\s*(?:[>》〉»›≫$#]+)|(?:\$|#)\s+(?:(?:ls|find|grep|rg|cat|pwd|read|python|node|npm|git|bash|sh)\b)).*$/gimu) || []).length,
    strip: (t) => t.split("\n").filter((l) => !PSEUDO_SHELL_LINE_RE.test(l)).join("\n"),
  },
  {
    name: "bare_pseudo_command",
    detect: (t) => BARE_PSEUDO_COMMAND_LINE_RE.test(t),
    count: (t) => (t.match(/^\s*(?:(?:find|ls|grep|rg|cat|pwd|glob|read|read_file|invoke|exec|bash)\b.*(?:\/Users\/|[A-Za-z]:\\|2>\/dev\/null|\|\||&&|-maxdepth|-name\b|pattern=|path=|command=).*)$/gimu) || []).length,
    strip: (t) => t.split("\n").filter((l) => !BARE_PSEUDO_COMMAND_LINE_RE.test(l)).join("\n"),
  },
  {
    name: "pipe_numbered_pseudo_tool",
    detect: (t) => testPattern(PIPE_NUMBERED_PSEUDO_TOOL_RE, t),
    count: (t) => (t.match(PIPE_NUMBERED_PSEUDO_TOOL_RE) || []).length,
    strip: (t) => t.replace(PIPE_NUMBERED_PSEUDO_TOOL_RE, "").replace(TRAILING_PIPE_NUM_RE, ""),
  },
  {
    name: "tool_params_fence",
    detect: (t) => testPattern(TOOL_PARAMS_FENCE_RE, t),
    count: (t) => (t.match(TOOL_PARAMS_FENCE_RE) || []).length,
    strip: (t) => t.replace(TOOL_PARAMS_FENCE_RE, ""),
  },
  {
    name: "arg_line_pseudo",
    detect: (t) => ARG_LINE_PSEUDO_RE.test(t),
    count: (t) => (t.match(ARG_LINE_PSEUDO_GLOBAL_RE) || []).length,
    strip: (t) => t.split("\n").filter((l) => !ARG_LINE_PSEUDO_RE.test(l)).join("\n"),
  },
  {
    name: "standalone_function_call",
    detect: (t) => {
      const cleaned = stripToolCodeMarkup(t).trim();
      if (!cleaned) return false;
      return cleaned.split(/\n\s*\n/).filter(Boolean).some(looksLikeStandalonePseudoToolCall);
    },
    count: (t) => stripToolCodeMarkup(t)
      .split(/\n\s*\n/)
      .filter(Boolean)
      .filter(looksLikeStandalonePseudoToolCall).length,
    strip: (t) => {
      const cleaned = stripToolCodeMarkup(t).trim();
      if (!cleaned) return "";
      return cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !looksLikeStandalonePseudoToolCall(p)).join("\n\n");
    },
  },
];

// ── Block-level tool markup stripper (shared by template_tool_block + standalone_function_call) ──

function stripToolCodeMarkup(raw) {
  return String(raw || "")
    .replace(TOOL_PARAMS_FENCE_RE, "")
    .replace(QWEN_TOOL_CODE_BLOCK_RE, "")
    .replace(QWEN_TOOL_CODE_MARKER_RE, "")
    .replace(TOOL_NAME_JSON_ARGS_BLOCK_RE, "")
    .replace(KNOWN_TOOL_XML_BLOCK_RE, "")
    .replace(/<tool_call\b[^\n>]*(?:>|$)[^\n]*?<\/arg_value>\s*/giu, "")
    .replace(TEMPLATE_TOOL_BLOCK_RE, "")
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

// ── Public API ──

export function containsPseudoToolSimulation(raw) {
  const text = String(raw || "");
  if (!text) return false;
  return PSEUDO_PATTERNS.some((p) => p.detect(text));
}

export function countPseudoToolMarkers(raw) {
  const text = String(raw || "");
  if (!text) return 0;
  return PSEUDO_PATTERNS.reduce((sum, p) => sum + p.count(text), 0);
}

export function stripPseudoToolCallMarkup(raw) {
  let text = stripToolCodeMarkup(raw);
  if (!text) return "";

  // Strip leaked thinking tag boundaries; actual thinking content is handled upstream.
  text = text.replace(THINK_TAG_RE, "");

  // Strip Qwen-style tool call markup
  text = text.replace(QWEN_TOOL_CALL_SECTION_RE, "");
  text = text.replace(QWEN_TOOL_CODE_BLOCK_RE, "");
  text = text.replace(QWEN_TOOL_CALL_MARKER_RE, "");
  text = text.replace(QWEN_TOOL_CODE_MARKER_RE, "");

  // Strip pipe-numbered
  text = text.replace(PIPE_NUMBERED_PSEUDO_TOOL_RE, "");
  text = text.replace(TRAILING_PIPE_NUM_RE, "");

  // Strip tool_params fence
  text = text.replace(TOOL_PARAMS_FENCE_RE, "");
  text = text.replace(TOOL_NAME_JSON_ARGS_BLOCK_RE, "");

  // Strip template tags
  text = text.replace(TEMPLATE_TOOL_TAG_GLOBAL_RE, "");
  text = text.replace(ORPHAN_TEMPLATE_FRAGMENT_RE, "");

  // Apply inline patterns
  text = text.replace(REPEATED_READ_TOOL_ERROR_RE, "");

  // Per-line stripping
  text = text
    .split("\n")
    .map((line) => {
      let cleaned = String(line ?? "");
      if (READ_TOOL_LEAK_RE.test(cleaned)) return "";
      if (ARG_LINE_PSEUDO_RE.test(cleaned)) return "";
      if (PSEUDO_SHELL_LINE_RE.test(cleaned) || BARE_PSEUDO_COMMAND_LINE_RE.test(cleaned)) return "";
      if (looksLikeStandalonePseudoToolCall(cleaned)) return "";
      // Clean inline tags on non-standalone lines
      ORPHAN_TEMPLATE_FRAGMENT_RE.lastIndex = 0;
      const hasKnownToolXmlTag = testPattern(KNOWN_TOOL_XML_TAG_GLOBAL_RE, cleaned);
      if (!hasKnownToolXmlTag && !PSEUDO_TOOL_TAG_RE.test(cleaned) && !TEMPLATE_TOOL_TAG_RE.test(cleaned) && !ORPHAN_TEMPLATE_FRAGMENT_RE.test(cleaned)) return cleaned;
      ORPHAN_TEMPLATE_FRAGMENT_RE.lastIndex = 0;
      cleaned = cleaned
        .replace(KNOWN_TOOL_XML_TAG_GLOBAL_RE, "")
        .replace(TEMPLATE_TOOL_TAG_GLOBAL_RE, "")
        .replace(PSEUDO_TOOL_TAG_GLOBAL_RE, "")
        .replace(FUNCTION_PARAM_GLOBAL_RE, "")
        .replace(ORPHAN_TEMPLATE_FRAGMENT_RE, "");
      return cleaned
        .replace(
          /^\s*(?:[a-z_][\w:-]*)(?:\s+[a-z_][\w:-]*=(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s]+))+\s*/i,
          "",
        )
        .replace(/^\s*\/?(?:[a-z_][\w:-]*)\s*$/i, "");
    })
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  // Per-paragraph: remove standalone pseudo calls
  text = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !looksLikeStandalonePseudoToolCall(p))
    .join("\n\n");

  return text;
}
