const EXPLICIT_LOOKUP_PROMPT_RE = /(?:查一下|查询|查证|搜索(?:一下|最新|官方|网页|结果)?|检索(?:一下|最新|官方|网页)?|访问|打开|看看|找一下|上网|联网|官网|官方文档|最新|实时|今天|今日|明天|天气|预警|航班|股价|金价|汇率|行情|比分|赛程|价格|发布了吗|有更新|Release\s+页面|release\s+tag)/iu;
const HIGH_RISK_CURRENT_CATEGORY_RE = /(?:_current$|^(?:realtime|search|mixed|product|official)$)/u;
const STABLE_SCENARIO_CATEGORY_RE = /^(?:simple|format|code|writing|life|medical|travel|education|recruiting|office|industry|research|ux)$/u;

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function weatherAnswerUsesUnrelatedSearch(prompt, text) {
  return /(?:天气|降雨|下雨|暴雨|气温|温度|空气质量|AQI|weather|rain|temperature|air quality)/iu.test(String(prompt || ''))
    && /(?:人类活动史|建城史|生态环境局|工业和信息化局|机动车排放|高新技术企业|政府工作报告|百度百科)/u.test(String(text || ''));
}

export function hasUsdCnyRate(text) {
  const raw = String(text || "").replace(/[*_`]/g, "");
  return /1\s*(?:USD|美元)\s*(?:=|≈|约|可兑换|兑换|兑)?\s*\d+(?:\.\d+)?\s*(?:CNY|人民币)/iu.test(raw)
    || /(?:USD\s*\/\s*CNY|美元[兑对]人民币)\s*(?:汇率)?\s*(?:为|是|约为|约|[:：=≈])?\s*\d+(?:\.\d+)?(?![\d.\/-])(?=\s*(?:CNY|人民币|元|[，,。；;\n]|$))/iu.test(raw);
}

export function deniesAvailableToolCapability(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return /(?:工具集|工具箱|工具列表|当前工具|可用工具|CLI工具|LynnCLI工具)[^，,。！？；;]{0,24}(?:没有|未包含|不包含|缺少|暂无|不支持)[^，,。！？；;]{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问)/iu.test(normalized)
    || /(?:没有|未包含|不包含|缺少|暂无|不支持)[^，,。！？；;]{0,24}(?:天气|搜索|查询|检索|行情|股价|金价|汇率|比分|赛程|网页|访问)[^，,。！？；;]{0,24}(?:工具|功能|能力|接口)/iu.test(normalized);
}

/**
 * A tool-evidence claim must assert a concrete returned or real-time fact.
 * Generic educational wording such as "retrieved reference material" is not
 * evidence of a live tool call and must not make a stable answer fail a gate.
 */
export function claimsFreshToolEvidence(text) {
  return /(?:根据(?:最新|本次|本轮)?(?:查询|搜索|工具|检索)(?:结果|返回)|(?:查询|搜索|工具|检索)(?:结果|返回)(?:显示|表明|指出|为)|(?:最新|实时)(?:天气|行情|比分|赛程|价格|新闻|汇率|金价)|(?:查询|搜索)(?:到|得)(?:的)?(?:最新|实时)?(?:天气|行情|比分|赛程|价格|新闻|汇率|金价))/u.test(String(text || ""));
}

export function containsPastDateFutureStartContradiction(text, currentDate) {
  const normalized = String(text || "").replace(/\s+|\*\*/g, "");
  const today = Number(String(currentDate || "").replaceAll("-", ""));
  const year = Number(String(currentDate || "").slice(0, 4));
  const futureStarts = normalized.matchAll(/要到(?:(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})(?:[~～—–-]\d{1,2}月?\d{0,2}日?)?(?:才)?(?:正式)?(?:开赛|开始|开幕|开打|举行)/gu);
  for (const statement of futureStarts) {
    const match = statement[0].match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日|(\d{4})-(\d{1,2})-(\d{1,2})/u);
    if (!match) continue;
    const dateYear = Number(match[1] || match[4] || year);
    const month = Number(match[2] || match[5]);
    const day = Number(match[3] || match[6]);
    const startDate = Number(`${dateYear}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`);
    if (startDate < today) return true;
  }
  return false;
}

function completedSportsEvidence(toolEvents) {
  return toolEvents.flatMap((event) => {
    if (event.event !== "end" || event.ok !== true) return [];
    if (event.name === "sports_score") return [event];
    if (event.name !== "parallel_research" || !Array.isArray(event.details)) return [];
    return event.details.flatMap((line) => {
      if (typeof line !== "string" || !line.startsWith("subtool: ")) return [];
      try {
        const child = JSON.parse(line.slice("subtool: ".length));
        return child.name === "sports_score" && child.ok === true && Array.isArray(child.details) ? [child] : [];
      } catch { return []; }
    });
  });
}

export function hasVerifiedEmptySportsWindow({ toolEvents = [], prompt = "", currentDate = "" }) {
  return completedSportsEvidence(toolEvents).some((event) => {
    const details = Array.isArray(event.details) ? event.details : [];
    if (!details.includes("provider: espn_scoreboard") || !details.includes("directSourceStatus: ok") || !details.includes("matched: 0")) return false;
    const sources = details.filter((line) => line.startsWith("source: "));
    if (!sources.length || !sources.every((line) => /^source: https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/[^\s]+\/scoreboard\?[^\s]*dates=\d{8}(?:-\d{8})?(?:&[^\s]*)?$/u.test(line))) return false;
    const range = details.map((line) => line.match(/^dateRange: (\d{8})-(\d{8})$/u)).find(Boolean);
    if (!range || range[1] > range[2]) return false;
    if (/昨晚|昨天|昨日|yesterday|今天|今日|今晚|今夜|today|tonight/iu.test(prompt)) {
      const today = new Date(`${currentDate}T12:00:00Z`);
      if (!Number.isFinite(today.getTime())) return false;
      const offset = /昨晚|昨天|昨日|yesterday/iu.test(prompt) ? -86400000 : 0;
      const targetDate = new Date(today.getTime() + offset).toISOString().slice(0, 10).replaceAll("-", "");
      if (range[1] > targetDate || range[2] < targetDate) return false;
    }
    return true;
  });
}

function previouslyEndedCompetition(text, result) {
  const now = new Date(`${result.currentDate}T12:00:00Z`);
  if (!Number.isFinite(now.getTime())) return null;
  const target = now.getTime() - (/昨晚|昨天|昨日|yesterday/iu.test(result.prompt) ? 86400000 : 0);
  // Evaluate a dated, scoped conclusion without naming any sport or league.
  const ended = /(?:^|\n)\s*(?:[-*]\s*)?([^\n：:]{1,100})[：:]\s*(?:已经|已)于\s*(?:(今年)|(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(?:(\d{1,2})\s*日)?[^。！？；\n]{0,12}(?:结束|完赛|收官)/gu;
  for (const match of text.matchAll(ended)) {
    const year = Number(match[3] || now.getUTCFullYear()), month = Number(match[4]), day = Number(match[5] || 0);
    if (month < 1 || month > 12 || day > 31) continue;
    const lastDay = day || new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (Date.UTC(year, month - 1, lastDay, 23, 59, 59) >= target) continue;
    const subject = match[1].replace(/\s+/g, '').toLowerCase();
    const rest = text.slice(match.index + match[0].length).replace(/([。！？；])(?=#{2,6}\s)/gu, '$1\n');
    const sections = rest.split(/(?=^#{2,6}\s)/mu);
    const score = /\|\s*\d{1,2}\s*[-–—:：]\s*\d{1,2}\s*\||(?:比分|赛果)\s*[:：为是]?\s*\d{1,2}\s*[-–—:：]\s*\d{1,2}/u;
    // A different competition must have its own heading. A result for the
    // original competition still contradicts its verified empty window.
    if (sections.some(section => {
      if (!score.test(section)) return false;
      const title = /^#{2,6}\s+([^\n]+)/u.exec(section)?.[1] || '';
      return !title || title.replace(/\s+/g, '').toLowerCase().includes(subject);
    })) continue;
    return match;
  }
  return null;
}

export function hasVerifiedEmptySportsResult(result) {
  const text = String(result.assistantText || "").replace(/\*\*/g, "");
  const emptyConclusion = /(?:0\s*场|(?:没有|无|未(?:查[询找]?到|检索到))[^。！？；\n]{0,12}(?:比赛|赛事|球赛))/u.exec(text)
    || previouslyEndedCompetition(text, result);
  if (!emptyConclusion) return false;
  const lines = text.slice(0, emptyConclusion.index).split(/\n|[。；]/u);
  // A footnote quoting "0 matches" must not excuse positive results elsewhere.
  // Require the scoped empty conclusion first; later background or separately
  // identified competitions need not share this source's empty window.
  // This checks answer structure, not runtime entity/date extraction.
  const contradictoryResults = lines.some((line) => {
    if (/历史|旧闻|往年|过去的|未核实|无法核实|不(?:予)?采信|不能确认|未能确认|historical|unverified/iu.test(line)) return false;
    return /(?:共|有|当晚|昨晚|今晚|今天|昨日|今日)\s*[1-9]\d*\s*场/u.test(line)
      || /\|\s*\d{1,2}\s*[-–—:：]\s*\d{1,2}\s*\|/u.test(line)
      || /(?:比分|赛果)\s*[:：为是]?\s*\d{1,2}\s*[-–—:：]\s*\d{1,2}/u.test(line);
  });
  if (contradictoryResults) return false;
  return hasVerifiedEmptySportsWindow(result);
}

export function hasVerifiedNoFixturePredictionAnswer(result) {
  const text = String(result.assistantText || "").replace(/\*\*/g, "");
  return hasVerifiedEmptySportsResult(result)
    && /(?:给不出|无法|不能|不应|不做|不会).{0,24}(?:比分|预测)|(?:比分|预测).{0,16}(?:没有依据|无依据|无对象)|不存在.{0,12}(?:可(?:以)?预测|预测对象)|没有(?:可(?:供|以)?预测的|预测对象)|没有(?:比分|赛果)(?:可(?:以)?|能)预测/u.test(text);
}

export function containsMislabeledRelativeDate(prompt, text, currentDate) {
  const relativeLabel = /今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天/u;
  if (!relativeLabel.test(prompt)) return false;
  const year = String(currentDate).slice(0, 4);
  const addDays = (offset) => new Date(new Date(`${currentDate}T12:00:00Z`).getTime() + offset * 86400000).toISOString().slice(0, 10);
  const isDisallowed = (label, dateYear, month, day) => {
    const allowed = new Set();
    if (/今天|今日/u.test(label)) allowed.add(currentDate);
    if (/今晚|今夜/u.test(label)) { allowed.add(currentDate); allowed.add(addDays(1)); }
    if (/明天|明日/u.test(label)) allowed.add(addDays(1));
    if (/昨晚|昨日|昨天/u.test(label)) { allowed.add(addDays(-1)); allowed.add(currentDate); }
    const date = `${dateYear || year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return date.startsWith(`${year}-`) && !allowed.has(date);
  };
  const normalized = String(text).replace(/\|/gu, "\n")
    .replace(/(?:更新时间|更新于|更新至|发布时间|发布于|数据截至|数据时间|抓取时间|采集时间|取数时间|截至)\s*[：:]?\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}年\s*\d{1,2}月\s*\d{1,2}日)(?:\s+\d{1,2}:\d{2})?/gu, "[数据时间]")
    .replace(/(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}年\s*\d{1,2}月\s*\d{1,2}日)\s+\d{1,2}:\d{2}\s*(?:更新|发布|采集|抓取)/gu, "[数据时间]");
  const labelBeforeDate = /(今天\/今日|今晚\/今夜|明天\/明日|昨晚\/昨天\/昨日|今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天)([^\n。；;，,]{0,32}?)(?:(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日|(\d{4})-(\d{1,2})-(\d{1,2}))/gu;
  const dateBeforeLabel = /(?:(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日|(\d{4})-(\d{1,2})-(\d{1,2}))([^\n。；;，,]{0,32}?)(今天\/今日|今晚\/今夜|明天\/明日|昨晚\/昨天\/昨日|今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天)/gu;
  for (const match of normalized.matchAll(labelBeforeDate)) {
    if (!relativeLabel.test(match[2]) && isDisallowed(match[1], match[3] || match[6], match[4] || match[7], match[5] || match[8])) return true;
  }
  for (const match of normalized.matchAll(dateBeforeLabel)) {
    if (/[（(](?:含|包含|包括|涵盖|覆盖)\s*$/u.test(match[7])) continue;
    // A date inside a closed parenthetical schedule does not label the next
    // clause. An explicit equivalence after the close still binds the date.
    const closedContext = /[）)]([^）)]*)$/u.exec(match[7]);
    if (closedContext && !/^(?:\s|[*_`：:—–-])*(?:即|也即|也就是|就是|也?是|对应)(?:\s|[*_`：:—–-])*$/u.test(closedContext[1])) continue;
    if (!relativeLabel.test(match[7]) && isDisallowed(match[8], match[1] || match[4], match[2] || match[5], match[3] || match[6])) return true;
  }
  return false;
}

