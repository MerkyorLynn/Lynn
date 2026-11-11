export type ThinkingLevel = "none" | "off" | "low" | "medium" | "high" | "xhigh" | "auto" | string;

export type Api = "openai-completions" | "openai-responses" | "anthropic-messages" | string;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mediaType?: string;
  mimeType?: string;
}

export type MessageContent = string | Array<TextContent | ImageContent | Record<string, unknown>>;

export type SessionMessageOrigin = "user_input" | "assistant" | "tool_result" | "synthetic" | "unknown";

export interface SessionFailureMetadata {
  isError?: boolean;
  exitCode?: number | null;
  errorType?: string;
  stderr?: string;
  stdout?: string;
  failureReason?: string;
}

export interface SessionMessageMetadata {
  origin?: SessionMessageOrigin;
  turnId?: string;
  toolRoundId?: string;
  failure?: SessionFailureMetadata;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: MessageContent;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatAssistantToolCall[];
  reasoning_content?: string;
}

export interface ChatAssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Model<TApi extends Api = Api> {
  provider: string;
  id: string;
  name?: string;
  api?: TApi;
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  vision?: boolean;
  reasoning?: boolean;
  compat?: Record<string, unknown>;
  quirks?: string[];
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResultContent {
  type: "text" | "image" | string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  content?: ToolResultContent[];
  isError?: boolean;
  details?: unknown;
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description?: string;
  parameters?: any;
  execute: (toolCallId: string, params: any, ...rest: any[]) => Promise<ToolResult>;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: any;
  execute?: (toolCallId: string, params: any, ...rest: any[]) => Promise<ToolResult> | ToolResult;
  [key: string]: unknown;
}

export interface LoadExtensionsResult {
  extensions: unknown[];
  diagnostics: unknown[];
}

export type AssistantMessageEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "toolcall_start"; toolCall: ToolCall }
  | { type: "toolcall_end"; toolCall: ToolCall }
  | { type: "error"; error: string };

export type AgentSessionEvent =
  | { type: "message_update"; role?: string; assistantMessageEvent?: AssistantMessageEvent; [key: string]: unknown }
  | { type: "message_end"; role?: string; [key: string]: unknown }
  | { type: "tool_execution_start"; toolName: string; toolCallId: string; args?: unknown; toolCall?: ToolCall; [key: string]: unknown }
  | { type: "tool_execution_end"; toolName: string; toolCallId: string; result?: unknown; isError?: boolean; args?: unknown; [key: string]: unknown }
  | { type: "agent_end"; [key: string]: unknown }
  | { type: "skill_activated"; [key: string]: unknown }
  | { type: "auto_compaction_end"; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface ResourceLoader {
  reload?: () => Promise<void> | void;
  getAppendSystemPrompt?: () => string | string[] | Promise<string | string[]>;
  getSystemPrompt?: () => string | string[] | Promise<string | string[]>;
  getSkills?: () => unknown[] | Promise<unknown[]>;
  [key: string]: unknown;
}

export interface AuthStorageLike {
  get?: (key: string) => Promise<unknown> | unknown;
  set?: (key: string, value: unknown) => Promise<void> | void;
  remove?: (key: string) => Promise<void> | void;
  delete?: (key: string) => Promise<void> | void;
  list?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  [key: string]: unknown;
}

export interface SettingsManagerLike {
  get?: (key: string, fallback?: unknown) => unknown;
  set?: (key: string, value: unknown) => void;
  [key: string]: unknown;
}

export interface PromptOptions {
  streamingBehavior?: "steer" | "followUp" | string;
  /** Internal one-turn override. It must never be persisted as the session model. */
  modelOverride?: Model;
  [key: string]: unknown;
}
