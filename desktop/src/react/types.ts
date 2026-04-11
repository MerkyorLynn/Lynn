// ── Auto-update ──

export interface AutoUpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'latest';
  version: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
  progress: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  } | null;
  error: string | null;
}

// ── 核心数据结构 ──

export interface Session {
  path: string;
  title: string | null;
  firstMessage: string;
  modified: string;
  messageCount: number;
  agentId: string | null;
  agentName: string | null;
  cwd: string | null;
  modelId?: string | null;
  modelProvider?: string | null;
  pinned?: boolean;
  labels?: string[];
  _optimistic?: boolean;
}

/** Bridge session (IM fixed channel) shown in sidebar */
export interface BridgeSession {
  sessionKey: string;
  platform: 'telegram' | 'feishu' | 'qq' | 'wechat';
  chatType: string;
  chatId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isOwner: boolean;
  lastActive: number | null;
  file: string;
}

export interface Agent {
  id: string;
  name: string;
  yuan: string;
  tier?: 'local' | 'expert' | 'byok';
  expertSlug?: string | null;
  isPrimary: boolean;
  hasAvatar?: boolean;
}

export interface ReviewCandidate {
  id: string;
  name: string;
  displayName?: string;
  yuan: 'hanako' | 'butter';
  hasAvatar?: boolean;
  modelId?: string | null;
  modelProvider?: string | null;
  isCurrent?: boolean;
}

export interface ReviewConfig {
  defaultReviewer: 'hanako' | 'butter';
  hanakoReviewerId: string | null;
  butterReviewerId: string | null;
  candidates: {
    hanako: ReviewCandidate[];
    butter: ReviewCandidate[];
  };
  resolvedReviewer: (ReviewCandidate & { reviewerName?: string }) | null;
}

