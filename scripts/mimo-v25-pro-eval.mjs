#!/usr/bin/env node
// @ts-nocheck
/**
 * MiMo V2.5 Pro 评测 runner — thinking-on,上下文给够
 *
 * 覆盖 suites:
 *   - mmlu    (需 --mmlu-path,500 全集;cais/mmlu test split)
 *   - gpqa    (默认 worktree smoke 21 题;--gpqa-path 接 Diamond 198 全集)
 *   - humaneval(默认 worktree 7 题;--humaneval-path 接 evalplus 164 全集)
 *   - aime    (worktree 7 道 AIME 数学题)
 *   - finance (worktree 7 题,数字 + tolerance)
 *   - medqa   (worktree 7 题,A/B/C/D)
 *   - v8      (tests/benchmarks/v8-cloud.mjs 的 V5+V6,heuristic 判)
 *
 * Usage:
 *   # 默认 smoke(worktree 内可达数据,跑全部 suite)
 *   node scripts/mimo-v25-pro-eval.mjs --out reports/mimo-pro-smoke
 *
 *   # 完整 GPQA Diamond 198(需外部数据)
 *   node scripts/mimo-v25-pro-eval.mjs --suite gpqa --gpqa-path /data/gpqa_diamond.json \
 *     --out reports/mimo-pro-gpqa-full
 *
 *   # 腾讯云后台跑(完整套件)
 *   nohup node scripts/mimo-v25-pro-eval.mjs \
 *     --mmlu-path /data/mmlu_500.json --gpqa-path /data/gpqa_diamond.json \
 *     --humaneval-path /data/humaneval_plus.json \
 *     --out /data/reports/mimo-v25-pro/$(date +%Y%m%d-%H%M%S) \
 *     --concurrency 4 > /data/reports/mimo-eval.log 2>&1 &
 *
 * Env:
 *   MIMO_PRO_BASE      默认 https://api.xiaomimimo.com/v1
 *   MIMO_PRO_KEY       必填(或在 ~/.lynn/brain.env 配 MIMO_KEY/MIMO_SEARCH_KEY)
 *   MIMO_PRO_MODEL     默认 mimo-v2.5-pro
 *
 * 输出:
 *   <out>/summary.json   — per-suite accuracy + latency p50/p95 + token usage
 *   <out>/<suite>.jsonl  — 每题 prompt / response / pass/fail / reasoning_content / 耗时
 *   <out>/run.log        — 运行日志
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// ── env loader ─────────────────────────────────────────────────
function loadEnvFile() {
  const candidates = [
    process.env.BRAIN_V2_ENV_FILE,
    path.join(process.env.HOME || '', '.lynn/brain.env'),
    '.env',
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#') || !s.includes('=')) continue;
        const [k, ...rest] = s.split('=');
        if (!process.env[k]) process.env[k] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
    } catch { /* ignore */ }
  }
}
loadEnvFile();

// ── CLI args ───────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf('--' + name); return i < 0 ? def : args[i + 1]; }
function flag(name) { return args.includes('--' + name); }

