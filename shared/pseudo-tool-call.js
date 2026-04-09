const PSEUDO_TOOL_TAG_RE = /<(?:\/)?(?:tool[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b|<(?:function|parameter)=/iu;
const PSEUDO_SHELL_LINE_RE = /^\s*(?:(?:shell|bash|terminal|cmd|powershell)(?:\s*[:：])?\s*(?:[>》〉»›≫$#]+)|(?:\$|#)\s+(?:(?:ls|find|grep|rg|cat|pwd|read|python|node|npm|git|bash|sh)\b)).*$/iu;
const BARE_PSEUDO_COMMAND_LINE_RE = /^\s*(?:(?:find|ls|grep|rg|cat|pwd|glob|read|read_file|invoke|exec|bash)\b.*(?:\/Users\/|[A-Za-z]:\\|2>\/dev\/null|\|\||&&|-maxdepth|-name\b|pattern=|path=|command=).*)$/iu;

function stripLeadingPseudoArgs(line) {
  return line
    .replace(
      /^\s*(?:[a-z_][\w:-]*)(?:\s+[a-z_][\w:-]*=(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s]+))+\s*/i,
      "",
    )
    .replace(/^\s*\/?(?:[a-z_][\w:-]*)\s*$/i, "");
}

function cleanPseudoToolLine(line) {
  let cleaned = String(line ?? "");
  if (PSEUDO_SHELL_LINE_RE.test(cleaned) || BARE_PSEUDO_COMMAND_LINE_RE.test(cleaned)) return "";
  if (!PSEUDO_TOOL_TAG_RE.test(cleaned)) return cleaned;

  cleaned = cleaned
    .replace(/<\/?(?:tool[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b[^>\n]*(?:>|$)/giu, "")
    .replace(/<(?:function|parameter)=[^>\n]*(?:>|$)/giu, "");

  return stripLeadingPseudoArgs(cleaned);
}

export function countPseudoToolMarkers(raw) {
  const text = String(raw || "");
  if (!text) return 0;

  const tagMatches = text.match(/<(?:\/)?(?:tool[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b|<(?:function|parameter)=/giu) || [];
  const argLineMatches = text.match(/^\s*(?:list_dir|glob|read|read_file|invoke|exec|bash)\b[\s\S]*?(?:path=|pattern=|command=|limit=)/gim) || [];
  const shellLineMatches = text.match(/^\s*(?:(?:shell|bash|terminal|cmd|powershell)(?:\s*[:：])?\s*(?:[>»›≫$#]+)|(?:\$|#)\s+(?:(?:ls|find|grep|rg|cat|pwd|read|python|node|npm|git|bash|sh)\b)).*$/gimu) || [];
  const bareCommandMatches = text.match(/^\s*(?:(?:find|ls|grep|rg|cat|pwd|glob|read|read_file|invoke|exec|bash)\b.*(?:\/Users\/|[A-Za-z]:\\|2>\/dev\/null|\|\||&&|-maxdepth|-name\b|pattern=|path=|command=).*)$/gimu) || [];
  return tagMatches.length + argLineMatches.length + shellLineMatches.length + bareCommandMatches.length;
}

export function containsPseudoToolSimulation(raw) {
  const text = String(raw || "");
  if (!text) return false;
  if (PSEUDO_TOOL_TAG_RE.test(text)) return true;
  if (PSEUDO_SHELL_LINE_RE.test(text)) return true;
  if (BARE_PSEUDO_COMMAND_LINE_RE.test(text)) return true;
  return /^\s*(?:list_dir|glob|read|read_file|invoke|exec|bash)\b[\s\S]*?(?:path=|pattern=|command=|limit=)/im.test(text);
}

export function stripPseudoToolCallMarkup(raw) {
  let text = String(raw || "");
  if (!text) return "";

  text = text
    .replace(/<tool_code\b[\s\S]*?<\/tool_code>\s*/gi, "")
    .replace(/<tool\b[\s\S]*?<\/tool>\s*/gi, "")
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>\s*/gi, "")
    .replace(/<minimax:tool_call\b[\s\S]*?<\/minimax:tool_call>\s*/gi, "")
    .replace(/<invoke\b[\s\S]*?<\/invoke>\s*/gi, "")
    .replace(/<read\b[\s\S]*?<\/read>\s*/gi, "")
    .replace(/<read_file\b[\s\S]*?<\/read_file>\s*/gi, "");

  text = text
    .split("\n")
    .map(cleanPseudoToolLine)
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  return text;
}
