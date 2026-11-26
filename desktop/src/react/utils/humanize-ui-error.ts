import { isChineseLocale } from './locale';

/** Inline zh/en picker for these generic error strings. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);

const ERROR_MESSAGES: Array<[RegExp, () => string]> = [
  [/auth|unauthori[sz]ed|forbidden|invalid[_ -]?key|401|403/i,
    () => D('认证失败，请检查登录状态或 API Key。', 'Authentication failed. Check your sign-in status or API key.')],
  [/timeout|timed out|aborterror|请求超时/i,
    () => D('请求超时，请稍后重试。', 'The request timed out. Please try again.')],
  [/network|failed to fetch|econnreset|econnrefused|enotfound|socket hang up/i,
    () => D('网络连接失败，请检查网络后重试。', 'Network connection failed. Check your connection and retry.')],
  [/rate[_ -]?limit|too many requests|429/i,
    () => D('请求过于频繁，请稍后再试。', 'Too many requests. Please try again in a moment.')],
  [/port[_ -]?in[_ -]?use|eaddrinuse/i,
    () => D('本地服务端口已被占用，请停止冲突进程后重试。', 'The local service port is already in use. Stop the conflicting process and retry.')],
  [/binary[_ -]?not[_ -]?found|enoent/i,
    () => D('缺少所需的本地运行程序，请在设置中重新检查安装。', 'A required local binary is missing. Re-check the installation in Settings.')],
  [/model[_ -]?not[_ -]?found/i,
    () => D('没有找到模型文件，请重新选择或下载。', 'The model file was not found. Choose it again or download it.')],
  [/cancelled|canceled|aborted/i,
    () => D('操作已取消。', 'The operation was cancelled.')],
];

export function humanizeUiError(input: unknown): string {
  const raw = String(input instanceof Error ? input.message : input || '').trim();
  if (!raw) return D('操作失败，请重试。', 'The operation failed. Please try again.');
  for (const [pattern, message] of ERROR_MESSAGES) {
    if (pattern.test(raw)) return message();
  }
  if (/^[a-z0-9_.:-]+$/i.test(raw) || raw.startsWith('{') || raw.includes('\n    at ')) {
    return D(
      '操作失败，请重试；如问题持续，可在诊断中查看详情。',
      'The operation failed. Retry, and check Diagnostics if the problem persists.',
    );
  }
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}
