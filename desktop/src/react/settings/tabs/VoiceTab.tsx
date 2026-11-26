import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { useStore } from '../../stores';
import { autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { KeyInput } from '../widgets/KeyInput';
import { isChineseLocale } from '../../utils/locale';
import styles from '../Settings.module.css';

function asrProviderOptions(zh: boolean) {
  return [
    { value: 'stepfun-realtime', label: zh ? 'StepFun Realtime ASR（Lynn 云端 · 默认）' : 'StepFun Realtime ASR (Lynn Cloud · default)' },
    { value: 'openai', label: 'OpenAI Whisper API (BYOK)' },
    { value: 'azure', label: 'Azure Speech-to-Text (BYOK)' },
  ];
}

function ttsProviderOptions(zh: boolean) {
  return [
    { value: 'stepfun-realtime', label: zh ? 'StepFun Realtime TTS（Lynn 云端 · 无需 Key）' : 'StepFun Realtime TTS (Lynn Cloud · no key needed)' },
    { value: 'openai', label: 'OpenAI TTS API (BYOK)' },
  ];
}

// Language names are intentionally written in their own language.
const LANGUAGES = [
  { value: 'auto', label: '' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

function languageOptions(zh: boolean) {
  return LANGUAGES.map((item) => (item.value === 'auto'
    ? { ...item, label: zh ? '自动检测' : 'Auto-detect' }
    : item));
}

function defaultTtsVoice(provider: string): string {
  if (provider === 'stepfun-realtime') return 'jingdiannvsheng';
  return 'zh-CN-XiaoxiaoNeural';
}

const LEGACY_ASR_FALLBACKS = new Set([
  'spark',
  'spark-local',
  'sensevoice',
  'faster-whisper',
  'qwen3-asr',
  'qwen3',
  'qwen',
  'brain-realtime',
  'brain-stepfun-realtime',
  'stepfun',
  'stepfun-direct',
  'stepfun-byok',
]);
const LEGACY_TTS_FALLBACKS = new Set(['spark', 'spark-local', 'cosyvoice', 'cosyvoice2', 'cosyvoice-2', 'edge', 'edge-tts', 'say']);

export function normalizeAsrProvider(provider?: string | null): string {
  const value = String(provider || '').trim();
  if (!value || LEGACY_ASR_FALLBACKS.has(value)) return 'stepfun-realtime';
  return value;
}

export function normalizeTtsProvider(provider?: string | null): string {
  const value = String(provider || '').trim();
  if (!value || LEGACY_TTS_FALLBACKS.has(value)) return 'stepfun-realtime';
  return value;
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

function formatShortcutStatus(status: ShortcutStatus | null, zh: boolean): string {
  if (!status) return zh ? '正在读取快捷键状态...' : 'Reading shortcut status...';
  const attempted = status.attempted?.join(' / ') || 'Cmd+Shift+L / Ctrl+Shift+L';
  if (!status.ok) {
    return zh
      ? `快捷键被占用或不可用。已尝试: ${attempted}`
      : `The shortcut is taken or unavailable. Tried: ${attempted}`;
  }
  if (status.configured && status.accelerator === status.configured) {
    return zh
      ? `${status.accelerator} 已注册为自定义快捷键。`
      : `${status.accelerator} is registered as your custom shortcut.`;
  }
  if (status.configured && status.accelerator !== status.configured) {
    return zh
      ? `自定义快捷键 ${status.configured} 不可用,已自动改用 ${status.accelerator}。`
      : `Your custom shortcut ${status.configured} is unavailable, so ${status.accelerator} is used instead.`;
  }
  if (status.fallbackUsed) {
    return zh
      ? `默认快捷键被占用,已自动改用 ${status.accelerator}。`
      : `The default shortcut is taken, so ${status.accelerator} is used instead.`;
  }
  return zh ? `${status.accelerator} 已注册。` : `${status.accelerator} is registered.`;
}

export function VoiceTab() {
  const { settingsConfig } = useSettingsStore();
  // The settings window reads from the global window.i18n, which is reloaded on
  // language change; isChineseLocale() keeps inline copy in sync with it.
  const zh = isChineseLocale();
  const voice = settingsConfig?.voice || {};

  const [asrProvider, setAsrProvider] = useState(normalizeAsrProvider(voice.asr?.provider));
  const [asrKey, setAsrKey] = useState(voice.asr?.api_key || '');
  const [asrBaseUrl, setAsrBaseUrl] = useState(voice.asr?.base_url || '');

  const [ttsProvider, setTtsProvider] = useState(normalizeTtsProvider(voice.tts?.provider));
  const [ttsKey, setTtsKey] = useState(voice.tts?.api_key || '');
  const [ttsBaseUrl, setTtsBaseUrl] = useState(voice.tts?.base_url || '');
  const [ttsVoice, setTtsVoice] = useState(voice.tts?.default_voice || defaultTtsVoice(normalizeTtsProvider(voice.tts?.provider)));
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
    const nextAsrProvider = normalizeAsrProvider(v.asr?.provider);
    setAsrProvider(nextAsrProvider);
    setAsrKey(v.asr?.api_key || '');
    setAsrBaseUrl(v.asr?.base_url || '');
    const nextTtsProvider = normalizeTtsProvider(v.tts?.provider);
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
          ...(needsAsrKey && asrBaseUrl ? { base_url: asrBaseUrl } : {}),
        },
        tts: {
          provider: ttsProvider,
          default_voice: ttsVoice,
          ...(needsTtsKey ? { api_key: ttsKey || undefined } : {}),
          ...(needsTtsKey && ttsBaseUrl ? { base_url: ttsBaseUrl } : {}),
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
        <h2 className={styles['settings-section-title']}>{zh ? '语音输入 (ASR)' : 'Voice input (ASR)'}</h2>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{zh ? '识别引擎' : 'Recognition engine'}</label>
          <SelectWidget
            options={asrProviderOptions(zh)}
            value={asrProvider}
            onChange={(v) => setAsrProvider(v)}
          />
          <span className={styles['settings-field-hint']}>
            {asrProvider === 'stepfun-realtime'
              ? (zh
                ? 'GUI/CLI 语音输入通过 Lynn Brain 托管 StepFun Realtime 转写,无需本地 Spark/SenseVoice。'
                : 'GUI/CLI voice input is transcribed through Lynn Brain-hosted StepFun Realtime, so no local Spark/SenseVoice is needed.')
              : (zh
                ? '使用第三方 API,需填写对应的密钥。'
                : 'Uses a third-party API and requires the matching key.')}
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{zh ? '备用顺序' : 'Fallback order'}</label>
          <span className={styles['settings-field-hint']}>
            {zh
              ? '默认链路:Lynn Brain → StepFun Realtime。OpenAI/Azure 仅在显式选择时使用。'
              : 'Default route: Lynn Brain → StepFun Realtime. OpenAI/Azure are only used when selected explicitly.'}
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
              <label className={styles['settings-field-label']}>{zh ? 'Base URL（可选）' : 'Base URL (optional)'}</label>
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
        <h2 className={styles['settings-section-title']}>{zh ? '语音合成 (TTS)' : 'Speech synthesis (TTS)'}</h2>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{zh ? '合成引擎' : 'Synthesis engine'}</label>
          <SelectWidget
            options={ttsProviderOptions(zh)}
            value={ttsProvider}
            onChange={(v) => {
              setTtsProvider(v);
              setTtsProviderPreference(v);
              setTtsVoice(defaultTtsVoice(v));
            }}
          />
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{zh ? '默认音色' : 'Default voice'}</label>
          <input
            className={styles['settings-input']}
            type="text"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
            placeholder={ttsProvider === 'stepfun-realtime' ? 'jingdiannvsheng' : 'zh-CN-XiaoxiaoNeural'}
          />
          <span className={styles['settings-field-hint']}>
            {ttsProvider === 'stepfun-realtime'
              ? (zh
                ? '主链:GUI/CLI 语音输出经 Lynn Brain 托管 StepFun Realtime,无需填写 Key。'
                : 'Primary route: GUI/CLI speech goes through Lynn Brain-hosted StepFun Realtime and needs no key.')
              : ttsProvider === 'openai'
              ? (zh
                ? 'OpenAI TTS 使用内置音色 alloy / echo / onyx / nova'
                : 'OpenAI TTS uses the built-in voices alloy / echo / onyx / nova')
              : (zh
                ? '第三方 TTS 需要你自己的配置。'
                : 'Third-party TTS needs your own configuration.')}
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{zh ? '备用顺序' : 'Fallback order'}</label>
          <span className={styles['settings-field-hint']}>
            {zh
              ? '不再自动调用 Spark/CosyVoice。服务端 TTS 不可用时,可由浏览器本地朗读 fallback 接管;OpenAI 仅在显式选择时使用。'
              : 'Spark/CosyVoice are no longer called automatically. When server TTS is unavailable the browser speech fallback takes over; OpenAI is only used when selected explicitly.'}
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
            <span>{zh ? '消息流结束后自动预合成语音(点喇叭即时播放)' : 'Pre-synthesise speech after each reply (instant playback on the speaker button)'}</span>
          </label>
          <span className={styles['settings-field-hint']}>
            {zh
              ? '开启后:每条 ≥50 字回复在 streaming 结束时后台 TTS 一次,缓存到磁盘。点喇叭命中缓存 0 等待。默认走 StepFun Realtime 主链;服务端 TTS 不可用时可退回浏览器朗读。Shift+点击仍可强制即时浏览器朗读。'
              : 'When on, every reply of 50+ characters is synthesised once in the background when streaming ends and cached to disk. Hitting the speaker button plays the cache with zero wait. StepFun Realtime is the primary route; if server TTS is unavailable it falls back to browser speech. Shift+click still forces instant browser speech.'}
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ttsStreamingEnabled}
              onChange={(e) => setTtsStreamingEnabled(e.target.checked)}
            />
            <span>{zh ? '优先使用流式播放(可用时更快开声)' : 'Prefer streaming playback (starts speaking sooner when available)'}</span>
          </label>
          <span className={styles['settings-field-hint']}>
            {zh
              ? 'StepFun Realtime 可用时优先边合成边播放;失败会自动回退到普通文件合成或浏览器朗读。'
              : 'When StepFun Realtime is available it synthesises and plays at the same time; on failure it falls back to regular file synthesis or browser speech.'}
          </span>
        </div>

        <div className={styles['settings-field']}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={ttsBrowserFallbackEnabled}
              onChange={(e) => setTtsBrowserFallbackEnabled(e.target.checked)}
            />
            <span>{zh ? '允许浏览器即时朗读 fallback' : 'Allow the instant browser-speech fallback'}</span>
          </label>
          <span className={styles['settings-field-hint']}>
            {zh
              ? '完全本地、无 quota。开启后服务端 TTS 不可用会自动接管;Shift+点击可强制使用浏览器朗读。'
              : 'Fully local with no quota. When on, it takes over automatically if server TTS is unavailable; Shift+click forces browser speech.'}
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
              <label className={styles['settings-field-label']}>{zh ? 'Base URL（可选）' : 'Base URL (optional)'}</label>
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
        <h2 className={styles['settings-section-title']}>{zh ? '通用' : 'General'}</h2>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{zh ? '默认语言' : 'Default language'}</label>
          <SelectWidget
            options={languageOptions(zh)}
            value={language}
            onChange={(v) => setLanguage(v)}
          />
        </div>
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{zh ? 'Lynn 语音快捷键' : 'Lynn voice shortcut'}</label>
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
              {zh ? '应用' : 'Apply'}
            </button>
            <button
              type="button"
              className={styles['settings-btn-primary']}
              onClick={resetShortcut}
              disabled={shortcutSaving}
            >
              {zh ? '默认' : 'Default'}
            </button>
          </div>
          <span className={styles['settings-field-hint']}>
            {formatShortcutStatus(shortcutStatus, zh)}
          </span>
        </div>
      </section>

      <div className={styles['settings-actions']}>
        <button
          type="button"
          className={styles['settings-btn-primary']}
          onClick={handleSave}
        >
          {zh ? '保存语音设置' : 'Save voice settings'}
        </button>
      </div>
    </div>
  );
}
