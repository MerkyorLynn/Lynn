/**
 * Settings window API utilities
 * 从 settings store 读 port/token，独立于主窗口
 */
import { useSettingsStore } from './store';

const DEFAULT_TIMEOUT = 30_000;

function getReadyServerPort(): string {
  const { serverPort } = useSettingsStore.getState();
  const port = String(serverPort ?? '').trim();
  if (!port || port === 'null' || port === 'undefined' || Number.isNaN(Number(port))) {
    throw new Error('settings server is not ready');
  }
  return port;
}

export function lynnUrl(path: string): string {
  const serverPort = getReadyServerPort();
  return `http://127.0.0.1:${serverPort}${path}`;
}

export const hanaUrl = lynnUrl;

export async function lynnFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { serverToken } = useSettingsStore.getState();
  const serverPort = getReadyServerPort();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (serverToken) {
    headers['Authorization'] = `Bearer ${serverToken}`;
  }

  const { timeout = DEFAULT_TIMEOUT, ...fetchOpts } = opts;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      ...fetchOpts,
      headers,
      signal: fetchOpts.signal ? AbortSignal.any([fetchOpts.signal, controller.signal]) : controller.signal,
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
      throw new Error(`lynnFetch ${path}: ${detail}`);
    }
    return res;
  } catch (err) {
    if (timedOut && controller.signal.aborted) {
      const seconds = Math.max(1, Math.round(timeout / 1000));
      throw new Error(`lynnFetch ${path}: 请求超时（${seconds} 秒）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const hanaFetch = lynnFetch;

/** 根据 yuan 类型返回 fallback 头像路径 */
export function yuanFallbackAvatar(yuan?: string): string {
  const t = window.t || ((k: string) => k);
  const normalizedYuan = yuan === 'ming' ? 'lynn' : (yuan || 'hanako');
  const types = (t('yuan.types') || {}) as Record<string, { avatar?: string }>;
  const entry = types[normalizedYuan] || types['hanako'];
  const avatar = entry?.avatar === 'Ming.png' ? 'Lynn.png' : (entry?.avatar || 'Lynn.png');
  if (avatar === 'Hanako.png') return 'assets/Hanako-1600.jpg';
  if (avatar === 'Butter.png') return 'assets/Butter-1600.jpg';
  if (avatar === 'Lynn.png') return 'assets/Lynn-512-opt.png';
  return `assets/${avatar}`;
}
