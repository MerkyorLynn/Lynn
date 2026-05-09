// Brain v2 · Deep Research best-of-N orchestrator
// 目标:对一个 user prompt 同时跑 N 个 provider → verifier 给每条 trajectory 评分 → 选最好的流式返回
// v1 简化:单条 scoring + avg 排名(每候选 1 次 verifier 调用)。v2 升级到 pairwise round-robin。
//
// 不打主链普通流路。挂在新 endpoint POST /v2/deep-research/completions。
// 用户感知:等 30-60s,然后一次性流式输出最佳答案 + 元数据(哪个 provider 赢、各候选分数)。
import 'dotenv/config';
import { getProvider, isInCooldown, markUnhealthy } from './provider-registry.js';
import { getAdapter } from './wire-adapter/index.js';

// 默认候选池(避开 thinking 慢的 deepseek-pro,留 4 路稳;后续可由 env 覆盖)
const DEFAULT_CANDIDATES = ['mimo', 'qwen3.6-35b-a3b', 'deepseek-chat', 'glm-5-turbo'];
const CANDIDATE_TIMEOUT_MS = Number(process.env.DEEP_RESEARCH_CANDIDATE_TIMEOUT_MS || 60_000);
const VERIFIER_TIMEOUT_MS = Number(process.env.DEEP_RESEARCH_VERIFIER_TIMEOUT_MS || 8_000);
const MIN_VALID_CANDIDATES = Number(process.env.DEEP_RESEARCH_MIN_CANDIDATES || 2);
const MAX_WINNER_AVG = Number(process.env.DEEP_RESEARCH_MAX_WINNER_AVG || 4);
const MAX_WINNER_DIMENSION = Number(process.env.DEEP_RESEARCH_MAX_WINNER_DIMENSION || 3);

function buildDeepResearchVerifierPrompt({ userPrompt, candidateAnswer }) {
  const truncated = String(candidateAnswer || '').slice(0, 12000);
  return `You are a strict reviewer of AI assistant answers. Given a user question and one candidate answer, rate it on 3 dimensions.

User Question:
${userPrompt}

Candidate Answer:
${truncated}

Evaluate on a 1-8 scale (1=perfect, 8=worst):

C1 Specification — does the answer address ALL parts of what the user asked?
   - All sub-questions covered?
   - Right scope (region / time / entity / domain)?
   - No off-topic tangents?

C2 Output Format — structured / sourced as the question deserves?
   - Citations or sources where claims are made?
   - Numbers have units + dates?
   - Internal coherence (no broken markup, no truncation)?

C3 Errors — factual errors / contradictions / hallucinations?
   - Numbers self-consistent?
   - No "I don't know" / placeholder?
   - No claims that contradict well-known facts?
   - For technical acronyms or model names (for example A3B), heavily penalize invented expansions unless the answer grounds them in the question or evidence; "needs context" is better than confident guessing.

Output ONLY this JSON, no other text or markdown:
{"C1": <integer 1-8>, "C2": <integer 1-8>, "C3": <integer 1-8>, "reason": "<one short sentence>"}`;
}

function parseScores(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  try {
    const obj = JSON.parse(s);
    if (validScores(obj)) return obj;
  } catch {}
  const match = s.match(/\{[^{}]*"C1"[^{}]*\}/s);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (validScores(obj)) return obj;
    } catch {}
  }
  return null;
}

function validScores(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const k of ['C1', 'C2', 'C3']) {
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 8) return false;
  }
  return true;
}

function scoreAvg(scores) {
  return (scores.C1 + scores.C2 + scores.C3) / 3;
}

function scoreMaxDimension(scores) {
  return Math.max(scores.C1, scores.C2, scores.C3);
}

function isAcceptableScore(score, {
  maxAvg = MAX_WINNER_AVG,
  maxDimension = MAX_WINNER_DIMENSION,
} = {}) {
  if (!score || !score.scored || !score.scores) return false;
  const avg = Number.isFinite(score.avg) ? score.avg : scoreAvg(score.scores);
  return avg <= maxAvg && scoreMaxDimension(score.scores) <= maxDimension;
}