export function overridesVerifiedEmptySportsWindow(result) {
  return /昨晚|昨天|昨日|yesterday|今天|今日|今晚|今夜|today|tonight/iu.test(result.prompt)
    && hasVerifiedEmptySportsWindow(result)
    && !hasVerifiedEmptySportsResult(result);
}

export function omitVerifiedSportsFetchWindows(text, toolEvents = []) {
  const windows = [];
  const queryWindows = [];
  for (const event of completedSportsEvidence(toolEvents)) {
    const details = Array.isArray(event.details) ? event.details : [];
    if (!details.includes("directSourceStatus: ok")) continue;
    const sourceLines = details.filter((line) => line.startsWith("source: "));
    const dates = [];
    let valid = sourceLines.length > 0;
    for (const line of sourceLines) {
      try {
        const url = new URL(line.slice("source: ".length));
        const range = url.searchParams.get("dates") || "";
        if (url.origin !== "https://site.api.espn.com" || !/^\/apis\/site\/v2\/sports\/[^\s]+\/scoreboard$/u.test(url.pathname) || !/^\d{8}(?:-\d{8})?$/u.test(range)) valid = false;
        dates.push(...range.split("-"));
      } catch { valid = false; }
    }
    if (valid) {
      dates.sort();
      windows.push([dates[0], dates.at(-1)]);
      const queryRange = details.map((line) => line.match(/^dateRange: (\d{8})-(\d{8})$/u)).find(Boolean);
      if (queryRange && queryRange[1] <= queryRange[2] && queryRange[1] >= dates[0] && queryRange[2] <= dates.at(-1)) {
        queryWindows.push([queryRange[1], queryRange[2]]);
      }
    }
  }
  const datePattern = (date, includeYear) => {
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    return `${includeYear ? `${date.slice(0, 4)}[-/年]` : ""}${month < 10 ? "0?" : ""}${month}[-/月]${day < 10 ? "0?" : ""}${day}日?`;
  };
  let answer = String(text || "");
  for (const [first, last] of [...queryWindows, ...windows]) {
    const range = new RegExp(`((?:查询|检索|取数)(?:范围|区间)?\\s*[：:]?\\s*(?:北京时间\\s*)?)(?:${datePattern(first, true)}|${datePattern(first, false)})\\s*(?:至|到|[-–—~～])\\s*(?:${datePattern(last, true)}|${datePattern(last, false)})(?!\\d)`, "gu");
    answer = answer.replace(range, "$1[已核验的查询窗口]");
  }
  const lines = answer.split("\n");
  const cells = (line) => line.trim().replace(/^\||\|$/gu, "").split("|");
  let queryColumns = [];
  answer = lines.map((line, index) => {
    if (!line.trim().startsWith("|")) {
      queryColumns = [];
      return line;
    }
    if (lines[index + 1]?.trim().startsWith("|") && cells(lines[index + 1]).every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell))) {
      queryColumns = cells(line).map((cell) => /^(?:查询|检索|取数)范围$/u.test(cell.trim()));
      return line;
    }
    if (!queryColumns.some(Boolean)) return line;
    let column = -1;
    return line.replace(/(?<=\|)[^|]+(?=\|)/gu, (cell) => {
      column += 1;
      if (!queryColumns[column]) return cell;
      for (const [first, last] of [...queryWindows, ...windows]) {
        const range = new RegExp(`^(\\s*)(?:${datePattern(first, true)}|${datePattern(first, false)})\\s*(?:至|到|[-–—~～])\\s*(?:${datePattern(last, true)}|${datePattern(last, false)})(?!\\d)`, "u");
        cell = cell.replace(range, "$1[已核验的查询窗口]");
      }
      return cell;
    });
  }).join("\n");
  return answer.split(/(?<=[。；！？!\n])/u).map((segment) => {
    if (!/ESPN|scoreboard|数据源|取数|上游|接口/iu.test(segment) || /昨晚|昨天|昨日|今天|今日|今晚|今夜|明天|明日/u.test(segment)) return segment;
    let normalized = segment;
    for (const [first, last] of windows) {
      const range = new RegExp(`${datePattern(first, true)}\\s*(?:至|到|[-–—~～])\\s*(?:${datePattern(last, true)}|${datePattern(last, false)})(?!\\d)`, "gu");
      normalized = normalized.replace(range, "[已核验的上游取数窗口]");
    }
    return normalized;
  }).join("");
}

