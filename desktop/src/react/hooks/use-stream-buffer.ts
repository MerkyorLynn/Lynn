/**
 * StreamBufferManager — per-session 流式事件节流缓冲
 *
 * WS 事件到达时写入 buffer（纯 JS 对象，不触发 React），
 * 每 FLUSH_INTERVAL ms 批量 flush 到 Zustand store（过大会像「一顿一顿」，过小会加重 markdown-it 解析负担）。
 *
 * 设计为 singleton，不依赖 React 组件生命周期。
 * app-ws-shim 直接调用 streamBufferManager.handle(msg)。
 */

import type { ChatMessage, ContentBlock } from '../stores/chat-types';
import { useStore } from '../stores';
import { renderMarkdown } from '../utils/markdown';
import { cleanMoodText } from '../utils/message-parser';
// @ts-expect-error - shared JS module
import { sanitizeBrainIdentityDisclosureText } from '../../../../shared/brain-provider.js';
// @ts-expect-error - shared JS module
import { stripPseudoToolCallMarkup } from '../../../../shared/pseudo-tool-call.js';
import { normalizeReportResponseText } from '../../../../shared/report-normalizer.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 流式消息 handle(msg) 接收动态 JSON */

/** 主文本流式刷新间隔。配合轻量预览渲染，提高流式顺滑度并减少明显卡段。 */
const FLUSH_INTERVAL = 32;
/** 视觉打字机节奏：API 如果一次性吐大块文本，UI 仍按稳定节奏揭示。 */
const REVEAL_INTERVAL = 24;

interface Buffer {
  sessionPath: string;
  /** 网络侧已收到的完整文本。 */
  textAcc: string;
  /** UI 侧已经揭示的、清洗后的可见文本。 */
  visibleTextAcc: string;
  thinkingAcc: string;
  moodAcc: string;
  moodYuan: string;
  xingAcc: string;
  xingTitle: string;
  inThinking: boolean;
  inMood: boolean;
  inXing: boolean;
  lastFlushTime: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  revealTimer: ReturnType<typeof setTimeout> | null;
  /** 当前 turn 是否已追加了空 assistant message */
  messageAppended: boolean;
  lastRenderedText: string;
  lastRenderedHtml: string;
  lastRenderedFinalized: boolean;
  /** turn_end 已到达，等待 reveal 完成后再 finalize */
  pendingFinalize: boolean;
}

function createBuffer(sessionPath: string): Buffer {
  return {
    sessionPath,
    textAcc: '',
    visibleTextAcc: '',
    thinkingAcc: '',
    moodAcc: '',
    moodYuan: 'hanako',
    xingAcc: '',
    xingTitle: '',
    inThinking: false,
    inMood: false,
    inXing: false,
    lastFlushTime: 0,
    flushTimer: null,
    revealTimer: null,
    messageAppended: false,
    lastRenderedText: '',
    lastRenderedHtml: '',
    lastRenderedFinalized: false,
    pendingFinalize: false,
  };
}

function buildDisplayText(raw: string, finalizeText = false): string {
  const displayTextBase = sanitizeBrainIdentityDisclosureText(stripPseudoToolCallMarkup(
    raw.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, ''),
  ));
  return finalizeText ? normalizeReportResponseText(displayTextBase) : displayTextBase;
}

function revealStepSize(remaining: number): number {
  if (remaining > 6000) return 240;
  if (remaining > 2000) return 120;
  if (remaining > 600) return 60;
  if (remaining > 160) return 24;
  return 8;
}

function renderStreamingTextHtml(src: string): string {
  if (!src) return '';
  const escaped = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>') || '&nbsp;'}</p>`)
    .join('');
}

function resetBufferState(buf: Buffer): void {
  if (buf.revealTimer) {
    clearTimeout(buf.revealTimer);
    buf.revealTimer = null;
  }
  buf.textAcc = '';
  buf.visibleTextAcc = '';
  buf.thinkingAcc = '';
  buf.moodAcc = '';
  buf.xingAcc = '';
  buf.inThinking = false;
  buf.inMood = false;
  buf.inXing = false;
  buf.messageAppended = false;
  buf.lastRenderedText = '';
  buf.lastRenderedHtml = '';
  buf.lastRenderedFinalized = false;
  buf.pendingFinalize = false;
}

class StreamBufferManager {
  private buffers = new Map<string, Buffer>();

  /** 获取或创建 session buffer */
  private getBuffer(sessionPath: string): Buffer {
    let buf = this.buffers.get(sessionPath);
    if (!buf) {
      buf = createBuffer(sessionPath);
      this.buffers.set(sessionPath, buf);
    }
    return buf;
  }

