import catalog from '../../../../../shared/qwen38-local-models.json';
import { isChineseLocale } from '../../utils/locale';
import styles from './LocalModelSetupChoice.module.css';

export const localModelCatalog = catalog;

/** Inline zh/en picker for copy that ships next to this chooser. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);

export function getLocalModelTier(id?: string | null) {
  return catalog.tiers.find(tier => tier.modelId === id) || catalog.tiers[0];
}
export function localModelInstallBytes(tier: { expectedSize: number }) {
  return tier.expectedSize;
}

export function LocalModelSetupChoice({ value, recommendedId, onChange, disabled, onHelp }: {
  value: string; recommendedId?: string | null; onChange: (id: string) => void;
  disabled?: boolean; onHelp: () => void;
}) {
  const tier = getLocalModelTier(value);
  const total = localModelInstallBytes(tier);
  return <div className={styles.choice}>
    <label>{D('安装方案', 'Install option')}
      <select
        aria-label={D('本地模型安装方案', 'Local model install option')}
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      >
        {catalog.tiers.map(item => <option key={item.modelId} value={item.modelId}>
          {item.quantization} · {item.audience}
          {item.modelId === recommendedId ? D('（本机推荐）', ' (recommended for this machine)') : ''}
        </option>)}
      </select>
    </label>
    {!recommendedId && (
      <p>
        {D(
          '硬件容量不足或尚未确认，暂不允许安装；手动选档不能跳过显存检查。',
          'Installation is disabled because hardware capacity is insufficient or unconfirmed. Choosing a tier manually does not skip the memory check.',
        )}
      </p>
    )}
    <p>
      {tier.label} · {D('主模型', 'main model')} {(tier.expectedSize / 1e9).toFixed(2)} GB
      {D('，内置 Q4 MTP。', ', built-in Q4 MTP.')}
      {' '}
      {D(
        `建议预留 ${Math.ceil(total * 1.1 / 1e9 + 1)} GB 磁盘空间。`,
        `Reserve about ${Math.ceil(total * 1.1 / 1e9 + 1)} GB of disk space.`,
      )}
    </p>
    <p>
      {D(
        `一键安装会检查或下载兼容的 llama.cpp，校验这一个主模型，然后以 ${tier.contextSize / 1024}K 上下文、单并发启动。`,
        `One-click setup checks or downloads a compatible llama.cpp, verifies this main model, then starts it with a ${tier.contextSize / 1024}K context and single-concurrency.`,
      )}
      {tier.quantization === 'Q2'
        ? D(
          '16GB 推荐此档，至少需要 14GiB 显存/统一内存；14～不足 16GiB 时上下文余量较紧。',
          'Recommended at 16GB. Requires at least 14GiB of VRAM / unified memory; between 14 and 16GiB the context headroom is tight.',
        )
        : D('24GB 及以上默认使用此档。', 'Used by default at 24GB and above.')}
      {D(
        '低于 14GiB 不能安装，13GB 容量不足。主模型之外还需上下文 KV 缓存和运行缓冲；此次安装不含视觉组件，也不另下 DFlash2 草稿。',
        'Below 14GiB installation is blocked, and 13GB is not enough. Beyond the main model you also need context KV cache and runtime buffers. This install excludes vision components and does not fetch the DFlash2 draft separately.',
      )}
    </p>
    <div>
      <a href={catalog.modelCardUrl} target="_blank" rel="noopener noreferrer" onClick={event => {
        if (window.platform?.openExternal) { event.preventDefault(); void window.platform.openExternal(catalog.modelCardUrl); }
      }}>{D('查看模型卡与详细说明', 'View model card and details')}</a>
      {' · '}
      <button type="button" onClick={onHelp}>{D('让 Lynn 帮我部署', 'Let Lynn set it up for me')}</button>
    </div>
  </div>;
}

export async function requestLocalModelHelp(modelId: string, hardware: unknown, error?: string | null) {
  const platform = window.platform as typeof window.platform & {
    requestLocalModelHelp?: (payload: { modelId: string; hardware: unknown; error?: string | null }) => Promise<{ ok: boolean }>;
  };
  if (!platform?.requestLocalModelHelp) {
    throw new Error(D('请在 Lynn 桌面端使用部署助手', 'Use the setup assistant in the Lynn desktop app'));
  }
  const result = await platform.requestLocalModelHelp({ modelId, hardware, error });
  if (!result?.ok) {
    throw new Error(D('暂时无法打开对话，请稍后重试', 'Could not open the conversation right now. Please try again later.'));
  }
}
