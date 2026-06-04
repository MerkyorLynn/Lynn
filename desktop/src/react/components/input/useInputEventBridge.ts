import { useEffect, type RefObject } from 'react';
import { useStore } from '../../stores';
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
  setInlineNotice,
  setPendingConfirm,
  t,
  textareaRef,
}: UseInputEventBridgeArgs) {
  useEffect(() => {
    const handlePasteToInput = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; editResend?: boolean }>).detail || {};
      const current = textareaRef.current?.value ?? useStore.getState().composerText;
      const editResend = !!detail.editResend;
      if (editResend && current.trim() && current.trim() !== String(detail.text || '').trim()) {
        useStore.getState().addToast?.('已用上一条消息替换当前输入。', 'info', 3600, {
          dedupeKey: 'edit-resend-replaced-draft',
        });
      }
      setComposerTextFromEvent(detail.text || '', {
        mode: editResend ? 'replace' : 'insert',
        appendSpacer: !editResend,
      });
      if (editResend) {
        setInlineNotice('已载入上一条消息。修改后按 Enter 重新发送。');
      }
    };
    window.addEventListener('hana-paste-to-input', handlePasteToInput);
    return () => window.removeEventListener('hana-paste-to-input', handlePasteToInput);
  }, [setComposerTextFromEvent, setInlineNotice, textareaRef]);

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
        ? (t('security.mode.safe') || '只读')
        : securityMode === 'plan'
          ? (t('security.mode.plan') || '规划')
          : (t('security.mode.authorized') || '执行');

      setPendingConfirm({
        title: t('markdown.runConfirm.title') || '执行代码块命令',
        message: (t('markdown.runConfirm.message') || '将把这段命令发给 Lynn 执行。').replace('{mode}', modeText),
        detail: [
          `${t('markdown.runConfirm.cwd') || '工作目录'}: ${cwd || (t('markdown.runConfirm.cwdUnknown') || '未指定')}`,
          `${t('markdown.runConfirm.risk') || '风险级别'}: ${riskText}`,
          command,
        ].join('\n'),
        confirmLabel: t('markdown.runConfirm.confirm') || '继续执行',
        cancelLabel: t('common.cancel') || '取消',
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
