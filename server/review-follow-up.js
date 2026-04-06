function cleanText(value, maxLength = 0) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!maxLength || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trim()}…`;
}

function normalizeFindings(structuredReview) {
  return Array.isArray(structuredReview?.findings) ? structuredReview.findings.filter(Boolean) : [];
}

function renderFindingBlock(finding, index, zh) {
  const lines = [];
  lines.push(`${index + 1}. [${finding.severity || 'medium'}] ${cleanText(finding.title, 160) || (zh ? '未命名问题' : 'Untitled finding')}`);
  if (finding.filePath) lines.push(zh ? `文件: ${cleanText(finding.filePath, 260)}` : `File: ${cleanText(finding.filePath, 260)}`);
  if (finding.detail) lines.push(zh ? `细节: ${cleanText(finding.detail, 700)}` : `Detail: ${cleanText(finding.detail, 700)}`);
  if (finding.suggestion) lines.push(zh ? `建议: ${cleanText(finding.suggestion, 360)}` : `Suggestion: ${cleanText(finding.suggestion, 360)}`);
  return lines.join('\n');
}

export function buildReviewFollowUpTaskTitle(structuredReview, { zh = false } = {}) {
  const findings = normalizeFindings(structuredReview);
  const lead = cleanText(findings[0]?.title, 80);
  if (zh) return lead ? `处理复查发现：${lead}` : '处理复查发现';
  return lead ? `Address review findings: ${lead}` : 'Address review findings';
}

export function buildReviewFollowUpTaskPrompt({ structuredReview, contextPack, followUpPrompt, reviewerName, sourceResponse, executionResolution } = {}, { zh = false } = {}) {
  const findings = normalizeFindings(structuredReview);
  const lines = [];

  if (zh) {
    lines.push('你正在处理一份异步 review 留下的发现项。请在当前工作区中完成必要修改，并在完成后用简短中文说明处理结果。');
    lines.push('');
    lines.push('要求：');
    lines.push('- 先验证 review 发现是否成立，再决定如何修改');
    lines.push('- 优先处理 high / medium 问题；如果某项不需要改，明确说明原因');
    lines.push('- 必要时补测试、回归验证或最小复现');
    lines.push('- 最后汇报：改了什么、如何验证、剩余风险');
    if (reviewerName) {
      lines.push('');
      lines.push('[复查人]');
      lines.push(cleanText(reviewerName, 120));
    }
    if (executionResolution) {
      lines.push('');
      lines.push('[建议执行结论]');
      lines.push(cleanText(executionResolution, 900));
    }
    if (sourceResponse) {
      lines.push('');
      lines.push('[Lynn 原回答摘要]');
      lines.push(cleanText(sourceResponse, 1200));
    }
    if (structuredReview?.summary) {
      lines.push('');
      lines.push('[复查结论]');
      lines.push(cleanText(structuredReview.summary, 600));
    }
    if (findings.length > 0) {
      lines.push('');
      lines.push('[发现项]');
      findings.slice(0, 6).forEach((finding, index) => {
        lines.push(renderFindingBlock(finding, index, true));
        if (index !== Math.min(findings.length, 6) - 1) lines.push('');
      });
    }
    if (structuredReview?.nextStep) {
      lines.push('');
      lines.push('[建议下一步]');
      lines.push(cleanText(structuredReview.nextStep, 320));
    }
    if (followUpPrompt) {
      lines.push('');
      lines.push('[后续动作草稿]');
      lines.push(cleanText(followUpPrompt, 1200));
    }
    if (contextPack?.request) {
      lines.push('');
      lines.push('[本次复查目标]');
      lines.push(cleanText(contextPack.request, 1600));
    }
    if (contextPack?.sessionContext?.userText) {
      lines.push('');
      lines.push('[最近一次用户请求]');
      lines.push(cleanText(contextPack.sessionContext.userText, 1200));
    }
    if (contextPack?.sessionContext?.assistantText) {
      lines.push('');
      lines.push('[最近一次助手结论]');
      lines.push(cleanText(contextPack.sessionContext.assistantText, 1400));
    }
    if (contextPack?.workspacePath) {
      lines.push('');
      lines.push('[工作目录]');
      lines.push(cleanText(contextPack.workspacePath, 300));
    }
  } else {
    lines.push('You are addressing findings from an async review. Make the necessary changes in the current workspace and finish with a concise execution summary.');
    lines.push('');
    lines.push('Requirements:');
    lines.push('- Validate each review finding before changing code');
    lines.push('- Prioritize high / medium findings; explain clearly if a finding does not require a change');
    lines.push('- Add tests, regression checks, or a minimal repro when needed');
    lines.push('- End with: what changed, how it was verified, and any remaining risks');
    if (reviewerName) {
      lines.push('');
      lines.push('[Reviewer]');
      lines.push(cleanText(reviewerName, 120));
    }
    if (executionResolution) {
      lines.push('');
      lines.push('[Suggested execution conclusion]');
      lines.push(cleanText(executionResolution, 900));
    }
    if (sourceResponse) {
      lines.push('');
      lines.push("[Lynn's original answer]");
      lines.push(cleanText(sourceResponse, 1200));
    }
    if (structuredReview?.summary) {
      lines.push('');
      lines.push('[Review summary]');
      lines.push(cleanText(structuredReview.summary, 600));
    }
    if (findings.length > 0) {
      lines.push('');
      lines.push('[Findings]');
      findings.slice(0, 6).forEach((finding, index) => {
        lines.push(renderFindingBlock(finding, index, false));
        if (index !== Math.min(findings.length, 6) - 1) lines.push('');
      });
    }
    if (structuredReview?.nextStep) {
      lines.push('');
      lines.push('[Suggested next step]');
      lines.push(cleanText(structuredReview.nextStep, 320));
    }
    if (followUpPrompt) {
      lines.push('');
      lines.push('[Follow-up draft]');
      lines.push(cleanText(followUpPrompt, 1200));
    }
    if (contextPack?.request) {
      lines.push('');
      lines.push('[Review target]');
      lines.push(cleanText(contextPack.request, 1600));
    }
    if (contextPack?.sessionContext?.userText) {
      lines.push('');
      lines.push('[Latest user request]');
      lines.push(cleanText(contextPack.sessionContext.userText, 1200));
    }
    if (contextPack?.sessionContext?.assistantText) {
      lines.push('');
      lines.push('[Latest assistant conclusion]');
      lines.push(cleanText(contextPack.sessionContext.assistantText, 1400));
    }
    if (contextPack?.workspacePath) {
      lines.push('');
      lines.push('[Workspace]');
      lines.push(cleanText(contextPack.workspacePath, 300));
    }
  }

  return lines.filter(Boolean).join('\n').trim();
}