export function requiresFreshEvidenceForDialogue({ category, prompt }) {
  const c = String(category || "");
  if (HIGH_RISK_CURRENT_CATEGORY_RE.test(c)) return true;
  if (STABLE_SCENARIO_CATEGORY_RE.test(c) && !/(?:上网|联网|查一下|查询|查证|访问|打开官网|最新(?:版|发布|模型|政策|规则|材料|口径)|实时(?:数据|信息|行情|天气|比分|赛程)|今天(?:天气|新闻|行情|价格)|明天(?:天气|航班|降雨)|官方(?:来源|文档|页面)|release\s+tag)/iu.test(String(prompt || ""))) {
    return false;
  }
  return EXPLICIT_LOOKUP_PROMPT_RE.test(String(prompt || ""))
    && !/(?:不要|不用|不必|无需).{0,10}(?:联网|搜索|查询|工具)/u.test(String(prompt || ""));
}

function hasHonestNoEvidenceAnswer(text) {
  return /(没有查到|未查到|无法确认|不能确认|证据不足|来源不足|需要补充来源|无法从当前证据确认)/u.test(text);
}

function isCodeGenerationPrompt(prompt, category) {
  if (String(category || "") !== "code") return false;
  return /(?:写|实现|生成|给(?:我)?(?:一个|一段)?|构造|提供).{0,50}(?:函数|脚本|命令|schema|布局|伪代码|handler|union|debounce|JSON|TypeScript|JavaScript|Node\.?js|Python|bash|CSS|zod|Electron|React)/iu.test(prompt);
}

