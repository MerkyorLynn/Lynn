#!/usr/bin/env node
/**
 * run-safety-tests.js — 自动化安全测试执行器
 *
 * 读取 docs/safety-test-suite.csv，逐题通过 ContentFilter 检测，
 * 记录结果并输出通过率统计。
 *
 * 用法：node scripts/run-safety-tests.js [--limit N]
 *
 * 注意：这个脚本只测 ContentFilter（输入侧关键词过滤），
 * 不测模型实际响应（那需要调用 LLM，耗时长且消耗额度）。
 * 模型响应测试需要单独运行 run-safety-tests-llm.js（待后续实现）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContentFilter } from '../lib/content-filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(__dirname, '..', 'docs');
const CSV_PATH = path.join(DOCS, 'safety-test-suite.csv');

// ── 参数解析 ──
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) || Infinity : Infinity;

// ── CSV 解析 ──
function parseCSVRow(line) {
  const parts = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      parts.push(current); current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

// ── 主流程 ──
async function main() {
  console.log('=== 安全测试执行器 ===\n');

  // 1. 加载 ContentFilter
  const filter = new ContentFilter();
  await filter.init();

  // 2. 读取题集
  const raw = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '');
  const lines = raw.split('\n').filter(l => l.trim());
  const header = lines[0];
  const rows = lines.slice(1);

  console.log(`题集: ${rows.length} 题\n`);

  // 3. 执行测试
  const results = [];
  let testedCount = 0;
  const stats = {
    total: 0,
    reject: { total: 0, pass: 0, fail: 0 },
    normal: { total: 0, pass: 0, fail: 0 },
    byCategory: {},
  };

  for (const row of rows) {
    if (testedCount >= LIMIT) break;
    const parts = parseCSVRow(row);
    if (parts.length < 6) continue;

    const [id, majorCat, minorCat, type, question, expected] = parts;
    const isReject = type === '应拒答';
    const isNormal = type === '非拒答';
    if (!isReject && !isNormal) continue;

    // 执行 ContentFilter 检查
    const check = filter.check(question);
    let passed;

    if (isReject) {
      // 应拒答题：ContentFilter 返回 blocked=true 才算通过
      // 注意：很多应拒答题不会被关键词过滤器拦截（需要模型层拒答）
      // 这里只测输入侧过滤，模型层拒答需要单独测试
      passed = check.blocked;
      stats.reject.total++;
      if (passed) stats.reject.pass++;
      else stats.reject.fail++;
    } else {
      // 非拒答题：ContentFilter 不应该 block，否则是误拦
      passed = !check.blocked;
      stats.normal.total++;
      if (passed) stats.normal.pass++;
      else stats.normal.fail++;
    }

    // 统计分类
    const catKey = minorCat;
    if (!stats.byCategory[catKey]) {
      stats.byCategory[catKey] = { total: 0, pass: 0, fail: 0 };
    }
    stats.byCategory[catKey].total++;
    if (passed) stats.byCategory[catKey].pass++;
    else stats.byCategory[catKey].fail++;

    results.push({
      id, majorCat, minorCat, type, question, expected,
      filterResult: check.level,
      filterBlocked: check.blocked,
      filterMatches: check.matches.map(m => `${m.word}(${m.category})`).join('; '),
      passed,
    });

    stats.total++;
    testedCount++;
  }

  // 4. 输出结果
  console.log('=== 测试结果（ContentFilter 输入侧）===\n');

  const rejectRate = stats.reject.total > 0
    ? (stats.reject.pass / stats.reject.total * 100).toFixed(1)
    : 'N/A';
  const normalRate = stats.normal.total > 0
    ? (stats.normal.pass / stats.normal.total * 100).toFixed(1)
    : 'N/A';
  const falsePositiveRate = stats.normal.total > 0
    ? (stats.normal.fail / stats.normal.total * 100).toFixed(1)
    : 'N/A';

  console.log(`总测试: ${stats.total}`);
  console.log(`\n应拒答测试（ContentFilter 拦截率）:`);
  console.log(`  总数: ${stats.reject.total}`);
  console.log(`  被拦截: ${stats.reject.pass}`);
  console.log(`  未拦截: ${stats.reject.fail}（需要模型层拒答）`);
  console.log(`  输入侧拦截率: ${rejectRate}%`);

  console.log(`\n非拒答测试（误拦率）:`);
  console.log(`  总数: ${stats.normal.total}`);
  console.log(`  正确放行: ${stats.normal.pass}`);
  console.log(`  误拦截: ${stats.normal.fail}`);
  console.log(`  误拦率: ${falsePositiveRate}%`);
  console.log(`  正确放行率: ${normalRate}%`);

  // 5. 输出详细报告
  const reportLines = [
    '题号,大类,小类,类型,题目,预期行为,过滤级别,是否拦截,命中词,测试通过',
  ];
  for (const r of results) {
    const escaped = (s) => `"${String(s).replace(/"/g, '""')}"`;
    reportLines.push([
      r.id, escaped(r.majorCat), escaped(r.minorCat), r.type,
      escaped(r.question), r.expected, r.filterResult,
      r.filterBlocked ? '是' : '否',
      escaped(r.filterMatches || '无'),
      r.passed ? '✅' : '❌',
    ].join(','));
  }

  const reportPath = path.join(DOCS, 'safety-test-results.csv');
  fs.writeFileSync(reportPath, '\uFEFF' + reportLines.join('\n'), 'utf-8');

  // 6. 误拦详情
  const falsePositives = results.filter(r => r.type === '非拒答' && !r.passed);
  if (falsePositives.length > 0) {
    console.log(`\n=== 误拦详情（${falsePositives.length} 条）===`);
    for (const fp of falsePositives.slice(0, 20)) {
      console.log(`  ❌ [${fp.id}] "${fp.question}" → 命中: ${fp.filterMatches}`);
    }
  }

  // 7. 保存统计
  const statsPath = path.join(DOCS, 'safety-test-results-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify({
    ...stats,
    rejectFilterRate: rejectRate + '%',
    falsePositiveRate: falsePositiveRate + '%',
    normalPassRate: normalRate + '%',
    testedAt: new Date().toISOString(),
    note: '此结果为 ContentFilter 输入侧过滤测试。应拒答题中"未拦截"的部分需要模型层拒答（LLM 测试另行进行）。',
  }, null, 2));

  console.log(`\n报告: ${reportPath}`);
  console.log(`统计: ${statsPath}`);
}

main().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
