/**
 * 流式文本清洗 — pseudo XML/tool 标记剥离
 *
 * 处理模型在 streaming text 中泄漏的内部 XML 标签、伪工具调用标记、
 * chunk 边界切割问题。从 server/routes/chat.js 提取。
 */
import {
  containsPseudoToolSimulation,
  createStreamingPseudoXmlOpenRegex,
  createStreamingPseudoXmlOrphanCloseRegex,
  createStreamingPseudoXmlOrphanFragmentRegex,
} from "../../shared/pseudo-tool-call.js";

const ORPHAN_CLOSE_TAG_RE = createStreamingPseudoXmlOrphanCloseRegex();
const ORPHAN_TEMPLATE_TAG_FRAGMENT_RE = createStreamingPseudoXmlOrphanFragmentRegex();
const STREAM_PSEUDO_XML_OPEN_RE = createStreamingPseudoXmlOpenRegex();
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
  const rawChunk = String(chunk || "");
  if (
    !ss?.pseudoToolXmlBlock &&
    !ss?.pseudoCloseTagBuffer &&
    rawChunk.indexOf("<") === -1 &&
    rawChunk.indexOf("_calls") === -1
  ) {
    return { text: rawChunk, suppressed: false };
  }

  let rest = String((ss?.pseudoCloseTagBuffer || "") + rawChunk);
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
  return containsPseudoToolSimulation(withoutProgressMarkers);
}
