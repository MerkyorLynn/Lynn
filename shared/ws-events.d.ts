export type ClientEventType =
  | 'abort'
  | 'compact'
  | 'context_usage'
  | 'prompt'
  | 'resume_stream'
  | 'steer'
  | 'toggle_plan_mode';

export type ReactChatEventType =
  | 'artifact'
  | 'browser_screenshot'
  | 'compaction_end'
  | 'compaction_start'
  | 'cron_confirmation'
  | 'file_diff'
  | 'file_output'
  | 'mood_end'
  | 'mood_start'
  | 'mood_text'
  | 'settings_confirmation'
  | 'skill_activated'
  | 'text_delta'
  | 'thinking_delta'
  | 'thinking_end'
  | 'thinking_start'
  | 'tool_authorization'
  | 'tool_end'
  | 'tool_progress'
  | 'tool_start'
  | 'turn_end'
  | 'xing_end'
  | 'xing_start'
  | 'xing_text';

export type ServerEventType =
  | ReactChatEventType
  | 'activity_update'
  | 'apply_frontend_setting'
  | 'bridge_message'
  | 'bridge_status'
  | 'browser_bg_status'
  | 'browser_status'
  | 'channel_archived'
  | 'channel_new_message'
  | 'confirmation_resolved'
  | 'context_usage'
  | 'desk_changed'
  | 'devlog'
  | 'dm_new_message'
  | 'error'
  | 'jian_update'
  | 'model_hint'
  | 'notification'
  | 'plan_mode'
  | 'review_progress'
  | 'review_result'
  | 'review_start'
  | 'security_mode'
  | 'session_relay'
  | 'session_title'
  | 'status'
  | 'steered'
  | 'stream_resume'
  | 'task_update'
  | 'turn_retry';

export interface ClientEvent {
  type: ClientEventType;
  [key: string]: unknown;
}

export interface ServerEvent {
  type: ServerEventType;
  sessionPath?: string;
  streamId?: string;
  seq?: number;
  [key: string]: unknown;
}

export const CLIENT_EVENT_TYPES: readonly ClientEventType[];
export const REACT_CHAT_EVENT_TYPES: readonly ReactChatEventType[];
export const SERVER_EVENT_TYPES: readonly ServerEventType[];
export const SERVER_EVENT_REQUIRED_FIELDS: Readonly<Record<ServerEventType, readonly string[]>>;
export const CLIENT_EVENT_REQUIRED_FIELDS: Readonly<Record<ClientEventType, readonly string[]>>;

export function isKnownServerEventType(type: unknown): type is ServerEventType;
export function isKnownClientEventType(type: unknown): type is ClientEventType;
export function isReactChatEventType(type: unknown): type is ReactChatEventType;
export function validateServerEvent(event: unknown): { ok: boolean; errors: string[] };
export function validateClientEvent(event: unknown): { ok: boolean; errors: string[] };
export function createWsProtocolSnapshot(): {
  clientEventTypes: readonly ClientEventType[];
  reactChatEventTypes: readonly ReactChatEventType[];
  serverEventTypes: readonly ServerEventType[];
  clientRequiredFields: Readonly<Record<ClientEventType, readonly string[]>>;
  serverRequiredFields: Readonly<Record<ServerEventType, readonly string[]>>;
};
