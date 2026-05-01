/**
 * MoodParser — 从 streaming text 中解析内省标签
 *
 * 支持三种标签（对应三个 yuan 的思维框架）：
 *   <mood></mood>       — Hanako（MOOD 意识流四池）
 *   <pulse></pulse>     — Butter（PULSE 体感三拍）
 *   <reflect></reflect> — Lynn（沉思两层）
 *
 * 无论哪种标签，都输出统一的事件流：
 *   mood_start / mood_text / mood_end
 *
 * 用法：
 *   const parser = new MoodParser();
 *   parser.feed(delta, (evt) => {
 *     // evt: { type: 'text', data } | { type: 'mood_start' } | { type: 'mood_text', data } | { type: 'mood_end' }
 *   });
 */

const TAGS = ["mood", "pulse", "reflect"];

/** 检查 buffer 末尾是否是 target 的前缀（1..target.length-1 个字符），返回匹配长度 */
function trailingPrefixLen(buffer, target) {
  const maxCheck = Math.min(buffer.length, target.length - 1);
  for (let len = maxCheck; len >= 1; len--) {
    if (buffer.endsWith(target.slice(0, len))) return len;
  }
  return 0;
}

const XING_OPEN_RE = /<xing\s+title=["\u201C\u201D]([^"\u201C\u201D]*)["\u201C\u201D]>/;

// [PROGRESS-UX v1] Brain emits self-closing markers like
//   <lynn_tool_progress event="start" name="web_search"></lynn_tool_progress>
//   <lynn_tool_progress event="end" name="web_search" ms="3245" ok="true"></lynn_tool_progress>
// Captured (non-greedy) attribute block, then the matching close tag.
const LYNN_PROGRESS_RE = /<lynn_tool_progress\s+([^>]*?)><\/lynn_tool_progress>/;

export class MoodParser {
  constructor() {
    this.inMood = false;
    this.buffer = "";
    this._justEndedMood = false;
    this._currentTag = null; // 当前打开的标签名
  }

  /**
   * 喂入一段 streaming delta 文本，通过 emit 回调输出解析后的事件
   * @param {string} delta
   * @param {(evt: {type: string, data?: string}) => void} emit
   */
  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

  /** 强制输出 buffer 中剩余内容 */
  flush(emit) {
    if (this.buffer) {
      if (this.inMood) {
        emit({ type: "mood_text", data: this.buffer });
      } else {
        emit({ type: "text", data: this.buffer });
      }
      this.buffer = "";
    }
    if (this.inMood) {
      emit({ type: "mood_end" });
      this.inMood = false;
      this._currentTag = null;
    }
  }

  reset() {
    this.inMood = false;
    this.buffer = "";
    this._justEndedMood = false;
    this._currentTag = null;
  }

  _trailingPrefixLen(buffer, target) {
    return trailingPrefixLen(buffer, target);
  }

  /**
   * 在 buffer 中查找最早出现的开始标签
   * @returns {{ tag: string, idx: number, openTag: string } | null}
   */
  _findOpenTag() {
    let best = null;
    for (const tag of TAGS) {
      const openTag = `<${tag}>`;
      const idx = this.buffer.indexOf(openTag);
      if (idx !== -1 && (best === null || idx < best.idx)) {
        best = { tag, idx, openTag };
      }
    }
    return best;
  }

  /**
   * 计算所有开始标签在 buffer 末尾的最大前缀匹配长度
   */
  _maxTrailingPrefix() {
    let max = 0;
    for (const tag of TAGS) {
      const len = trailingPrefixLen(this.buffer, `<${tag}>`);
      if (len > max) max = len;
    }
    return max;
  }

  /** 内部：尽可能多地从 buffer 中提取完整事件 */
  _drain(emit) {
    while (this.buffer.length > 0) {
      // mood 刚结束时，裁掉前导换行
      if (this._justEndedMood && !this.inMood) {
        this.buffer = this.buffer.replace(/^\n+/, "");
        this._justEndedMood = false;
        if (!this.buffer.length) break;
      }

      if (!this.inMood) {
        // 寻找任意开始标签
        const found = this._findOpenTag();
        if (found) {
          const before = this.buffer.slice(0, found.idx);
          if (before) emit({ type: "text", data: before });
          emit({ type: "mood_start" });
          this.inMood = true;
          this._currentTag = found.tag;
          this.buffer = this.buffer.slice(found.idx + found.openTag.length);
          continue;
        }
        // buffer 末尾可能是某个开始标签的前缀
        const holdLen = this._maxTrailingPrefix();
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "text", data: this.buffer });
        this.buffer = "";
      } else {
        // 寻找对应的关闭标签
        const closeTag = `</${this._currentTag}>`;
        const idx = this.buffer.indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "mood_text", data: content });
          emit({ type: "mood_end" });
          this.inMood = false;
          this._justEndedMood = true;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          this._currentTag = null;
          continue;
        }
        // buffer 末尾可能是关闭标签的前缀
        const moodHoldLen = trailingPrefixLen(this.buffer, closeTag);
        if (moodHoldLen > 0) {
          const safe = this.buffer.slice(0, -moodHoldLen);
          if (safe) emit({ type: "mood_text", data: safe });
          this.buffer = this.buffer.slice(-moodHoldLen);
          break;
        }
        emit({ type: "mood_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}

/**
 * 思考开头启发式前缀（SFT 训练产物 · Qwen3.6-A3B / DeepSeek-R1 等常见裸输出）
 * [THINK-SANITIZE v2]
 */
const THINKING_PREFIX_PATTERNS = [
  /^Here'?s (a |my |the )?thinking process[:：]/i,
  /^Let me think (about|through) this/i,
  /^(Let me )?Analyze (the )?[Uu]ser [Ii]nput[:：]/i,
  /^\*{0,2}Thinking Process[:：]?\*{0,2}/i,
  /^The user (wants|needs|is asking|has asked)/i,
  /^用户(要求|希望|想要|在问)我?/,
  /^\*?\(?Self[-_ ]Correction(\/Verification)?\)?\*?/i,
  /^Step 1[:：]?\s*Analyze/i,
  /^\d+\.\s*\*\*(Analyze|Identify|Understand)/i,
];

/**
 * 输出崩坏模式（SFT 残留占位符 · 直接剥离）
 * [THINK-SANITIZE v2]
 */
const CORRUPTION_PATTERNS = [
  /\*\(Done\)\*/g,
  /\*\(Proceeding?\)\*/g,
  /\(Proceeds\)/g,
  /\*\(Continuing\)\*/g,
  /<\|[a-z_]{0,40}\|>/gi,
];

function matchesThinkingPrefix(text) {
  const head = text.trimStart();
  if (!head) return false;
  for (const pat of THINKING_PREFIX_PATTERNS) {
    if (pat.test(head)) return true;
  }
  return false;
}

function sanitizeCorruption(text) {
  let out = text;
  for (const pat of CORRUPTION_PATTERNS) out = out.replace(pat, "");
  return out;
}

function planningScaffoldLabels(text) {
  const head = String(text || "").trimStart();
  if (!/^Premise\s*:/i.test(head)) return [];
  return [...head.matchAll(/(?:^|\n)\s*(Premise|Conduct|Reflection|Act)\s*:/gi)]
    .map((match) => String(match[1] || "").toLowerCase());
}

function looksLikeLeadingPlanningScaffold(text) {
  const labels = planningScaffoldLabels(text);
  return labels.includes("premise") && labels.includes("conduct");
}

function hasCompletePlanningScaffold(text) {
  const labels = new Set(planningScaffoldLabels(text));
  return labels.has("premise") && labels.has("conduct") && labels.has("act");
}

function stripLeadingPlanningScaffold(text) {
  if (!looksLikeLeadingPlanningScaffold(text)) return text;
  // Premise / Conduct / Reflection / Act is an internal planning scaffold.
  // If it reaches the visible channel, showing it is worse than returning
  // nothing and letting the turn-quality gate continue/recover the action.
  return "";
}

function stripLeadingThinkingPrefixOnce(text) {
  const leadingWs = text.match(/^\s*/)?.[0] || "";
  const head = text.slice(leadingWs.length);
  if (!head) return text;

  const candidates = [];
  const lineBreak = head.indexOf("\n");
  if (lineBreak !== -1 && lineBreak <= 180) candidates.push(lineBreak + 1);

  // 中文常见写法会在句号后直接接下一句，不一定带空格或换行。
  // 这里允许句末标点后直接截断；后续仍用 rest.trim() 保证不会把整段正文吞掉。
  const sentenceMatch = head.match(/^.{0,180}?[。！？!?.](?:\s+|\n|$)?/);
  if (sentenceMatch) candidates.push(sentenceMatch[0].length);

  for (const cut of candidates) {
    const prefix = head.slice(0, cut).trim();
    const rest = head.slice(cut);
    if (!prefix || !rest.trim()) continue;
    if (!matchesThinkingPrefix(prefix)) continue;
    return leadingWs + rest.replace(/^\s+/, "");
  }

  return text;
}

function stripLeadingThinkingPrefixes(text, maxPasses = 2) {
  let out = stripLeadingPlanningScaffold(text);
  for (let i = 0; i < maxPasses; i++) {
    const next = stripLeadingThinkingPrefixOnce(out);
    if (next === out) break;
    out = next;
    out = stripLeadingPlanningScaffold(out);
  }
  return out;
}

/**
 * ThinkTagParser v2 — 拦截 <think>...</think> / 裸 </think> / 启发式思考前缀 / 崩坏模式
 *
 * 关键机制：DECISION_WINDOW（前 120 字延迟 emit 做模式识别）
 *   - 防止流式逐 token feed 导致"文本先 emit → 无法回溯当 thinking"
 *   - 小代价：首字延迟约 120 字 · A3B 50 tok/s 下 ~2s
 *
 * 支持模式（Qwen3.6-A3B / DeepSeek-R1 / MoE SFT 常见）：
 *   1. 标准     "<think>...</think> 正文"
 *   2. 裸结尾   "纯文本思考...</think> 正文"  → 前半段当 think_text
 *   3. 前缀     "Here's a thinking process:\n..."  → 匹配到即进 inThink
 *   4. 崩坏     "答案 *(Done)* (Proceeds)" → 剥离
 *
 * 输出事件流：
 *   think_start / think_text { data } / think_end
 *   text { data } — 已过 corruption sanitization
 */
export class ThinkTagParser {
  constructor() {
    this.inThink = false;
    this.buffer = "";
    this._justEnded = false;
    // [THINK-SANITIZE v2] 决策窗口 · 前 120 字累积不 emit · 直到做出模式判定
    this.DECISION_WINDOW = 120;
    this._decisionMade = false;
  }

  feed(delta, emit) {
    this.buffer += delta;
    // 首轮 · 累积到决策阈值或看到确定标记 · 再 drain
    if (!this._decisionMade && !this.inThink) {
      const hasOpenTag = this.buffer.includes("<think>");
      const hasCloseTag = this.buffer.includes("</think>");
      const pendingPlanningScaffold =
        looksLikeLeadingPlanningScaffold(this.buffer) &&
        !hasCompletePlanningScaffold(this.buffer) &&
        this.buffer.length < 2400;
      if (pendingPlanningScaffold) {
        return;
      }
      if (this.buffer.length < this.DECISION_WINDOW && !hasOpenTag && !hasCloseTag) {
        return; // 继续 buffer
      }
      this._makeDecision(emit);
      this._decisionMade = true;
    }
    this._drain(emit);
  }

  // 做模式决策：look at buffer head · 决定是 thinking / 正文
  _makeDecision(emit) {
    const text = this.buffer;

    // Case A: 裸 </think>（前面没 <think>）→ 前半段当 thinking
    const closeIdx = text.indexOf("</think>");
    const openIdx = text.indexOf("<think>");
    if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
      const thinkContent = text.slice(0, closeIdx);
      if (thinkContent) {
        emit({ type: "think_start" });
        emit({ type: "think_text", data: thinkContent });
        emit({ type: "think_end" });
      }
      this._justEnded = true;
      this.buffer = text.slice(closeIdx + "</think>".length);
      return;
    }

    // Case B: 启发式前缀
    // 不再把它整体吞进 silent thinking；只有限剥离明显的模板头，
    // 例如 "Here's a thinking process:" / "Let me think through this."
    // 避免把后面的真实答案一起吃掉。
    const stripped = stripLeadingThinkingPrefixes(text);
    if (stripped !== text) {
      this.buffer = stripped;
      return;
    }

    // Case C: 正常 · buffer 保留让 _drain 处理（可能含标准 <think>）
  }

  flush(emit) {
    // flush 前 · 如果还没决策 · 强制决策
    if (!this._decisionMade && !this.inThink && this.buffer) {
      this._makeDecision(emit);
      this._decisionMade = true;
    }
    if (this.buffer) {
      // [THINK-SANITIZE v2.1] flush 时 · 若 parser 陷在 inThink 没 </think> → **不要当 think_text 吞掉**
      //   可能是启发式误匹配或 chat_template 遗漏 · 应该当正文 emit 以防空输出
      //   真正的 thinking 一定带 <think>...</think> pair · 到 flush 时 inThink=true 是异常状态
      if (this.inThink) {
        emit({ type: "think_end" });
        emit({ type: "text", data: sanitizeCorruption(stripLeadingThinkingPrefixes(this.buffer)) });
        this.inThink = false;
      } else {
        const cleaned = sanitizeCorruption(stripLeadingThinkingPrefixes(this.buffer));
        if (cleaned) emit({ type: "text", data: cleaned });
      }
      this.buffer = "";
    } else if (this.inThink) {
      emit({ type: "think_end" });
      this.inThink = false;
    }
  }

  reset() {
    this.inThink = false;
    this.buffer = "";
    this._justEnded = false;
    this._decisionMade = false;
  }

  _drain(emit) {
    while (this.buffer.length > 0) {
      // think 刚结束时裁掉前导换行
      if (this._justEnded && !this.inThink) {
        this.buffer = this.buffer.replace(/^\n+/, "");
        this._justEnded = false;
        if (!this.buffer.length) break;
      }

      if (!this.inThink) {
        const openTag = "<think>";
        const idx = this.buffer.indexOf(openTag);
        if (idx !== -1) {
          const before = this.buffer.slice(0, idx);
          if (before) emit({ type: "text", data: before });
          emit({ type: "think_start" });
          this.inThink = true;
          this.buffer = this.buffer.slice(idx + openTag.length);
          continue;
        }
        // buffer 末尾可能是 <think> 的前缀
        const holdLen = trailingPrefixLen(this.buffer, openTag);
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "text", data: this.buffer });
        this.buffer = "";
      } else {
        const closeTag = "</think>";
        const idx = this.buffer.indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "think_text", data: content });
          emit({ type: "think_end" });
          this.inThink = false;
          this._justEnded = true;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          continue;
        }
        const holdLen = trailingPrefixLen(this.buffer, closeTag);
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "think_text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "think_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}

