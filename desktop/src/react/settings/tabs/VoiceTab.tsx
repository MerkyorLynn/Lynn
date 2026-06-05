import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { useStore } from '../../stores';
import { autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { KeyInput } from '../widgets/KeyInput';
import styles from '../Settings.module.css';

const ASR_PROVIDERS = [
  { value: 'sensevoice', label: 'SenseVoice (达摩院・推荐)' },
  { value: 'faster-whisper', label: 'Faster Whisper (自托管)' },
  { value: 'openai', label: 'OpenAI Whisper API (BYOK)' },
  { value: 'azure', label: 'Azure Speech-to-Text (BYOK)' },
];

const TTS_PROVIDERS = [
  { value: 'cosyvoice', label: 'CosyVoice (Spark · 真流式 · 默认推荐)' },
  { value: 'edge', label: 'Edge TTS (免费在线・备用)' },
  { value: 'openai', label: 'OpenAI TTS API (BYOK)' },
  { value: 'say', label: 'macOS say (本地离线)' },
];

// CosyVoice SFT 7 个内置 speakers
const COSYVOICE_VOICES = [
  { value: '中文女', label: '中文女(默认)' },
  { value: '中文男', label: '中文男' },
  { value: '英文女', label: '英文女' },
  { value: '英文男', label: '英文男' },
  { value: '日语男', label: '日语男' },
  { value: '韩语女', label: '韩语女' },
  { value: '粤语女', label: '粤语女' },
];

const LANGUAGES = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

function defaultTtsVoice(provider: string): string {
  if (provider === 'cosyvoice') return '中文女';
  return 'zh-CN-XiaoxiaoNeural';
}

type ShortcutStatus = {
  ok: boolean;
  accelerator: string | null;
  fallbackUsed: boolean;
  attempted: string[];
  configured?: string | null;
  defaultAccelerator?: string | null;
  layer?: string | null;
  errors?: Record<string, string>;
};

function formatShortcutStatus(status: ShortcutStatus | null): string {
  if (!status) return '正在读取快捷键状态...';
  const attempted = status.attempted?.join(' / ') || 'Cmd+Shift+L / Ctrl+Shift+L';
  if (!status.ok) return `快捷键被占用或不可用。已尝试: ${attempted}`;
  if (status.configured && status.accelerator === status.configured) {
    return `${status.accelerator} 已注册为自定义快捷键。`;
  }
  if (status.configured && status.accelerator !== status.configured) {
    return `自定义快捷键 ${status.configured} 不可用,已自动改用 ${status.accelerator}。`;
  }
  if (status.fallbackUsed) return `默认快捷键被占用,已自动改用 ${status.accelerator}。`;
  return `${status.accelerator} 已注册。`;
}

export function VoiceTab() {
  const { settingsConfig } = useSettingsStore();
  const voice = settingsConfig?.voice || {};

  const [asrProvider, setAsrProvider] = useState(voice.asr?.provider || 'sensevoice');
  const [asrKey, setAsrKey] = useState(voice.asr?.api_key || '');
  const [asrBaseUrl, setAsrBaseUrl] = useState(voice.asr?.base_url || '');

  const [ttsProvider, setTtsProvider] = useState(voice.tts?.provider || 'cosyvoice');
  const [ttsKey, setTtsKey] = useState(voice.tts?.api_key || '');
  const [ttsBaseUrl, setTtsBaseUrl] = useState(voice.tts?.base_url || '');
  const [ttsVoice, setTtsVoice] = useState(voice.tts?.default_voice || defaultTtsVoice(voice.tts?.provider || 'cosyvoice'));
  const ttsAutoPrefetch = useStore((s) => s.ttsAutoPrefetch);
  const ttsStreamingEnabled = useStore((s) => s.ttsStreamingEnabled);
  const ttsBrowserFallbackEnabled = useStore((s) => s.ttsBrowserFallbackEnabled);
  const setTtsAutoPrefetch = useStore((s) => s.setTtsAutoPrefetch);
  const setTtsStreamingEnabled = useStore((s) => s.setTtsStreamingEnabled);
  const setTtsBrowserFallbackEnabled = useStore((s) => s.setTtsBrowserFallbackEnabled);
  const setTtsProviderPreference = useStore((s) => s.setTtsProviderPreference);

  const [language, setLanguage] = useState(voice.language || 'auto');
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState('');
  const [shortcutSaving, setShortcutSaving] = useState(false);

  // 当 settingsConfig 从服务端刷新后，同步本地状态
  useEffect(() => {
    const v = settingsConfig?.voice || {};
    setAsrProvider(v.asr?.provider || 'sensevoice');
    setAsrKey(v.asr?.api_key || '');
    setAsrBaseUrl(v.asr?.base_url || '');
    const nextTtsProvider = v.tts?.provider || 'cosyvoice';
    setTtsProvider(nextTtsProvider);
    setTtsProviderPreference(nextTtsProvider);
    setTtsKey(v.tts?.api_key || '');
    setTtsBaseUrl(v.tts?.base_url || '');
    setTtsVoice(v.tts?.default_voice || defaultTtsVoice(nextTtsProvider));
    setLanguage(v.language || 'auto');
  }, [settingsConfig?.voice, setTtsProviderPreference]);

  useEffect(() => {
    let cancelled = false;
    window.platform?.getGlobalSummonShortcutStatus?.()
      .then((status) => {
        if (!cancelled) {
          setShortcutStatus(status || null);
          setShortcutDraft(status?.configured || status?.accelerator || '');
        }
      })
      .catch(() => {
        if (!cancelled) setShortcutStatus(null);
      });
    return () => { cancelled = true; };
  }, []);

  const needsAsrKey = asrProvider === 'openai' || asrProvider === 'azure';
  const needsTtsKey = ttsProvider === 'openai';

  const handleSave = async () => {
    const payload: {
      voice: {
        language: string;
        asr: { provider: string; api_key?: string; base_url?: string };
        tts: {
          provider: string;
          default_voice: string;
          api_key?: string;
          base_url?: string;
        };
      };
    } = {
      voice: {
        language,
        asr: {
          provider: asrProvider,
          ...(needsAsrKey ? { api_key: asrKey || undefined } : {}),
          ...(asrBaseUrl ? { base_url: asrBaseUrl } : {}),
        },
        tts: {
          provider: ttsProvider,
          default_voice: ttsVoice,
          ...(needsTtsKey ? { api_key: ttsKey || undefined } : {}),
          ...(ttsBaseUrl ? { base_url: ttsBaseUrl } : {}),
        },
      },
    };
    // 清理空值
    if (!payload.voice.asr.api_key) delete payload.voice.asr.api_key;
    if (!payload.voice.asr.base_url) delete payload.voice.asr.base_url;
    if (!payload.voice.tts.api_key) delete payload.voice.tts.api_key;
    if (!payload.voice.tts.base_url) delete payload.voice.tts.base_url;
    await autoSaveConfig(payload);
  };

  const applyShortcut = async () => {
    if (!window.platform?.setGlobalSummonShortcut) return;
    setShortcutSaving(true);
    try {
      const status = await window.platform.setGlobalSummonShortcut(shortcutDraft.trim() || null);
      setShortcutStatus(status || null);
      setShortcutDraft(status?.configured || status?.accelerator || shortcutDraft.trim());
    } catch (err) {
      setShortcutStatus({
        ok: false,
        accelerator: null,
        fallbackUsed: false,
        attempted: [shortcutDraft.trim()].filter(Boolean),
        errors: { [shortcutDraft.trim() || 'shortcut']: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      setShortcutSaving(false);
    }
  };

  const resetShortcut = async () => {
    if (!window.platform?.setGlobalSummonShortcut) return;
    setShortcutSaving(true);
    try {
      const status = await window.platform.setGlobalSummonShortcut(null);
      setShortcutStatus(status || null);
      setShortcutDraft(status?.accelerator || '');
    } catch (err) {
      setShortcutStatus({
        ok: false,
        accelerator: null,
        fallbackUsed: false,
        attempted: [],
        errors: { shortcut: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      setShortcutSaving(false);
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="voice">
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>语音输入 (ASR)</h2>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>识别引擎</label>
          <SelectWidget
            options={ASR_PROVIDERS}
            value={asrProvider}
            onChange={(v) => setAsrProvider(v)}
          />
          <span className={styles['settings-field-hint']}>
            {asrProvider === 'sensevoice'
              ? 'SenseVoice 部署在 Spark,中文流式 50ms,WER 业界领先,无需额外配置(默认推荐)。'
              : asrProvider === 'faster-whisper'
              ? 'Faster Whisper 自托管服务,无需额外配置。'
              : '使用第三方 API,需填写对应的密钥。'}
          </span>
        </div>

        {needsAsrKey && (
          <>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>API Key</label>
              <KeyInput
                value={asrKey}
                onChange={setAsrKey}
                placeholder="sk-..."
              />
            </div>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>Base URL（可选）</label>
              <input
                className={styles['settings-input']}
                type="text"
                value={asrBaseUrl}
                onChange={(e) => setAsrBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          </>
        )}
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>语音合成 (TTS)</h2>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>合成引擎</label>
          <SelectWidget
            options={TTS_PROVIDERS}
            value={ttsProvider}
            onChange={(v) => {
              setTtsProvider(v);
              setTtsProviderPreference(v);
              setTtsVoice(defaultTtsVoice(v));
            }}
          />
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>默认音色</label>
          {ttsProvider === 'cosyvoice' ? (
            <SelectWidget
              options={COSYVOICE_VOICES}
              value={ttsVoice}
              onChange={(v) => setTtsVoice(v)}
            />
          ) : (
            <input
              className={styles['settings-input']}
              type="text"
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              placeholder="zh-CN-XiaoxiaoNeural"
            />
          )}
          <span className={styles['settings-field-hint']}>
            {ttsProvider === 'cosyvoice'
              ? 'CosyVoice 2 部署在 Spark,短文本低延迟,支持真流式播放。内置音色:中文女 / 中文男 / 英文女 / 英文男 / 日语男 / 韩语女 / 粤语女。'
              : ttsProvider === 'edge'
              ? 'Edge TTS 使用 Neural 音色 ID,如 zh-CN-XiaoxiaoNeural,适合作为网络备用。'
              : ttsProvider === 'openai'
              ? 'OpenAI TTS 使用内置音色 alloy / echo / onyx / nova'
              : '本地 say,音色取决于系统设置'}
          </span>
        </div>

        {/* P0: 自动预合成 toggle */}
        <div className={styles['settings-field']}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ttsAutoPrefetch}
              onChange={(e) => setTtsAutoPrefetch(e.target.checked)}
            />
            <span>消息流结束后自动预合成语音(点喇叭即时播放)</span>
          </label>
          <span className={styles['settings-field-hint']}>
            开启后:每条 ≥50 字回复在 streaming 结束时后台 TTS 一次,缓存到磁盘。点喇叭命中缓存 0 等待。
            注意:每条都烧 TTS quota,OpenAI 收费 provider 慎开。CosyVoice/Edge 免费可开。
            ⚡ Shift+点击 喇叭 = 浏览器原生即时朗读(本地,&lt;50ms,无 quota)。
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ttsStreamingEnabled}
              onChange={(e) => setTtsStreamingEnabled(e.target.checked)}
            />
            <span>优先使用流式播放(可用时更快开声)</span>
          </label>
          <span className={styles['settings-field-hint']}>
            CosyVoice 支持真流式时会优先边合成边播放;失败会自动回退到普通文件合成。
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ttsBrowserFallbackEnabled}
              onChange={(e) => setTtsBrowserFallbackEnabled(e.target.checked)}
            />
            <span>允许 Shift+点击使用浏览器即时朗读</span>
          </label>
          <span className={styles['settings-field-hint']}>
            完全本地、无 quota,适合快速听草稿;关闭后 Shift+点击会按普通朗读处理。
          </span>
        </div>

        {needsTtsKey && (
          <>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>API Key</label>
              <KeyInput
                value={ttsKey}
                onChange={setTtsKey}
                placeholder="sk-..."
              />
            </div>
            <div className={styles['settings-field']}>
              <label className={styles['settings-field-label']}>Base URL（可选）</label>
              <input
                className={styles['settings-input']}
                type="text"
                value={ttsBaseUrl}
                onChange={(e) => setTtsBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          </>
        )}
      </section>

      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>通用</h2>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>默认语言</label>
          <SelectWidget
            options={LANGUAGES}
            value={language}
            onChange={(v) => setLanguage(v)}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>Lynn 语音快捷键</label>
          <div className={styles['settings-input-group']}>
            <input
              className={styles['settings-input']}
              type="text"
              value={shortcutDraft}
              onChange={(e) => setShortcutDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void applyShortcut();
              }}
              placeholder="Command+Shift+L"
            />
            <button
              type="button"
              className={styles['settings-btn-primary']}
              onClick={applyShortcut}
              disabled={shortcutSaving}
            >
              应用
            </button>
            <button
              type="button"
              className={styles['settings-btn-primary']}
              onClick={resetShortcut}
              disabled={shortcutSaving}
            >
              默认
            </button>
          </div>
          <span className={styles['settings-field-hint']}>
            {formatShortcutStatus(shortcutStatus)}
          </span>
        </div>
      </section>

      <div className={styles['settings-actions']}>
        <button
          type="button"
          className={styles['settings-btn-primary']}
          onClick={handleSave}
        >
          保存语音设置
        </button>
      </div>
    </div>
  );
}
