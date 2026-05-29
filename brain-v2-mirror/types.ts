export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type ProviderIdLiteral =
  | 'mimo'
  | 'apex-spark-i-balanced'
  | 'step-3.7-flash'
  | 'deepseek-chat'
  | 'deepseek-pro'
  | 'glm-5-turbo'
  | 'glm-coding';

export type ModelIdLiteral =
  | 'mimo-v2.5-pro'
  | 'mimo-v2.5'
  | 'mimo-v2-omni'
  | 'qwen36-35b-a3b-apex-mtp'
  | 'step-3.7-flash'   // StepFun 198B-MoE/11B-A vision-language, step_plan 端点
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | 'GLM-5-Turbo';

export type ProviderId = Brand<ProviderIdLiteral, 'ProviderId'>;
export type ModelId = Brand<ModelIdLiteral, 'ModelId'>;

export type WireName = 'mimo' | 'sglang' | 'openai' | 'openai-compat';

export interface ProviderCapability {
  vision: boolean;
  audio: boolean;
  video: boolean;
  tools: boolean;
  thinking: boolean;
  native_search: boolean;
}

export interface Provider {
  id: ProviderId;
  endpoint: string;
  apiKey: string;
  model: ModelId;
  capability: ProviderCapability;
  wire: WireName;
  cooldown_ms: number;
  health_path?: string;
  health_probe_ms?: number;
  default_thinking: boolean;
  authType?: 'none' | 'bearer';
  max_tokens?: number;
  temperature?: number;
}

export type FallbackReason = 'cooldown' | 'probe-failed' | 'probe-threw' | 'error' | 'empty';

export interface FallbackEntry {
  id: ProviderId;
  reason: FallbackReason;
}

export interface ChunkMeta {
  providerId: ProviderId;
  fallback_from?: FallbackEntry[];
}

export type ToolCallDelta = {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type StreamChunk =
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'tool_call_delta'; delta: ToolCallDelta[] }
  | { type: 'finish'; reason: string }
  | { type: 'tool_progress'; event: 'start' | 'end'; name: string; ms?: number; ok?: boolean }
  | { type: 'pre_search'; source: 'mimo'; query: string; hit: boolean; ms: number; cached: 'request' | 'lru' | null }
  | { type: 'audio_fallback'; source: string; transcripts: number; total: number; ms: number }
  | ({ type: 'error'; error: string } & Record<string, unknown>);

export interface HmacSignaturePayload {
  method?: string;
  pathname?: string;
  timestamp: number;
  nonce?: string;
  agentKey?: string;
}

export interface RouterRunOptions {
  messages?: ChatMessage[];
  tools?: ToolDefinition[] | null;
  capabilityRequired?: Partial<Pick<ProviderCapability, 'vision' | 'audio' | 'video'>>;
  signal?: AbortSignal;
  onChunk: (chunk: StreamChunk, meta: ChunkMeta) => void | Promise<void>;
  log?: LogFn;
  extraBody?: Record<string, unknown> | null;
  reasoningEffort?: string | null;
}

export interface RouterRunResult {
  ok: boolean;
  providerId: ProviderId | null;
  iterations: number;
  forwardedToClient?: boolean;
  clientToolCalls?: number;
  toolCalls?: ToolCall[];
  bufferedContentChunks?: StreamChunk[];
  bufferedFinishChunk?: Extract<StreamChunk, { type: 'finish' }>;
  hitMaxIterations?: boolean;
  error?: string;
}

export type LogFn = (level: string, message: string) => void;

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments?: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface WireAdapterOptions {
  provider: Provider;
  messages?: ChatMessage[];
  tools?: ToolDefinition[] | null;
  signal?: AbortSignal;
  log?: LogFn | null;
  extraBody?: Record<string, unknown> | null;
  reasoningEffort?: string | null;
}

export type WireAdapter = (options: WireAdapterOptions) => AsyncGenerator<StreamChunk>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

export function providerId<T extends ProviderIdLiteral>(id: T): ProviderId {
  return id as ProviderId;
}

export function modelId<T extends ModelIdLiteral>(id: T): ModelId {
  return id as unknown as ModelId;
}

export function envModel<T extends ModelIdLiteral>(key: string, fallback: T): ModelId {
  return (process.env[key] || fallback) as ModelId;
}
