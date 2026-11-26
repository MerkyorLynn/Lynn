import React, { useEffect, useRef, useState } from 'react';
import { hanaFetch } from '../api';
import { useSettingsStore } from '../store';
import { DEFAULT_MODEL_CALL_TIMEOUTS, isValidModelCallTimeouts, type ModelCallTimeouts } from '../../../../../shared/model-call-timeouts.js';
import { isChineseLocale } from '../../utils/locale';
import styles from '../Settings.module.css';

import type { modelTimeoutDiagnostics } from '../../../../../core/agent-runtime/model-call-timeouts.js';

type TimeoutResponse = { configured: ModelCallTimeouts; effective: ModelCallTimeouts; brainEffective: ModelCallTimeouts; diagnostics?: ReturnType<typeof modelTimeoutDiagnostics>; error?: string };
function timeoutFields(zh: boolean) {
  return [
    ['firstChunkMs', zh ? '首段等待（秒）' : 'First-chunk wait (s)'],
    ['idleMs', zh ? '流式空闲（秒）' : 'Stream idle (s)'],
    ['totalMs', zh ? '总时限（秒，0 为不限）' : 'Total limit (s, 0 = unlimited)'],
  ] as const;
}

export function ModelTimeoutSettings() {
  const zh = isChineseLocale();
  const L = (zhText: string, enText: string) => (zh ? zhText : enText);
  const fields = timeoutFields(zh);
  const serverPort = useSettingsStore(state => state.serverPort);
  const serverToken = useSettingsStore(state => state.serverToken);
  const connectionRevision = useRef(0);
  const [values, setValues] = useState<ModelCallTimeouts>({ ...DEFAULT_MODEL_CALL_TIMEOUTS });
  const [status, setStatus] = useState<TimeoutResponse | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const revision = ++connectionRevision.current;
    let active = true;
    setStatus(null);
    setSaving(false);
    setMessage(L('正在连接设置服务…', 'Connecting to the settings service…'));
    if (serverPort != null && Number.isFinite(serverPort) && serverPort > 0) {
      setMessage(L('正在读取超时设置…', 'Reading timeout settings…'));
      hanaFetch('/api/preferences/model-timeouts').then(async response => {
        const data: TimeoutResponse = await response.json();
        if (!response.ok || data.error) {
          throw new Error(data.error || L('读取超时设置失败', 'Could not read timeout settings'));
        }
        if (active) { setValues(data.configured); setStatus(data); setMessage(''); }
      }).catch(error => { if (active) setMessage(String(error.message || error)); });
    }
    return () => { active = false; if (connectionRevision.current === revision) ++connectionRevision.current; };
  }, [serverPort, serverToken]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!status || saving) return;
    const revision = connectionRevision.current;
    if (!isValidModelCallTimeouts(values)) {
      setMessage(L('请输入有效时长；首段和空闲必须大于 0，总时限可以为 0。', 'Enter valid durations: first-chunk and idle must be greater than 0, the total limit may be 0.'));
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const response = await hanaFetch('/api/preferences/model-timeouts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      const data: TimeoutResponse = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || L('保存失败', 'Save failed'));
      if (connectionRevision.current !== revision) return;
      setStatus(data);
      setValues(data.configured);
      setMessage(L('已保存，下一次模型请求生效（GUI / CLI 共用）。', 'Saved. It applies to the next model request and is shared by GUI and CLI.'));
    } catch (error) {
      if (connectionRevision.current === revision) setMessage(error instanceof Error ? error.message : String(error));
    } finally { if (connectionRevision.current === revision) setSaving(false); }
  };

  return (
    <form onSubmit={save} aria-label={L('模型请求超时', 'Model request timeouts')} className={styles['settings-section']}>
      <h3>{L('模型请求超时', 'Model request timeouts')}</h3>
      <p>
        {L(
          '首段包含连接和首个流数据块的等待；收到任何数据块（含思考、工具参数、心跳）后，改为空闲计时，每个新数据块重置。首段和空闲默认均为 600 秒（10 分钟），总时限关闭；持续输出不会在 10 分钟时被截断。',
          'The first-chunk window covers connecting and waiting for the first streamed block. Once any block arrives (thinking, tool arguments, heartbeat), it switches to idle timing and resets on every new block. First-chunk and idle both default to 600 seconds (10 minutes) and the total limit is off, so continuous output is never cut off at the 10-minute mark.',
        )}
      </p>
      {fields.map(([key, label]) => (
        <label key={key} style={{ display: 'block', marginBottom: 8 }}>
          {label}{' '}
          <input type="number" min={key === 'totalMs' ? 0 : 0.001} max={2147483.647} step="0.001" value={Number.isFinite(values[key]) ? values[key] / 1000 : ''} disabled={!status || saving}
            onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value === '' ? NaN : Math.round(Number(event.target.value) * 1000) }))} />
        </label>
      ))}
      <p>
        {L(
          '环境变量优先：LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS、LYNN_MODEL_IDLE_TIMEOUT_MS、LYNN_MODEL_TOTAL_TIMEOUT_MS；兼容 LYNN_MODEL_CALL_TIMEOUT_MS，Brain 另受 LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS 覆盖。单位均为毫秒。',
          'Environment variables win: LYNN_MODEL_FIRST_CHUNK_TIMEOUT_MS, LYNN_MODEL_IDLE_TIMEOUT_MS and LYNN_MODEL_TOTAL_TIMEOUT_MS. LYNN_MODEL_CALL_TIMEOUT_MS is still honoured, and Brain has its own LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS override. All values are milliseconds.',
        )}
      </p>
      <p>
        {L(
          'CLI 的云端快速连接/回退仍有独立响应头等待限制（LYNN_CLI_BRAIN_TIMEOUT_MS）；此处不修改工具、语音或服务商自身限制。',
          'CLI cloud fast-connect and fallback still have their own response-header wait limit (LYNN_CLI_BRAIN_TIMEOUT_MS). Tool, voice and provider-side limits are not changed here.',
        )}
      </p>
      {status && (
        <p>
          {L('实际生效（首段 / 空闲 / 总时限）：', 'In effect (first chunk / idle / total): ')}
          {status.effective.firstChunkMs / 1000} / {status.effective.idleMs / 1000} / {status.effective.totalMs / 1000}{L(' 秒；', ' s; ')}
          {L('Brain 总时限：', 'Brain total limit: ')}{status.brainEffective.totalMs / 1000}{L(' 秒。0 = 不限。', ' s. 0 = unlimited.')}
        </p>
      )}
      {status?.diagnostics && <details>
        <summary>{L('统一超时诊断：生效值与来源', 'Unified timeout diagnostics: effective values and sources')}</summary>
        <p>
          {L(
            '下列为 GUI 服务进程当前值（毫秒）；内置 Qwen 与普通本地端点共用模型设置。CLI 请运行 Lynn doctor --offline 查看自身环境。longResearchTurn 仅在 turn 非 0 时启用；它不是额外的默认截止时间。远端 Brain、代理和服务商限制需在对应服务检查。',
            'These are the current values in the GUI service process (milliseconds). The bundled Qwen and regular local endpoints share the model settings. For the CLI, run Lynn doctor --offline to see its own environment. longResearchTurn only applies when turn is non-zero; it is not an extra default deadline. Remote Brain, proxy and provider limits must be checked on those services.',
          )}
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(status.diagnostics, null, 2)}</pre>
      </details>}
      <button type="submit" disabled={!status || saving}>{saving ? L('保存中…', 'Saving…') : L('保存超时设置', 'Save timeout settings')}</button>
      <p role="status">{message}</p>
    </form>
  );
}
