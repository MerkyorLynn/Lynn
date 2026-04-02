/**
 * agent-helpers.ts — Yuan 辅助纯函数
 *
 * 从 app-agents-shim.ts 提取。不依赖 ctx 注入，直接使用 Zustand store。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- t() 返回值 + opts/patch 为动态 Record */

import { useStore } from '../stores';

declare function t(key: string, vars?: Record<string, string>): any;

export function resolveBundledAvatar(assetName?: string): string {
  switch (assetName) {
    case 'Hanako.png':
      return 'assets/Hanako-1600.jpg';
    case 'Butter.png':
      return 'assets/Butter-1600.jpg';
    case 'Ming.png':
      return 'assets/Ming-512-opt.png';
    case 'Lynn.png':
      return 'assets/Lynn-512-opt.png';
    default:
      return `assets/${assetName || 'Lynn.png'}`;
  }
}

export function yuanFallbackAvatar(yuan?: string): string {
  const types = t('yuan.types') || {};
  const entry = types[yuan || 'hanako'];
  return resolveBundledAvatar(entry?.avatar || 'Lynn.png');
}

export function randomWelcome(agentName?: string, yuan?: string): string {
  const s = useStore.getState();
  const name = agentName || s.agentName;
  const y = yuan || s.agentYuan;
  const yuanMsgs = t(`yuan.welcome.${y}`);
  const msgs = Array.isArray(yuanMsgs) ? yuanMsgs : t('welcome.messages');
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  const raw = msgs[Math.floor(Math.random() * msgs.length)];
  return raw.replaceAll('{name}', name);
}

export function yuanPlaceholder(yuan?: string): string {
  const s = useStore.getState();
  const y = yuan || s.agentYuan;
  const yuanPh = t(`yuan.placeholder.${y}`);
  return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
}
