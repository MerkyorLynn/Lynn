import { useEffect, type RefObject } from 'react';
import { useStore } from '../../stores';
import { isChineseLocale } from '../../utils/locale';

/** Inline zh/en picker for copy that ships near this module. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);

import { submitPromptTask } from '../../stores/prompt-actions';
import type { ComposerInsertMode } from './composer-text';
import {
  buildRunCommandPrompt,
  deriveRunRisk,
  runRiskLabel,
} from './run-risk';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface ComposerInsertOptions {
  mode?: ComposerInsertMode;
  appendSpacer?: boolean;
}

interface PendingConfirmPayload {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: 'danger' | 'default';
  onConfirm: () => Promise<void>;
}

interface UseInputEventBridgeArgs {
  deskBasePath: string | null | undefined;
  deskCurrentPath: string | null | undefined;
  securityMode: string;
  selectedFolder: string | null | undefined;
  setComposerTextFromEvent: (text: string, options?: ComposerInsertOptions) => void;
  setEditResendTarget: (messageId: string | null) => void;
  setInlineNotice: (value: string | null) => void;
  setPendingConfirm: (payload: PendingConfirmPayload) => void;
  t: Translate;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useInputEventBridge({
  deskBasePath,
  deskCurrentPath,
  securityMode,
  selectedFolder,
  setComposerTextFromEvent,
  setEditResendTarget,
  setInlineNotice,
  setPendingConfirm,
  t,
  textareaRef,
}: UseInputEventBridgeArgs) {
  useEffect(() => {
    const handlePasteToInput = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; editResend?: boolean; messageId?: string }>).detail || {};
      const current = textareaRef.current?.value ?? useStore.getState().composerText;
      const editResend = !!detail.editResend;
      setEditResendTarget(editResend && detail.messageId ? String(detail.messageId) : null);
      if (editResend && current.trim() && current.trim() !== String(detail.text || '').trim()) {
        useStore.getState().addToast?.(
          D('已用上一条消息替换当前输入。', 'The current draft was replaced with the previous message.'),
          'info',
          3600,
          {
            dedupeKey: 'edit-resend-replaced-draft',
          },
        );
      }
      setComposerTextFromEvent(detail.text || '', {
        mode: editResend ? 'replace' : 'insert',
        appendSpacer: !editResend,
      });
      if (editResend) {
        setInlineNotice(D(
          '已载入上一条消息。修改后按 Enter 重新发送。',
          'The previous message was loaded. Edit it and press Enter to send again.',
        ));
      }
    };
    window.addEventListener('hana-paste-to-input', handlePasteToInput);
    return () => window.removeEventListener('hana-paste-to-input', handlePasteToInput);
  }, [setComposerTextFromEvent, setEditResendTarget, setInlineNotice, textareaRef]);

  useEffect(() => {
    const handleRunCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ command?: string; language?: string }>).detail || {};
      const command = String(detail.command || '').trim();
      if (!command) return;

      const cwd = deskBasePath
        ? (deskCurrentPath ? `${deskBasePath}/${deskCurrentPath}` : deskBasePath)
        : (selectedFolder || useStore.getState().homeFolder || null);
      const risk = deriveRunRisk(command);
      const riskText = runRiskLabel(risk, t);
      const modeText = securityMode === 'safe'
        ? (t('security.mode.safe') || D('只读', 'Read-only'))
        : securityMode === 'plan'
          ? (t('security.mode.plan') || D('规划', 'Plan'))
          : (t('security.mode.authorized') || D('执行', 'Execute'));

      setPendingConfirm({
        title: t('markdown.runConfirm.title') || D('执行代码块命令', 'Run the code-block command'),
        message: (t('markdown.runConfirm.message') || D('将把这段命令发给 Lynn 执行。', 'This command will be sent to Lynn to run.'))
          .replace('{mode}', modeText),
        detail: [
          `${t('markdown.runConfirm.cwd') || D('工作目录', 'Working directory')}: ${cwd || (t('markdown.runConfirm.cwdUnknown') || D('未指定', 'not set'))}`,
          `${t('markdown.runConfirm.risk') || D('风险级别', 'Risk level')}: ${riskText}`,
          command,
        ].join('\n'),
        confirmLabel: t('markdown.runConfirm.confirm') || D('继续执行', 'Continue'),
        cancelLabel: t('common.cancel') || D('取消', 'Cancel'),
        tone: risk === 'high' ? 'danger' : 'default',
        onConfirm: async () => {
          const ok = await submitPromptTask({
            mode: 'prompt',
            text: command,
            displayText: command,
            requestText: buildRunCommandPrompt(command, cwd),
          });
          if (!ok) {
            throw new Error(t('chat.needWsConnection') || '连接未就绪');
          }
        },
      });
    };

    window.addEventListener('hana-run-command', handleRunCommand);
    return () => window.removeEventListener('hana-run-command', handleRunCommand);
  }, [deskBasePath, deskCurrentPath, securityMode, selectedFolder, setPendingConfirm, t]);
}
