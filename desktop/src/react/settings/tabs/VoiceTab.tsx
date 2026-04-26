import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { t, autoSaveConfig } from '../helpers';
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
  { value: 'cosyvoice', label: 'CosyVoice 2 (阿里・推荐)' },
  { value: 'edge', label: 'Edge TTS (免费在线)' },
  { value: 'say', label: 'macOS say (本地)' },
  { value: 'openai', label: 'OpenAI TTS API (BYOK)' },
];

const LANGUAGES = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
];

export function VoiceTab() {
  const { settingsConfig } = useSettingsStore();
  const voice = settingsConfig?.voice || {};

  const [asrProvider, setAsrProvider] = useState(voice.asr?.provider || 'sensevoice');
  const [asrKey, setAsrKey] = useState(voice.asr?.api_key || '');
  const [asrBaseUrl, setAsrBaseUrl] = useState(voice.asr?.base_url || '');

  const [ttsProvider, setTtsProvider] = useState(voice.tts?.provider || 'cosyvoice');
  const [ttsKey, setTtsKey] = useState(voice.tts?.api_key || '');
  const [ttsBaseUrl, setTtsBaseUrl] = useState(voice.tts?.base_url || '');
  const [ttsVoice, setTtsVoice] = useState(voice.tts?.default_voice || '中文女');

  const [language, setLanguage] = useState(voice.language || 'auto');

  // 当 settingsConfig 从服务端刷新后，同步本地状态
  useEffect(() => {
    const v = settingsConfig?.voice || {};
    setAsrProvider(v.asr?.provider || 'sensevoice');
    setAsrKey(v.asr?.api_key || '');
    setAsrBaseUrl(v.asr?.base_url || '');
    setTtsProvider(v.tts?.provider || 'cosyvoice');
    setTtsKey(v.tts?.api_key || '');
    setTtsBaseUrl(v.tts?.base_url || '');
    setTtsVoice(v.tts?.default_voice || '中文女');
    setLanguage(v.language || 'auto');
  }, [settingsConfig?.voice]);

  const needsAsrKey = asrProvider === 'openai' || asrProvider === 'azure';
  const needsTtsKey = ttsProvider === 'openai';

  const handleSave = async () => {
    const payload: Record<string, any> = {
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
            onChange={(v) => setTtsProvider(v)}
          />
        </div>

        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>默认音色</label>
          <input
            className={styles['settings-input']}
            type="text"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
            placeholder="zh-CN-XiaoxiaoNeural"
          />
          <span className={styles['settings-field-hint']}>
            {ttsProvider === 'cosyvoice'
              ? 'CosyVoice 2 部署在 Spark,内置音色:中文女 / 中文男 / 英文女 / 英文男 / 日语男 / 韩语女 / 粤语女(默认推荐)'
              : ttsProvider === 'edge'
              ? 'Edge TTS 使用 Neural 音色 ID,如 zh-CN-XiaoxiaoNeural'
              : ttsProvider === 'openai'
              ? 'OpenAI TTS 使用内置音色 alloy / echo / onyx / nova'
              : '本地 say,音色取决于系统设置'}
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
