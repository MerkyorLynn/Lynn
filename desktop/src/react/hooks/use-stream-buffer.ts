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
import { getCachedRenderMarkdown, loadRenderMarkdown } from '../utils/markdown-loader';
import { cleanMoodText, sanitizeAssistantDisplayText } from '../utils/message-parser';
import { streamRenderInterval } from '../utils/stream-render-budget';

/* eslint-disable @typescript-eslint/no-explicit-any -- 流式消息 handle(msg) 接收动态 JSON */

/** 主文本流式刷新间隔。配合轻量预览渲染，提高流式顺滑度并减少明显卡段。 */

interface Buffer {
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
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** 当前 turn 是否已追加了空 assistant message */
  messageAppended: boolean;
  lastRenderedText: string;
  lastRenderedHtml: string;
  lastRenderedFinalized: boolean;
  markdownWarmupStarted: boolean;
  activeMessageId: string | null;
  streamId: string | null;
  lastEndedStreamId: string | null;
  pendingModelHint: string | null;
  pendingProviderRoute: ChatMessage['providerRoute'] | null;
}

function createBuffer(sessionPath: string): Buffer {
  return {
    sessionPath,
    textAcc: '',
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
    messageAppended: false,
    lastRenderedText: '',
    lastRenderedHtml: '',
    lastRenderedFinalized: false,
    markdownWarmupStarted: false,
    activeMessageId: null,
    streamId: null,
    lastEndedStreamId: null,
    pendingModelHint: null,
    pendingProviderRoute: null,
  };
}

function providerHopFromWire(raw: any): { id: string; reason?: string | null } | null {
  const id = String(raw?.id || raw?.provider || raw?.providerId || '').trim();
  if (!id) return null;
  const reason = raw?.reason == null ? null : String(raw.reason).trim().slice(0, 120);
  return reason ? { id, reason } : { id };
}

function providerRouteFromWire(msg: any): ChatMessage['providerRoute'] | null {
  const activeProvider = String(msg?.activeProvider || msg?.active_provider || '').trim();
  if (!activeProvider) return null;
  const rawFallback = Array.isArray(msg?.fallbackFrom)
    ? msg.fallbackFrom
    : (Array.isArray(msg?.fallback_from) ? msg.fallback_from : []);
  const fallbackFrom = rawFallback
    .map(providerHopFromWire)
    .filter(Boolean)
    .slice(0, 6) as NonNullable<ChatMessage['providerRoute']>['fallbackFrom'];
  return {
    activeProvider,
    ...(fallbackFrom && fallbackFrom.length > 0 ? { fallbackFrom } : {}),
    updatedAt: Date.now(),
  };
}

