/**
 * content-filter.js — 基于 DFA（确定有限自动机）的高性能内容安全过滤
 *
 * 启动时加载 17 类关键词库到 Trie 树，对输入/输出文本做实时过滤。
 * 支持三级处置：BLOCK（屏蔽） / WARN（警告） / LOG（记录）
 *
 * 用法：
 *   import { ContentFilter } from '../lib/content-filter.js';
 *   const filter = new ContentFilter();
 *   await filter.init();
 *   const result = filter.check('some text');
 *   // { blocked: false, matches: [], level: 'pass' }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'content-filter-data');

// ── 三级处置策略 ──

const CATEGORY_LEVELS = {
  '01-political-subversion':   'block',
  '02-national-security':      'block',
  '03-extremism-terrorism':    'block',
  '04-ethnic-discrimination':  'block',
  '05-religious-discrimination':'block',
  '06-regional-discrimination':'warn',
  '07-gender-discrimination':  'warn',
  '08-pornography':            'block',
  '09-violence-terror':        'block',
  '10-gambling':               'warn',
  '11-drugs':                  'block',
  '12-defamation':             'warn',
  '13-misinformation':         'warn',
  '14-self-harm':              'block',
  '15-privacy-leak':           'warn',
  '16-personal-attack':        'warn',
  '17-ip-infringement':        'warn',
};

// ── Trie 节点 ──

// 上下文白名单模式：当输入包含这些教育/学术/求助性短语时，短敏感词不触发拦截
const SAFE_CONTEXT_PATTERNS = [
  /如何帮助|如何应对|如何防[护范止]|如何保护|如何预防/,
  /什么是.{0,6}[？?]|的定义|的概念|的含义|的区别|的原因|怎么看/,
  /请.{0,4}介绍|请.{0,4}分析|请.{0,4}解释|客观分析|客观看待/,
  /法律规定|政策|管控|法.{0,2}是什么|保护法/,
  /心理.{0,6}[干预咨询治疗帮助]|危机干预|心理援助|心理恢复/,
  /教育|学术|研究|科普|知识|原理|机制|历史|发展/,
  /有哪些|有什么|是什么|包含|包括|主要内容/,
  /如何.{0,6}[戒除克服应对处理解决改善]/,
  /财经|行情|股价|股票|基金|指数|汇率|金价|报价|价格|开盘|收盘|成交量|投资建议|不构成投资/,
  /商务邮件|工作邮件|会议|项目|纪要|客户|合同|办公|任务规划|工作计划|时间安排|风险|冲突/,
  /(?:文件|文件夹|目录|路径|本地操作|工具结果|真实工具|执行命令|已执行命令|mkdir|mv|cp|read).{0,16}(?:创建|移动|复制|读取|查询|整理)|(?:创建|移动|复制|读取|查询|整理).{0,16}(?:文件|文件夹|目录|路径|本地操作|工具结果|真实工具|命令)/,
];

// 在教育语境中豁免的短词（这些词单独出现时是高频误拦源）
const CONTEXTUAL_EXEMPT_WORDS = new Set([
  '政府', '恐怖主义', '毒品', '自杀', '自残', '暴力', '赌博',
  '色情', '诽谤', '歧视', '侵权', '犯罪', '校园霸凌',
  '暴力犯罪', '暴力事件', '名誉损害', '维权', '危机干预',
  '护法', '管控', '成瘾', '网暴', '价格', '开盘', '冲突',
  '复制',
]);

function isAsciiTokenChar(char) {
  return /[a-z0-9]/i.test(char || '');
}

function shouldSkipEmbeddedAsciiShortWord(text, start, end, word) {
  if (!/^[a-z0-9]{1,4}$/i.test(word || '')) return false;
  return isAsciiTokenChar(text[start - 1]) || isAsciiTokenChar(text[end]);
}

class TrieNode {
  constructor() {
    this.children = new Map();
    this.isEnd = false;
    this.category = null;   // 命中时的风险类别
    this.level = null;      // 处置级别
  }
}

// ── 核心过滤器 ──

export class ContentFilter {
  constructor(opts = {}) {
    this._root = new TrieNode();
    this._dataDir = opts.dataDir || DATA_DIR;
    this._wordCount = 0;
    this._categories = new Map(); // categoryId → { name, count }
    this._loaded = false;
  }

  /**
   * 初始化：加载词库到 Trie 树
   */
  async init() {
    if (this._loaded) return;
    const t0 = performance.now();

    const files = fs.readdirSync(this._dataDir)
      .filter(f => /^\d{2}-.*\.txt$/.test(f))
      .sort();

    for (const file of files) {
      const categoryId = file.replace('.txt', '');
      const level = CATEGORY_LEVELS[categoryId] || 'log';
      const content = fs.readFileSync(path.join(this._dataDir, file), 'utf-8');
      const words = content.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

      let count = 0;
      for (const word of words) {
        this._insert(word.toLowerCase(), categoryId, level);
        count++;
      }
      this._categories.set(categoryId, { name: categoryId, count });
      this._wordCount += count;
    }

    this._loaded = true;
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`[content-filter] 加载完成: ${this._wordCount} 词, ${this._categories.size} 类, ${elapsed}ms`);
  }

  /**
   * 插入关键词到 Trie
   */
  _insert(word, category, level) {
    let node = this._root;
    for (const char of word) {
      if (!node.children.has(char)) {
        node.children.set(char, new TrieNode());
      }
      node = node.children.get(char);
    }
    node.isEnd = true;
    // block > warn > log 优先级
    if (!node.category || this._levelPriority(level) > this._levelPriority(node.level)) {
      node.category = category;
      node.level = level;
    }
  }

  _levelPriority(level) {
    if (level === 'block') return 3;
    if (level === 'warn') return 2;
    return 1;
  }

  /**
   * 检查文本，返回匹配结果
   *
   * @param {string} text - 待检查文本
   * @returns {{ blocked: boolean, level: 'pass'|'log'|'warn'|'block', matches: Array<{ word: string, category: string, level: string, position: number }> }}
   */
  check(text) {
    if (!this._loaded || !text) {
      return { blocked: false, level: 'pass', matches: [] };
    }

    const normalizedText = text
      .toLowerCase()
      // URLs often contain base64-ish path fragments that accidentally spell
      // short sensitive words. Mask them before Trie scanning while preserving
      // string length so match positions still point into the original text.
      .replace(/https?:\/\/\S+/g, (match) => ' '.repeat(match.length));

    // 上下文白名单：教育/学术/求助/客观讨论语境放行短敏感词
    const isEducationalContext = SAFE_CONTEXT_PATTERNS.some(p => p.test(normalizedText));

    const matches = [];
    let maxLevel = 'pass';

    for (let i = 0; i < normalizedText.length; i++) {
      let node = this._root;
      let j = i;

      while (j < normalizedText.length && node.children.has(normalizedText[j])) {
        node = node.children.get(normalizedText[j]);
        j++;

        if (node.isEnd) {
          // 上下文白名单豁免：教育语境 + 短词（≤4字）→ 跳过
          const wordLen = j - i;
          const matchedWord = normalizedText.slice(i, j);
          // 英文短词库容易误伤普通单词子串，例如 sm 命中 small、kill 命中 skill。
          // 短英文敏感词必须以独立 token 出现，避免正常英文翻译/写作被 block。
          if (shouldSkipEmbeddedAsciiShortWord(normalizedText, i, j, matchedWord)) {
            continue;
          }
          if (isEducationalContext && wordLen <= 4 && CONTEXTUAL_EXEMPT_WORDS.has(matchedWord)) {
            continue;
          }

          const match = {
            word: text.slice(i, j),  // 保留原始大小写
            category: node.category,
            level: node.level,
            position: i,
          };
          matches.push(match);

          if (this._levelPriority(node.level) > this._levelPriority(maxLevel)) {
            maxLevel = node.level;
          }
        }
      }
    }

    return {
      blocked: maxLevel === 'block',
      level: maxLevel,
      matches,
    };
  }

  /**
   * 替换文本中的敏感词为 ***
   *
   * @param {string} text - 原始文本
   * @returns {{ filtered: string, matches: Array }}
   */
  filter(text) {
    const result = this.check(text);
    if (result.matches.length === 0) {
      return { filtered: text, matches: [] };
    }

    // 按位置排序，从后往前替换（避免位移）
    const sorted = [...result.matches].sort((a, b) => b.position - a.position);
    let filtered = text;
    const replaced = new Set();

    for (const match of sorted) {
      const key = `${match.position}:${match.word.length}`;
      if (replaced.has(key)) continue;
      replaced.add(key);

      const stars = '*'.repeat(match.word.length);
      filtered = filtered.slice(0, match.position) + stars + filtered.slice(match.position + match.word.length);
    }

    return { filtered, matches: result.matches };
  }

  /**
   * 获取统计信息
   */
  get stats() {
    return {
      loaded: this._loaded,
      totalWords: this._wordCount,
      categories: Object.fromEntries(this._categories),
    };
  }
}