const OUT = arg('out', `reports/mimo-v25-pro-eval/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SUITES = (arg('suite') ? String(arg('suite')).split(',').map(s => s.trim()) : ['gpqa', 'humaneval', 'aime', 'finance', 'medqa', 'v8']);
const CONCURRENCY = Number(arg('concurrency', '4'));
const MAX_TOKENS = Number(arg('max-tokens', '32768'));
const THINKING = arg('thinking', 'enabled');  // enabled | disabled
const PER_Q_TIMEOUT_MS = Number(arg('timeout-ms', '300000'));  // 单题 timeout,默认 300s(thinking-on 难题撞墙保护)
const RESUME = flag('resume');
const DRY_RUN = flag('dry-run');
const DATA_DIR = arg('data-dir', 'tests/benchmarks/v9-comprehensive/data');
const MMLU_PATH = arg('mmlu-path', '');
const GPQA_PATH = arg('gpqa-path', '');
const HUMANEVAL_PATH = arg('humaneval-path', '');

// ── Provider 路由(--provider mimo | deepseek)──────────────────
const PROVIDER = arg('provider', 'mimo');  // mimo (默认) | deepseek

let BASE, KEY, MODEL;
if (PROVIDER === 'deepseek') {
  BASE = (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  KEY = process.env.DEEPSEEK_KEY || '';
  MODEL = arg('model') || process.env.DEEPSEEK_MODEL_OVERRIDE || 'deepseek-v4-flash';
} else {
  // mimo:Endpoint 优先级 MIMO_PRO_BASE → MIMO_BASE → MIMO_SEARCH_BASE
  // 注意:token-plan-cn.xiaomimimo.com 走 tp-* key;api.xiaomimimo.com 走 sk-* key
  BASE = (
    process.env.MIMO_PRO_BASE ||
    process.env.MIMO_BASE ||
    process.env.MIMO_SEARCH_BASE ||
    'https://api.xiaomimimo.com/v1'
  ).replace(/\/+$/, '');
  KEY = process.env.MIMO_PRO_KEY || process.env.MIMO_KEY || process.env.MIMO_SEARCH_KEY || '';
  MODEL = arg('model') || process.env.MIMO_PRO_MODEL || process.env.MIMO_MODEL || 'mimo-v2.5-pro';
}

// ── output prep ────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const LOG = fs.createWriteStream(path.join(OUT, 'run.log'), { flags: 'a' });
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.error(line);
  LOG.write(line + '\n');
}

// ── Provider client(支持 mimo / deepseek)──────────────────────
function buildRequestBody(prompt) {
  const base = {
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.0,
    stream: false,
  };
  if (PROVIDER === 'deepseek') {
    // DeepSeek v4-flash/pro:thinking 默认开,reasoning_content 自动返回
    // 不识别 enable_search / thinking field,加了会被忽略或 400
    return { ...base, max_tokens: MAX_TOKENS };
  }
  // mimo
  return {
    ...base,
    max_completion_tokens: MAX_TOKENS,
    thinking: { type: THINKING },      // enabled / disabled
    enable_search: false,              // eval 关搜索
  };
}

async function callMimoOnce(prompt, { signal, timeout = PER_Q_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeout);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason));
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequestBody(prompt)),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${txt.slice(0, 300)}`);
      err.retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      throw err;
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    return {
      content: String(msg.content || ''),
      reasoning: String(msg.reasoning_content || ''),
      usage: data?.usage || {},
      ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(t);
  }
}