export interface SessionStream {
  streamId: string | null;
  lastSeq: number;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  isCurrent?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

// ── Expert 类型 ──

export interface ExpertPreset {
  slug: string;
  name: string | Record<string, string>;
  nameI18n?: Record<string, string>;
  icon: string;
  avatarUrl?: string;
  category: string;
  tier: 'expert';
  model_binding: {
    preferred: string | { id: string; provider?: string };
    fallback: string | { id: string; provider?: string };
  };
  credit_cost: {
    per_session: number;
    per_extra_round: number;
  };
  skills: string[];
  description: string | Record<string, string>;
  descriptionI18n?: Record<string, string>;
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  members: string[];
  lastMessage: string;
  lastSender: string;
  lastTimestamp: string;
  newMessageCount: number;
  archived?: boolean;
  archivedAt?: string;
  isDM?: boolean;
  peerId?: string;
  peerName?: string;
}

export interface ChannelMessage {
  sender: string;
  timestamp: string;
  body: string;
}

export interface Activity {
  id: string;
  type: string;
  title: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface TaskRuntimeSnapshotItem {
  id: string;
  title: string;
  status: string;
  currentLabel?: string | null;
  snapshot?: Record<string, unknown> | null;
}

export interface TaskRuntimeSnapshot {
  activeCount: number;
  waitingApprovalCount: number;
  runningCount: number;
  pendingCount: number;
  recent: TaskRuntimeSnapshotItem[];
}

export interface CapabilitySnapshot {
  enabledSkills: number;
  learnedSkills: number;
  externalSkills: number;
  mcp: {
    servers: number;
    tools: number;
  };
  projectInstructions: {
    layers: number;
    files: string[];
  };
}

export interface Artifact {
  id: string;
  type: string;
  title: string;
  content: string;
  language?: string | null;
  filePath?: string;
  ext?: string;
  previewOnly?: boolean;
}

export interface DeskFile {
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

export interface SessionAgent {
  name: string;
  yuan: string;
  avatarUrl: string | null;
}

// ── 浮动面板类型 ──
export type ActivePanel = 'activity' | 'automation' | 'bridge' | 'changes' | null;
export type TabType = 'chat' | 'channels';

// ── Platform API 类型声明 ──
export interface SettingsNavigationTarget {
  tab?: string;
  providerId?: string | null;
  resetProviderSelection?: boolean;
  agentId?: string | null;
  resetAgentSelection?: boolean;
  reviewerKind?: 'hanako' | 'butter' | null;
}

export type NotificationPermissionStatus = 'granted' | 'denied' | 'not-determined' | 'unsupported';

export interface PlatformApi {
  getServerPort(): Promise<string>;
  getServerToken(): Promise<string>;
  openSettings(target?: string | SettingsNavigationTarget): void;
  getInitialSettingsNavigationTarget?(): Promise<SettingsNavigationTarget | null>;
  openBrowserViewer(url?: string, theme?: string): void;
  openHtmlInBrowser(html: string, title?: string): Promise<void>;
  selectFolder(): Promise<string | null>;
  getOnboardingDefaults?(): Promise<{ workspacePath: string; trustedRoots: string[]; installRoot?: string | null; desktopRoot?: string | null }>;
  selectSkill(): Promise<string | null>;
  readFile(path: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  watchFile(filePath: string): Promise<boolean>;
  unwatchFile(filePath: string): Promise<boolean>;
  onFileChanged(callback: (filePath: string) => void): void;
  readFileBase64(path: string): Promise<string | null>;
  readDocxHtml(path: string): Promise<string | null>;
  readXlsxHtml(path: string): Promise<string | null>;
  openEditorWindow(data: { filePath: string; title: string; type: string; language?: string | null }): void;
  onEditorDockFile?(callback: (data: { filePath: string; title: string; type: string; language?: string | null }) => void): void;
  onEditorDetached?(callback: (detached: boolean) => void): void;
  openFolder(path: string): void;
  openFile(path: string): void;
  openExternal(url: string): void;
  showInFinder(path: string): void;
  saveFileDialog?(opts: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  browserEmergencyStop?(): void;
  openSkillViewer?(opts: { skillPath?: string; name?: string; baseDir?: string; filePath?: string; installed?: boolean }): void;
  settingsChanged(event: string, payload?: unknown): void;
  onSettingsChanged(callback: (event: string, payload: unknown) => void): (() => void) | void;
  onSwitchTab?(callback: (target: string | SettingsNavigationTarget) => void): (() => void) | void;
  onServerRestarted?(callback: (data: { port: number; token: string }) => void): void;
  getFilePath?(file: File): Promise<string | null>;
  startDrag?(filePaths: string | string[]): void;
  appReady(): void;

  // ── Window controls (Windows/Linux) ──
  getPlatform?(): Promise<string>;
  windowMinimize?(): void;
  windowMaximize?(): void;
  windowClose?(): void;
  windowIsMaximized?(): Promise<boolean>;
  onMaximizeChange?(callback: (maximized: boolean) => void): void;

  // ── Browser viewer ──
  updateBrowserViewer?(data: { running?: boolean; url?: string | null; thumbnail?: string | null }): void;
  onBrowserUpdate?(callback: (data: { title?: string; canGoBack?: boolean; canGoForward?: boolean; running?: boolean }) => void): void;
  closeBrowserViewer?(): void;
  closeBrowser?(): void;
  browserGoBack?(): void;
  browserGoForward?(): void;
  browserReload?(): void;

  // ── Skill viewer (preload) ──
  listSkillFiles?(baseDir: string): Promise<unknown[]>;
  readSkillFile?(filePath: string): Promise<string | null>;

  // ── Splash / Onboarding ──
  getAvatarPath?(role: string): Promise<string | null>;
  getSplashInfo?(): Promise<{ agentName?: string; locale?: string; yuan?: string } | null>;
  onboardingComplete?(): Promise<boolean | void>;

  // ── Notification / confirm ──
  showNotification?(title: string, body: string): void;
  getNotificationPermissionStatus?(): Promise<NotificationPermissionStatus>;
  requestNotificationPermission?(): Promise<NotificationPermissionStatus>;
  confirmAction?(opts: { title?: string; message: string; detail?: string; confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger' }): Promise<boolean>;
  onConfirmActionRequest?(callback: (payload: { requestId: string; title?: string; message: string; detail?: string; confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger' }) => void): (() => void) | void;
  respondConfirmAction?(requestId: string, approved: boolean): void;
  onGlobalSummon?(callback: () => void): (() => void) | void;

  // ── App info ──
  getAppVersion?(): Promise<string>;
  checkUpdate?(): Promise<{ version: string; downloadUrl: string } | null>;

  // ── Auto-update (Windows) ──
  autoUpdateCheck?(): Promise<string | null>;
  autoUpdateDownload?(): Promise<boolean>;
  autoUpdateInstall?(): void;
  autoUpdateState?(): Promise<AutoUpdateState>;
  autoUpdateSetChannel?(channel: 'stable' | 'beta'): Promise<void>;
  onAutoUpdateState?(callback: (state: AutoUpdateState) => void): (() => void) | void;

  // ── Skill viewer overlay ──
  onShowSkillViewer?(callback: (data: unknown) => void): void;

  // ── Inter-window communication ──
  notifyMainWindow?(event: string, payload?: unknown): void;

  [key: string]: unknown;
}
