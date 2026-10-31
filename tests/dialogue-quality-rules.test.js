import { describe, expect, it } from "vitest";
import { weatherAnswerUsesUnrelatedSearch, hasUsdCnyRate } from "../scripts/dialogue-quality-rules.mjs";
import { deniesAvailableToolCapability, additionalDialogueQualityReason, claimsFreshToolEvidence, containsMislabeledRelativeDate, containsPastDateFutureStartContradiction, hasVerifiedEmptySportsResult, hasVerifiedEmptySportsWindow, hasVerifiedNoFixturePredictionAnswer, omitVerifiedSportsFetchWindows, overridesVerifiedEmptySportsWindow } from "../scripts/dialogue-quality-rules.mjs";

describe("dialogue quality rules", () => {
  it.each([
    '世界杯（10月17日–11月7日）——今晚有两场比赛。',
    '展览（2026-10-01至2026-11-02）今天开放。',
    '活动（10月17日）结束，今晚（10月24日）休息。',
  ])('does not bind dates inside a closed schedule parenthesis to the next clause: %s', (text) => {
    expect(containsMislabeledRelativeDate('今天晚上安排', text, '2026-10-24')).toBe(false);
  });

  it.each([
    '世界杯（10月17日–11月7日）——今晚（10月22日）有两场比赛。',
    '活动（10月17日）——也就是今晚，没有比赛。',
    '展览（2026-10-01）即今天开放。',
    '今晚是10月17日至11月7日。',
  ])('still rejects explicit incorrect relative dates around parentheses: %s', (text) => {
    expect(containsMislabeledRelativeDate('今天晚上安排', text, '2026-10-24')).toBe(true);
  });

  it.each([
    '1 美元 = **6.6925** 人民币',
    '1 USD = `6.692129` CNY',
    'USD/CNY：6.6925',
    '美元兑人民币汇率约为6.6925元。',
  ])('recognizes rates independently of Markdown presentation: %s', (text) => {
    expect(hasUsdCnyRate(text)).toBe(true);
  });

  it.each([
    'USD/CNY：2026-10-11，未取得汇率。',
    '美元兑人民币，2026年10月11日暂无数据。',
    'USD/CNY 请求失败，错误码429。',
    '1美元的报价暂不可用，已查询2个来源。',
  ])('does not treat dates or error counters as rates: %s', (text) => {
    expect(hasUsdCnyRate(text)).toBe(false);
  });

  it.each([
    'Lynn CLI 的工具集中暂未包含天气查询功能。',
    '当前工具不支持实时查询股价。',
    '没有汇率查询工具。',
  ])('still rejects explicit denial of declared tools: %s', (text) => {
    expect(deniesAvailableToolCapability(text)).toBe(true);
  });

  it.each([
    'ECB 为日度官方参考汇率，不能替代银行结售汇牌价或实时成交价。',
    '搜索源返回429和超时，本次无法取得实时板块排行。',
    '当前工具只返回指数样本，无法判断实时全市场异动。',
    '没有拿到天气数据，工具返回上游错误。',
  ])('does not mistake data scope for missing tool capability: %s', (text) => {
    expect(deniesAvailableToolCapability(text)).toBe(false);
  });

  it("accepts declining a prediction only when the requested empty window is verified", () => {
    const result = {
      prompt: "预测今晚比赛比分", currentDate: "2026-10-09",
      assistantText: "今晚没有比赛可预测，所以给不出比分。",
      toolEvents: [{ name: "sports_score", event: "end", ok: true, details: [
        "provider: espn_scoreboard", "directSourceStatus: ok", "matched: 0",
        "dateRange: 20261009-20261010",
        "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20261009",
      ] }],
    };
    expect(hasVerifiedNoFixturePredictionAnswer(result)).toBe(true);
    expect(hasVerifiedNoFixturePredictionAnswer({ ...result, assistantText: "今晚没有比赛，所以不存在可以预测的比分。" })).toBe(true);
    expect(hasVerifiedNoFixturePredictionAnswer({ ...result, assistantText: "今晚没有世界杯比赛，所以没有比分可以预测。" })).toBe(true);
    expect(hasVerifiedNoFixturePredictionAnswer({ ...result, toolEvents: [], assistantText: "今晚没有世界杯比赛，所以没有比分可以预测。" })).toBe(false);
    expect(hasVerifiedNoFixturePredictionAnswer({ ...result, toolEvents: [] })).toBe(false);
    expect(hasVerifiedNoFixturePredictionAnswer({ ...result, toolEvents: [{ ...result.toolEvents[0], ok: false }] })).toBe(false);
    expect(hasVerifiedNoFixturePredictionAnswer({ ...result, currentDate: "2026-10-11" })).toBe(false);
    expect(hasVerifiedNoFixturePredictionAnswer({ ...result, assistantText: "今晚没有比赛，但预测比分为 2-1。" })).toBe(false);
    expect(hasVerifiedNoFixturePredictionAnswer({ ...result, assistantText: "赛事已结束，无法预测比分。" })).toBe(false);
  });

  it("separates source timestamps from relative forecast dates without allowing incorrect dates", () => {
    const prompt = "深圳明天下雨吗？";
    const text = "明天（2026-10-10）深圳不下雨。中国气象局数据（更新时间 2026-10-09 23:20）显示：明天白天晴。";
    expect(containsMislabeledRelativeDate(prompt, text, "2026-10-09")).toBe(false);
    expect(containsMislabeledRelativeDate(prompt, text.replace("明天（2026-10-10）", "明天（2026-10-09）"), "2026-10-09")).toBe(true);
    expect(containsMislabeledRelativeDate(prompt, "更新时间2026-10-09，明天2026-10-11有雨。", "2026-10-09")).toBe(true);
    expect(containsMislabeledRelativeDate(prompt, "截至2026年10月9日23时发布：明天2026年10月10日晴。", "2026-10-09")).toBe(false);
    expect(containsMislabeledRelativeDate(prompt, "2026-10-09明天有雨。", "2026-10-09")).toBe(true);
    expect(containsMislabeledRelativeDate("昨晚比赛结果", "昨晚2026-10-07没有比赛。", "2026-10-09")).toBe(true);
    expect(containsMislabeledRelativeDate("今晚比赛结果", "今晚2026-10-10凌晨的比赛。", "2026-10-09")).toBe(false);
    expect(containsMislabeledRelativeDate(prompt, "明天2027-01-01有雨。", "2026-12-31")).toBe(false);
  });

  it('does not bind a source publication timestamp to the following forecast label', () => {
    const text = '深圳明天（2026-10-15）不下雨。依据中国气象局 2026-10-14 19:30 更新的预报：明天白天多云，夜间晴。';
    expect(containsMislabeledRelativeDate('深圳明天下雨吗？', text, '2026-10-14')).toBe(false);
    expect(containsMislabeledRelativeDate('深圳明天下雨吗？', text.replace('明天（2026-10-15）', '明天（2026-10-14）'), '2026-10-14')).toBe(true);
    expect(containsMislabeledRelativeDate('深圳明天下雨吗？', text.replace('明天白天', '明天2026-10-16白天'), '2026-10-14')).toBe(true);
  });

  it.each([
    '2026年10月9日–11日（含昨晚10月10日）没有比赛。',
    '2026-10-09至2026-10-11（包含昨晚2026-10-10）没有比赛。',
    '2026年10月9日至12日(覆盖明天10月12日)的天气查询。',
    '2026年10月9日至12日（包括今天10月11日）的行情。',
  ])('does not equate a containing interval with its explicitly dated relative day: %s', (text) => {
    expect(containsMislabeledRelativeDate('今天明天昨晚的情况', text, '2026-10-11')).toBe(false);
  });

  it.each([
    '昨晚是2026年10月9日–11日（含昨晚10月10日）。',
    '2026年10月9日–11日（含昨晚10月9日）没有比赛。',
    '2026年10月9日（也就是昨晚）没有比赛。',
    '2026年10月9日昨晚没有比赛。',
    '明天2026-10-11有雨，查询范围2026-10-09至2026-10-12（包含明天）。',
  ])('still rejects wrong explicit day bindings even around containment clauses: %s', (text) => {
    expect(containsMislabeledRelativeDate('今天明天昨晚的情况', text, '2026-10-11')).toBe(true);
  });

  it("separates verified fetch buffers from answer dates without hiding wrong conclusions", () => {
    const event = { name: "sports_score", event: "end", ok: true, details: [
      "directSourceStatus: ok",
      "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=950&dates=20261007-20261010",
    ] };
    const text = "昨晚（2026年10月8日）没有比赛。\n赛事数据源（ESPN）：查询了2026-10-07至2026-10-10。";
    const normalized = omitVerifiedSportsFetchWindows(text, [event]);
    expect(normalized).toContain("2026年10月8日");
    expect(normalized).not.toContain("2026-10-07");
    expect(omitVerifiedSportsFetchWindows(text, [])).toBe(text);
    expect(omitVerifiedSportsFetchWindows(text, [{ ...event, ok: false }])).toBe(text);
    const wrong = "ESPN显示昨晚是2026-10-07至2026-10-10，没有比赛。";
    expect(omitVerifiedSportsFetchWindows(wrong, [event])).toBe(wrong);
    const wrongWindow = "赛事数据源（ESPN）：查询了2026-10-06至2026-10-11。";
    expect(omitVerifiedSportsFetchWindows(wrongWindow, [event])).toBe(wrongWindow);
    expect(omitVerifiedSportsFetchWindows("根据工具核查结果（ESPN，2026-10-07 至 10-10）：", [event])).not.toContain("2026-10-07");
  });

  it("keeps relative-date conclusions distinct from explicitly verified query windows", () => {
    const event = { name: "sports_score", event: "end", ok: true, details: [
      "directSourceStatus: ok", "dateRange: 20261009-20261011",
      "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20261008-20261012",
    ] };
    const text = "昨晚（北京时间2026年10月10日）没有比赛。\n查询范围：北京时间2026-10-09至2026-10-11（含昨晚10-10），数据源为ESPN。";
    const normalized = omitVerifiedSportsFetchWindows(text, [event]);
    expect(normalized).toContain("2026年10月10日");
    expect(normalized).toContain("（含昨晚10-10）");
    expect(containsMislabeledRelativeDate("昨晚比赛", normalized, "2026-10-11")).toBe(false);
    expect(containsMislabeledRelativeDate("昨晚比赛", normalized.replace("2026年10月10日", "2026年10月9日"), "2026-10-11")).toBe(true);
    expect(omitVerifiedSportsFetchWindows(text, [])).toBe(text);
    expect(omitVerifiedSportsFetchWindows(text, [{ ...event, ok: false }])).toBe(text);
    expect(omitVerifiedSportsFetchWindows(text, [{ ...event, details: event.details.filter((line) => !line.startsWith("dateRange:")) }])).toBe(text);
    const wrongWindow = text.replace("2026-10-09至", "2026-10-07至");
    expect(omitVerifiedSportsFetchWindows(wrongWindow, [event])).toBe(wrongWindow);
    const wrongClaim = "ESPN显示昨晚是2026-10-09至2026-10-11，没有比赛。";
    expect(omitVerifiedSportsFetchWindows(wrongClaim, [event])).toBe(wrongClaim);
  });

  it('does not label a verified retrieval interval as the date of a quoted no-game conclusion', () => {
    const event = { name: 'sports_score', event: 'end', ok: true, details: [
      'directSourceStatus: ok', 'dateRange: 20261007-20261014',
      'source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20261006-20261015',
    ] };
    const text = '昨晚（10月13日晚至10月14日）没有比赛。“昨晚无赛”的结论覆盖检索区间 10月7日至10月14日，该区间赛事为0场。';
    const normalized = omitVerifiedSportsFetchWindows(text, [event]);
    expect(containsMislabeledRelativeDate('昨晚比分', normalized, '2026-10-14')).toBe(false);
    expect(normalized).toContain('10月13日');
    expect(omitVerifiedSportsFetchWindows(text, [])).toBe(text);
    expect(omitVerifiedSportsFetchWindows(text.replace('10月7日至', '10月5日至'), [event])).toContain('10月5日至');
    expect(containsMislabeledRelativeDate('昨晚比分', normalized.replace('10月13日', '10月11日'), '2026-10-14')).toBe(true);
  });

  it("recognizes verified yearless query buffers without relabeling tonight", () => {
    const event = { name: "sports_score", event: "end", ok: true, details: [
      "directSourceStatus: ok", "dateRange: 20261011-20261011",
      "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20261010-20261012",
    ] };
    const text = "今晚（2026年10月11日）没有比赛。ESPN查询10月10日至10月12日（含今晚及前后各一天的时区缓冲窗口），均未匹配到比赛。";
    const normalized = omitVerifiedSportsFetchWindows(text, [event]);
    expect(normalized).toContain("今晚（2026年10月11日）");
    expect(normalized).toContain("含今晚及前后各一天");
    expect(containsMislabeledRelativeDate("今晚比赛", normalized, "2026-10-11")).toBe(false);
    expect(containsMislabeledRelativeDate("今晚比赛", normalized.replace("2026年10月11日", "2026年10月10日"), "2026-10-11")).toBe(true);
    expect(omitVerifiedSportsFetchWindows(text, [])).toBe(text);
    const wrong = "今晚（10月10日至10月12日）没有比赛。";
    expect(omitVerifiedSportsFetchWindows(wrong, [event])).toBe(wrong);
    expect(containsMislabeledRelativeDate("今晚比赛", wrong, "2026-10-11")).toBe(true);
  });

  it("distinguishes verified Markdown query-window cells from date conclusions", () => {
    const event = { name: "sports_score", event: "end", ok: true, details: [
      "directSourceStatus: ok", "dateRange: 20261010-20261012",
      "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20261009-20261013",
    ] };
    const text = "今晚（2026-10-11）无比赛。\n| 检索范围 | 结果 |\n|---|---|\n| 2026-10-09 ~ 10-13(含今晚) | 0场 |";
    const normalized = omitVerifiedSportsFetchWindows(text, [event]);
    expect(normalized).toContain("[已核验的查询窗口](含今晚)");
    expect(containsMislabeledRelativeDate("今晚比赛", normalized, "2026-10-11")).toBe(false);
    expect(containsMislabeledRelativeDate("今晚比赛", normalized.replace("今晚（2026-10-11）", "今晚（2026-10-09）"), "2026-10-11")).toBe(true);
    expect(omitVerifiedSportsFetchWindows(text, [])).toBe(text);
    expect(omitVerifiedSportsFetchWindows(text, [{ ...event, ok: false }])).toBe(text);
    for (const wrong of [text.replace("检索范围", "比赛日期"), text.replace("| 2026-10-09", "| 今晚是2026-10-09"), text.replace("10-13(含今晚)", "10-14(含今晚)")]) {
      expect(omitVerifiedSportsFetchWindows(wrong, [event])).toBe(wrong);
    }
    const wrongConclusion = text.replace("0场", "今晚是2026-10-09");
    expect(containsMislabeledRelativeDate("今晚比赛", omitVerifiedSportsFetchWindows(wrongConclusion, [event]), "2026-10-11")).toBe(true);
    const wrongOutsideTable = text + "\n\n| 2026-10-09 ~ 10-13(含今晚) |";
    expect(omitVerifiedSportsFetchWindows(wrongOutsideTable, [event])).toContain("\n\n| 2026-10-09 ~ 10-13(含今晚) |");
  });

  it("accepts an empty sports window only with successful, dated, direct-source evidence", () => {
    const result = {
      prompt: "昨晚世界杯最新的比赛结果", currentDate: "2026-10-09",
      assistantText: "北京时间昨晚没有世界杯比赛，共 0 场，不能编造比分。",
      toolEvents: [{ name: "sports_score", event: "end", ok: true, details: [
        "provider: espn_scoreboard", "directSourceStatus: ok", "matched: 0",
        "dateRange: 20261008-20261009",
        "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=950&dates=20261008",
      ] }],
    };
    expect(hasVerifiedEmptySportsResult(result)).toBe(true);
    for (const assistantText of [
      "昨晚赛果：\n| Alpha vs Beta | **3–1** |\n结构化数据源返回 0 场，结论以新闻为准。",
      "当晚 4 场比赛共打入 19 球。ESPN 返回 0 场比赛。",
      "比分为 2-1。数据源返回 0 场，存在取数缺口。",
    ]) {
      expect(hasVerifiedEmptySportsResult({ ...result, assistantText })).toBe(false);
      expect(overridesVerifiedEmptySportsWindow({ ...result, assistantText })).toBe(true);
    }
    expect(hasVerifiedEmptySportsResult({ ...result, assistantText: '该日期 0 场。历史赛果 2-1 不属于昨晚，不能确认昨晚有比赛。' })).toBe(true);
    expect(hasVerifiedEmptySportsResult({ ...result, assistantText: '已查询的赛事昨晚没有比赛，共 0 场。\n另外一项赛事的已核实赛果：\n| Alpha vs Beta | 3–1 |' })).toBe(true);
    const endedScope = '- 赛事 Alpha：已于今年7月结束。\n## 赛事 Beta 最近赛果\n| Team One vs Team Two | 3–1 |';
    expect(hasVerifiedEmptySportsResult({ ...result, assistantText: endedScope })).toBe(true);
    expect(hasVerifiedEmptySportsResult({ ...result, assistantText: endedScope.replace('今年7月', '今年 7 月').replace('。\n##', '。##') })).toBe(true);
    expect(hasVerifiedEmptySportsResult({ ...result, assistantText: endedScope, toolEvents: [] })).toBe(false);
    for (const assistantText of [
      endedScope.replace('赛事 Beta 最近赛果', '赛事 Alpha 昨晚赛果'),
      endedScope.replace('今年7月', '今年12月'),
      endedScope.replace('今年7月', '今年10月8日'),
      endedScope.replace('## 赛事 Beta 最近赛果\n', ''),
    ]) expect(hasVerifiedEmptySportsResult({ ...result, assistantText })).toBe(false);
    for (const assistantText of ["昨晚没有世界杯足球赛。", "昨晚未查询到任何世界杯足球比赛。", "昨晚未查到该联赛赛事。", "昨晚未检索到该联赛比赛。"]) {
      expect(hasVerifiedEmptySportsResult({ ...result, assistantText })).toBe(true);
      expect(overridesVerifiedEmptySportsWindow({ ...result, assistantText })).toBe(false);
      expect(hasVerifiedEmptySportsResult({ ...result, assistantText, toolEvents: [] })).toBe(false);
      expect(hasVerifiedEmptySportsResult({ ...result, assistantText, currentDate: "2026-11-18" })).toBe(false);
    }
    expect(hasVerifiedEmptySportsWindow({ ...result, assistantText: "历史决赛 Alpha 2-1 Beta。" })).toBe(true);
    const historical = { name: "sports_score", event: "end", ok: true, details: [
      "provider: espn_scoreboard", "directSourceStatus: ok", "matched: 4",
      "dateRange: 20260701-20260731",
      "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=950&dates=20260701-20260731",
    ] };
    const mixed = { ...result, toolEvents: [...result.toolEvents, historical] };
    expect(overridesVerifiedEmptySportsWindow({ ...mixed, assistantText: "7月19日历史决赛 Alpha 2-1 Beta。" })).toBe(true);
    expect(overridesVerifiedEmptySportsWindow(mixed)).toBe(false);
    expect(overridesVerifiedEmptySportsWindow({ ...result, toolEvents: [historical] })).toBe(false);
    expect(hasVerifiedEmptySportsWindow({ ...result, prompt: "今天世界杯最新比赛结果", toolEvents: [{ ...result.toolEvents[0], details: result.toolEvents[0].details.map((line) => line.replace("20261008-20261009", "20261008-20261008")) }] })).toBe(false);
    const parallel = { name: "parallel_research", event: "end", ok: true, details: [
      `subtool: ${JSON.stringify({ name: "sports_score", ok: true, details: result.toolEvents[0].details })}`,
    ] };
    expect(hasVerifiedEmptySportsResult({ ...result, toolEvents: [parallel] })).toBe(true);
    expect(hasVerifiedEmptySportsResult({ ...result, toolEvents: [{ ...parallel, ok: false }] })).toBe(false);
    expect(hasVerifiedEmptySportsResult({ ...result, toolEvents: [{ ...parallel, details: [
      `subtool: ${JSON.stringify({ name: "sports_score", ok: false, details: result.toolEvents[0].details })}`,
    ] }] })).toBe(false);
    expect(hasVerifiedEmptySportsResult({ ...result, toolEvents: [{ ...result.toolEvents[0], details: result.toolEvents[0].details.map((line) => line.replace("20261008-20261009", "20261008-20261008")) }] })).toBe(true);
    expect(hasVerifiedEmptySportsResult({ ...result, toolEvents: [] })).toBe(false);
    expect(hasVerifiedEmptySportsResult({ ...result, toolEvents: [{ ...result.toolEvents[0], ok: false }] })).toBe(false);
    expect(hasVerifiedEmptySportsResult({ ...result, assistantText: "数据源故障，未能查询赛果。" })).toBe(false);
    for (const replacement of [
      ["directSourceStatus: ok", "directSourceStatus: unavailable"],
      ["directSourceStatus: ok", "directSourceStatus: fallback_static_schedule"],
      ["dateRange: 20261008-20261009", "dateRange: 20260601-20260630"],
      ["dateRange: 20261008-20261009", "dateRange: 20261007-20261007"],
      [result.toolEvents[0].details[4], "source: https://example.com/search?q=WorldCup"],
    ]) {
      const details = result.toolEvents[0].details.map((line) => line === replacement[0] ? replacement[1] : line);
      expect(hasVerifiedEmptySportsResult({ ...result, toolEvents: [{ ...result.toolEvents[0], details }] })).toBe(false);
    }
  });

  it("distinguishes verified absence from a past-date future-start contradiction", () => {
    const text = "昨晚（2026年10月8日）没有世界杯比赛，暂无赛果。";
    expect(containsPastDateFutureStartContradiction(text, "2026-10-09")).toBe(false);
    for (const stale of ["要到2026年6月11日才开赛，目前暂无赛果。", "要到 **2026年6月11日~7月19日** 才开打。", "要到2026-10-08才开赛。"]) {
      expect(containsPastDateFutureStartContradiction(stale, "2026-10-09")).toBe(true);
    }
    expect(containsPastDateFutureStartContradiction("今天2026-10-09，要到2027年6月11日才开赛。", "2026-10-09")).toBe(false);
    expect(containsPastDateFutureStartContradiction("要到2026年10月9日才开赛。", "2026-10-09")).toBe(false);
  });

  it("only flags explicit live-result claims as tool evidence", () => {
    expect(claimsFreshToolEvidence("根据查询结果，深圳今天有阵雨。")).toBe(true);
    expect(claimsFreshToolEvidence("搜索结果显示该政策已于今天发布。")).toBe(true);
    expect(claimsFreshToolEvidence("上下文可包含检索到的参考资料和当前输入。")).toBe(false);
    expect(claimsFreshToolEvidence("可以检索相关资料后再做判断。")).toBe(false);
  });

  it("requires a finals series summary rather than accepting unrelated game scores", () => {
    const task = { prompt: "NBA 总决赛打了几场，总比分如何？", category: "realtime", hasToolEvidence: true };
    expect(additionalDialogueQualityReason({ ...task, text: "共查到 23 场比赛：Alpha 110-104 Beta。" })).toBe("nba-finals-answer-missing-series-summary");
    expect(additionalDialogueQualityReason({ ...task, text: "已核实该赛季总决赛打了 7 场，系列赛总比分 4-3。" })).toBe("");
    expect(additionalDialogueQualityReason({ ...task, text: "**NBA 总决赛：Alpha 4–1 Beta（共 5 场）**" })).toBe("");
    expect(additionalDialogueQualityReason({ ...task, text: "**2026 年 NBA 总决赛：5 场结束，Alpha 4-1 Beta。**" })).toBe("");
    expect(additionalDialogueQualityReason({ ...task, text: "NBA 总决赛打了2场，Alpha 1:1 Beta。" })).toBe("");
    expect(additionalDialogueQualityReason({ ...task, text: "NBA 总决赛：7场结束，Alpha 4比3 Beta。" })).toBe("");
    expect(additionalDialogueQualityReason({ ...task, text: "NBA 总决赛：6场结束，Alpha 4-1 Beta。" })).toBe("nba-finals-answer-missing-series-summary");
    expect(additionalDialogueQualityReason({ ...task, text: "NBA 总决赛：5场结束，Alpha 110-104 Beta。" })).toBe("nba-finals-answer-missing-series-summary");
    expect(additionalDialogueQualityReason({ ...task, text: "系列赛共进行 **5 场**，Alpha 以 **4 胜 1 负** 夺冠。" })).toBe("");
    expect(additionalDialogueQualityReason({ ...task, text: "NBA 总决赛数据：Alpha 110-104 Beta，共 23 场。" })).toBe("nba-finals-answer-missing-series-summary");
    expect(additionalDialogueQualityReason({ ...task, text: "NBA 总决赛：Alpha 4-1 Beta，共 23 场。" })).toBe("nba-finals-answer-missing-series-summary");
  });

  it("does not treat a relevant Claude Code product mention as stale context", () => {
    expect(additionalDialogueQualityReason({
      category: "recruiting",
      prompt: "为 AI Agent 前端工程师写一份务实 JD",
      text: "职责：实现流式对话、工具状态和长会话导航。要求：熟悉 React、TypeScript 与 SSE，候选人用过 Cursor、Claude Code 或其他 Agent 产品，并能举例说明交互取舍。面试按代码质量、工程判断和协作沟通评分。",
      hasToolEvidence: false,
    })).toBe("");
  });
  it("accepts character profile prose for writing profile prompts", () => {
    const reason = additionalDialogueQualityReason({
      category: "writing",
      prompt: "给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威",
      hasToolEvidence: false,
      text: "陈默，三十六岁，前结构工程师，现靠承接零散的民用加固设计维生。七年前的一场实验室事故让他的记忆出现缺口，官方结论越完整，他越本能地怀疑。性格上他克制、敏感，不轻易接受权威解释，但仍保留工程师式的秩序感。他的核心动机是找回事故当天缺失的三小时，同时避免自己再被任何机构定义。",
    });

    expect(reason).toBe("");
  });

  it("rejects thin character profile answers", () => {
    const reason = additionalDialogueQualityReason({
      category: "writing",
      prompt: "给一个长篇小说主角写人物小传：前工程师、记忆有缺口、不信任权威",
      hasToolEvidence: false,
      text: "一个前工程师，失忆，不信任权威。",
    });

    expect(reason).toBe("creative-character-profile-too-thin");
  });

  it("rejects visible model-only structure tags but ignores fenced examples", () => {
    expect(additionalDialogueQualityReason({
      category: "education",
      prompt: "做一个 90 天学习计划",
      text: '<phase name="Foundation">每天练习</phase>',
      hasToolEvidence: false,
    })).toBe("model-structural-tag-visible");
    expect(additionalDialogueQualityReason({
      category: "code",
      prompt: "写一个 XML 示例",
      text: '```xml\n<phase name="Foundation">每天练习</phase>\n```',
      hasToolEvidence: false,
    })).toBe("");
    expect(additionalDialogueQualityReason({
      category: "writing",
      prompt: "整理一个世界观设定表",
      text: '<worldbuilding_table>\n| 阶层 | 货币 |\n</worldbuilding_table>',
      hasToolEvidence: false,
    })).toBe("model-structural-tag-visible");
  });

  it("requires a sample boundary for A-share anomaly snapshots", () => {
    expect(additionalDialogueQualityReason({
      category: "realtime",
      prompt: "今天 A 股有什么异动？",
      text: "中际旭创上涨 4.29%。",
      hasToolEvidence: true,
    })).toBe("a-share-anomaly-answer-missing-sample-boundary");
    expect(additionalDialogueQualityReason({
      category: "realtime",
      prompt: "今天 A 股有什么异动？",
      text: "当前只覆盖代表性样本，不是全市场异动榜；样本中中际旭创上涨 4.29%。",
      hasToolEvidence: true,
    })).toBe("");
  });

  it("rejects visible internal task narration at the start of an answer", () => {
    expect(additionalDialogueQualityReason({
      category: "gov_legal",
      prompt: "租房押金纠纷怎么处理？",
      text: "用户需要租房押金纠纷的实操步骤，分协商和证据两块。直接给结构化清单，按时间线排列，让用户能照着执行。先保存合同、付款记录和房屋交接照片。",
      hasToolEvidence: false,
    })).toBe("internal-task-narration-visible");
  });

  it("rejects model-only Chinese angle-bracket structure labels", () => {
    expect(additionalDialogueQualityReason({
      category: "writing",
      prompt: "设计一个三幕式小说大纲",
      text: "<大纲>\n## 第一幕\n主角出租了一段记忆。",
      hasToolEvidence: false,
    })).toBe("model-structural-label-visible");
    expect(additionalDialogueQualityReason({
      category: "writing",
      prompt: "设计一个三幕式小说大纲",
      text: "## 第三幕\n主角找回记忆。\n</大纲>",
      hasToolEvidence: false,
    })).toBe("model-structural-label-visible");
  });

  it("requires both route cities in flight weather answers", () => {
    const task = {
      category: "travel_current",
      prompt: "明天上海飞北京，帮我查天气风险并给穿衣和到机场建议",
      hasToolEvidence: true,
    };
    expect(additionalDialogueQualityReason({
      ...task,
      text: "北京明天有小雨，建议带伞并提前两小时到机场。",
    })).toBe("flight-weather-answer-missing-route-city");
    expect(additionalDialogueQualityReason({
      ...task,
      text: "上海明天多云，北京明天有小雨。天气风险是北京降雨可能影响落地和地面交通，建议带伞并穿短袖加轻薄外套。出发前再检查两地雷达、机场路况和航司动态；国内航班至少提前两小时到机场，早高峰或托运行李较多时再加三十分钟机动。",
    })).toBe("");
  });
});


describe('weather evidence scope', () => {
  it.each(['你能预测今晚世界杯比分吗？', '今天有哪些科技新闻？', '深圳今天有足球比赛吗？'])(
    'does not apply weather-source rules to other current topics: %s', prompt => {
      expect(weatherAnswerUsesUnrelatedSearch(prompt, '百度百科提到赛事日期；今晚没有比赛。')).toBe(false);
    });
  it.each(['深圳明天天气如何？', '北京今天空气质量怎么样？', 'Will it rain tonight?'])(
    'still rejects irrelevant search material for weather questions: %s', prompt => {
      expect(weatherAnswerUsesUnrelatedSearch(prompt, '百度百科介绍当地建城史')).toBe(true);
    });
  it('accepts direct weather observations', () => {
    expect(weatherAnswerUsesUnrelatedSearch('顺德大良明天会下雨吗？', '逐小时预报显示有降雨可能，来源：气象数据。')).toBe(false);
  });
});