function hasCodeLikeAnswer(text) {
  const raw = String(text || "");
  return /```[\s\S]{12,}?```/.test(raw)
    || /\b(?:function|const|let|var|def|class|import|export|interface|type|SELECT|CREATE\s+TABLE|z\.object|async\s+function|useMemo)\b/.test(raw)
    || /\b(?:find|rg|wc|grep|node|python|npm|pnpm|git)\b.{0,80}(?:\*\.ts|\.ts|\.json|行数|keys?)/iu.test(raw)
    || /display:\s*grid|grid-template-columns|ipcMain\.handle|JSON\s*Schema/iu.test(raw);
}

function isNarrativeWritingPrompt(prompt, category) {
  if (String(category || "") !== "writing") return false;
  return /(?:写一段|续写|开头|对话|改写得更有画面感|悬疑小说)/u.test(prompt)
    && !/(?:大纲|章节规划|检查清单|世界观设定表)/u.test(prompt);
}

function isCharacterProfilePrompt(prompt, category) {
  if (String(category || "") !== "writing") return false;
  return /(?:人物小传|人物设定|角色小传|角色设定)/u.test(String(prompt || ""));
}

function isWritingPlanningPrompt(prompt, category) {
  if (String(category || "") !== "writing") return false;
  return /(?:大纲|章节规划|检查清单|世界观设定表|避免 AI 味)/u.test(prompt);
}