async function callMimo(prompt, { signal, timeout = PER_Q_TIMEOUT_MS, maxRetries = 3 } = {}) {
  if (!KEY) throw new Error(`${PROVIDER.toUpperCase()}_KEY missing`);
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callMimoOnce(prompt, { signal, timeout });
    } catch (e) {
      lastErr = e;
      const msg = (e?.message || String(e)).toLowerCase();
      // 可重试:fetch failed(网络/DNS/连接重置)/ 5xx / 429 / 超时
      const retryable = e.retryable
        || msg.includes('fetch failed')
        || msg.includes('econnreset')
        || msg.includes('etimedout')
        || msg.includes('socket')
        || msg.includes('network');
      if (!retryable || attempt === maxRetries) throw e;
      // exp backoff with jitter: 2s, 4s, 8s
      const delay = (2 ** attempt) * 2000 + Math.random() * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── suite registry ─────────────────────────────────────────────
const SUITE_DEFS = {
  gpqa: {
    files: GPQA_PATH ? [GPQA_PATH] : ['gpqa_physics3.json', 'gpqa_chemistry3.json', 'gpqa_biology3.json'],
    promptOf: (q) => q.problem,
    grade: (q, r) => {
      // 提取最后一个独立 A/B/C/D
      const text = r.content + '\n' + r.reasoning.slice(-200);
      const m = [...text.matchAll(/\b([A-D])\b/g)];
      const pred = m.length ? m[m.length - 1][1] : '';
      return { pred, correct: pred === String(q.answer).trim().toUpperCase() };
    },
  },
  humaneval: {
    files: HUMANEVAL_PATH ? [HUMANEVAL_PATH] : ['humaneval3.json'],
    promptOf: (q) => `Complete the following Python function. Write only the full function body in a single \`\`\`python\`\`\` code block.\n\n${q.problem}`,
    grade: (q, r) => {
      // 提取 ```python``` 代码块(可能有多个,取第一个)
      const m = r.content.match(/```python\n?([\s\S]*?)```/);
      const code = m ? m[1] : r.content;
      const hasDef = code.includes(`def ${q.entry_point}`);
      // 完整代码保留在 fullCode 字段(给 evalplus 转换用)
      return {
        pred: code.slice(0, 200),
        correct: hasDef && code.length > 50,
        note: 'static sanity only — use evalplus for true eval',
        fullCode: code,  // 完整提取的代码,给 evalplus
      };
    },
  },
  aime: {
    files: ['aime3.json'],
    promptOf: (q) => q.problem + '\n\n请在最终答案处使用 \\boxed{...} 包围一个整数。',
    grade: (q, r) => {
      const text = r.content + r.reasoning.slice(-500);
      // 最后一个 \boxed{n}
      const boxed = [...text.matchAll(/\\boxed\{([^}]+)\}/g)];
      let pred = boxed.length ? boxed[boxed.length - 1][1].trim() : '';
      // fallback:最后一个整数
      if (!pred) {
        const ints = [...text.matchAll(/-?\d+/g)];
        pred = ints.length ? ints[ints.length - 1][0] : '';
      }
      return { pred, correct: String(pred).trim() === String(q.answer).trim() };
    },
  },
  finance: {
    files: ['finance3.json'],
    promptOf: (q) => q.problem + '\n\n直接给最终数字答案。',
    grade: (q, r) => {
      const text = r.content + ' ' + r.reasoning.slice(-200);
      // 找最后一个数字(可含负号、小数、百分号)
      const nums = [...text.matchAll(/-?\d+\.?\d*/g)].map(m => Number(m[0])).filter(Number.isFinite);
      const pred = nums.length ? nums[nums.length - 1] : NaN;
      const target = Number(q.answer);
      const tol = Number(q.tolerance ?? 0.01);
      const ok = Number.isFinite(pred) && Number.isFinite(target) && Math.abs(pred - target) <= Math.abs(target * tol);
      return { pred: String(pred), correct: ok };
    },
  },
  medqa: {
    files: ['medqa3.json'],
    promptOf: (q) => q.problem,
    grade: (q, r) => {
      const m = [...r.content.matchAll(/\b([A-E])\b/g)];
      const pred = m.length ? m[m.length - 1][1] : '';
      return { pred, correct: pred === String(q.answer).trim().toUpperCase() };
    },
  },
  mmlu: {
    files: MMLU_PATH ? [MMLU_PATH] : [],
    promptOf: (q) => {
      const opts = ['A', 'B', 'C', 'D'].map((l, i) => `${l}. ${q.choices?.[i] ?? q.options?.[i] ?? ''}`).join('\n');
      return `${q.question || q.problem}\n\n${opts}\n\nAnswer with only the letter (A/B/C/D).`;
    },
    grade: (q, r) => {
      const m = [...r.content.matchAll(/\b([A-D])\b/g)];
      const pred = m.length ? m[m.length - 1][1] : '';
      // MMLU 数据 answer 可能是 index(0-3)也可能是 letter
      let target = q.answer;
      if (typeof target === 'number') target = ['A', 'B', 'C', 'D'][target];
      return { pred, correct: pred === String(target).trim().toUpperCase() };
    },
  },
  v8: {
    files: ['__v8_inline__'],  // V8 直接 inline,不从文件读
    promptOf: (q) => q.prompt,
    grade: (q, r) => {
      const ok = q.pass_re ? q.pass_re.test(r.content) : r.content.length > 20;
      return { pred: r.content.slice(0, 120), correct: ok };
    },
  },
};

