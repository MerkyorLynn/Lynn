// Brain v2 · Agent / Codex / Computer Use 中段 checkpoint
// 给一段 agent trajectory 评估"还在正轨吗",返回 continue / replan / abort 建议。
// Endpoint: POST /v2/agent-checkpoint
// 复用 verifier (deepseek-chat + thinking disabled),延迟 1-2s。
import 'dotenv/config';
import { getProvider } from './provider-registry.js';
import { getAdapter } from './wire-adapter/index.js';

const VERIFIER_PROVIDER = process.env.VERIFIER_PROVIDER || 'deepseek-chat';
const TIMEOUT_MS = Number(process.env.AGENT_CHECKPOINT_TIMEOUT_MS || 8000);

function formatTrajectory(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '(no steps yet)';
  return steps
    .slice(-15) // last 15 steps to keep prompt bounded
    .map((s, i) => {
      const stepNum = s.step ?? i + 1;
      const action = typeof s.action === 'string' ? s.action : JSON.stringify(s.action || {});
      const obs = typeof s.observation === 'string'
        ? s.observation.slice(0, 600)
        : JSON.stringify(s.observation || {}).slice(0, 600);
      return `Step ${stepNum}:\n  Action: ${action.slice(0, 400)}\n  Observation: ${obs}`;
    })
    .join('\n\n');
}

function buildCheckpointPrompt({ userPrompt, trajectory, currentStep, maxSteps }) {
  const traj = formatTrajectory(trajectory);
  const truncated = String(userPrompt || '').slice(0, 2000);

  return `You are a strict reviewer of an AI agent's progress. Decide whether the agent is on track to succeed.

User Goal:
${truncated}

Current Trajectory (step ${currentStep ?? '?'}/${maxSteps ?? '?'}):
${traj}

Evaluate on 1-8 scale (1=perfect, 8=worst):

C1 Goal alignment — is the trajectory still aligned with the user's goal?
   - Sub-tasks taken match what the user asked?
   - No drift to unrelated objectives?

C2 Progress — concrete forward progress?
   - Each step closer to a result, not looping the same action?
   - No long stuck periods waiting for nothing?

C3 Errors — actions producing errors / wrong outputs / dead-ends?
   - Repeated tool failures unhandled?
   - Wrong assumptions baked into recent steps?

Decide a verdict:
  - "continue" — on track, keep going
  - "replan"   — drifting / stuck / repeated errors; agent should rethink approach
  - "abort"    — fundamental mismatch with user goal; stop and ask user

Output ONLY this JSON, no other text or markdown:
{"C1": <integer 1-8>, "C2": <integer 1-8>, "C3": <integer 1-8>, "verdict": "<continue|replan|abort>", "reason": "<one short sentence>"}`;
}

function parseCheckpointResponse(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const tryParse = (str) => {
    try {
      const obj = JSON.parse(str);
      if (validCheckpoint(obj)) return obj;
    } catch {}
    return null;
  };
  const direct = tryParse(s);
  if (direct) return direct;
  const match = s.match(/\{[^{}]*"C1"[^{}]*\}/s);
  if (match) {
    const m = tryParse(match[0]);
    if (m) return m;
  }
  return null;
}

function validCheckpoint(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const k of ['C1', 'C2', 'C3']) {
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 8) return false;
  }
  if (!['continue', 'replan', 'abort'].includes(obj.verdict)) return false;
  return true;
}

export async function checkpointAgent({ userPrompt, trajectory, currentStep, maxSteps, log = null }) {
  if (!userPrompt) return { ok: false, reason: 'no-user-prompt' };
  if (!Array.isArray(trajectory)) return { ok: false, reason: 'trajectory-not-array' };

  const provider = getProvider(VERIFIER_PROVIDER);
  if (!provider) return { ok: false, reason: 'verifier-provider-not-registered' };
  const adapter = getAdapter(provider.wire);
  const prompt = buildCheckpointPrompt({ userPrompt, trajectory, currentStep, maxSteps });

  const t0 = Date.now();
  let raw = '';
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
  } catch (err) {
    log && log('warn', `[agent-checkpoint] llm error: ${err.message}, fail-open continue`);
    // Fail-open to "continue" so user agent doesn't get stuck waiting on a flaky verifier.
    return { ok: false, failOpen: true, verdict: 'continue', error: err.message, latencyMs: Date.now() - t0 };
  }

  const parsed = parseCheckpointResponse(raw);
  if (!parsed) {
    log && log('warn', `[agent-checkpoint] parse failed: "${raw.slice(0, 200)}"`);
    return { ok: false, parseFailed: true, verdict: 'continue', latencyMs: Date.now() - t0, raw: raw.slice(0, 500) };
  }

  const avg = (parsed.C1 + parsed.C2 + parsed.C3) / 3;
  return {
    ok: true,
    scores: { C1: parsed.C1, C2: parsed.C2, C3: parsed.C3 },
    avg,
    verdict: parsed.verdict,
    reason: parsed.reason,
    latencyMs: Date.now() - t0,
  };
}

export const _internals = { parseCheckpointResponse, validCheckpoint, formatTrajectory, buildCheckpointPrompt };