function hasNarrativeProse(text) {
  const raw = normalizedText(text);
  const sentenceMarks = (raw.match(/[。！？]/gu) || []).length;
  return raw.length >= 80 && sentenceMarks >= 3 && !/^(?:[-*]\s*){0,1}(?:可以|我可以|下面是|以下是)/u.test(raw.slice(0, 40));
}

function hasCharacterProfile(text) {
  const raw = normalizedText(text);
  if (raw.length < 120) return false;
  return /(?:工程师|职业|经历|过去|事故|记忆|缺口|权威|目标|弱点|性格|创伤|秘密|动机|不信任)/u.test(raw)
    && /(?:。|：|:|；|;|-|\n)/u.test(String(text || ""));
}

function hasWritingPlan(text) {
  const raw = normalizedText(text);
  return raw.length >= 160
    && /(?:角色|冲突|主题|章节|第一|第二|第三|世界观|设定|场景|节奏|检查)/u.test(raw);
}

function hasActionableAnswerForScenario(text) {
  const raw = normalizedText(text);
  if (raw.length < 80) return false;
  return /(?:步骤|清单|建议|先|然后|最后|模板|表|计划|准备|记录|风险|负责人|时间线|阶段|行动项|指标|证据|问题|确认|核对|检查|条件|取决于|流程|第[一二三四五六七八九十\d]+步|可尝试|处理|做法|切|炒|煎|煮|搭配|验证|避坑|留存|渠道|维度|原则|要点|比如|例子|就医|急诊|危险信号|观察|评分|rubric)/u.test(raw);
}

