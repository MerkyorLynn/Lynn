import { useStore } from '../stores';

const DEFAULT_TIMEOUT = 30_000;

/**
 * 构建带认证的 Lynn Server URL
 * 认证通过 Electron 主进程注入的 Authorization header 或同源 cookie 完成，
 * 不再把 token 暴露在 query string。
 */
export function hanaUrl(path: string): string {
  const { serverPort } = useStore.getState();
  return `http://127.0.0.1:${serverPort}${path}`;
}

/**
 * 带认证的 fetch 封装
 * - 默认 30s 超时
 * - 自动校验 res.ok，非 2xx 抛错
 */
export async function hanaFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { serverPort, serverToken } = useStore.getState();
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
      throw new Error(`hanaFetch ${path}: ${res.status} ${res.statusText}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 与 hanaFetch 相同认证与超时，但不因非 2xx 抛错（用于并行请求中部分失败不拖垮整体）。
 */
export async function hanaFetchAllowError(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { serverPort, serverToken } = useStore.getState();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (serverToken) {
    headers['Authorization'] = `Bearer ${serverToken}`;
  }

  const { timeout = DEFAULT_TIMEOUT, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
