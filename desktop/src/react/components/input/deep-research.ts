export const DEEP_RESEARCH_TIMEOUT_MS = 180_000;
export const DEEP_RESEARCH_FETCH_TIMEOUT_MS = DEEP_RESEARCH_TIMEOUT_MS + 10_000;

export type DeepResearchScoreRow = Record<string, unknown>;

export interface DeepResearchResponse {
  text?: unknown;
  winnerProviderId?: unknown;
  qualityRejected?: unknown;
  ok?: unknown;
  rankedScores?: unknown;
}

export function normalizeDeepResearchErrorMessage(raw: unknown): string {
  const rawMessage = raw instanceof Error ? raw.message : String(raw || "Deep Research 失败");
  if (/aborted without reason|AbortError|请求超时/iu.test(rawMessage)) {
    return "Deep Research 超过等待时间，已停止本轮。你可以稍后重试，或把问题拆成更具体的子问题。";
  }
  return rawMessage;
}

export function formatDeepResearchAssistantText(data: DeepResearchResponse): string {
  const text = String(data?.text || "").trim()
    || "Deep Research 没有返回可见答案，请稍后重试或把问题拆得更具体。";
  const winner = data?.winnerProviderId ? ` · winner: ${data.winnerProviderId}` : "";
  const status = data?.qualityRejected
    ? "质量地板已拦截"
    : data?.ok === false
      ? "未通过质量复核"
      : "已通过质量复核";
  const scoreLines = Array.isArray(data?.rankedScores)
    ? data.rankedScores.slice(0, 3).map((row: DeepResearchScoreRow, index: number) => {
      const provider = String(row.providerId || row.provider || `候选 ${index + 1}`);
      const avg = Number(row.avg ?? row.average ?? NaN);
      return Number.isFinite(avg) ? `- ${provider}: ${avg.toFixed(2)}` : `- ${provider}`;
    })
    : [];
  const footer = [
    "",
    "---",
    `**Deep Research**：${status}${winner}`,
    scoreLines.length ? `\n${scoreLines.join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return `${text}\n${footer}`;
}