  /** 确保 store 中已为该 session 追加了一条空 assistant message */
  private ensureMessage(buf: Buffer): void {
    if (buf.messageAppended) return;
    buf.messageAppended = true;

    const store = useStore.getState();
    const session = store.chatSessions[buf.sessionPath];
    if (!session) return; // session 未初始化（可能还没 loadMessages）

    const id = `stream-${Date.now()}`;
    const msg: ChatMessage = { id, role: 'assistant', blocks: [] };
    store.appendItem(buf.sessionPath, { type: 'message', data: msg });
  }

  /** 调度节流 flush */
  private scheduleFlush(buf: Buffer): void {
    const now = Date.now();
    if (now - buf.lastFlushTime >= FLUSH_INTERVAL) {
      this.flush(buf);
    } else if (!buf.flushTimer) {
      buf.flushTimer = setTimeout(() => {
        buf.flushTimer = null;
        this.flush(buf);
      }, FLUSH_INTERVAL - (now - buf.lastFlushTime));
    }
  }

  private cancelReveal(buf: Buffer): void {
    if (!buf.revealTimer) return;
    clearTimeout(buf.revealTimer);
    buf.revealTimer = null;
  }

  private revealTextStep(buf: Buffer): void {
    const targetText = buildDisplayText(buf.textAcc, false);

    if (!targetText) {
      if (buf.visibleTextAcc) {
        buf.visibleTextAcc = '';
        this.scheduleFlush(buf);
      }
      this.cancelReveal(buf);
      return;
    }

    if (!targetText.startsWith(buf.visibleTextAcc)) {
      const nextLength = Math.min(buf.visibleTextAcc.length, targetText.length);
      buf.visibleTextAcc = targetText.slice(0, nextLength);
    }

    const remaining = targetText.length - buf.visibleTextAcc.length;
    if (remaining <= 0) {
      this.cancelReveal(buf);
      // turn_end 已到达且 reveal 完成 → 执行延迟 finalize
      if (buf.pendingFinalize) {
        buf.pendingFinalize = false;
        this.flush(buf, true);
        resetBufferState(buf);
      }
      return;
    }

    const nextLength = buf.visibleTextAcc.length + Math.min(remaining, revealStepSize(remaining));
    buf.visibleTextAcc = targetText.slice(0, nextLength);
    this.scheduleFlush(buf);

    if (nextLength < targetText.length && !buf.revealTimer) {
      buf.revealTimer = setTimeout(() => {
        buf.revealTimer = null;
        this.revealTextStep(buf);
      }, REVEAL_INTERVAL);
    }
  }

  private drainText(buf: Buffer, finalizeText = false): void {
    this.cancelReveal(buf);
    buf.visibleTextAcc = buildDisplayText(buf.textAcc, finalizeText);
  }

  private flushBeforeStructuralBlock(buf: Buffer): void {
    this.drainText(buf, false);
    this.flush(buf);
  }

  /** 把 buffer 中累积的内容一次性 flush 到 Zustand */
  private flush(buf: Buffer, finalizeText = false): void {
    buf.lastFlushTime = Date.now();
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    if (finalizeText) this.drainText(buf, true);

    const store = useStore.getState();
    store.updateLastMessage(buf.sessionPath, (msg) => {
      const blocks = [...(msg.blocks || [])];

      // ── Thinking ──
      if (buf.thinkingAcc || buf.inThinking) {
        const idx = blocks.findIndex(b => b.type === 'thinking');
        const thinkingBlock: ContentBlock = {
          type: 'thinking',
          content: buf.thinkingAcc,
          sealed: !buf.inThinking,
        };
        if (idx >= 0) blocks[idx] = thinkingBlock;
        else blocks.unshift(thinkingBlock); // thinking 在最前面
      }

      // ── Mood ──
      if (buf.moodAcc || buf.inMood) {
        const idx = blocks.findIndex(b => b.type === 'mood');
        const moodBlock: ContentBlock = {
          type: 'mood',
          yuan: buf.moodYuan,
          text: buf.inMood ? buf.moodAcc : cleanMoodText(buf.moodAcc),
        };
        if (idx >= 0) blocks[idx] = moodBlock;
        else {
          // mood 在 thinking 后面
          const insertAt = blocks.findIndex(b => b.type !== 'thinking') ;
          blocks.splice(insertAt >= 0 ? insertAt : blocks.length, 0, moodBlock);
        }
      }

      // ── Text ──
      if (buf.visibleTextAcc) {
        const displayText = buf.visibleTextAcc;
        if (displayText !== buf.lastRenderedText || finalizeText !== buf.lastRenderedFinalized) {
          buf.lastRenderedText = displayText;
          buf.lastRenderedFinalized = finalizeText;
          buf.lastRenderedHtml = finalizeText
            ? renderMarkdown(displayText)
            : renderStreamingTextHtml(displayText);
        }
        const idx = blocks.findIndex(b => b.type === 'text');
        if (idx >= 0) {
          blocks[idx] = { type: 'text', html: buf.lastRenderedHtml };
        } else {
          blocks.push({ type: 'text', html: buf.lastRenderedHtml });
        }
      } else if (buf.lastRenderedText) {
        const idx = blocks.findIndex(b => b.type === 'text');
        if (idx >= 0) blocks.splice(idx, 1);
        buf.lastRenderedText = '';
        buf.lastRenderedHtml = '';
        buf.lastRenderedFinalized = finalizeText;
      }

      // ── Xing ──
      if (buf.xingAcc || buf.inXing) {
        const idx = blocks.findIndex(b => b.type === 'xing');
        const xingBlock: ContentBlock = {
          type: 'xing',
          title: buf.xingTitle,
          content: buf.xingAcc,
          sealed: !buf.inXing,
        };
        if (idx >= 0) blocks[idx] = xingBlock;
        else blocks.push(xingBlock);
      }

      return { ...msg, blocks };
    });
  }

