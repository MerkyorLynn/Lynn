// Brain v2 · Verifier catch-rate validation
// 直接调用 verifyToolResult,跑一组 expectFail / expectPass fixture,统计准确率。
// 用法 (on lynn-brain):
//   VERIFIER_ENABLED=1 VERIFIER_PROVIDER=deepseek-chat node scripts/verifier-catch-rate.mjs
import 'dotenv/config';
import { verifyToolResult } from '../verifier-middleware.mjs';

const FIXTURES = [
  // ===== expectFail (verifier 应判 fail) =====
  {
    id: 'stock_market_usd_wrong_currency',
    userPrompt: '查一下贵州茅台今天股价',
    toolName: 'stock_market',
    toolResult: '{"symbol":"600519","price":"187.42","currency":"USD","exchange":"NASDAQ","timestamp":"2026-05-08T08:00:00Z"}',
    expectFail: true,
    expectedFailReason: 'C1: 茅台是 A 股,不应是 USD/NASDAQ',
  },
  {
    id: 'weather_offtopic_user_asked_beijing_got_tokyo',
    userPrompt: '北京今天天气怎么样',
    toolName: 'weather',
    toolResult: 'Tokyo, Japan: 22°C, partly cloudy, humidity 60%, wind 5km/h E',
    expectFail: true,
    expectedFailReason: 'C1: 用户问北京,返回东京',
  },
  {
    id: 'web_search_unrelated_topic',
    userPrompt: '黄金价格走势',
    toolName: 'web_search',
    toolResult: '搜索结果:1. 苹果发布新款 iPhone 17 评测... 2. 特斯拉 Q1 财报... 3. 英伟达股价上涨...',
    expectFail: true,
    expectedFailReason: 'C1: 用户问黄金,返回科技股新闻',
  },
  {
    id: 'web_search_placeholder_text',
    userPrompt: '英伟达 RTX 5090 性能评测',
    toolName: 'web_search',
    toolResult: 'I don\'t have specific information about that. Please consult official sources.',
    expectFail: true,
    expectedFailReason: 'C3: placeholder/I don\'t know',
  },
  {
    id: 'parallel_research_truncated_mid_sentence',
    userPrompt: '调研下小米 SU7 用户反馈',
    toolName: 'parallel_research',
    toolResult: '小米 SU7 自 2024 年发布以来,用户反馈整体积极。续航方面表现良好,但',
    expectFail: true,
    expectedFailReason: 'C2: 截断中句,缺尾',
  },

  // ===== expectPass (verifier 应判 pass) =====
  {
    id: 'weather_proper_response',
    userPrompt: '上海今天天气',
    toolName: 'weather',
    toolResult: '上海 (Shanghai), 2026-05-08: 24°C, 多云转晴, 湿度 65%, 风速 8km/h NE, 体感 25°C',
    expectFail: false,
  },
  {
    id: 'stock_market_proper_a_share_response',
    userPrompt: '贵州茅台今天股价',
    toolName: 'stock_market',
    toolResult: '{"symbol":"600519.SH","name":"贵州茅台","price":"1750.50","currency":"CNY","change":"+12.30","change_pct":"+0.71%","exchange":"上交所","timestamp":"2026-05-08T15:00:00+08:00"}',
    expectFail: false,
  },
  {
    id: 'web_search_relevant_with_sources',
    userPrompt: '英伟达 RTX 5090 性能评测',
    toolName: 'web_search',
    toolResult: '## RTX 5090 评测要点 (sources: TomsHardware, AnandTech, GamersNexus)\n- 4K 性能比 4090 提升 40-60%\n- TDP 575W, 16-pin 12V-2x6 接口\n- DLSS 4 + 神经网络渲染加速\n- 售价 $1999 起 (FE 版本)',
    expectFail: false,
  },
  {
    id: 'parallel_research_complete_with_citations',
    userPrompt: '调研下国内 35B 级开源模型',
    toolName: 'parallel_research',
    toolResult: '截至 2026-05-08,国内 35B 级开源 LLM 主流候选:\n1. Qwen3.6-35B-A3B-FP8 (阿里) — MoE,激活 3B,中文 SOTA\n2. ChatGLM4-32B (智谱) — Dense,中英平衡\n3. DeepSeek-V3-32B (深度求索) — 开源版本受限\n来源: ① modelscope ② huggingface MTEB leaderboard ③ OpenCompass 2026-Q2',
    expectFail: false,
  },
  {
    id: 'live_news_recent_proper',
    userPrompt: '今天科技圈有什么新闻',
    toolName: 'live_news',
    toolResult: '2026-05-08 科技要闻:\n- 苹果 WWDC 25 公布 iOS 19 (来源:Apple Newsroom)\n- OpenAI 发布 GPT-5.5 Coder (来源:OpenAI Blog)\n- 英伟达 GTC 2026 演讲: Blackwell Ultra 路线图 (来源:NVIDIA官方)',
    expectFail: false,
  },
];

