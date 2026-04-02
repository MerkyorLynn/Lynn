/**
 * history-builder.ts — 将 /api/sessions/messages 的 API 响应转换为 ChatListItem[]
 *
 * 替代 app-messages-shim.ts loadMessages() 中的 DOM 构建循环。
 */

import type { ChatMessage, ChatListItem, ContentBlock } from '../stores/chat-types';
import { parseMoodFromContent, parseXingFromContent, parseUserAttachments } from './message-parser';
import { renderMarkdown } from './markdown';

/* eslint-disable @typescript-eslint/no-explicit-any -- API 历史消息 JSON 结构动态，难以静态收窄 */

// ── API 响应类型 ──

export interface HistoryApiResponse {
  messages: Array<{
    id?: string;
    role: string;
    content: string;
    thinking?: string;
    toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
    images?: Array<{ data: string; mimeType: string }>;
  }>;
  fileOutputs?: Array<{
    afterIndex: number;
    files: Array<{ filePath: string; label: string; ext: string }>;
  }>;
  fileDiffs?: Array<{
    afterIndex: number;
    filePath: string;
    diff: string;
    linesAdded: number;
    linesRemoved: number;
    rollbackId?: string;
  }>;
  artifacts?: Array<{
    afterIndex: number;
    artifactId: string;
    artifactType: string;
    title: string;
    content: string;
    language?: string;
  }>;
  todos?: any[];
  hasMore?: boolean;
}

// ── 构建 ──

export function buildItemsFromHistory(data: HistoryApiResponse): ChatListItem[] {
  const items: ChatListItem[] = [];

  // 按 afterIndex 分组 fileOutputs 和 artifacts
  const fileMap: Record<number, Array<{ filePath: string; label: string; ext: string }>> = {};
  const diffMap: Record<number, Array<{ filePath: string; diff: string; linesAdded: number; linesRemoved: number; rollbackId?: string }>> = {};
  const artMap: Record<number, Array<{ artifactId: string; artifactType: string; title: string; content: string; language?: string }>> = {};

  for (const fo of (data.fileOutputs || [])) {
    (fileMap[fo.afterIndex] ??= []).push(...fo.files);
  }
  for (const fd of (data.fileDiffs || [])) {
    (diffMap[fd.afterIndex] ??= []).push(fd);
  }
  for (const ar of (data.artifacts || [])) {
    (artMap[ar.afterIndex] ??= []).push(ar);
  }

  for (let i = 0; i < data.messages.length; i++) {
    const m = data.messages[i];
    const id = m.id || `hist-${i}`;

    if (m.role === 'user') {
      // strip steer 前缀（内部标记，不应展示给用户）
      const rawContent = (m.content || '').replace(/^（插话，无需 MOOD）\n?/, '');
      const { text, files, deskContext, quotedText } = parseUserAttachments(rawContent);
      const requestText = rawContent || text;
      const fileAtts = files.map(f => ({
        path: f.path,
        name: f.name,
        isDir: f.isDirectory,
      }));
      const imageAtts = (m.images || []).map((img, idx) => ({
        path: `image-${idx}`,
        name: `image-${idx}.${(img.mimeType || 'image/png').split('/')[1] || 'png'}`,
        isDir: false,
        base64Data: img.data,
        mimeType: img.mimeType,
      }));
      const allAtts = [...fileAtts, ...imageAtts];
      const msg: ChatMessage = {
        id,
        role: 'user',
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
        attachments: allAtts.length ? allAtts : undefined,
        deskContext: deskContext || undefined,
        quotedText: quotedText || undefined,
        requestText: requestText || undefined,
        requestImages: m.images?.length ? m.images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType })) : undefined,
      };
      items.push({ type: 'message', data: msg });
    } else if (m.role === 'assistant') {
      const blocks: ContentBlock[] = [];

      // 1. Thinking
      if (m.thinking) {
        blocks.push({ type: 'thinking', content: m.thinking, sealed: true });
      }

      // 2. Mood + 主文本
      const { mood, yuan, text: afterMood } = parseMoodFromContent(m.content);
      if (mood && yuan) {
        blocks.push({ type: 'mood', yuan, text: mood });
      }

      // 3. Tool calls
      if (m.toolCalls?.length) {
        // 分离确认类工具和普通工具
        const normalTools = [];
        for (const tc of m.toolCalls) {
          if (tc.name === 'update_settings' && tc.args) {
            const a = tc.args as Record<string, string>;
            // 仅 apply 调用（或旧格式无 action）重建卡片，search 调用跳过
            if (a.action === 'apply' || (!a.action && a.key && a.value)) {
              blocks.push({
                type: 'settings_confirm',
                confirmId: '',
                settingKey: a.key || '',
                cardType: (a.key === 'sandbox' || a.key === 'memory.enabled' ? 'toggle' : 'list') as any,
                currentValue: '',
                proposedValue: a.value || '',
                label: a.key || '',
                status: 'confirmed',
              } as any);
            } else {
              normalTools.push(tc);
            }
          } else if (tc.name === 'cron' && tc.args && (tc.args as any).action === 'add') {
            // 重建 cron 确认卡片（已完成状态）
            const a = tc.args as Record<string, any>;
            blocks.push({
              type: 'cron_confirm',
              jobData: { type: a.type, schedule: a.schedule, prompt: a.prompt, label: a.label },
              status: 'approved',
            } as any);
          } else {
            normalTools.push(tc);
          }
        }
        if (normalTools.length) {
          blocks.push({
            type: 'tool_group',
            tools: normalTools.map(tc => ({
              name: tc.name,
              args: tc.args,
              done: true,
              success: true,
            })),
            collapsed: normalTools.length > 1,
          });
        }
      }

      // 4. 主文本（去掉 mood 和 xing 后的内容）
      const { xingBlocks, text: mainText } = parseXingFromContent(afterMood);
      if (mainText) {
        blocks.push({ type: 'text', html: renderMarkdown(mainText) });
      }

      // 5. Xing
      for (const xb of xingBlocks) {
        blocks.push({ type: 'xing', title: xb.title, content: xb.content, sealed: true });
      }

      // 6. 跟在这条消息后面的 file outputs
      const files = fileMap[i];
      if (files) {
        for (const f of files) {
          blocks.push({ type: 'file_output', filePath: f.filePath, label: f.label, ext: f.ext });
        }
      }

      // 7. 跟在这条消息后面的 file diffs
      const diffs = diffMap[i];
      if (diffs) {
        for (const d of diffs) {
          blocks.push({
            type: 'file_diff',
            filePath: d.filePath,
            diff: d.diff,
            linesAdded: d.linesAdded,
            linesRemoved: d.linesRemoved,
            rollbackId: d.rollbackId,
          });
        }
      }

      // 8. 跟在这条消息后面的 artifacts
      const arts = artMap[i];
      if (arts) {
        for (const a of arts) {
          blocks.push({
            type: 'artifact',
            artifactId: a.artifactId,
            artifactType: a.artifactType,
            title: a.title,
            content: a.content,
            language: a.language,
          });
        }
      }

      const msg: ChatMessage = { id, role: 'assistant', blocks };
      items.push({ type: 'message', data: msg });
    }
  }

  return items;
}