  // ── 公开事件处理器 ──

  handle(msg: any): void {
    const sessionPath = msg.sessionPath || useStore.getState().currentSessionPath;
    if (!sessionPath) return;
    const buf = this.getBuffer(sessionPath);

    switch (msg.type) {
      case 'text_delta':
        this.ensureMessage(buf);
        buf.textAcc += msg.delta || '';
        this.revealTextStep(buf);
        break;

      case 'thinking_start':
        this.ensureMessage(buf);
        buf.inThinking = true;
        buf.thinkingAcc = '';
        this.flush(buf);
        break;

      case 'thinking_delta':
        buf.thinkingAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'thinking_end':
        buf.inThinking = false;
        this.flush(buf);
        break;

      case 'mood_start':
        this.ensureMessage(buf);
        buf.inMood = true;
        buf.moodAcc = '';
        buf.moodYuan = useStore.getState().agentYuan || 'hanako';
        this.flush(buf);
        break;

      case 'mood_text':
        buf.moodAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'mood_end':
        buf.inMood = false;
        this.flush(buf);
        break;

      case 'xing_start':
        this.ensureMessage(buf);
        buf.inXing = true;
        buf.xingAcc = '';
        buf.xingTitle = msg.title || (window.t?.('xing.title') || 'Reflection');
        this.flush(buf);
        break;

      case 'xing_text':
        buf.xingAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'xing_end':
        buf.inXing = false;
        this.flush(buf);
        break;

      case 'tool_start':
        this.ensureMessage(buf);
        // 工具事件频率低，直接写 store
        this.flushBeforeStructuralBlock(buf); // 先排空并 flush 文本
        useStore.getState().updateLastMessage(sessionPath, (m) => {
          const blocks = [...(m.blocks || [])];
          // 找最后一个 tool_group 或创建新的
          let lastTg = blocks.length - 1;
          while (lastTg >= 0 && blocks[lastTg].type !== 'tool_group') lastTg--;
          if (lastTg >= 0 && blocks[lastTg].type === 'tool_group') {
            const tg = blocks[lastTg] as Extract<ContentBlock, { type: 'tool_group' }>;
            // 如果上一个 group 里还有未完成的工具，追加到同一个 group
            if (tg.tools.some(t => !t.done)) {
              blocks[lastTg] = {
                ...tg,
                tools: [...tg.tools, { name: msg.name, args: msg.args, done: false, success: false, startedAt: Date.now() }],
              };
              return { ...m, blocks };
            }
          }
          // 新建 tool_group
          blocks.push({
            type: 'tool_group',
            tools: [{ name: msg.name, args: msg.args, done: false, success: false, startedAt: Date.now() }],
            collapsed: false,
          });
          return { ...m, blocks };
        });
        break;

      case 'tool_end':
        useStore.getState().updateLastMessage(sessionPath, (m) => {
          const blocks = [...(m.blocks || [])];
          // 从后往前找含该 tool 名且未 done 的
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].type !== 'tool_group') continue;
            const tg = blocks[i] as Extract<ContentBlock, { type: 'tool_group' }>;
            const toolIdx = tg.tools.findIndex(t => t.name === msg.name && !t.done);
            if (toolIdx >= 0) {
              const tools = [...tg.tools];
              tools[toolIdx] = { ...tools[toolIdx], done: true, success: !!msg.success, summary: msg.summary };
              const allDone = tools.every(t => t.done);
              blocks[i] = { ...tg, tools, collapsed: allDone && tools.length > 1 };
              return { ...m, blocks };
            }
          }
          return m;
        });
        break;

      case 'file_output':
        this.ensureMessage(buf);
        this.flushBeforeStructuralBlock(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'file_output', filePath: msg.filePath, label: msg.label, ext: msg.ext }],
        }));
        break;

      case 'file_diff':
        this.ensureMessage(buf);
        this.flushBeforeStructuralBlock(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), {
            type: 'file_diff',
            filePath: msg.filePath,
            diff: msg.diff,
            linesAdded: msg.linesAdded || 0,
            linesRemoved: msg.linesRemoved || 0,
            rollbackId: msg.rollbackId,
          }],
        }));
        break;

      case 'artifact':
        this.ensureMessage(buf);
        this.flushBeforeStructuralBlock(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), {
            type: 'artifact',
            artifactId: msg.artifactId || msg.id,
            artifactType: msg.artifactType || msg.type,
            title: msg.title || '',
            content: msg.content || '',
            language: msg.language,
          }],
        }));
        break;

      case 'browser_screenshot':
        this.ensureMessage(buf);
        this.flushBeforeStructuralBlock(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'browser_screenshot', base64: msg.base64, mimeType: msg.mimeType }],
        }));
        break;

      case 'skill_activated':
        this.ensureMessage(buf);
        this.flushBeforeStructuralBlock(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'skill', skillName: msg.skillName, skillFilePath: msg.skillFilePath }],
        }));
        break;

      case 'cron_confirmation':
        this.ensureMessage(buf);
        this.flushBeforeStructuralBlock(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'cron_confirm', confirmId: msg.confirmId, jobData: msg.jobData, status: 'pending' as const }],
        }));
        break;

      case 'settings_confirmation':
        this.ensureMessage(buf);
        this.flushBeforeStructuralBlock(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), {
            type: 'settings_confirm' as const,
            confirmId: msg.confirmId,
            settingKey: msg.settingKey,
            cardType: msg.cardType,
            currentValue: msg.currentValue,
            proposedValue: msg.proposedValue,
            options: msg.options,
            optionLabels: msg.optionLabels,
            label: msg.label,
            description: msg.description,
            frontend: msg.frontend,
            status: 'pending' as const,
          }],
        }));
        break;

      case 'tool_authorization':
        this.ensureMessage(buf);
        this.flushBeforeStructuralBlock(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), {
            type: 'tool_authorization' as const,
            confirmId: msg.confirmId,
            command: msg.command,
            reason: msg.reason,
            description: msg.description,
            category: msg.category,
            identifier: msg.identifier,
            trustedRoot: msg.trustedRoot || null,
            status: 'pending' as const,
          }],
        }));
        break;

      case 'compaction_start':
        break;

      case 'compaction_end':
        break;

      case 'turn_end': {
        const hasUnrevealedText = buf.textAcc && buf.visibleTextAcc.length < buildDisplayText(buf.textAcc, false).length;
        if (hasUnrevealedText && buf.revealTimer) {
          // reveal 动画仍在进行 → 延迟 finalize，让文字逐步展示完毕
          buf.pendingFinalize = true;
        } else {
          this.flush(buf, true);
          resetBufferState(buf);
        }
        break;
      }

      case 'turn_retry':
        if (buf.flushTimer) {
          clearTimeout(buf.flushTimer);
          buf.flushTimer = null;
        }
        useStore.setState((state) => {
          const chatSession = state.chatSessions[sessionPath];
          if (!chatSession?.items?.length) return state;
          const items = [...chatSession.items];
          const last = items[items.length - 1];
          if (last?.type !== 'message' || last.data.role !== 'assistant') return state;
          items.pop();
          return {
            chatSessions: {
              ...state.chatSessions,
              [sessionPath]: { ...chatSession, items },
            },
          };
        });
        resetBufferState(buf);
        break;
    }
  }

  /** 清理指定 session 的 buffer */
  clear(sessionPath: string): void {
    const buf = this.buffers.get(sessionPath);
    if (buf?.flushTimer) clearTimeout(buf.flushTimer);
    if (buf?.revealTimer) clearTimeout(buf.revealTimer);
    this.buffers.delete(sessionPath);
  }

  /** 清理所有 */
  clearAll(): void {
    for (const [, buf] of this.buffers) {
      if (buf.flushTimer) clearTimeout(buf.flushTimer);
      if (buf.revealTimer) clearTimeout(buf.revealTimer);
    }
    this.buffers.clear();
  }
}

/** 全局 singleton */
export const streamBufferManager = new StreamBufferManager();
