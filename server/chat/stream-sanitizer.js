/**
 * 流式文本清洗 — pseudo XML/tool 标记剥离
 *
 * 处理模型在 streaming text 中泄漏的内部 XML 标签、伪工具调用标记、
 * chunk 边界切割问题。从 server/routes/chat.js 提取。
 */
import { containsPseudoToolCallSimulation } from "../../core/llm-utils.js";

const STREAM_PSEUDO_XML_TOOLS = [
  // 真工具名(brain 转发的)
  "web_search", "web_fetch", "live_news", "weather", "stock_market", "sports_score",
  "bash", "read", "read_file", "write", "edit", "find", "grep", "glob",
  // 常见 markdown / 假工具协议 tag
  "code", "pre", "details", "summary", "think",
  "tool_call", "tool_calls", "tavily",
  "search", "search_query", "search_result", "search_results",
  "_calls", "calls", "inv",
  "argument", "arguments", "args", "json",
  "result", "results", "response", "responses",
  "function", "parameter", "execute", "tool",
];

const ORPHAN_CLOSE_TAG_RE = /<\/_?(?:tavily|search|search_query|search_result|search_results|tool_calls?|calls?|inv|arguments?|args|json|results?|responses?|function|parameter|execute|tool|code|pre|details|summary|think)\s*>/giu;
const ORPHAN_TEMPLATE_TAG_FRAGMENT_RE = /(?:^|[\s>])(?:t?avily|_?calls?|inv)>\s*/giu;
const STREAM_PSEUDO_XML_TOOL_SOURCE = STREAM_PSEUDO_XML_TOOLS
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const STREAM_PSEUDO_XML_OPEN_RE = new RegExp(`<(${STREAM_PSEUDO_XML_TOOL_SOURCE})\\b[^>\\n]*(?:>|$)`, "iu");
const PARTIAL_CLOSE_TAG_TAIL_RE = /<\/?[a-zA-Z][a-zA-Z0-9_-]{0,20}\s*$/;

function closePseudoXmlRe(toolName) {
  const escaped = String(toolName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`</\\s*${escaped}\\s*>`, "iu");
}

/**
 * 从 streaming text chunk 中剥离伪 XML tool 块。
 * 处理 chunk 边界切割：末尾半截 `</...` 计入 ss.pseudoCloseTagBuffer 等下个 chunk 拼接。
 */
export function stripStreamingPseudoToolBlocks(ss, chunk) {
  let rest = String((ss?.pseudoCloseTagBuffer || "") + (chunk || ""));
  if (ss) ss.pseudoCloseTagBuffer = "";
  let text = "";
  let suppressed = false;

  while (rest) {
    if (ss?.pseudoToolXmlBlock) {
      suppressed = true;
      const closeRe = closePseudoXmlRe(ss.pseudoToolXmlBlock);
      const closeMatch = rest.match(closeRe);
      if (!closeMatch) return { text, suppressed };
      rest = rest.slice((closeMatch.index || 0) + closeMatch[0].length);
      ss.pseudoToolXmlBlock = null;
      continue;
    }

    const openMatch = rest.match(STREAM_PSEUDO_XML_OPEN_RE);
    if (!openMatch) {
      text += rest;
      break;
    }

    const openIndex = openMatch.index || 0;
    text += rest.slice(0, openIndex);
    suppressed = true;

    const toolName = String(openMatch[1] || "").toLowerCase();
    const afterOpen = rest.slice(openIndex + openMatch[0].length);
    const closeMatch = afterOpen.match(closePseudoXmlRe(toolName));
    if (!closeMatch) {
      ss.pseudoToolXmlBlock = toolName;
      break;
    }
    rest = afterOpen.slice((closeMatch.index || 0) + closeMatch[0].length);
  }

  if (text && ORPHAN_CLOSE_TAG_RE.test(text)) {
    ORPHAN_CLOSE_TAG_RE.lastIndex = 0;
    text = text.replace(ORPHAN_CLOSE_TAG_RE, "");
    suppressed = true;
  }
  ORPHAN_TEMPLATE_TAG_FRAGMENT_RE.lastIndex = 0;
  if (text && ORPHAN_TEMPLATE_TAG_FRAGMENT_RE.test(text)) {
    ORPHAN_TEMPLATE_TAG_FRAGMENT_RE.lastIndex = 0;
    text = text.replace(ORPHAN_TEMPLATE_TAG_FRAGMENT_RE, "");
    suppressed = true;
  }

  if (ss && text) {
    const tailMatch = text.match(PARTIAL_CLOSE_TAG_TAIL_RE);
    if (tailMatch) {
      ss.pseudoCloseTagBuffer = tailMatch[0];
      text = text.slice(0, text.length - tailMatch[0].length);
    }
  }

  return { text, suppressed };
}

export function containsNonProgressPseudoToolSimulation(text) {
  const withoutProgressMarkers = String(text || "")
    .replace(/<lynn_tool_progress\b[\s\S]*?(?:<\/lynn_tool_progress>|$)/gi, "");
  return containsPseudoToolCallSimulation(withoutProgressMarkers);
}