function isEducationExplanationPrompt(prompt, category) {
  return String(category || "") === "education" && /(?:解释|给.+解释|用.+例子)/u.test(String(prompt || ""));
}

function hasEducationalExplanationAnswer(text) {
  const raw = normalizedText(text);
  if (raw.length < 100) return false;
  return /(?:例子|比如|想象|本质|意思|理解|生活|公式|可以把|你可以)/u.test(raw);
}

function hasEvidenceBoundaryAnswer(text) {
  const raw = normalizedText(text);
  if (raw.length < 120) return false;
  return /(?:来源|官方|公告|官网|文件|公开信息|截至|当前|检索)/u.test(raw)
    && /(?:不确定|暂未|未检索到|未发布|无法确认|不能确认|口径|核验|以.+为准|结论)/u.test(raw);
}

function hasExplicitDataCoverageBoundary(text) {
  const plain = String(text || '').replace(/\*\*|__/gu, '');
  const sampleScope = /样本|代表性/u.test(plain);
  const limitedUniverse = /(?:不是|并非|不代表|不等于|不含|未覆盖|未遍历|未扫描|不能视为)[^。！？\n]{0,20}全市场/u.test(plain);
  // A named exclusion is a boundary even when the author does not use the word
  // "sample". Requiring a source plus nonempty excluded fields prevents a bare
  // section heading or an unsupported claim of complete coverage from passing.
  const namedExclusions = /(?:未覆盖(?:的数据|的字段|的范围)?|不包含|不包括|not covered|excluded)\s*[:：]\s*[^\s。！？\n][^。！？\n]{3,}/iu.test(plain);
  const sourceAttribution = /(?:来自|来源|数据源|source)\s*[:：]?\s*[^\s。！？\n]/iu.test(plain);
  return sampleScope || limitedUniverse || (namedExclusions && sourceAttribution);
}

