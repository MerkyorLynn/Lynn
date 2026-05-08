// Brain v2 · tool-exec/live_news
// 多窗口扩展新闻检索 (今日/3天/7天) - 调用 web_search 子工具
// Ported from brain v1 server.js (lines 4832-4977)

function compactLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function todayCnText() {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const obj = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return obj.year + '年' + obj.month + '月' + obj.day + '日';
  } catch {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.getUTCFullYear() + '年' + String(d.getUTCMonth() + 1).padStart(2, '0') + '月' + String(d.getUTCDate()).padStart(2, '0') + '日';
  }
}

function buildExpansionQueries(query, days) {
  const raw = compactLine(query);
  const core = compactLine(raw.replace(/(?:请|帮我|查一下|查查|搜索|查询|全网|今天|今日|最新|新闻|有什么|哪些|一下)/g, ' ')) || raw;
  const dateText = todayCnText();
  const windowText = Number(days) <= 1 ? '今日 最新' : '近' + days + '天 最新';
  const queries = [
    raw + ' ' + windowText + ' 消息 新闻',
    core + ' ' + dateText + ' ' + windowText + ' 新闻',
  ];
  if (/干细胞|细胞治疗|再生医学|临床|医疗|医药|医院|药企/i.test(raw)) {
    queries.push(core + ' 细胞治疗 临床研究 产业 政策 进展 ' + windowText);
    queries.push(core + ' 再生医学 医院 药企 备案 ' + windowText);
  } else if (/AI|人工智能|大模型|模型|芯片|半导体|机器人|科技/i.test(raw)) {
    queries.push(core + ' 行业 公司 产品 发布 ' + windowText);
  } else {
    queries.push(core + ' 进展 影响 来源 ' + windowText);
  }
  return [...new Set(queries.map(compactLine).filter(Boolean))].slice(0, 3);
}

export async function liveNews(query, { log, webSearchFn } = {}) {
  const raw = compactLine(query);
  if (!raw) return JSON.stringify({ error: 'empty query' });
  if (typeof webSearchFn !== 'function') {
    return JSON.stringify({ error: 'live_news 需要注入 webSearchFn' });
  }

  const windows = [
    { days: 1, label: '今日/最近36小时' },
    { days: 3, label: '最近3天' },
    { days: 7, label: '最近7天' },
  ];
  const sections = [];
  for (const win of windows) {
    const qs = buildExpansionQueries(raw, win.days);
    const jobs = qs.map((q) =>
      webSearchFn(q)
        .then((text) => ({ q, text }))
        .catch((err) => ({ q, text: '', error: err && err.message })),
    );
    const settled = await Promise.allSettled(jobs);
    const rows = [];
    for (const item of settled) {
      const value = item.status === 'fulfilled' ? item.value : null;
      const text = compactLine(value && value.text);
      if (!text) continue;
      rows.push('【搜索：' + value.q + '】\n' + text.slice(0, 1300) + (text.length > 1300 ? '\n...（已截断）' : ''));
      if (rows.length >= 2) break;
    }
    if (rows.length) {
      sections.push('## ' + win.label + '\n新鲜度：搜索候选，需打开原文核验日期；不要把近 7 天结果说成"今天发生"。\n' + rows.join('\n\n'));
    }
  }
  if (!sections.length) {
    log && log('info', 'tool-exec/live_news', 'no results for: ' + raw);
    return JSON.stringify({ error: 'no news results' });
  }
  log && log('info', 'tool-exec/live_news', 'success: ' + sections.length + ' window sections');
  return [
    '【实时新闻扩展检索】',
    '查询：' + raw,
    '说明：国内默认不依赖 Google News RSS；已自动扩展到 今日/最近36小时、最近3天、最近7天 三个窗口。回答时请先给"今日可核验/搜索候选"的分组结论，并明确哪些需要打开原文核验日期。',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n');
}
