/**
 * agent-helpers.ts — Yuan 辅助纯函数
 *
 * 从 app-agents-shim.ts 提取。不依赖 ctx 注入，直接使用 Zustand store。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- t() 返回值 + opts/patch 为动态 Record */

import { useStore } from '../stores';

declare function t(key: string, vars?: Record<string, string>): any;

export type YuanMeta = {
  name?: string;
  label?: string;
  avatar?: string;
};

export function normalizeYuanKey(yuan?: string): string {
  return yuan === 'ming' ? 'lynn' : (yuan || 'hanako');
}

function normalizeYuanMeta(key: string, meta: YuanMeta = {}): YuanMeta {
  const normalizedAvatar = meta.avatar === 'Ming.png' ? 'Lynn.png' : meta.avatar;
  if (key === 'hanako') return { ...meta, avatar: normalizedAvatar, name: 'Hanako' };
  if (key === 'lynn') return { ...meta, avatar: normalizedAvatar, name: 'Lynn' };
  return { ...meta, avatar: normalizedAvatar };
}

export function getDisplayYuanEntries(types?: Record<string, YuanMeta>): [string, YuanMeta][] {
  const rawTypes = (types || {}) as Record<string, YuanMeta>;
  const normalized = new Map<string, YuanMeta>();

  for (const [rawKey, rawMeta] of Object.entries(rawTypes)) {
    const key = normalizeYuanKey(rawKey);
    const meta = normalizeYuanMeta(key, rawMeta || {});
    const existing = normalized.get(key);
    if (!existing || rawKey === key) {
      normalized.set(key, meta);
    }
  }

  const preferredOrder = ['butter', 'hanako', 'lynn', 'kong'];
  const ordered: [string, YuanMeta][] = [];

  for (const key of preferredOrder) {
    const meta = normalized.get(key);
    if (meta) ordered.push([key, meta]);
  }

  for (const [key, meta] of normalized.entries()) {
    if (!preferredOrder.includes(key)) ordered.push([key, meta]);
  }

  return ordered;
}

export function resolveBundledAvatar(assetName?: string): string {
  const normalizedAsset = assetName === 'Ming.png' ? 'Lynn.png' : (assetName || 'Lynn.png');
  switch (normalizedAsset) {
    case 'Hanako.png':
      return 'assets/Hanako-1600.jpg';
    case 'Butter.png':
      return 'assets/Butter-1600.jpg';
    case 'Lynn.png':
      return 'assets/Lynn-512-opt.png';
    default:
      return `assets/${normalizedAsset}`;
  }
}

export function yuanFallbackAvatar(yuan?: string): string {
  const types = t('yuan.types') || {};
  const key = normalizeYuanKey(yuan);
  const entries = Object.fromEntries(getDisplayYuanEntries(types));
  const entry = entries[key] || entries['hanako'];
  return resolveBundledAvatar(entry?.avatar || 'Lynn.png');
}

export function randomWelcome(agentName?: string, yuan?: string): string {
  const s = useStore.getState();
  const name = agentName || s.agentName;
  const y = normalizeYuanKey(yuan || s.agentYuan);
  const yuanMsgs = t(`yuan.welcome.${y}`);
  const msgs = Array.isArray(yuanMsgs) ? yuanMsgs : t('welcome.messages');
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  const raw = msgs[Math.floor(Math.random() * msgs.length)];
  return raw.replaceAll('{name}', name);
}

export function yuanPlaceholder(yuan?: string): string {
  const s = useStore.getState();
  const y = normalizeYuanKey(yuan || s.agentYuan);
  const yuanPh = t(`yuan.placeholder.${y}`);
  return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
}