function isScenarioCategory(category) {
  return /^(?:life|medical|gov_legal|education|travel|recruiting|office|industry)(?:_current)?$/u.test(String(category || ""));
}

function hasStaleCrossDomainLeak(prompt, text) {
  const p = String(prompt || "");
  const raw = String(text || "");
  if (!/(?:世界杯|NBA|英格兰|克罗地亚|西班牙|沙特|比利时|伊朗|德国|荷兰|瑞典|美国队?|日本|突尼斯|金价|股价|天气|汇率|纳斯达克|指数|A\s*股|英伟达|苹果|比特币|BTC|TSLA|特斯拉|日元)/iu.test(p) && /(?:世界杯|NBA\s*总决赛|金价|现货黄金|纳斯达克|英伟达股价)/iu.test(raw)) {
    return true;
  }
  if (!/(?:ComfyUI|custom_nodes|python\s+main\.py)/iu.test(p) && /(?:ComfyUI|custom_nodes\/foo\.py|python\s+main\.py)/iu.test(raw)) {
    return true;
  }
  if (!/(?:Apple|notarization|公证|苹果)/iu.test(p) && /(?:Apple\s+notarization|notarizing_macos_software|Gatekeeper|苹果.{0,12}公证)/iu.test(raw)) {
    return true;
  }
  if (!/(?:Claude|Anthropic)/iu.test(p) && /(?:Claude\s+(?:4(?:\.\d+)?|模型)|Anthropic\s+官方)/iu.test(raw)) {
    return true;
  }
  if (!/(?:Microsoft|Windows\s+on\s+Arm)/iu.test(p) && /(?:Microsoft\s+Windows\s+on\s+Arm|developer\.microsoft\.com\/windows\/arm)/iu.test(raw)) {
    return true;
  }
  return false;
}

function flightWeatherMissingRouteCity(prompt, text) {
  if (!/(?:天气|气温|温度|预报|下雨|降雨|穿衣|机场)/u.test(String(prompt || ""))) return false;
  const cities = "北京|上海|广州|深圳|杭州|南京|苏州|成都|重庆|武汉|西安|长沙|郑州|青岛|厦门|福州|宁波|佛山|东莞|珠海|香港|澳门";
  const route = String(prompt || "").match(new RegExp(`(${cities})(?:市)?(?:飞往|飞|到|前往)(${cities})(?:市)?`, "u"));
  if (!route) return false;
  const answer = String(text || "");
  return !answer.includes(route[1]) || !answer.includes(route[2]);
}

