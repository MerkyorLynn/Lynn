/**
 * Settings window API utilities
 * 从 settings store 读 port/token，独立于主窗口
 */
import { useSettingsStore } from './store';

const DEFAULT_TIMEOUT = 30_000;

export function hanaUrl(path: string): string {
  const { serverPort } = useSettingsStore.getState();
  return `http://127.0.0.1:${serverPort}${path}`;
}

export async function hanaFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { serverPort, serverToken } = useSettingsStore.getState();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (serverToken) {
    headers['Authorization'] = `Bearer ${serverToken}`;
  }

  const { timeout = DEFAULT_TIMEOUT, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const ct = res.headers.get('content-type');
        if (ct?.includes('application/json')) {
          const j = (await res.clone().json()) as { error?: string };
          if (j?.error) detail = j.error;
        }
      } catch {
        /* keep status text */
      }
      throw new Error(`hanaFetch ${path}: ${detail}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** 根据 yuan 类型返回 fallback 头像路径 */
export function yuanFallbackAvatar(yuan?: string): string {
  const t = window.t || ((k: string) => k);
  const types = (t('yuan.types') || {}) as Record<string, { avatar?: string }>;
  const entry = types[yuan || 'hanako'];
  const avatar = entry?.avatar || 'Lynn.png';
  if (avatar === 'Hanako.png') return 'assets/Hanako-1600.jpg';
  if (avatar === 'Butter.png') return 'assets/Butter-1600.jpg';
  if (avatar === 'Ming.png') return 'assets/Ming-512-opt.png';
  if (avatar === 'Lynn.png') return 'assets/Lynn-512-opt.png';
  return `assets/${avatar}`;
}
