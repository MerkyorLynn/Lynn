import { useStore } from '../stores';
import { isChineseLocale } from '../utils/locale';

/** Inline zh/en picker for copy that ships near this module. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);
import { createRequestDeadline } from '../../../../shared/request-deadline';

const DEFAULT_TIMEOUT = 30_000;

export class LynnServerPortNotReadyError extends Error {
  readonly code = 'LYNN_SERVER_PORT_NOT_READY';

  constructor() {
    super('Lynn server port is not ready');
    this.name = 'LynnServerPortNotReadyError';
  }
}

function readReadyServerPort(): string {
  const { serverPort } = useStore.getState();
  const port = String(serverPort ?? '').trim();
  if (!port || port === 'null' || port === 'undefined' || !/^\d+$/.test(port)) {
    throw new LynnServerPortNotReadyError();
  }
  return port;
}

export function isLynnServerPortNotReady(err: unknown): boolean {
  if (err instanceof LynnServerPortNotReadyError) return true;
  if (!err || typeof err !== 'object') return false;
  const maybe = err as { code?: unknown; name?: unknown; message?: unknown };
  return maybe.code === 'LYNN_SERVER_PORT_NOT_READY'
    || maybe.name === 'LynnServerPortNotReadyError'
    || maybe.message === 'Lynn server port is not ready';
}

export function hasReadyServerPort(): boolean {
  try {
    readReadyServerPort();
    return true;
  } catch (err) {
    if (isLynnServerPortNotReady(err)) return false;
    throw err;
  }
}

/**
 * 构建带认证的 Lynn Server URL
 * 认证通过 Electron 主进程注入的 Authorization header 或同源 cookie 完成，
 * 不再把 token 暴露在 query string。
 */
export function lynnUrl(path: string): string {
  const serverPort = readReadyServerPort();
  return `http://127.0.0.1:${serverPort}${path}`;
}

/**
 * 带认证的 fetch 封装
 * - 默认 30s 超时
 * - 自动校验 res.ok，非 2xx 抛错
 * - 尽量返回服务端 JSON error 文案，避免前端只能拿到 400/500 状态码
 */
export async function lynnFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const serverPort = readReadyServerPort();
  const { serverToken } = useStore.getState();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (serverToken) {
    headers.Authorization = `Bearer ${serverToken}`;
  }

  const { timeout = DEFAULT_TIMEOUT, ...fetchOpts } = opts;
  const deadline = createRequestDeadline(timeout, opts.signal);

  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      ...fetchOpts,
      headers,
      signal: deadline.signal,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const ct = res.headers.get('content-type');
        if (ct?.includes('application/json')) {
          const data = (await res.clone().json()) as { error?: string };
          if (data?.error || (data as { message?: string })?.message) {
            detail = [data.error, (data as { message?: string }).message].filter(Boolean).join(": ");
          }
        }
      } catch {
        // ignore parse failures and keep status text
      }
      throw new Error(`lynnFetch ${path}: ${detail}`);
    }
    return res;
  } catch (err) {
    if (deadline.timedOut && !opts.signal?.aborted) {
      const seconds = Math.max(1, Math.round(timeout / 1000));
      throw new Error(D(
        `lynnFetch ${path}: 请求超时（${seconds} 秒）`,
        `lynnFetch ${path}: request timed out after ${seconds}s`,
      ));
    }
    throw err;
  } finally {
    deadline.dispose();
  }
}

/**
 * 与 lynnFetch 相同认证与超时，但不因非 2xx 抛错（用于并行请求中部分失败不拖垮整体）。
 */
export async function lynnFetchAllowError(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const serverPort = readReadyServerPort();
  const { serverToken } = useStore.getState();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (serverToken) {
    headers.Authorization = `Bearer ${serverToken}`;
  }

  const { timeout = DEFAULT_TIMEOUT, ...fetchOpts } = opts;
  const deadline = createRequestDeadline(timeout, opts.signal);

  try {
    return await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      ...fetchOpts,
      headers,
      signal: deadline.signal,
    });
  } catch (err) {
    if (deadline.timedOut && !opts.signal?.aborted) {
      const seconds = Math.max(1, Math.round(timeout / 1000));
      throw new Error(D(
        `lynnFetch ${path}: 请求超时（${seconds} 秒）`,
        `lynnFetch ${path}: request timed out after ${seconds}s`,
      ));
    }
    throw err;
  } finally {
    deadline.dispose();
  }
}

/** @deprecated use lynnUrl */
export const hanaUrl = lynnUrl;
/** @deprecated use lynnFetch */
export const hanaFetch = lynnFetch;
/** @deprecated use lynnFetchAllowError */
export const hanaFetchAllowError = lynnFetchAllowError;