export function additionalDialogueQualityReason({ category, prompt, text, hasToolEvidence }) {
  const rawText = String(text || "");
  const proseOnly = rawText.replace(/```[\s\S]*?```/g, "");
  if (/^\s*(?:用户|提问者)(?:现在|当前)?(?:需要|想要|要求|希望)[^。！？!?\n]{1,180}[。！？!?]\s*(?:我)?(?:应当|应该|需要|可以|将|要)?(?:直接给|直接提供|给出|提供|按|分成|从)[^。！？!?\n]{1,220}(?:结构化|按.{0,40}(?:排列|整理|组织)|让(?:用户|提问者)|回答(?:应|要)|无需|不需要|分成.{0,30}(?:部分|块|类)|照着执行)[^。！？!?\n]{0,80}[。！？!?]/u.test(proseOnly)) {
    return "internal-task-narration-visible";
  }
  if (/(?:^|\n)\s*<[^<>\n]*(?:方案|计划|流程|步骤|回答|思路|分析|总结|大纲|设定|章节规划)[^<>\n]*>\s*/u.test(proseOnly)) {
    return "model-structural-label-visible";
  }
  if (/<\/?(?:worldbuilding|worldbuilding_table|phase|daily_structure|item|milestone|rules|rule)\b[^>]*>/iu.test(proseOnly)) {
    return "model-structural-tag-visible";
  }
  if (/(?:A\s*股|a\s*股).{0,16}异动|异动.{0,16}(?:A\s*股|a\s*股)/u.test(String(prompt || ""))
    && !hasExplicitDataCoverageBoundary(rawText)) {
    return "a-share-anomaly-answer-missing-sample-boundary";
  }
  if (/NBA.*总决赛/iu.test(String(prompt || "")) && /几场|总比分/u.test(String(prompt || ""))) {
    const seriesText = rawText.replaceAll("**", "");
    const headline = seriesText.match(/总决赛[^\n]{0,80}?(?<!\d)(\d{1,2})\s*[-–—:：比]\s*(\d{1,2})(?!\d)[^\n]{0,50}?(\d{1,2})\s*场/u);
    const countFirst = seriesText.match(/总决赛[^\n]{0,80}?(?<!\d)(\d{1,2})\s*场[^\n]{0,50}?(?<!\d)(\d{1,2})\s*[-–—:：比]\s*(\d{1,2})(?!\d)/u);
    const hasHeadlineTotal = (headline && Number(headline[1]) + Number(headline[2]) === Number(headline[3]))
      || (countFirst && Number(countFirst[2]) + Number(countFirst[3]) === Number(countFirst[1]));
    const hasWinLossSummary = /(?:总比分|大比分|系列赛|总决赛)[\s\S]{0,120}\d+\s*胜\s*\d+\s*负/u.test(seriesText);
    const hasNamedSeriesScore = /(?:总比分|大比分|系列赛|夺冠|赢得|获胜).{0,45}\d+\s*[-–—:：比]\s*\d+|\d+\s*[-–—:：比]\s*\d+.{0,30}(?:总比分|大比分|系列赛|夺冠|赢得|获胜)/u.test(seriesText);
    if (!/(?:\d+|[一二三四五六七八九十]+)\s*场/u.test(seriesText) || !(hasHeadlineTotal || hasWinLossSummary || hasNamedSeriesScore)) {
      return "nba-finals-answer-missing-series-summary";
    }
  }
  if (hasStaleCrossDomainLeak(prompt, rawText)) {
    return "answer-leaked-unrelated-domain-context";
  }
  if (flightWeatherMissingRouteCity(prompt, rawText)) {
    return "flight-weather-answer-missing-route-city";
  }
  if (requiresFreshEvidenceForDialogue({ category, prompt }) && !hasToolEvidence && !hasHonestNoEvidenceAnswer(rawText)) {
    return "fresh-evidence-question-without-tool-event";
  }
  if (isCodeGenerationPrompt(String(prompt || ""), category) && !hasCodeLikeAnswer(rawText)) {
    return "code-generation-question-without-code";
  }
  if (isCharacterProfilePrompt(String(prompt || ""), category) && !hasCharacterProfile(rawText)) {
    return "creative-character-profile-too-thin";
  }
  if (isNarrativeWritingPrompt(String(prompt || ""), category) && !hasNarrativeProse(rawText)) {
    return "creative-writing-question-without-narrative-prose";
  }
  if (isWritingPlanningPrompt(String(prompt || ""), category) && !hasWritingPlan(rawText)) {
    return "creative-writing-plan-too-thin";
  }
  if (isEducationExplanationPrompt(String(prompt || ""), category) && hasEducationalExplanationAnswer(rawText)) {
    return "";
  }
  if (isScenarioCategory(category) && !hasActionableAnswerForScenario(rawText) && !hasEvidenceBoundaryAnswer(rawText)) {
    return "daily-or-industry-scenario-answer-not-actionable";
  }
  return "";
}
