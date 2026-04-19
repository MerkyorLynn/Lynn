import type { ActivePanel, TabType } from '../types';

// 写作模式默认开启（跟 Claude Code 对齐，扩大可用屏幕宽度到 800px）
// 用 localStorage 持久化用户的偏好
const WRITING_MODE_KEY = 'hana-writing-mode';
function readInitialWritingMode(): boolean {
  try {
    const stored = localStorage.getItem(WRITING_MODE_KEY);
    if (stored === null) return true; // 默认开启
    return stored === '1';
  } catch {
    return true;
  }
}

export interface UiSlice {
  sidebarOpen: boolean;
  sidebarAutoCollapsed: boolean;
  jianOpen: boolean;
  jianAutoCollapsed: boolean;
  previewOpen: boolean;
  /** 写作模式：加宽聊天区域，自动收起 Jian，自动打开 MD 预览 */
  writingMode: boolean;
  welcomeVisible: boolean;
  currentTab: TabType;
  activePanel: ActivePanel;
  locale: string;
  /** Skill 预览 overlay 数据（null = 关闭） */
  skillViewerData: { name: string; baseDir: string; filePath?: string; installed?: boolean } | null;
  /** 频道创建弹窗是否可见 */
  channelCreateOverlayVisible: boolean;
  /** 添加成员弹窗是否可见 */
  addMemberOverlayVisible: boolean;
  /** 添加成员目标频道 ID */
  addMemberTargetChannel: string | null;
  /** AI 智能体发现弹窗是否可见 */
  agentDiscoveryVisible: boolean;
  /** 发现的其他 AI 智能体列表 */
  discoveredAgents: Array<{ dirPath: string; label: string; exists: boolean }>;
  /** 统一确认对话框 */
  pendingConfirm: {
    title?: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'default' | 'danger';
    onConfirm: () => Promise<void> | void;
    onCancel?: () => void;
  } | null;
  setSidebarOpen: (open: boolean) => void;
  setSidebarAutoCollapsed: (collapsed: boolean) => void;
  setJianOpen: (open: boolean) => void;
  setJianAutoCollapsed: (collapsed: boolean) => void;
  setPreviewOpen: (open: boolean) => void;
  setWritingMode: (enabled: boolean) => void;
  setWelcomeVisible: (visible: boolean) => void;
  setCurrentTab: (tab: TabType) => void;
  setActivePanel: (panel: ActivePanel) => void;
  setChannelCreateOverlayVisible: (visible: boolean) => void;
  setAddMemberOverlayVisible: (visible: boolean) => void;
  setAddMemberTargetChannel: (channelId: string | null) => void;
  setAgentDiscoveryVisible: (visible: boolean) => void;
  setDiscoveredAgents: (agents: Array<{ dirPath: string; label: string; exists: boolean }>) => void;
  setPendingConfirm: (confirm: UiSlice['pendingConfirm']) => void;
  toggleSidebar: () => void;
  toggleJian: () => void;
}

export const createUiSlice = (
  set: (partial: Partial<UiSlice> | ((s: UiSlice) => Partial<UiSlice>)) => void
): UiSlice => ({
  sidebarOpen: true,
  sidebarAutoCollapsed: false,
  jianOpen: false,
  jianAutoCollapsed: false,
  previewOpen: false,
  writingMode: readInitialWritingMode(),
  welcomeVisible: true,
  currentTab: 'chat',
  activePanel: null,
  // Keep locale empty until i18n.load() finishes so the first successful
  // locale sync always triggers a rerender, even for the default zh locale.
  locale: '',
  skillViewerData: null,
  channelCreateOverlayVisible: false,
  addMemberOverlayVisible: false,
  addMemberTargetChannel: null,
  agentDiscoveryVisible: false,
  discoveredAgents: [],
  pendingConfirm: null,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarAutoCollapsed: (collapsed) => set({ sidebarAutoCollapsed: collapsed }),
  setJianOpen: (open) => set({ jianOpen: open }),
  setJianAutoCollapsed: (collapsed) => set({ jianAutoCollapsed: collapsed }),
  setPreviewOpen: (open) => set({ previewOpen: open }),
  setWritingMode: (enabled) => {
    set({ writingMode: enabled });
    try { localStorage.setItem(WRITING_MODE_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
  },
  setWelcomeVisible: (visible) => set({ welcomeVisible: visible }),
  setCurrentTab: (tab) => set({ currentTab: tab }),
  setActivePanel: (panel) => set({ activePanel: panel }),
  setChannelCreateOverlayVisible: (visible) => set({ channelCreateOverlayVisible: visible }),
  setAddMemberOverlayVisible: (visible) => set({ addMemberOverlayVisible: visible }),
  setAddMemberTargetChannel: (channelId) => set({ addMemberTargetChannel: channelId }),
  setAgentDiscoveryVisible: (visible) => set({ agentDiscoveryVisible: visible }),
  setDiscoveredAgents: (agents) => set({ discoveredAgents: agents }),
  setPendingConfirm: (confirm) => set({ pendingConfirm: confirm }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleJian: () => set((s) => ({ jianOpen: !s.jianOpen })),
});
