const VALID_VERDICTS = new Set(["pass", "concerns", "blocker"]);
const VALID_SEVERITIES = new Set(["high", "medium", "low"]);

function cleanText(value, maxLength = 0) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!maxLength || normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trim();
}

function parseJsonCandidate(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractStructuredCandidate(rawText) {
  const trimmed = cleanText(rawText);
  if (!trimmed) return null;

  const candidates = [trimmed];
  const fenceMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of fenceMatches) {
    if (match[1]) candidates.push(match[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function normalizeSeverity(value) {
  return VALID_SEVERITIES.has(value) ? value : "medium";
}

function normalizeFinding(finding) {
  if (!finding || typeof finding !== "object") return null;

  const title = cleanText(finding.title || finding.name, 160);
  const detail = cleanText(finding.detail || finding.description, 800);
  const suggestion = cleanText(finding.suggestion || finding.fix || finding.nextStep, 400);
  const filePath = cleanText(finding.filePath || finding.path, 260);

  if (!title && !detail && !suggestion) return null;

  return {
    severity: normalizeSeverity(finding.severity),
    title: title || detail || suggestion,
    detail,
    suggestion,
    ...(filePath ? { filePath } : {}),
  };
}

export function computeReviewWorkflowGate(structuredReview) {
  const findings = Array.isArray(structuredReview?.findings) ? structuredReview.findings : [];
  const hasHigh = findings.some((finding) => finding?.severity === "high");

  if (structuredReview?.verdict === "blocker" || hasHigh) return "hold";
  if (structuredReview?.verdict === "concerns" || findings.length > 0) return "follow_up";
  return "clear";
}

export function buildReviewFollowUp(structuredReview) {
  if (!structuredReview) return null;
  const findings = Array.isArray(structuredReview.findings) ? structuredReview.findings : [];
  if (findings.length === 0 && structuredReview.workflowGate === "clear") return null;

  const topFindings = findings.slice(0, 3)
    .map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title}${finding.filePath ? ` (${finding.filePath})` : ""}`)
    .join("\n");

  const summary = cleanText(structuredReview.summary, 320);
  const nextStep = cleanText(structuredReview.nextStep, 240);
  const lines = [
    `Review verdict: ${structuredReview.verdict}`,
    summary ? `Summary: ${summary}` : null,
    topFindings ? `Findings:\n${topFindings}` : null,
    nextStep ? `Next step: ${nextStep}` : null,
    "Address the review findings before continuing.",
  ].filter(Boolean);

  return lines.join("\n\n");
}

export function normalizeStructuredReview(candidate, rawText = "") {
  if (!candidate || typeof candidate !== "object") return null;

  const findings = Array.isArray(candidate.findings)
    ? candidate.findings.map(normalizeFinding).filter(Boolean)
    : [];

  let verdict = VALID_VERDICTS.has(candidate.verdict) ? candidate.verdict : "";
  if (!verdict) {
    verdict = findings.some((finding) => finding.severity === "high")
      ? "blocker"
      : findings.length > 0
        ? "concerns"
        : "pass";
  }

  const summary = cleanText(candidate.summary, 600)
    || cleanText(rawText, 600)
    || (verdict === "pass" ? "No material issues found." : `${findings.length} finding${findings.length === 1 ? "" : "s"}.`);

  const nextStep = cleanText(candidate.nextStep, 400);
  const structuredReview = {
    summary,
    verdict,
    findings,
    workflowGate: "clear",
    ...(nextStep ? { nextStep } : {}),
  };

  structuredReview.workflowGate = computeReviewWorkflowGate(structuredReview);
  return structuredReview;
}

export function parseStructuredReview(rawText) {
  const candidate = extractStructuredCandidate(rawText);
  if (!candidate) return null;
  return normalizeStructuredReview(candidate, rawText);
}
