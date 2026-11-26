import { D } from '../../utils/locale';

export type RunRisk = 'low' | 'medium' | 'high';

export function deriveRunRisk(command: string): RunRisk {
  const normalized = command.trim().toLowerCase();
  if (/\b(rm|sudo|chmod|chown|mv|scp|ssh|docker\s+rm|git\s+push|npm\s+publish)\b/.test(normalized)) {
    return 'high';
  }
  if (/\b(git|npm|pnpm|yarn|bun|cargo|go|python|node|uv|make|brew|curl|wget)\b/.test(normalized)) {
    return 'medium';
  }
  return 'low';
}

export function runRiskLabel(
  risk: RunRisk,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (risk === 'high') return t('markdown.runRisk.high') || '高风险';
  if (risk === 'medium') return t('markdown.runRisk.medium') || '中风险';
  return t('markdown.runRisk.low') || '低风险';
}

export function buildRunCommandPrompt(command: string, cwd: string | null): string {
  const cwdLine = cwd ? D(`当前工作目录：${cwd}\n`, `Working directory: ${cwd}\n`) : '';
  return D(
    `请直接在终端执行下面的命令，并基于真实结果回复。不要只解释命令本身。\n${cwdLine}\n\`\`\`sh\n${command.trim()}\n\`\`\``,
    `Run the command below in a terminal and reply based on the real result. Do not just explain the command.\n${cwdLine}\n\`\`\`sh\n${command.trim()}\n\`\`\``,
  );
}