async function main() {
  if (process.env.VERIFIER_ENABLED !== '1') {
    console.log('Setting VERIFIER_ENABLED=1 for this run...');
    process.env.VERIFIER_ENABLED = '1';
  }
  if (!process.env.VERIFIER_PROVIDER) {
    process.env.VERIFIER_PROVIDER = 'deepseek-chat';
  }
  console.log(`Provider: ${process.env.VERIFIER_PROVIDER}`);
  console.log(`Threshold: ${process.env.VERIFIER_PASS_THRESHOLD || '4'}`);
  console.log(`Fixtures: ${FIXTURES.length} (${FIXTURES.filter(f => f.expectFail).length} expectFail / ${FIXTURES.filter(f => !f.expectFail).length} expectPass)`);
  console.log('');

  let truePos = 0;   // expectFail and verifier said fail (correct catch)
  let falseNeg = 0;  // expectFail but verifier said pass (missed catch)
  let trueNeg = 0;   // expectPass and verifier said pass (correct accept)
  let falsePos = 0;  // expectPass but verifier said fail (over-rejection)
  let parseFailed = 0;
  let failOpen = 0;
  const latencies = [];
  const details = [];

  for (const fx of FIXTURES) {
    const t0 = Date.now();
    const result = await verifyToolResult({
      userPrompt: fx.userPrompt,
      toolName: fx.toolName,
      toolResult: fx.toolResult,
      log: null,
    });
    const elapsed = Date.now() - t0;
    latencies.push(result.latencyMs ?? elapsed);

    const pass = result.pass;
    const skipped = result.skipped;
    if (skipped) {
      console.log(`[SKIP] ${fx.id} (${result.reason})`);
      details.push({ id: fx.id, status: 'skipped', reason: result.reason });
      continue;
    }
    if (result.parseFailed) parseFailed++;
    if (result.failOpen) failOpen++;

    let verdict;
    if (fx.expectFail && !pass) { truePos++; verdict = 'TP (correct catch)'; }
    else if (fx.expectFail && pass) { falseNeg++; verdict = 'FN (missed!)'; }
    else if (!fx.expectFail && pass) { trueNeg++; verdict = 'TN (correct accept)'; }
    else { falsePos++; verdict = 'FP (over-reject!)'; }

    const scoresStr = result.scores ? `C1=${result.scores.C1} C2=${result.scores.C2} C3=${result.scores.C3} avg=${result.avg?.toFixed(2)}` : 'fail-open';
    console.log(`[${verdict}] ${fx.id} | ${scoresStr} | ${elapsed}ms`);
    details.push({ id: fx.id, expectFail: fx.expectFail, pass, scores: result.scores, avg: result.avg, latency: elapsed, verdict });
  }

  const expectFailCount = FIXTURES.filter(f => f.expectFail).length;
  const expectPassCount = FIXTURES.filter(f => !f.expectFail).length;
  const catchRate = expectFailCount > 0 ? (truePos / expectFailCount * 100).toFixed(1) : 'n/a';
  const falsePosRate = expectPassCount > 0 ? (falsePos / expectPassCount * 100).toFixed(1) : 'n/a';
  const p50 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)];
  const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

  console.log('');
  console.log('===== Summary =====');
  console.log(`Catch rate (expectFail correctly flagged):  ${truePos}/${expectFailCount} = ${catchRate}%   [target ≥ 80%]`);
  console.log(`False-positive rate (expectPass over-reject): ${falsePos}/${expectPassCount} = ${falsePosRate}%  [target ≤ 10%]`);
  console.log(`Parse failed: ${parseFailed} | Fail-open: ${failOpen}`);
  console.log(`Latency p50: ${p50}ms | p95: ${p95}ms   [target p50 < 1500ms]`);
  console.log('');

  const catchOk = expectFailCount > 0 && truePos / expectFailCount >= 0.8;
  const fpOk = expectPassCount === 0 || falsePos / expectPassCount <= 0.1;
  const latOk = p50 < 1500;
  console.log(`Verdict: catch=${catchOk ? 'OK' : 'FAIL'}  fp=${fpOk ? 'OK' : 'FAIL'}  latency=${latOk ? 'OK' : 'WARN'}`);
  if (!catchOk || !fpOk) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