/**
 * XingParser — 从 streaming text 中解析 <xing title="...">...</xing> 标签
 *
 * 链在 MoodParser 的 text 输出之后，输出统一的事件流：
 *   xing_start { title } / xing_text { data } / xing_end
 *   text { data } — 非 xing 内容透传
 */
export class XingParser {
  constructor() {
    this.inXing = false;
    this.buffer = "";
    this._title = null;
  }

  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

  flush(emit) {
    if (this.buffer) {
      if (this.inXing) {
        emit({ type: "xing_text", data: this.buffer });
      } else {
        emit({ type: "text", data: this.buffer });
      }
      this.buffer = "";
    }
    if (this.inXing) {
      emit({ type: "xing_end" });
      this.inXing = false;
      this._title = null;
    }
  }

  reset() {
    this.inXing = false;
    this.buffer = "";
    this._title = null;
  }

  _drain(emit) {
    while (this.buffer.length > 0) {
      if (!this.inXing) {
        // 尝试匹配完整的开标签 <xing title="...">
        const match = this.buffer.match(XING_OPEN_RE);
        if (match) {
          const before = this.buffer.slice(0, match.index);
          if (before) emit({ type: "text", data: before });
          this._title = match[1];
          emit({ type: "xing_start", title: this._title });
          this.inXing = true;
          this.buffer = this.buffer.slice(match.index + match[0].length);
          continue;
        }
        // buffer 里有 <xing 但标签还没闭合 → 持住等更多数据
        const partialIdx = this.buffer.indexOf("<xing");
        if (partialIdx !== -1) {
          const before = this.buffer.slice(0, partialIdx);
          if (before) emit({ type: "text", data: before });
          this.buffer = this.buffer.slice(partialIdx);
          break;
        }
        // buffer 末尾可能是 <, <x, <xi, <xin 的前缀
        const holdLen = trailingPrefixLen(this.buffer, "<xing");
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "text", data: this.buffer });
        this.buffer = "";
      } else {
        const closeTag = "</xing>";
        const idx = this.buffer.indexOf(closeTag);
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx);
          if (content) emit({ type: "xing_text", data: content });
          emit({ type: "xing_end" });
          this.inXing = false;
          this._title = null;
          this.buffer = this.buffer.slice(idx + closeTag.length);
          continue;
        }
        const holdLen = trailingPrefixLen(this.buffer, closeTag);
        if (holdLen > 0) {
          const safe = this.buffer.slice(0, -holdLen);
          if (safe) emit({ type: "xing_text", data: safe });
          this.buffer = this.buffer.slice(-holdLen);
          break;
        }
        emit({ type: "xing_text", data: this.buffer });
        this.buffer = "";
      }
    }
  }
}

