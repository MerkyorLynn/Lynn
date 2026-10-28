/**
 * ProviderDetail pure helpers — local-Qwen provider id/filename checks, TPS &
 * byte formatters, memory-adaptive local upgrade-option normalization, local
 * endpoint root, and local-model action error text. Extracted from
 * ProviderDetail.tsx (GUI monolith decomposition). No React/hooks/JSX/CSS —
 * pure, unit-testable. (window.platform stays in the component.)
 */

export const LOCAL_QWEN_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';
export const LOCAL_QWEN_PROVIDER_LABEL = '本地 Qwen3.8-27B Coder390';
export const LOCAL_QWEN_DEFAULT_MODEL_ID = 'qwen38-27b-coder390-q3-lynnstyle';
export const LOCAL_QWEN_DEFAULT_MODEL_FILE = 'Qwen3.8-27B-Coder390-EfficientThink-Q3LynnStyle-MTP.gguf';
export const LOCAL_QWEN_DEFAULT_EXPECTED_SIZE = 17_303_770_432;
export const LOCAL_QWEN_COMPAT_PROVIDER_IDS = new Set([
  LOCAL_QWEN_PROVIDER_ID,
  'local-qwen35-4b-q4km',
  'local-qwen3-4b-thinking-2507-q4km-imatrix',
]);

export function isLocalQwenProviderId(id?: string | null) {
  return !!id && (LOCAL_QWEN_COMPAT_PROVIDER_IDS.has(id) || /^local-qwen/i.test(id));
}

export function isDefaultQwen35MtpFileName(fileName: string) {
  // Legacy MTP helper: keep its original contract for existing integrations.
  return /^Q4-imatrix-MTP-\d{5}-of-00004\.gguf$/i.test(fileName)
    || /^Qwen3\.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-Q4-MTP\.gguf$/i.test(fileName);
}

export function formatLocalTps(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${value.toFixed(value >= 10 ? 0 : 1)} tok/s`;
}

export function largestLocalGpu<T extends { memory_gib?: number | null }>(gpus?: T[] | null): T | undefined {
  return gpus?.reduce<T | undefined>((largest, candidate) =>
    !largest || (candidate.memory_gib || 0) > (largest.memory_gib || 0)
      ? candidate
      : largest, undefined);
}

export type LocalActionStatus = {
  kind: 'info' | 'success' | 'error';
  text: string;
};

export type LocalUpgradeOption = {
  id?: string;
  label?: string;
  profile?: string;
  metrics?: string[];
  reason?: string;
  modelscope_url?: string;
  download_label?: string;
  file_name?: string;
};

export const LOCAL_QWEN36_35B_UPGRADE: LocalUpgradeOption = {
  id: 'qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix',
  label: 'Qwen3.6-35B-A3B DSV4Pro Thinking Distill MTP Q5_K_M imatrix',
  profile: '32GB 显存/统一内存+ 可选 · 更高配本地编排器',
  metrics: ['25.3 GB Q5_K_M imatrix', 'MTP 原生头', 'GPQA-Diamond 80.3%', '端到端编排 26.6s'],
  reason: '35B-A3B Q5_K_M 是手动可选的旧版模型，文件和缓存占用更大。默认推荐 Qwen3.8-27B Coder390：24GB 及以上 Q3，24GB 以下（16GB 档） Q2。',
  modelscope_url: 'https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF',
  download_label: '下载到本机',
  file_name: 'Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf',
};

export function normalizeLocalUpgradeOptions(options: LocalUpgradeOption[] = [], memoryGib?: number | null) {
  // 9B and 4B are no longer offered. 35B stays a manual high-memory option.
  let server35b: LocalUpgradeOption | null = null;
  const others: LocalUpgradeOption[] = [];
  for (const option of options) {
    const haystack = `${option.id || ''} ${option.label || ''}`.toLowerCase();
    if (haystack.includes('27b') || haystack.includes('9b') || haystack.includes('4b')) continue;
    if (haystack.includes('35b')) { server35b = option; continue; }
    others.push(option);
  }
  const mem = typeof memoryGib === 'number' && Number.isFinite(memoryGib) ? memoryGib : null;
  const show35b = mem === null || mem >= 32;
  const normalized: LocalUpgradeOption[] = [...others];
  if (show35b) {
    normalized.push({ ...LOCAL_QWEN36_35B_UPGRADE, ...(server35b || {}), ...LOCAL_QWEN36_35B_UPGRADE });
  }
  return normalized;
}

export function localEndpointRoot(baseUrl?: string | null) {
  return String(baseUrl || 'http://127.0.0.1:18099/v1').replace(/\/v1\/?$/, '');
}

export function formatBytes(bytes?: number | null) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function localModelActionErrorText(reason?: string, detail?: string) {
  const value = String(detail || reason || 'unknown-error');
  if (reason === 'insufficient-disk-space') return detail || '磁盘空间不足。请清理模型目录所在磁盘后重试。';
  if (reason === 'insufficient-model-memory' || reason === 'unknown-model-memory') return detail || '显存/统一内存不足或未确认。Q2 至少 14GiB、推荐 16GB；Q3 需要 24GB 档位。';
  if (reason === 'another-download-running') return '已有其他本地模型正在下载或校验。请等待完成，或先取消当前下载。';
  if (reason === 'unknown-model-id' || reason === 'invalid-model-id') return '本地模型请求无效。请刷新设置页后重试。';
  if (reason === 'download-boundary-invalid') return detail || '下载源未通过安全校验。Lynn 只允许公开 http/https GGUF 源。';
  if (reason === 'model-path-not-allowed') return '请通过“选择本机 GGUF 启动”重新选择该文件，或把 GGUF 放到本地模型目录后再启动。';
  if (reason === 'not-gguf') return '只能导入 .gguf 模型文件。';
  if (reason === 'not-main-model') return '这是草稿模型或视觉组件，请选择 Q2/Q3 主模型，或使用一键安装。';
  if (reason === 'model-not-found') return '模型文件不存在或已移动。请重新选择 GGUF。';
  if (reason === 'llamacpp-binary-not-found') return '未找到 llama.cpp。请安装 llama-server 并重新启动 Lynn，或把 llama-server 放到 ~/.lynn/llamacpp/bin。';
  if (reason === 'llamacpp-port-in-use') return '本地端口 18099 已被另一个 llama.cpp 实例占用。请先停止该实例，再启动所选 GGUF。';
  if (reason === 'startup-timeout') return detail ? `本地模型启动超时：${detail}` : '本地模型启动超时。请检查内存是否足够，并查看 llama-server 的启动输出。';
  if (reason === 'child-exited' || reason === 'spawn-error') return detail ? `llama-server 启动失败：${detail}` : 'llama-server 启动失败。请检查模型格式与本机运行时是否兼容。';
  return value;
}
