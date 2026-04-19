/**
 * chat-types.ts — 聊天消息数据模型
 *
 * 历史消息和流式消息共用同一套类型。
 * ContentBlock 按展示顺序排列（thinking → mood → tools → text → xing），
 * 不按流式到达顺序。
 */

import type { ComposerDraft, QuotedSelection } from './input-slice';

// ── 工具调用 ──

export interface ToolCallSummary {
  filePath?: string;
  linesAdded?: number;
  linesRemoved?: number;
  bytesWritten?: number;
  outputPreview?: string;
  command?: string;
  matchCount?: number;
  lineCount?: number;
  totalLines?: number;
  truncated?: boolean;
}

export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
  done: boolean;
  success: boolean;
  startedAt?: number;
  summary?: ToolCallSummary;
}

// ── 用户附件 ──

export interface PromptImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface UserAttachment {
  path: string;
  name: string;
  isDir: boolean;
  base64Data?: string;
  mimeType?: string;
}

export interface DeskContext {
  dir: string;
  fileCount: number;
}

export interface GitContext {
  repoName?: string | null;
  branch?: string | null;
  changedCount?: number | null;
}

export interface ReviewContextPack {
  request: string;
  workspacePath?: string;
  gitContext?: {
    sessionPath?: string | null;
    sessionFile?: string | null;
  } | null;
  sessionContext?: {
    userText?: string;
    assistantText?: string;
    toolUses?: Array<{ name: string; argsPreview?: string }>;
  } | null;
}

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  suggestion?: string;
  filePath?: string;
}

export interface StructuredReview {
  summary: string;
  verdict: 'pass' | 'concerns' | 'blocker';
  findings: ReviewFinding[];
  nextStep?: string;
  workflowGate: 'clear' | 'follow_up' | 'hold';
}

export interface ReviewFollowUpTaskState {
  taskId: string;
  title?: string | null;
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  resultSummary?: string | null;
  error?: string | null;
  updatedAt?: string | null;
}

// ── 内容块 ──

export type ContentBlock =
  | { type: 'thinking'; content: string; sealed: boolean }
  | { type: 'mood'; yuan: string; text: string }
  | { type: 'tool_group'; tools: ToolCall[]; collapsed: boolean }
  | { type: 'text'; html: string }
  | { type: 'xing'; title: string; content: string; sealed: boolean }
  | { type: 'file_output'; filePath: string; label: string; ext: string }
  | { type: 'file_diff'; filePath: string; diff: string; linesAdded: number; linesRemoved: number; rollbackId?: string }
  | { type: 'artifact'; artifactId: string; artifactType: string; title: string; content: string; language?: string }
  | { type: 'browser_screenshot'; base64: string; mimeType: string }
  | { type: 'skill'; skillName: string; skillFilePath: string }
  | { type: 'cron_confirm'; confirmId?: string; jobData: Record<string, unknown>; status: 'pending' | 'approved' | 'rejected' }
  | { type: 'settings_confirm'; confirmId: string; settingKey: string; cardType: 'toggle' | 'list' | 'text'; currentValue: string; proposedValue: string; options?: string[]; optionLabels?: Record<string, string>; label: string; description?: string; frontend?: boolean; status: 'pending' | 'confirmed' | 'rejected' | 'timeout' }
  | { type: 'tool_authorization'; confirmId: string; command: string; reason: string; description: string; category: string; identifier: string; trustedRoot?: string | null; status: 'pending' | 'confirmed' | 'rejected' }
  | {
      type: 'review';
      reviewId: string;
      reviewerName: string;
      reviewerAgent?: string;
      reviewerAgentName?: string;
      reviewerYuan?: string;
      reviewerHasAvatar?: boolean;
      reviewerModelLabel?: string | null;
      reviewerModelId?: string | null;
      reviewerModelProvider?: string | null;
      content: string;
      error?: string;
      status: 'loading' | 'done';
      stage?: 'packing_context' | 'reviewing' | 'structuring' | 'done';
      findingsCount?: number;
      verdict?: StructuredReview['verdict'];
      workflowGate?: StructuredReview['workflowGate'];
      structured?: StructuredReview | null;
      contextPack?: ReviewContextPack | null;
      followUpPrompt?: string | null;
      followUpTask?: ReviewFollowUpTaskState | null;
      fallbackNote?: string | null;
      errorCode?: string | null;
    };

// ── 消息 ──

export interface ChatMessage {
  id: string;              // 服务端返回的稳定 ID（JSONL 行号）
  role: 'user' | 'assistant';
  // User
  taskMode?: 'prompt' | 'steer';
  text?: string;
  textHtml?: string;
  quotedText?: string;
  quotedSelection?: QuotedSelection | null;
  attachments?: UserAttachment[];
  deskContext?: DeskContext | null;
  gitContext?: GitContext | null;
  requestText?: string;
  requestImages?: PromptImage[];
  retryDraft?: ComposerDraft | null;
  // Assistant
  blocks?: ContentBlock[];
  model?: string | null;  // [PROVIDER-BADGE v1] which provider actually answered (T1/T2/T3...)
  // 通用
  timestamp?: number;
}

// ── Virtuoso 列表项 ──

export type ChatListItem =
  | { type: 'message'; data: ChatMessage }
  | { type: 'compaction'; id: string; yuan: string };

// ── Per-session 消息状态 ──

export interface SessionMessages {
  items: ChatListItem[];
  hasMore: boolean;
  loadingMore: boolean;
  oldestId?: string;
}

// ── 流式缓冲（不入 Zustand） ──

export interface StreamBuffer {
  sessionPath: string;
  textAcc: string;
  thinkingAcc: string;
  moodAcc: string;
  moodYuan: string;
  xingAcc: string;
  xingTitle: string;
  inThinking: boolean;
  inMood: boolean;
  inXing: boolean;
  lastFlushTime: number;
}