/**
 * LynnProgressParser — 从 streaming text 中抠掉 Brain 注入的进度标记
 *
 * 输入格式 (Brain server.js callQwenLocalStream 注入):
 *   <lynn_tool_progress event="start" name="web_search"></lynn_tool_progress>
 *   <lynn_tool_progress event="end" name="web_search" ms="3245" ok="true"></lynn_tool_progress>
 *
 * 输出事件:
 *   { type: "text", data }                                — 非进度内容透传
 *   { type: "tool_progress", event: "start"|"end", name, ms?, ok? }
 *
 * 链接位置: ThinkTagParser.text → LynnProgressParser.text → MoodParser.feed
 *           （即在 text-后、mood-前）
 */
export class LynnProgressParser {
  constructor() {
    this.buffer = "";
  }

  feed(delta, emit) {
    this.buffer += delta;
    this._drain(emit);
  }

  flush(emit) {
    if (this.buffer) {
      emit({ type: "text", data: this.buffer });
      this.buffer = "";
    }
  }

  reset() {
    this.buffer = "";
  }

  _parseAttrs(attrStr) {
    const out = {};
    const re = /(\w+)=["']([^"']*)["']/g;
    let m;
    while ((m = re.exec(attrStr)) !== null) out[m[1]] = m[2];
    return out;
  }

