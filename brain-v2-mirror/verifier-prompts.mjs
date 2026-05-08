// Brain v2 · Verifier prompt builder + response parser (C1/C2/C3 三维度)
// 单条 tool result 评分,不做 N-of-best。LLM-as-a-Verifier 的轻量化单轨实现。
// Deploy target: /opt/lobster-brain-v2/verifier-prompts.mjs

const MAX_RESULT_CHARS = 8000;

export function buildVerifierPrompt({ userPrompt, toolName, toolResult }) {
  const truncated = String(toolResult || '').slice(0, MAX_RESULT_CHARS);

  return `You are a strict tool-result reviewer. Given a user question and the tool's response, rate it on 3 dimensions.

User Question:
${userPrompt}

Tool: ${toolName}

Tool Result:
${truncated}

Evaluate on a 1-8 scale (1=perfect, 8=worst):

C1 Specification — does the result address what the user actually asked?
   - Right currency / region / time range / entity?
   - Tool actually answered the question (not adjacent topic)?

C2 Output Format — structured / cited as needed?
   - Finance / weather: numbers + units + date stamp present?
   - web_search / parallel_research: sources cited?
   - Internal coherence (no broken markup, no truncation mid-sentence)?

C3 Errors — obvious factual errors / broken refs / internal contradictions?
   - Numbers self-consistent?
   - No "I don't know" / placeholder / lorem-ipsum?
   - No timestamp from far future / past?

Output ONLY this JSON, no other text or markdown:
{"C1": <integer 1-8>, "C2": <integer 1-8>, "C3": <integer 1-8>, "reason": "<one short sentence>"}`;
}

export function parseVerifierResponse(text) {
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
