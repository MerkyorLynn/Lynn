/**
 * Settings window Zustand store
 * 独立于主窗口 store，设置窗口有自己的 BrowserWindow + JS context
 */
import { create } from 'zustand';

export interface Agent {
  id: string;
  name: string;
  yuan: string;
  tier?: string;
  isPrimary: boolean;
  hasAvatar?: boolean;
}

export interface SkillInfo {
  name: string;
  description?: string;
  enabled: boolean;
  hidden?: boolean;
  baseDir?: string;
  filePath?: string;
  source?: string;
  externalLabel?: string | null;
  externalPath?: string | null;
  readonly?: boolean;
}

export interface ProviderSummary {
  type: 'api-key' | 'oauth' | 'none';
  display_name: string;
  base_url: string;
  api: string;
  api_key: string;
  models: string[];
  custom_models: string[];
  has_credentials: boolean;
  logged_in?: boolean;
  supports_oauth: boolean;
  is_coding_plan?: boolean;
  can_delete: boolean;
}

export interface ProviderConfig extends Record<string, unknown> {
  models?: string[];
  base_url?: string;
  api_key?: string;
  api?: string;
  provider?: string;
}

export interface ModelRefConfig extends Record<string, unknown> {
  id?: string;
  provider?: string;
}

export interface AgentConfig extends Record<string, unknown> {
  name?: string;
  yuan?: string;
  tier?: string;
  enabled?: boolean;
}

export interface VoiceProviderConfig extends Record<string, unknown> {
  provider?: string;
  api_key?: string;
  base_url?: string;
  default_voice?: string;
}

export interface SettingsConfig extends Record<string, unknown> {
  locale?: string;
  agent?: AgentConfig;
  _identity?: string;
  _ishiki?: string;
  _experience?: string;
  _userProfile?: string;
  appearance?: Record<string, unknown> & {
    theme?: string;
    font_serif?: boolean;
  };
  providers?: Record<string, ProviderConfig>;
  models?: Record<string, unknown> & {
    overrides?: Record<string, Record<string, unknown>>;
    chat?: string | ModelRefConfig;
    utility?: string | ModelRefConfig;
    utility_large?: string | ModelRefConfig;
  };
  api?: Record<string, unknown> & { provider?: string };
  desk?: Record<string, unknown> & {
    home_folder?: string | null;
    trusted_roots?: string[];
    heartbeat_enabled?: boolean;
    heartbeat_interval?: number;
    cron_auto_approve?: boolean;
  };
  memory?: Record<string, unknown> & { enabled?: boolean };
  skills?: Record<string, unknown> & { learn_skills?: boolean };
  capabilities?: Record<string, unknown> & {
    learn_skills?: {
      enabled?: boolean;
      allow_github_fetch?: boolean;
      safety_review?: boolean;
    };
  };
  user?: { name?: string };
  timezone?: string;
  voice?: Record<string, unknown> & {
    language?: string;
    asr?: VoiceProviderConfig;
    tts?: VoiceProviderConfig;
  };
}

export interface GlobalModelsConfig extends Record<string, unknown> {
  models?: Record<string, string | ModelRefConfig | undefined>;
  search?: ProviderConfig;
}

export interface SettingsState {
  // connection
  serverPort: number | null;
  serverToken: string | null;

  // agents
  agents: Agent[];
  currentAgentId: string | null;
  settingsAgentId: string | null;
  agentName: string;
  userName: string;
  agentYuan: string;
  agentAvatarUrl: string | null;
  userAvatarUrl: string | null;

  // config
  settingsConfig: SettingsConfig | null;
  settingsConfigAgentId: string | null;
  globalModelsConfig: GlobalModelsConfig | null;
  homeFolder: string | null;
  trustedRoots: string[];

  // ui
  activeTab: string;
  pendingReviewerKind: 'hanako' | 'butter' | null;
  ready: boolean;

  // pins
  currentPins: string[];

  // providers (unified)
  providersSummary: Record<string, ProviderSummary>;
  selectedProviderId: string | null;
  preferredProviderId: string | null;

  // skills
  skillsList: SkillInfo[];

  // toast
  toastMessage: string;
  toastType: 'success' | 'error' | 'info' | '';
  toastVisible: boolean;
}

export interface SettingsActions {
  set: (partial: Partial<SettingsState>) => void;
  getSettingsAgentId: () => string | null;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export type SettingsStore = SettingsState & SettingsActions;

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  // connection
  serverPort: null,
  serverToken: null,

  // agents
  agents: [],
  currentAgentId: null,
  settingsAgentId: null,
  agentName: 'Lynn',
  userName: 'User',
  agentYuan: 'hanako',
  agentAvatarUrl: null,
  userAvatarUrl: null,

  // config
  settingsConfig: null,
  settingsConfigAgentId: null,
  globalModelsConfig: null,
  homeFolder: null,
  trustedRoots: [],

  // ui
  activeTab: 'agent',
  pendingReviewerKind: null,
  ready: false,

  // pins
  currentPins: [],

  // providers (unified)
  providersSummary: {},
  selectedProviderId: null,
  preferredProviderId: null,

  // skills
  skillsList: [],

  // toast
  toastMessage: '',
  toastType: '',
  toastVisible: false,

  // actions
  set: (partial) => set(partial),

  getSettingsAgentId: () => {
    const { settingsAgentId, currentAgentId } = get();
    return settingsAgentId || currentAgentId;
  },

  showToast: (message, type) => {
    if (_toastTimer) clearTimeout(_toastTimer);
    set({ toastMessage: message, toastType: type, toastVisible: true });
    _toastTimer = setTimeout(() => {
      set({ toastVisible: false });
    }, 1500);
  },
}));