// V8 题集(精简版,聚焦 coding spike + 实时性几道核心)
const V8_QUESTIONS = [
  { qid: 'T01', subset: 'identity', prompt: '【T01 基础身份】请用 80 字以内介绍你是谁、能帮我做什么。不要提到模型厂商。', pass_re: /(?:助手|assistant|帮)/ },
  { qid: 'T12', subset: 'math', prompt: '【T12】月收入 18000,房租 5200,固定支出 3100,想 8 个月攒 50000。算每月存多少,给现实调整方案。', pass_re: /(?:6250|每月.*存.*\d+)/ },
  { qid: 'T15', subset: 'math', prompt: '【T15】求小于 100 的最小正整数 n,使 n 除以 5 余 2,除以 7 余 3。写推理过程。', pass_re: /\b(17)\b/ },
  // === Coding spike(用户明确要求含 coding) ===
  { qid: 'T16', subset: 'code', prompt: '【T16】用 JavaScript 写 groupBy(array, keyFn) 函数,不修改原数组,支持 keyFn 返回字符串或数字,给 2 个测试用例。', pass_re: /function\s+groupBy|const\s+groupBy/ },
  { qid: 'T17', subset: 'code', prompt: '【T17】下段 JS 有什么 bug?指出原因并给修复版:\n```js\nfunction average(nums) {\n  let sum = 0;\n  nums.forEach(n => sum += n);\n  return sum / nums.length;\n}\nconsole.log(average([]));\n```', pass_re: /(?:NaN|空数组|length\s*===?\s*0|divide by zero)/i },
  { qid: 'T18', subset: 'writing', prompt: '【T18】写一个 500 字左右小说开头:江南雨巷、旧式照相馆、轻微科幻感。直接写正文,不要提纲。', pass_re: /(?:雨巷|照相馆)/ },
  // === V9 coding extension ===
  { qid: 'T_CODE_FIB', subset: 'code', prompt: '用 Python 写一个生成斐波那契数列前 n 项的函数 fib(n),用 list 返回。然后写 3 行调用示例。', pass_re: /def\s+fib/ },
  { qid: 'T_CODE_BUGFIX', subset: 'code', prompt: '下面 Python 函数有什么 bug?指出并给修复:\n```python\ndef avg(nums):\n    return sum(nums) / len(nums)\n```\n直接写修复版,不要长篇大论。', pass_re: /(?:if\s+not\s+nums|len.*==\s*0|raise|ValueError|return\s+0)/i },
  { qid: 'T_CODE_SQL', subset: 'code', prompt: '一个 orders 表 (order_id, user_id, amount, created_at)。写 SQL:查最近 7 天每个 user 的总金额,按金额降序前 10。', pass_re: /(?:SELECT|select).*(?:GROUP\s+BY|group\s+by).*user_id/is },
];

// ── data loader ────────────────────────────────────────────────
function loadSuite(name) {
  const def = SUITE_DEFS[name];
  if (!def) throw new Error('unknown suite: ' + name);
  if (name === 'v8') {
    return V8_QUESTIONS.map(q => ({ ...q, subset: q.subset || 'general' }));
  }
  const all = [];
  for (const f of def.files) {
    const p = path.isAbsolute(f) ? f : path.join(DATA_DIR, f);
    if (!fs.existsSync(p)) {
      log(`  ⚠ ${name}: ${p} not found, skip`);
      continue;
    }
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    all.push(...arr);
  }
  return all;
}