function renderStreamingTextHtml(src: string): string {
  if (!src) return '';
  // [2026-04-20 vertical-char-fix] 防御:streaming 时如果出现连续单字符行（sanitizeAssistantDisplayText
  // 剥离部分伪工具标签后可能留下这种模式），合并回正常行，避免每字符 <br> 产生竖排显示
  const compacted = src.replace(/(?:^|\n)(\S)\n(?=\S\n)/g, (_m, ch) => ch);
  const escaped = compacted
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
    const store = useStore.getState();
    const session = store.chatSessions[buf.sessionPath];
    if (!session) return; // session 未初始化（可能还没 loadMessages）
    buf.messageAppended = true;

    const id = `stream-${Date.now()}`;
    buf.activeMessageId = id;
    const currentModel = store.currentModel;
    const currentModelHint = currentModel?.id
      ? (currentModel.provider ? `${currentModel.provider}/${currentModel.id}` : currentModel.id)
      : null;
    const msg: ChatMessage = {
      id,
      role: 'assistant',
      blocks: [],
      // Snapshot the user-selected model at turn creation. A later server
      // model_hint can still override this when routing/fallback chooses a
      // different provider, but completed stream messages must not drift when
      // the user changes the selector afterward.
      model: buf.pendingModelHint || currentModelHint,
      providerRoute: buf.pendingProviderRoute || null,
    };
    store.appendItem(buf.sessionPath, { type: 'message', data: msg });
  }

  private updateActiveStreamingMessage(buf: Buffer, updater: (message: ChatMessage) => ChatMessage): boolean {
    if (!buf.messageAppended || !buf.activeMessageId) return false;
    const state = useStore.getState();
    const sess = state.chatSessions?.[buf.sessionPath];
    const items = sess?.items;
    if (!items || !items.length) return false;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (
        it?.type === 'message'
        && it.data?.role === 'assistant'
        && it.data.id === buf.activeMessageId
        && it.data.id.startsWith('stream-')
      ) {
        const nextItems = items.slice();
        nextItems[i] = { ...it, data: updater(it.data) };
        useStore.setState({
          chatSessions: { ...state.chatSessions, [buf.sessionPath]: { ...sess, items: nextItems } },
        });
        return true;
      }
    }
    return false;
  }

  private getActiveStreamingMessage(buf: Buffer): ChatMessage | null {
    if (!buf.messageAppended || !buf.activeMessageId) return null;
    const state = useStore.getState();
    const sess = state.chatSessions?.[buf.sessionPath];
    const items = sess?.items;
    if (!items || !items.length) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (
        it?.type === 'message'
        && it.data?.role === 'assistant'
        && it.data.id === buf.activeMessageId
        && it.data.id.startsWith('stream-')
      ) {
        return it.data;
      }
    }
    return null;
  }

  private updateStreamingMessage(buf: Buffer, updater: (message: ChatMessage) => ChatMessage): void {
    if (this.updateActiveStreamingMessage(buf, updater)) return;
    // Legacy fallback for very old stream events without an active id. Never use
    // this when an active stream id exists; updating "last message" is what let
    // a later tool row attach to a previous answer after abort/retry.
    if (buf.activeMessageId) return;
    useStore.getState().updateLastMessage(buf.sessionPath, (m) => (
      m.role === 'assistant' ? updater(m) : m
    ));
  }

  private resetTurnBuffer(buf: Buffer, nextStreamId: string | null = null): void {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    buf.textAcc = '';
    buf.thinkingAcc = '';
    buf.moodAcc = '';
    buf.xingAcc = '';
    buf.xingTitle = '';
    buf.inThinking = false;
    buf.inMood = false;
    buf.inXing = false;
    buf.messageAppended = false;
    buf.lastRenderedText = '';
    buf.lastRenderedHtml = '';
    buf.lastRenderedFinalized = false;
    buf.markdownWarmupStarted = false;
    buf.activeMessageId = null;
    buf.streamId = nextStreamId;
    buf.pendingModelHint = null;
    buf.pendingProviderRoute = null;
  }

  private bindIncomingStream(buf: Buffer, msg: any): boolean {
    const incoming = typeof msg?.streamId === 'string' && msg.streamId
      ? msg.streamId
      : null;
    if (!incoming) return true;
    if (!buf.messageAppended && buf.lastEndedStreamId === incoming) return false;
    if (!buf.streamId) {
      this.resetTurnBuffer(buf, incoming);
      return true;
    }
    if (buf.streamId === incoming) return true;
    // A new stream started in the same session. Reset local accumulators before
    // the first chunk so old text/tool state cannot bleed into the next turn.
    if (!buf.messageAppended || msg?.seq === 1 || msg?.type === 'text_delta' || msg?.type === 'tool_start' || msg?.type === 'tool_progress') {
      this.resetTurnBuffer(buf, incoming);
      return true;
    }
    return false;
  }

  /** 调度节流 flush */
  private scheduleFlush(buf: Buffer): void {
    const now = Date.now();
    const interval = streamRenderInterval(buf.textAcc.length);
    if (now - buf.lastFlushTime >= interval) {
      this.flush(buf);
    } else if (!buf.flushTimer) {
      buf.flushTimer = setTimeout(() => {
        buf.flushTimer = null;
        this.flush(buf);
      }, interval - (now - buf.lastFlushTime));
    }
  }

  /** 把 buffer 中累积的内容一次性 flush 到 Zustand */
  private flush(buf: Buffer, finalizeText = false): void {
    buf.lastFlushTime = Date.now();
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }

    const store = useStore.getState();
    let finalMarkdownRefresh: { sessionPath: string; text: string } | null = null;
    this.updateStreamingMessage(buf, (msg) => {
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
      if (buf.textAcc) {
        const displayText = sanitizeAssistantDisplayText(buf.textAcc);
        if (displayText !== buf.lastRenderedText || finalizeText !== buf.lastRenderedFinalized) {
          buf.lastRenderedText = displayText;
          buf.lastRenderedFinalized = finalizeText;
          const renderMarkdown = getCachedRenderMarkdown();
          if (renderMarkdown) {
            buf.lastRenderedHtml = renderMarkdown(displayText);
          } else {
            buf.lastRenderedHtml = renderStreamingTextHtml(displayText);
            if (finalizeText) {
              finalMarkdownRefresh = { sessionPath: buf.sessionPath, text: displayText };
            }
          }
        }
        const idx = blocks.findIndex(b => b.type === 'text');
        if (idx >= 0) {
          blocks[idx] = { type: 'text', html: buf.lastRenderedHtml, plainText: displayText };
        } else {
          blocks.push({ type: 'text', html: buf.lastRenderedHtml, plainText: displayText });
        }
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

    if (finalMarkdownRefresh) {
      const { sessionPath, text } = finalMarkdownRefresh;
      void loadRenderMarkdown()
        .then((renderMarkdown) => {
          const latestBuf = this.buffers.get(sessionPath);
          if (!latestBuf || sanitizeAssistantDisplayText(latestBuf.textAcc) !== text) return;
          const html = renderMarkdown(text);
          latestBuf.lastRenderedHtml = html;
          this.updateStreamingMessage(latestBuf, (msg) => ({
            ...msg,
            blocks: (msg.blocks || []).map((block) => (
              block.type === 'text' && block.plainText === text
                ? { ...block, html }
                : block
            )),
          }));
        })
        .catch((err) => {
          console.warn('[stream] final markdown render failed:', err);
        });
    }
  }

  // ── 公开事件处理器 ──

  handle(msg: any): void {
    const sessionPath = msg.sessionPath || useStore.getState().currentSessionPath;
    if (!sessionPath) return;
    const buf = this.getBuffer(sessionPath);
    if (!this.bindIncomingStream(buf, msg)) return;

    switch (msg.type) {
      case 'text_delta':
        this.ensureMessage(buf);
        buf.textAcc += msg.delta || '';
        if (!buf.markdownWarmupStarted) {
          buf.markdownWarmupStarted = true;
          const warmupSessionPath = buf.sessionPath;
          void loadRenderMarkdown()
            .then(() => {
              const latestBuf = this.buffers.get(warmupSessionPath);
              if (!latestBuf || latestBuf !== buf || !latestBuf.textAcc) return;
              latestBuf.lastRenderedText = '';
              this.flush(latestBuf);
            })
            .catch((err) => {
              console.warn('[stream] markdown warmup failed:', err);
            });
        }
        this.scheduleFlush(buf);
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
        this.flush(buf); // 先 flush 文本
        // [PROGRESS-UX v1] also surface to title bar
        useStore.setState({ currentActivity: msg.name || 'tool' });
        this.updateStreamingMessage(buf, (m) => {
          const blocks = [...(m.blocks || [])];
          // 找最后一个 tool_group 或创建新的
          let lastTg = blocks.length - 1;
          while (lastTg >= 0 && blocks[lastTg].type !== 'tool_group') lastTg--;
          if (lastTg >= 0 && blocks[lastTg].type === 'tool_group') {
            const tg = blocks[lastTg] as Extract<ContentBlock, { type: 'tool_group' }>;
            if (msg.toolCallId && tg.tools.some(t => t.toolCallId === msg.toolCallId)) return m;
            // 如果上一个 group 里还有未完成的工具，追加到同一个 group
            if (tg.tools.some(t => !t.done)) {
              blocks[lastTg] = {
                ...tg,
                tools: [...tg.tools, { name: msg.name, toolCallId: msg.toolCallId, args: msg.args, done: false, success: false, startedAt: Date.now() }],
              };
              return { ...m, blocks };
            }
          }
          // 新建 tool_group
          blocks.push({
            type: 'tool_group',
            tools: [{ name: msg.name, toolCallId: msg.toolCallId, args: msg.args, done: false, success: false, startedAt: Date.now() }],
            collapsed: false,
          });
          return { ...m, blocks };
        });
        break;

      case 'tool_end':
        // [PROGRESS-UX v1] clear activity if no other tool still running on this turn
        {
          const lastMsg = this.getActiveStreamingMessage(buf);
          // Determine if any other tool is still pending after this one closes
          let stillBusy = false;
          for (const b of (lastMsg?.blocks || [])) {
            if (b.type === 'tool_group') {
              for (const t of b.tools) {
                // Skip the one we're about to mark done
                if ((msg.toolCallId ? t.toolCallId === msg.toolCallId : t.name === msg.name) && !t.done) continue;
                if (!t.done) { stillBusy = true; break; }
              }
            }
            if (stillBusy) break;
          }
          if (!stillBusy) useStore.setState({ currentActivity: null });
        }
        this.updateStreamingMessage(buf, (m) => {
          const blocks = [...(m.blocks || [])];
          // 从后往前找含该 tool 名且未 done 的
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].type !== 'tool_group') continue;
            const tg = blocks[i] as Extract<ContentBlock, { type: 'tool_group' }>;
            const toolIdx = tg.tools.findIndex(t => (msg.toolCallId ? t.toolCallId === msg.toolCallId : t.name === msg.name) && !t.done);
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

      // [PROGRESS-UX v1] Brain-side tool progress (web_search/stock_market/weather/...)
      // Translate to the same tool_group block model that client-side tool_start/tool_end uses.
      case 'tool_progress': {
        this.ensureMessage(buf);
        this.flush(buf);
        const event = msg.event;
        const name = msg.name || 'tool';
        if (event === 'start') {
          this.updateStreamingMessage(buf, (m) => {
            const blocks = [...(m.blocks || [])];
            let lastTg = blocks.length - 1;
            while (lastTg >= 0 && blocks[lastTg].type !== 'tool_group') lastTg--;
            if (lastTg >= 0 && blocks[lastTg].type === 'tool_group') {
              const tg = blocks[lastTg] as Extract<ContentBlock, { type: 'tool_group' }>;
              if (tg.tools.some(t => t.name === name && !t.done)) return m;
              if (tg.tools.some(t => !t.done)) {
                blocks[lastTg] = {
                  ...tg,
                  tools: [...tg.tools, { name, args: undefined, done: false, success: false, startedAt: Date.now() }],
                };
                return { ...m, blocks };
              }
            }
            blocks.push({
              type: 'tool_group',
              tools: [{ name, args: undefined, done: false, success: false, startedAt: Date.now() }],
              collapsed: false,
            });
            return { ...m, blocks };
          });
          // Also surface to title bar via store activity
          useStore.setState({ currentActivity: name });
        } else if (event === 'end') {
          this.updateStreamingMessage(buf, (m) => {
            const blocks = [...(m.blocks || [])];
            for (let i = blocks.length - 1; i >= 0; i--) {
              if (blocks[i].type !== 'tool_group') continue;
              const tg = blocks[i] as Extract<ContentBlock, { type: 'tool_group' }>;
              const toolIdx = tg.tools.findIndex(t => t.name === name && !t.done);
              if (toolIdx >= 0) {
                const tools = [...tg.tools];
                tools[toolIdx] = { ...tools[toolIdx], done: true, success: !!msg.ok };
                const allDone = tools.every(t => t.done);
                blocks[i] = { ...tg, tools, collapsed: allDone && tools.length > 1 };
                return { ...m, blocks };
              }
            }
            return m;
          });
          // Clear activity if no other tool is still running
          const lastMsg = this.getActiveStreamingMessage(buf);
          const stillBusy = lastMsg?.blocks?.some(
            (b) => b.type === 'tool_group' && b.tools.some((t) => !t.done),
          );
          if (!stillBusy) useStore.setState({ currentActivity: null });
        }
        break;
      }

      case 'file_output':
        this.ensureMessage(buf);
        this.flush(buf);
        this.updateStreamingMessage(buf, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'file_output', filePath: msg.filePath, label: msg.label, ext: msg.ext, fileId: msg.fileId, sessionId: msg.sessionId, downloadUrl: msg.downloadUrl }],
        }));
        // 写作模式：通知预览面板
        if (msg.filePath) {
          window.dispatchEvent(new CustomEvent('hana-writing-file', { detail: { filePath: msg.filePath, type: 'output' } }));
        }
        break;

      case 'file_diff':
        this.ensureMessage(buf);
        this.flush(buf);
        this.updateStreamingMessage(buf, (m) => ({
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
        // 写作模式：通知预览面板刷新
        if (msg.filePath) {
          window.dispatchEvent(new CustomEvent('hana-writing-file', { detail: { filePath: msg.filePath, type: 'diff' } }));
        }
        break;

      case 'artifact':
        this.ensureMessage(buf);
        this.flush(buf);
        this.updateStreamingMessage(buf, (m) => ({
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
        this.flush(buf);
        this.updateStreamingMessage(buf, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'browser_screenshot', base64: msg.base64, mimeType: msg.mimeType }],
        }));
        break;

      case 'skill_activated':
        this.ensureMessage(buf);
        this.flush(buf);
        this.updateStreamingMessage(buf, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'skill', skillName: msg.skillName, skillFilePath: msg.skillFilePath }],
        }));
        break;

      case 'cron_confirmation':
        this.ensureMessage(buf);
        this.flush(buf);
        this.updateStreamingMessage(buf, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'cron_confirm', confirmId: msg.confirmId, jobData: msg.jobData, status: 'pending' as const }],
        }));
        break;

      case 'settings_confirmation':
        this.ensureMessage(buf);
        this.flush(buf);
        this.updateStreamingMessage(buf, (m) => ({
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
        this.flush(buf);
        this.updateStreamingMessage(buf, (m) => ({
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

      case 'model_hint':
        // [PROVIDER-BADGE v3] Only attach provider/model hints to the active streaming
        // message. Late follow-up hints must never rewrite completed history.
        if (msg.model) {
          try {
            const modelHint = String(msg.model);
            if (!buf.messageAppended || !buf.activeMessageId) {
              buf.pendingModelHint = modelHint;
              break;
            }
            this.updateActiveStreamingMessage(buf, (m) => ({ ...m, model: modelHint }));
          } catch { /* non-fatal */ }
        }
        break;

      case 'provider_meta': {
        const route = providerRouteFromWire(msg);
        if (!route) break;
        if (!buf.messageAppended || !buf.activeMessageId) {
          buf.pendingProviderRoute = route;
          break;
        }
        this.updateActiveStreamingMessage(buf, (m) => ({ ...m, providerRoute: route }));
        break;
      }

      case 'turn_end':
        {
          const endedStreamId = buf.streamId;
          const success = msg.ok !== false;
          const terminalSummary = String(msg.reason || msg.code || (success ? '' : 'Run ended before tool completion'));
          this.updateStreamingMessage(buf, (m) => ({
            ...m,
            blocks: (m.blocks || []).map((block) => {
              if (block.type !== 'tool_group' || block.tools.every((tool) => tool.done)) return block;
              const tools = block.tools.map((tool) => tool.done ? tool : {
                ...tool,
                done: true,
                success,
                ...(terminalSummary ? { summary: { outputPreview: terminalSummary } } : {}),
              });
              return { ...block, tools, collapsed: tools.length > 1 };
            }),
          }));
          this.flush(buf, true);
          this.resetTurnBuffer(buf, null);
          buf.lastEndedStreamId = endedStreamId;
        }
        // [PROGRESS-UX v1] clear title-bar activity on turn end
        useStore.setState({ currentActivity: null });
        break;
    }
  }

  /** 清理指定 session 的 buffer */
  clear(sessionPath: string): void {
    const buf = this.buffers.get(sessionPath);
    if (buf?.flushTimer) clearTimeout(buf.flushTimer);
    this.buffers.delete(sessionPath);
  }

  /** 清理所有 */
  clearAll(): void {
    for (const [, buf] of this.buffers) {
      if (buf.flushTimer) clearTimeout(buf.flushTimer);
    }
    this.buffers.clear();
  }
}

/** 全局 singleton */
export const streamBufferManager = new StreamBufferManager();