function buildQualityRejectedResult({ candidateResults, scores, phase1Ms, phase2Ms, startedAt, reason = '' }) {
  const rankedScores = scores
    .filter((s) => s.scored)
    .map((s) => ({ providerId: s.providerId, avg: s.avg, maxDimension: scoreMaxDimension(s.scores), scores: s.scores }))
    .sort((a, b) => a.avg - b.avg);
  const validCount = candidateResults.filter((c) => c.ok && c.content && c.content.length > 20).length;

  const fallbackContent = [
    '这轮 Deep Research 已拦截：多模型候选答案没有达到质量线，暂不直接输出，避免把不稳定或可能误导的内容当作结论。',
    '',
    reason ? `拦截原因：${reason}` : '',
    `质量线：平均分 ≤ ${MAX_WINNER_AVG}，且任一维度 ≤ ${MAX_WINNER_DIMENSION}。`,
    rankedScores.length
      ? `当前最好候选：${rankedScores[0].providerId}，avg=${rankedScores[0].avg.toFixed(2)}，max=${rankedScores[0].maxDimension}。`
      : (validCount > 0
          ? `有效候选不足：${validCount}/${MIN_VALID_CANDIDATES}，未进入最终评分。`
          : '当前没有候选完成有效评分。'),
    '',
    '建议：请重试一次，或把问题拆成更具体的子问题后再做深度研究。',
  ].filter(Boolean).join('\n');

  return {
    winner: null,
    qualityRejected: true,
    fallbackContent,
    allCandidates: candidateResults,
    allScores: scores,
    rankedScores,
    meta: {
      phase1Ms,
      phase2Ms,
      totalMs: Date.now() - startedAt,
      candidateCount: candidateResults.length,
      validCount: candidateResults.filter((c) => c.ok && c.content && c.content.length > 20).length,
      scoredCount: rankedScores.length,
      qualityFloor: { maxAvg: MAX_WINNER_AVG, maxDimension: MAX_WINNER_DIMENSION },
    },
  };
}

// Run one provider non-streaming-equivalent: drain the SSE adapter and return final answer text.
async function runOneCandidate({ providerId, messages, signal, log }) {
  const provider = getProvider(providerId);
  if (!provider) return { providerId, ok: false, error: 'provider not registered' };
  if (isInCooldown(providerId)) return { providerId, ok: false, error: 'in-cooldown' };

  const adapter = getAdapter(provider.wire);
  const t0 = Date.now();
  let content = '';
  let reasoning = '';
  let finishReason = null;

  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), CANDIDATE_TIMEOUT_MS);
    const combinedSignal = anySignal([signal, ctrl.signal]);

    try {
      for await (const chunk of adapter({ provider, messages, tools: null, signal: combinedSignal, log: null })) {
        if (chunk.type === 'content') content += chunk.delta;
        else if (chunk.type === 'reasoning') reasoning += chunk.delta;
        else if (chunk.type === 'finish') finishReason = chunk.reason;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    return {
      providerId,
      ok: true,
      content,
      reasoning,
      finishReason,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    log && log('warn', `[deep-research] candidate ${providerId} failed: ${err.message}`);
    if (err.name !== 'AbortError') markUnhealthy(providerId, err.message);
    return { providerId, ok: false, error: err.message, latencyMs: Date.now() - t0 };
  }
}

// Score one candidate using deepseek-chat verifier (with thinking disabled).
async function scoreCandidate({ userPrompt, candidate, log }) {
  if (!candidate.ok || !candidate.content) {
    return { providerId: candidate.providerId, scored: false, reason: 'no-content' };
  }
  const verifierProviderId = process.env.VERIFIER_PROVIDER || 'deepseek-chat';
  const provider = getProvider(verifierProviderId);
  if (!provider) {
    return { providerId: candidate.providerId, scored: false, reason: 'verifier-not-found' };
  }
  const adapter = getAdapter(provider.wire);
  const prompt = buildDeepResearchVerifierPrompt({ userPrompt, candidateAnswer: candidate.content });

  const t0 = Date.now();
  let raw = '';
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), VERIFIER_TIMEOUT_MS);
    try {
      for await (const chunk of adapter({
        provider,
        messages: [{ role: 'user', content: prompt }],
        tools: null,
        signal: ctrl.signal,
        log: null,
        extraBody: { thinking: { type: 'disabled' } },
      })) {
        if (chunk.type === 'content') raw += chunk.delta;
      }
    } finally {
      clearTimeout(timeoutId);
    }
    const scores = parseScores(raw);
    if (!scores) {
      return { providerId: candidate.providerId, scored: false, reason: 'parse-failed', latencyMs: Date.now() - t0, raw: raw.slice(0, 200) };
    }
    const avg = (scores.C1 + scores.C2 + scores.C3) / 3;
    return { providerId: candidate.providerId, scored: true, scores, avg, latencyMs: Date.now() - t0 };
  } catch (err) {
    log && log('warn', `[deep-research] scoring ${candidate.providerId} failed: ${err.message}`);
    return { providerId: candidate.providerId, scored: false, reason: err.message, latencyMs: Date.now() - t0 };
  }
}

