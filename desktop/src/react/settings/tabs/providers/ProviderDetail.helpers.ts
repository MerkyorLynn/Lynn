/**
 * ProviderDetail pure helpers — local-Qwen provider id/filename checks, TPS &
 * byte formatters, memory-adaptive local upgrade-option normalization, local
 * endpoint root, and local-model action error text. Extracted from
 * ProviderDetail.tsx (GUI monolith decomposition). No React/hooks/JSX/CSS —
 * pure, unit-testable. (window.platform stays in the component.)
 */

import { isChineseLocale } from '../../../utils/locale';

/** Inline zh/en picker for copy that ships next to these helpers. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);

export const LOCAL_QWEN_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';

/** Display label for the bundled local model, localized on each read. */
export function localQwenProviderLabel(): string {
  return D('本地 Qwen3.8-27B Coder390', 'Local Qwen3.8-27B Coder390');
}

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

function localQwen36_35bUpgrade(): LocalUpgradeOption {
  return {
    id: 'qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix',
    label: 'Qwen3.6-35B-A3B DSV4Pro Thinking Distill MTP Q5_K_M imatrix',
    profile: D(
      '32GB 显存/统一内存+ 可选 · 更高配本地编排器',
      'Optional at 32GB VRAM / unified memory and above · higher-spec local orchestrator',
    ),
    metrics: [
      '25.3 GB Q5_K_M imatrix',
      D('MTP 原生头', 'native MTP head'),
      'GPQA-Diamond 80.3%',
      D('端到端编排 26.6s', 'end-to-end orchestration 26.6s'),
    ],
    reason: D(
      '35B-A3B Q5_K_M 是手动可选的旧版模型，文件和缓存占用更大。默认推荐 Qwen3.8-27B Coder390：24GB 及以上 Q3，24GB 以下（16GB 档） Q2。',
      'The 35B-A3B Q5_K_M is a manually selectable older model with larger files and cache. The default is Qwen3.8-27B Coder390: Q3 at 24GB and above, Q2 below 24GB (the 16GB tier).',
    ),
    modelscope_url: 'https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF',
    download_label: D('下载到本机', 'Download to this machine'),
    file_name: 'Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf',
  };
}

/** Snapshot for module-scope consumers; normalizeLocalUpgradeOptions() re-reads the locale. */
export const LOCAL_QWEN36_35B_UPGRADE: LocalUpgradeOption = localQwen36_35bUpgrade();

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
    const fallback = localQwen36_35bUpgrade();
    normalized.push({ ...fallback, ...(server35b || {}), ...fallback });
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
  if (reason === 'insufficient-disk-space') {
    return detail || D(
      '磁盘空间不足。请清理模型目录所在磁盘后重试。',
      'Not enough disk space. Free up space on the model directory drive and retry.',
    );
  }
  if (reason === 'insufficient-model-memory' || reason === 'unknown-model-memory') {
    return detail || D(
      '显存/统一内存不足或未确认。Q2 至少 14GiB、推荐 16GB；Q3 需要 24GB 档位。',
      'VRAM / unified memory is insufficient or unconfirmed. Q2 needs at least 14GiB (16GB recommended); Q3 needs the 24GB tier.',
    );
  }
  if (reason === 'another-download-running') {
    return D(
      '已有其他本地模型正在下载或校验。请等待完成，或先取消当前下载。',
      'Another local model is downloading or verifying. Wait for it to finish, or cancel the current download first.',
    );
  }
  if (reason === 'unknown-model-id' || reason === 'invalid-model-id') {
    return D(
      '本地模型请求无效。请刷新设置页后重试。',
      'The local model request is invalid. Refresh the settings page and retry.',
    );
  }
  if (reason === 'download-boundary-invalid') {
    return detail || D(
      '下载源未通过安全校验。Lynn 只允许公开 http/https GGUF 源。',
      'The download source failed the safety check. Lynn only allows public http/https GGUF sources.',
    );
  }
  if (reason === 'model-path-not-allowed') {
    return D(
      '请通过“选择本机 GGUF 启动”重新选择该文件，或把 GGUF 放到本地模型目录后再启动。',
      'Pick the file again via "Start a local GGUF", or move the GGUF into the local model directory before starting.',
    );
  }
  if (reason === 'not-gguf') return D('只能导入 .gguf 模型文件。', 'Only .gguf model files can be imported.');
  if (reason === 'not-main-model') {
    return D(
      '这是草稿模型或视觉组件，请选择 Q2/Q3 主模型，或使用一键安装。',
      'This is a draft model or a vision component. Choose a Q2/Q3 main model, or use one-click setup.',
    );
  }
  if (reason === 'model-not-found') {
    return D(
      '模型文件不存在或已移动。请重新选择 GGUF。',
      'The model file is missing or has moved. Choose the GGUF again.',
    );
  }
  if (reason === 'llamacpp-binary-not-found') {
    return D(
      '未找到 llama.cpp。请安装 llama-server 并重新启动 Lynn，或把 llama-server 放到 ~/.lynn/llamacpp/bin。',
      'llama.cpp was not found. Install llama-server and restart Lynn, or place llama-server in ~/.lynn/llamacpp/bin.',
    );
  }
  if (reason === 'llamacpp-port-in-use') {
    return D(
      '本地端口 18099 已被另一个 llama.cpp 实例占用。请先停止该实例，再启动所选 GGUF。',
      'Local port 18099 is already used by another llama.cpp instance. Stop it first, then start the selected GGUF.',
    );
  }
  if (reason === 'startup-timeout') {
    return detail
      ? D(`本地模型启动超时：${detail}`, `The local model timed out while starting: ${detail}`)
      : D(
        '本地模型启动超时。请检查内存是否足够，并查看 llama-server 的启动输出。',
        'The local model timed out while starting. Check that memory is sufficient and review the llama-server output.',
      );
  }
  if (reason === 'child-exited' || reason === 'spawn-error') {
    return detail
      ? D(`llama-server 启动失败：${detail}`, `llama-server failed to start: ${detail}`)
      : D(
        'llama-server 启动失败。请检查模型格式与本机运行时是否兼容。',
        'llama-server failed to start. Check that the model format is compatible with the local runtime.',
      );
  }
  return value;
}
