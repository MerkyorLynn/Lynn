// Brain v2 · Deep Research multi-candidate orchestrator
// 目标:对一个 user prompt 同时跑 N 个 provider → 返回第一个成功候选。
// 不做质量评分、不拦截、不改写候选内容；模型输出是什么就呈现什么。
//
// 不打主链普通流路。挂在新 endpoint POST /v2/deep-research/completions。
// 用户感知:等 30-60s,然后一次性流式输出模型答案 + 最小元数据(哪个 provider 输出)。
import 'dotenv/config';
import { getProvider, isInCooldown, markUnhealthy } from './provider-registry.js';
import { getAdapter } from './wire-adapter/index.js';
import { errorMessage, errorName, type ChatMessage, type LogFn, type ProviderId } from './types.js';

// 默认候选池(避开 deepseek-pro 同端点重复、glm 余额型失败;后续可由 env 覆盖)
const DEFAULT_CANDIDATES = String(process.env.DEEP_RESEARCH_CANDIDATES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (DEFAULT_CANDIDATES.length === 0) {
  DEFAULT_CANDIDATES.push('step-3.7-flash', 'apex-spark-i-balanced', 'deepseek-chat');
}
const CANDIDATE_TIMEOUT_MS = Number(process.env.DEEP_RESEARCH_CANDIDATE_TIMEOUT_MS || 60_000);

type DeepResearchProgressEvent = Record<string, unknown>;
type DeepResearchCandidateFailure = { providerId: string; ok: false; error: string; latencyMs?: number };
type DeepResearchCandidateSuccess = {
  providerId: string;
  ok: true;
  content: string;
  reasoning: string;
  finishReason: string | null;
  latencyMs: number;
};
type DeepResearchCandidateResult = DeepResearchCandidateFailure | DeepResearchCandidateSuccess;

type RunOneCandidateOptions = {
  providerId: string;
  messages?: ChatMessage[];
  signal?: AbortSignal;
  log?: LogFn | null;
};

export type DeepResearchOptions = {
  messages?: ChatMessage[];
  candidates?: string[] | null;
  signal?: AbortSignal;
  log?: LogFn | null;
  onProgress?: (event: DeepResearchProgressEvent) => void;
};

function isSuccessfulCandidate(candidate: DeepResearchCandidateResult): candidate is DeepResearchCandidateSuccess {
  return candidate.ok;
}

// Run one provider non-streaming-equivalent: drain the SSE adapter and return final answer text.
async function runOneCandidate({ providerId, messages, signal, log }: RunOneCandidateOptions): Promise<DeepResearchCandidateResult> {
  const provider = getProvider(providerId);
  if (!provider) return { providerId, ok: false, error: 'provider not registered' };
  if (isInCooldown(providerId as ProviderId)) return { providerId, ok: false, error: 'in-cooldown' };

  const adapter = getAdapter(provider.wire);
  const t0 = Date.now();
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;

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
    const message = errorMessage(err);
    log && log('warn', `[deep-research] candidate ${providerId} failed: ${message}`);
    if (errorName(err) !== 'AbortError') markUnhealthy(providerId as ProviderId, message);
    return { providerId, ok: false, error: message, latencyMs: Date.now() - t0 };
  }
}

// anySignal: combine multiple AbortSignal into one
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
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
 *  Returns: { winner: { providerId, content, ... }, allCandidates, meta }
 */
export async function runDeepResearch({ messages, candidates, signal, log, onProgress }: DeepResearchOptions) {
  const candidatePool = (Array.isArray(candidates) && candidates.length > 0) ? candidates : DEFAULT_CANDIDATES;
  if (!extractLatestUser(messages)) throw new Error('deep-research: no user message found');

  log && log('info', `[deep-research] starting candidates=${candidatePool.length}: ${candidatePool.join(', ')}`);
  onProgress && onProgress({ event: 'start', candidates: candidatePool });

  // Phase 1: parallel candidate generation
  const t0 = Date.now();
  const candidateResults = await Promise.all(
    candidatePool.map((id) => runOneCandidate({ providerId: id, messages, signal, log }))
  );
  const phase1Ms = Date.now() - t0;

  const successfulCandidates = candidateResults.filter(isSuccessfulCandidate);
  log && log('info', `[deep-research] phase1 done in ${phase1Ms}ms — ${successfulCandidates.length}/${candidatePool.length} successful`);
  onProgress && onProgress({
    event: 'phase1-done',
    phase1Ms,
    successful: successfulCandidates.map((c) => ({ providerId: c.providerId, latencyMs: c.latencyMs, contentLen: c.content.length })),
    failed: candidateResults.filter((c) => !c.ok).map((c) => ({ providerId: c.providerId, error: c.error })),
  });

  if (successfulCandidates.length === 0) {
    throw new Error('deep-research: all candidates failed');
  }

  const winner = successfulCandidates[0];
  onProgress && onProgress({
    event: 'candidate-picked',
    winnerProviderId: winner.providerId,
    successfulCount: successfulCandidates.length,
  });
  log && log('info', `[deep-research] winner: ${winner.providerId} (first successful candidate)`);

  return {
    winner,
    allCandidates: candidateResults,
    meta: {
      phase1Ms,
      totalMs: Date.now() - t0,
      candidateCount: candidatePool.length,
      successfulCount: successfulCandidates.length,
      selection: 'first-successful-candidate',
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function extractLatestUser(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asRecord(messages[i]);
    if (m?.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((p) => {
            if (typeof p === 'string') return p;
            const part = asRecord(p);
            return typeof part?.text === 'string' ? part.text : '';
          })
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
};
