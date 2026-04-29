/**
 * ui-helpers.ts — 连接状态 / 错误提示 / 模型加载
 *
 * 纯 store 操作，无 DOM 依赖。
 */

import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { parseSharedModelRef } from './model-ref';
// @ts-expect-error — shared JS module
import { errorBus } from '../../../../shared/error-bus.js';
// @ts-expect-error — shared JS module
import { AppError } from '../../../../shared/errors.js';

// ── 连接状态 ──

export function setStatus(key: string, connected: boolean, vars: Record<string, string | number> = {}): void {
  useStore.setState({ connected, statusKey: key, statusVars: vars });
}

// ── 错误显示 ──

export function showError(message: string): void {
  errorBus.report(new AppError('UNKNOWN', { message }));
}

// ── 模型加载 ──

export async function loadModels(): Promise<void> {
  try {
    const res = await hanaFetch('/api/models');
    const data = await res.json();
    const currentModelObj = (data.models || []).find((m: { isCurrent?: boolean }) => m.isCurrent);
    const utilityRef = parseSharedModelRef(data.utilityModel || null);
    const utilityLargeRef = parseSharedModelRef(data.utilityLargeModel || null);
    useStore.setState({
      models: data.models || [],
      currentModel: currentModelObj ? { id: currentModelObj.id, provider: currentModelObj.provider } : null,
      utilityModel: utilityRef.id ? { id: utilityRef.id, provider: utilityRef.provider } : null,
      utilityLargeModel: utilityLargeRef.id ? { id: utilityLargeRef.id, provider: utilityLargeRef.provider } : null,
    });
  } catch { /* silent */ }
}