  _drain(emit) {
    while (this.buffer.length > 0) {
      const match = this.buffer.match(LYNN_PROGRESS_RE);
      if (match) {
        const before = this.buffer.slice(0, match.index);
        if (before) emit({ type: "text", data: before });
        const attrs = this._parseAttrs(match[1]);
        emit({
          type: "tool_progress",
          event: attrs.event || "start",
          name: attrs.name || "tool",
          ms: attrs.ms ? Number(attrs.ms) : undefined,
          ok: attrs.ok === undefined ? undefined : attrs.ok === "true",
        });
        this.buffer = this.buffer.slice(match.index + match[0].length);
        continue;
      }
      // Hold tail if it might be the start of "<lynn_tool_progress"
      const partialIdx = this.buffer.indexOf("<lynn_tool_progress");
      if (partialIdx !== -1) {
        // Have an opening tag but no closing — wait for more data
        const before = this.buffer.slice(0, partialIdx);
        if (before) emit({ type: "text", data: before });
        this.buffer = this.buffer.slice(partialIdx);
        break;
      }
      const holdLen = trailingPrefixLen(this.buffer, "<lynn_tool_progress");
      if (holdLen > 0) {
        const safe = this.buffer.slice(0, -holdLen);
        if (safe) emit({ type: "text", data: safe });
        this.buffer = this.buffer.slice(-holdLen);
        break;
      }
      emit({ type: "text", data: this.buffer });
      this.buffer = "";
    }
  }
}
