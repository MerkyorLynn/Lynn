import { createHash } from 'node:crypto';
import type { ToolCall } from './types.js';

export type ToolStormConfig = {
  enabled: boolean;
  threshold: number;
  windowSize: number;
  maxStorms: number;
};

export type ToolStormEntry = {
  signature: string;
  toolName: string;
};

export type ToolStormState = {
  history: ToolStormEntry[];
  stormCount: number;
};

export type ToolStormVerdict = {
  storm: boolean;
  signature: string;
  toolName: string;
  seen: number;
  stormCount: number;
  maxStormsReached: boolean;
};

const DEFAULT_CONFIG: ToolStormConfig = {
  enabled: false,
  threshold: 2,
  windowSize: 3,
  maxStorms: 3,
};

function envFlag(name: string): boolean {
  const value = String(process.env[name] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((key) => (
    JSON.stringify(key) + ':' + stableStringify(obj[key])
  )).join(',') + '}';
}

function normalizeArgs(args: unknown): string {
  if (typeof args !== 'string') return stableStringify(args ?? {});
  const trimmed = args.trim();
  if (!trimmed) return '{}';
  try {
    return stableStringify(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

export function readToolStormConfigFromEnv(): ToolStormConfig {
  return {
    enabled: envFlag('BRAIN_V2_STORM_DETECT'),
    threshold: positiveInt(process.env.BRAIN_V2_STORM_THRESHOLD, DEFAULT_CONFIG.threshold),
    windowSize: positiveInt(process.env.BRAIN_V2_STORM_WINDOW, DEFAULT_CONFIG.windowSize),
    maxStorms: positiveInt(process.env.BRAIN_V2_STORM_MAX, DEFAULT_CONFIG.maxStorms),
  };
}

export function createToolStormState(): ToolStormState {
  return { history: [], stormCount: 0 };
}

export function toolCallSignature(toolName: string, args: unknown): string {
  const normalized = `${toolName}\n${normalizeArgs(args)}`;
  return createHash('sha256').update(normalized).digest('hex');
}

export function observeToolCallStorm(
  state: ToolStormState,
  toolCall: ToolCall,
  config: ToolStormConfig = readToolStormConfigFromEnv(),
): ToolStormVerdict {
  const toolName = toolCall.function?.name || '';
  const signature = toolCallSignature(toolName, toolCall.function?.arguments || '{}');
  const recent = state.history.slice(-config.windowSize);
  const seenBefore = recent.filter((entry) => entry.signature === signature).length;
  const seen = seenBefore + 1;
  const storm = !!config.enabled && seen >= config.threshold;

  state.history.push({ signature, toolName });
  if (state.history.length > config.windowSize) {
    state.history.splice(0, state.history.length - config.windowSize);
  }
  if (storm) state.stormCount += 1;

  return {
    storm,
    signature,
    toolName,
    seen,
    stormCount: state.stormCount,
    maxStormsReached: storm && state.stormCount >= config.maxStorms,
  };
}

export function buildToolStormReflection(verdict: ToolStormVerdict): string {
  return JSON.stringify({
    ok: false,
    error: 'tool_call_storm_suppressed',
    tool: verdict.toolName,
    repeat_count: verdict.seen,
    message: 'The same server-side tool was requested repeatedly with identical arguments. Do not call it again unless the arguments change; summarize or answer from the existing tool result instead.',
  });
}
