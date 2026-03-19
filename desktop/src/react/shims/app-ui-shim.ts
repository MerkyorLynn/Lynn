/**
 * app-ui-shim.ts — 连接状态 / 错误提示 / 模型加载 / i18n
 *
 * 滚动管理已移入 React ChatArea Panel 组件，scrollToBottom / resetScroll 已删除。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare function t(key: string, vars?: Record<string, string>): any;

interface AppUiCtx {
  state: Record<string, any>;
  $: (sel: string) => HTMLElement | null;
  hanaFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  connectionStatus: HTMLElement;
  settingsBtn: HTMLElement | null;
  _dk: () => Record<string, any>;
}

let ctx: AppUiCtx;

// ── 连接状态 ──

function setStatus(text: string, connected: boolean): void {
  const el = ctx.connectionStatus;
  const textEl = el.querySelector('.status-text');
  if (textEl) textEl.textContent = text;
  el.classList.toggle('connected', connected);
}

// ── 错误显示 ──

function showError(message: string): void {
  console.error('[hana]', message);
  const toast = document.createElement('div');
  toast.className = 'hana-toast error';
  toast.textContent = `\u26A0 ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ── 模型加载 ──

async function loadModels(): Promise<void> {
  const { state, hanaFetch } = ctx;
  try {
    const favRes = await hanaFetch('/api/models/favorites');
    const favData = await favRes.json();
    state.models = favData.models || [];
    state.currentModel = favData.current;
  } catch { /* silent */ }
}

// ── i18n 静态文本 ──

function applyStaticI18n(): void {
  const { state, $, settingsBtn } = ctx;

  const sidebarTitle = $('.sidebar-title');
  if (sidebarTitle) sidebarTitle.textContent = t('sidebar.title');
  const toggleLabel = $('.sidebar-toggle-label');
  if (toggleLabel) toggleLabel.textContent = t('sidebar.title');

  const activityBarLabel = $('#activityBarLabel');
  if (activityBarLabel) activityBarLabel.textContent = t('sidebar.activity');

  const newSessionBtn = $('#newSessionBtn');
  if (newSessionBtn) newSessionBtn.title = t('sidebar.newChat');
  if (settingsBtn) settingsBtn.title = t('settings.title');
  const bridgeBarLabel = $('#bridgeBarLabel');
  if (bridgeBarLabel) bridgeBarLabel.textContent = t('sidebar.bridge');

  const sidebarCollapseBtn = $('#sidebarCollapseBtn');
  if (sidebarCollapseBtn) sidebarCollapseBtn.title = t('sidebar.collapse');
  const tbToggleLeft = $('#tbToggleLeft');
  if (tbToggleLeft) tbToggleLeft.title = t('sidebar.expand');
  const tbToggleRight = $('#tbToggleRight');
  if (tbToggleRight) tbToggleRight.title = t('sidebar.jian') || '\u4E66\u684C';

  const dropText = $('.drop-text');
  if (dropText) dropText.textContent = t('drop.hint', { name: state.agentName });

  ctx._dk().updateMemoryToggle();

  const statusText = $('.status-text');
  if (statusText && !state.connected) statusText.textContent = t('status.connecting');

  ctx._dk().updateFolderButton();
}

// ── Setup ──

export function setupAppUiShim(modules: Record<string, unknown>): void {
  modules.appUi = {
    scrollToBottom: () => {},
    resetScroll: () => {},
    initScrollListener: () => {},
    setStatus,
    showError,
    loadModels,
    applyStaticI18n,
    initAppUi: (injected: AppUiCtx) => { ctx = injected; },
  };
}