// anySignal: combine multiple AbortSignal into one
function anySignal(signals) {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

/**
 * runDeepResearch
 *  Returns: { winner: { providerId, content, ... }, allCandidates, allScores, meta }
 */
export async function runDeepResearch({ messages, candidates, signal, log, onProgress }) {
  const candidatePool = (Array.isArray(candidates) && candidates.length > 0) ? candidates : DEFAULT_CANDIDATES;
  const userPrompt = extractLatestUser(messages);
  if (!userPrompt) throw new Error('deep-research: no user message found');

  log && log('info', `[deep-research] starting best-of-${candidatePool.length}: ${candidatePool.join(', ')}`);
  onProgress && onProgress({ event: 'start', candidates: candidatePool });

  // Phase 1: parallel candidate generation
  const t0 = Date.now();
  const candidateResults = await Promise.all(
    candidatePool.map((id) => runOneCandidate({ providerId: id, messages, signal, log }))
  );
  const phase1Ms = Date.now() - t0;

  const validCandidates = candidateResults.filter((c) => c.ok && c.content && c.content.length > 20);
  log && log('info', `[deep-research] phase1 done in ${phase1Ms}ms — ${validCandidates.length}/${candidatePool.length} valid`);
  onProgress && onProgress({
    event: 'phase1-done',
    phase1Ms,
    valid: validCandidates.map((c) => ({ providerId: c.providerId, latencyMs: c.latencyMs, contentLen: c.content.length })),
    failed: candidateResults.filter((c) => !c.ok).map((c) => ({ providerId: c.providerId, error: c.error })),
  });

  if (validCandidates.length === 0) {
    throw new Error('deep-research: all candidates failed');
  }
  if (validCandidates.length < MIN_VALID_CANDIDATES) {
    const reason = `有效候选数 ${validCandidates.length}/${MIN_VALID_CANDIDATES}，不足以做可靠 best-of-N 选择。`;
    log && log('warn', `[deep-research] quality rejected: ${reason}`);
    onProgress && onProgress({
      event: 'quality-rejected',
      reason: 'insufficient-valid-candidates',
      validCount: validCandidates.length,
      minValidCandidates: MIN_VALID_CANDIDATES,
    });
    return buildQualityRejectedResult({
      candidateResults,
      scores: [],
      phase1Ms,
      phase2Ms: 0,
      startedAt: t0,
      reason,
    });
  }

  // Phase 2: parallel scoring of all valid candidates
  const t1 = Date.now();
  const scores = await Promise.all(
    validCandidates.map((c) => scoreCandidate({ userPrompt, candidate: c, log }))
  );
  const phase2Ms = Date.now() - t1;
  log && log('info', `[deep-research] phase2 scoring done in ${phase2Ms}ms`);
  onProgress && onProgress({ event: 'phase2-done', phase2Ms, scores });

  // Phase 3: rank — lower avg = better
  const ranked = scores
    .filter((s) => s.scored)
    .map((s) => ({ ...s, candidate: validCandidates.find((c) => c.providerId === s.providerId) }))
    .sort((a, b) => a.avg - b.avg);

  let winner;
  const acceptableRanked = ranked.filter((s) => isAcceptableScore(s));
  if (acceptableRanked.length > 0) {
    winner = acceptableRanked[0].candidate;
    log && log('info', `[deep-research] winner: ${winner.providerId} avg=${acceptableRanked[0].avg.toFixed(2)}`);
  } else {
    log && log('warn', `[deep-research] quality rejected: ${ranked.length} scored, 0 acceptable`);
    onProgress && onProgress({
      event: 'quality-rejected',
      scores,
      qualityFloor: { maxAvg: MAX_WINNER_AVG, maxDimension: MAX_WINNER_DIMENSION },
    });
    return buildQualityRejectedResult({ candidateResults, scores, phase1Ms, phase2Ms, startedAt: t0 });
  }

  return {
    winner,
    allCandidates: candidateResults,
    allScores: scores,
    rankedScores: ranked.map((r) => ({ providerId: r.providerId, avg: r.avg, scores: r.scores })),
    meta: {
      phase1Ms,
      phase2Ms,
      totalMs: Date.now() - t0,
      candidateCount: candidatePool.length,
      validCount: validCandidates.length,
      scoredCount: ranked.length,
      acceptableCount: acceptableRanked.length,
      qualityFloor: { maxAvg: MAX_WINNER_AVG, maxDimension: MAX_WINNER_DIMENSION },
    },
  };
}

function extractLatestUser(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
          .filter(Boolean)
          .join(' ');
      }
      try { return JSON.stringify(m.content); } catch { return ''; }
    }
  }
  return '';
}

export const _internals = {
  DEFAULT_CANDIDATES,
  CANDIDATE_TIMEOUT_MS,
  VERIFIER_TIMEOUT_MS,
  MIN_VALID_CANDIDATES,
  MAX_WINNER_AVG,
  MAX_WINNER_DIMENSION,
  parseScores,
  validScores,
  scoreAvg,
  scoreMaxDimension,
  isAcceptableScore,
  buildQualityRejectedResult,
};