// ── concurrent runner ──────────────────────────────────────────
async function runSuite(name) {
  const def = SUITE_DEFS[name];
  const questions = loadSuite(name);
  if (questions.length === 0) {
    log(`SUITE ${name}: no data, skipping`);
    return { suite: name, total: 0, correct: 0, accuracy: 0, ms: 0 };
  }
  log(`SUITE ${name}: ${questions.length} questions, concurrency=${CONCURRENCY}`);

  const outFile = path.join(OUT, `${name}.jsonl`);
  let done = new Set();
  if (RESUME && fs.existsSync(outFile)) {
    // 只有成功 entry 算 done(有 error 字段的不算,下次会重试)
    const filteredLines = [];
    let errorCount = 0;
    for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.error) {
          errorCount++;
          continue;  // 不写回 jsonl,不算 done,会被重试
        }
        done.add(d.qid);
        filteredLines.push(line);
      } catch { /* ignore */ }
    }
    if (errorCount > 0) {
      // 重写 jsonl 删掉 error entries,下面 append 模式追加新结果
      fs.writeFileSync(outFile, filteredLines.length ? filteredLines.join('\n') + '\n' : '');
      log(`  resuming: ${done.size} successful, ${errorCount} errors purged for retry`);
    } else {
      log(`  resuming: ${done.size} already done (no errors)`);
    }
  }
  const sink = fs.createWriteStream(outFile, { flags: 'a' });

  const todo = questions.filter(q => !done.has(q.qid));
  const t0 = Date.now();
  let correct = 0, total = 0;
  const latencies = [];

  // 简单并发池
  async function worker(workerId) {
    while (true) {
      const q = todo.shift();
      if (!q) return;
      const prompt = def.promptOf(q);
      if (DRY_RUN) {
        log(`  [w${workerId}] DRY ${q.qid}: ${prompt.slice(0, 60)}...`);
        continue;
      }
      try {
        const r = await callMimo(prompt);
        const judged = def.grade(q, r);
        latencies.push(r.ms);
        total++;
        if (judged.correct) correct++;
        // HumanEval 保留完整 content(给 evalplus 转换);其他 suite 仍 excerpt
        const isCode = name === 'humaneval';
        sink.write(JSON.stringify({
          qid: q.qid, subset: q.subset, prompt_excerpt: prompt.slice(0, 200),
          response: isCode ? r.content : undefined,
          response_excerpt: isCode ? undefined : r.content.slice(0, 400),
          reasoning_excerpt: r.reasoning.slice(0, 200),
          pred: judged.pred, answer: q.answer, correct: judged.correct,
          note: judged.note, ms: r.ms, usage: r.usage,
          fullCode: isCode ? judged.fullCode : undefined,
          entry_point: isCode ? q.entry_point : undefined,
          task_id: isCode ? q.task_id : undefined,
        }) + '\n');
        if (total % 5 === 0 || total === questions.length - done.size) {
          log(`  [${name}] ${total}/${todo.length} progress, acc=${(correct / total * 100).toFixed(1)}%, avg ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms`);
        }
      } catch (e) {
        total++;
        sink.write(JSON.stringify({
          qid: q.qid, subset: q.subset, error: e.message, correct: false, ms: 0,
        }) + '\n');
        log(`  [w${workerId}] FAIL ${q.qid}: ${e.message.slice(0, 200)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
  sink.end();

  const ms = Date.now() - t0;
  const accuracy = total > 0 ? correct / total : 0;
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  log(`SUITE ${name} DONE: ${correct}/${total} = ${(accuracy * 100).toFixed(2)}% in ${(ms / 1000).toFixed(1)}s, p50=${p50}ms p95=${p95}ms`);
  return { suite: name, total, correct, accuracy, ms, p50, p95 };
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  log(`=== MiMo V2.5 Pro Eval ===`);
  log(`base=${BASE} model=${MODEL} thinking=${THINKING} max_tokens=${MAX_TOKENS}`);
  log(`out=${OUT} concurrency=${CONCURRENCY} resume=${RESUME} dry-run=${DRY_RUN}`);
  log(`suites=${SUITES.join(',')}`);
  if (!KEY && !DRY_RUN) {
    log('ERROR: MIMO_PRO_KEY (or MIMO_SEARCH_KEY / MIMO_KEY) missing');
    process.exit(1);
  }

  const summaries = [];
  for (const s of SUITES) {
    if (!SUITE_DEFS[s]) {
      log(`unknown suite: ${s}, skip`);
      continue;
    }
    try {
      summaries.push(await runSuite(s));
    } catch (e) {
      log(`SUITE ${s} CRASHED: ${e.message}`);
      summaries.push({ suite: s, error: e.message });
    }
  }

  const summary = {
    ts: new Date().toISOString(),
    base: BASE, model: MODEL, thinking: THINKING, max_tokens: MAX_TOKENS,
    suites: summaries,
    overall: {
      total: summaries.reduce((a, s) => a + (s.total || 0), 0),
      correct: summaries.reduce((a, s) => a + (s.correct || 0), 0),
    },
  };
  summary.overall.accuracy = summary.overall.total > 0
    ? summary.overall.correct / summary.overall.total
    : 0;
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  log('=== DONE ===');
  log(`Overall: ${summary.overall.correct}/${summary.overall.total} = ${(summary.overall.accuracy * 100).toFixed(2)}%`);
  log(`Summary written to ${OUT}/summary.json`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(e => { log('FATAL:', e.stack || e.message); process.exit(1); });
}

export { callMimo, runSuite, SUITE_DEFS, V8_QUESTIONS };
