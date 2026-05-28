import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Local Qwen provider UX guards', () => {
  it('shows inline feedback for endpoint and registration actions', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(source).toContain('setActionStatus');
    expect(source).toContain('已打开 llama.cpp 端点');
    expect(source).toContain('正在重新注册本地 OpenAI 端点');
    expect(source).toContain('platform?.openExternal');
  });

  it('keeps the advanced GGUF launcher discoverable but folded', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(source).toContain('可选本地模型');
    expect(source).toContain('已有 GGUF / 模型目录');
    expect(source).toContain('管理本地模型');
    expect(source).toContain('定位当前模型文件');
    expect(source).toContain('selectGgufModel');
  });

  it('advertises the local ladder (9B default → 4B downgrade → 35B 32GB+ APEX-MTP) with objective metrics', () => {
    const source = read('server/routes/local-qwen35.ts');
    expect(source).not.toContain('qwen36-27b-q4km-imatrix');
    // 9B is the default local onboarding model.
    expect(source).toContain('local-qwen35-9b-q4km-imatrix');
    expect(source).toContain('qwen35-9b-q4km-imatrix');
    expect(source).toContain('Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf');
    // 4B remains visible only as a low-config downgrade with explicit thinking-on risk.
    expect(source).toContain('qwen35-4b-q4km');
    expect(source).toContain('低配降级');
    expect(source).toContain('thinking-on 可能长思考后无正文');
    // 35B = 32GB+ high-end APEX-MTP with DGX Spark TPS clearly labeled.
    expect(source).toContain('qwen36-35b-a3b-apex-mtp');
    expect(source).toContain('DGX Spark thinking-on 75-85 TPS');
    expect(source).toContain('DGX Spark 数学 84.69 TPS');
    expect(source).toContain('DGX Spark 归纳证明 75.53 TPS');
    expect(source).toContain('APEX I-Balanced');
    expect(source).not.toContain('Spark/远端兜底');
    expect(source).toContain('https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-APEX-MTP-GGUF');
    expect(source).toContain('下载到本机');
    expect(source).toContain('Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf');
  });

  it('makes advanced local models actionable instead of passive cards', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(source).toContain('MMLU 500 81.20%');
    expect(source).not.toContain('MMLU 100 81.00%');
    expect(source).toContain('startRecommendedDownload');
    expect(source).toContain('llamacppStartDownload');
    expect(source).toContain('下载到本机');
    expect(source).toContain('启动此模型');
    expect(source).toContain('导入本机 GGUF');
    expect(source).toContain('取消下载');
    expect(source).toContain('cancelRecommendedDownload');
    expect(source).toContain('定位当前模型文件');
    expect(source).not.toContain('下载/查看');
    expect(source).toContain('chooseGgufModel');
    expect(source).toContain('4B 仅作为低配降级');
    expect(source).toContain('thinking-on 可能长思考后无正文');
    expect(source).toContain('localModelActionErrorText');
  });

  it('keeps local model IPC commands explicit and guarded', () => {
    const main = read('desktop/main.cjs');
    const preload = read('desktop/preload.cjs');
    expect(main).toContain('const LOCAL_MODEL_IPC = Object.freeze');
    expect(main).toContain('parseStartDownloadPayload');
    expect(main).toContain('download-boundary-invalid');
    expect(main).toContain('model-path-not-allowed');
    expect(main).toContain('isLocalModelPathAllowed');
    expect(preload).toContain('llamacppStartDownload: (payload)');
    expect(preload).toContain('llamacppStartCustomModel: (modelPath)');
  });

  it('downloads the recommended 35B APEX-MTP model through Lynn with checksum and parallel ranges', () => {
    const profiles = read('desktop/llamacpp-profiles.cjs');
    const downloader = read('desktop/model-downloader.cjs');
    const preload = read('desktop/preload.cjs');
    // 2026-05-28: canonical 35B = APEX-MTP I-Balanced;old Q4_K_M id remains a backward-compatible alias.
    expect(profiles).toContain('qwen36-35b-a3b-apex-mtp');
    expect(profiles).toContain('26_059_443_808');
    expect(profiles).toContain('9bf7d96bb3a9d363e645dd998aee9e9bff8e016a82aec7ff081e0e6cdb53419e');
    expect(profiles).toContain('parallelSegments: 4');
    expect(profiles).toContain('Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf');
    expect(profiles).toContain('Qwen3.6-35B-A3B-APEX-MTP-GGUF');
    // legacy alias still maps old stored ids to the new canonical profile.
    expect(profiles).toContain('"qwen36-35b-a3b-q4km-imatrix": "qwen36-35b-a3b-apex-mtp"');
    expect(preload).toContain('llamacppStartDownload: (payload)');
    expect(downloader).toContain('_downloadFromSourceParallel');
    expect(downloader).toContain('"Range"');
  });

  it('keeps onboarding, status badge, and chat routing on the server-side local provider id', () => {
    const constants = read('desktop/src/react/onboarding/constants.ts');
    const onboardingStep = read('desktop/src/react/onboarding/steps/LocalModelDownloadStep.tsx');
    const badge = read('desktop/src/react/components/ProviderStatusBadge.tsx');
    expect(constants).toContain("providerName: 'local-qwen35-9b-q4km-imatrix'");
    expect(constants).toContain("defaultModelId: 'qwen35-9b-q4km-imatrix'");
    expect(onboardingStep).toContain('/api/local-qwen35-9b/status');
    expect(onboardingStep).toContain('/api/local-qwen35-9b/setup');
    expect(badge).toContain('/api/local-qwen35-9b/status');
    expect(badge).toContain('/api/local-qwen35-9b/setup');
    expect(badge).not.toContain("LLAMACPP_PROVIDER_ID = 'llamacpp'");
    expect(onboardingStep).not.toContain('useLlamacppState');
  });

  it('keeps external bridge owner replies on Brain when foreground chat uses a local model', () => {
    const bridge = read('core/bridge-session-manager.ts');
    expect(bridge).toContain('BRAIN_DEFAULT_MODEL_ID');
    expect(bridge).toContain('LOCAL_QWEN35_PROVIDER_IDS');
    expect(bridge).toContain('resolveBridgeOwnerModel');
    expect(bridge).toContain('brain_default_for_bridge');
    expect(bridge).toContain('owner bridge model pinned to Brain default');
    expect(bridge).toContain('"weather"');
    expect(bridge).toContain('"stock_market"');
    expect(bridge).toContain('"live_news"');
    expect(bridge).toContain('"sports_score"');
  });

  it('uses platform-stable status dots instead of emoji status icons', () => {
    const badge = read('desktop/src/react/components/ProviderStatusBadge.tsx');
    const styles = read('desktop/src/styles.css');
    const emojiStatusIcons = ['🟢', '📥', '⏸', '🔴', '🟡', '☁️'];
    expect(badge).toContain('provider-status-dot');
    expect(badge).toContain('provider-status-menu-dot');
    expect(styles).toContain('.provider-status-dot');
    expect(emojiStatusIcons.some(icon => badge.includes(icon))).toBe(false);
  });

  it('keeps reasoning auto mode available for the daily local model', () => {
    const manager = read('desktop/llamacpp-manager.cjs');
    const launcher = read('scripts/local_qwen35_9b_q4km_llamacpp_server.sh');
    expect(manager).toContain('"--reasoning", "auto"');
    expect(launcher).toContain('--jinja --reasoning auto');
  });

  it('uses the Lynn imatrix 9B MTP artifact for the default local download', () => {
    const profiles = read('desktop/llamacpp-profiles.cjs');
    const downloader = read('desktop/model-downloader.cjs');
    const route = read('server/routes/local-qwen35.ts');
    expect(profiles).toContain('Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf');
    expect(profiles).toContain('revision: "2026-05-28-mtp"');
    expect(profiles).toContain('supersedesFileNames');
    expect(profiles).toContain('Qwen3.5-9B-Q4_K_M-imatrix.gguf');
    expect(profiles).toContain('0f292ba0d1058065a6624883a76a2adf00b266d07b9396ed67b155ff522e18d4');
    expect(downloader).toContain('Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP');
    expect(downloader).toContain('nerkyor/Qwen3.5-9B-GGUF-imatrix-MTP');
    expect(route).toContain('Qwen3.5-9B Q4_K_M imatrix MTP');
    expect(route).toContain('Qwen3.5-4B Q4_K_M imatrix (低配降级)');
    expect(route).not.toContain('Qwen3.5-4B Q4_K_M (unsloth)');
  });

  it('detects older 9B GGUF files as upgrade candidates instead of default-ready MTP', () => {
    const panel = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    const bootstrap = read('scripts/local_qwen35_9b_client_bootstrap.py');
    const setup = read('scripts/local_qwen35_9b_setup.sh');
    expect(panel).toContain('isDefaultQwen35MtpFileName');
    expect(panel).toContain('needs_model_upgrade');
    expect(panel).toContain('升级到 9B MTP (5.78 GB)');
    expect(panel).toContain('旧版 9B');
    expect(panel).toContain('新版 MTP 待下载');
    expect(bootstrap).toContain('DEFAULT_MODEL_FILE_NAME = "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf"');
    expect(bootstrap).toContain('LEGACY_MODEL_FILE_NAMES');
    expect(bootstrap).toContain('"legacy_gguf"');
    expect(bootstrap).toContain('"needs_model_upgrade"');
    expect(bootstrap).toContain('Upgrade Qwen3.5-9B to Q4_K_M imatrix MTP GGUF');
    expect(setup).toContain('find_legacy_gguf');
    expect(setup).toContain('legacy 9B GGUF found but default requires MTP');
    expect(setup).toContain('is_default_mtp_gguf_path "$candidate" || continue');
  });

  it('keeps local model progress out of model-visible thinking', () => {
    const route = read('server/routes/chat.ts');
    const localBridge = read('server/chat/local-model-bridge.ts');
    const chatRuntime = `${route}\n${localBridge}`;
    const thinkingBlock = read('desktop/src/react/components/chat/ThinkingBlock.tsx');
    const assistantMessage = read('desktop/src/react/components/chat/AssistantMessage.tsx');
    const inputArea = read('desktop/src/react/components/InputArea.tsx');
    expect(localBridge).toContain('startLocalQwen35WarmupFeedback');
    expect(localBridge).toContain('startLocalQwen35PrefetchFeedback');
    expect(chatRuntime).not.toContain('本地 4B 已接到任务，正在连接本机 llama.cpp。');
    expect(chatRuntime).not.toContain('正在查询实时天气数据');
    expect(chatRuntime).not.toContain('首次启动会加载 4B 权重');
    expect(chatRuntime).not.toContain('这不是常态，后续回答通常会明显更快');
    expect(chatRuntime).not.toContain('刚启动后的第一问，本地 4B 正在暖机');
    expect(chatRuntime).not.toContain('正在预热本地上下文');
    expect(chatRuntime).not.toContain('还在等待首字');
    expect(chatRuntime).not.toContain('这次工具耗时偏长');
    expect(assistantMessage).toContain('modelLabel={agentModelLabel}');
    expect(thinkingBlock).toContain('isLocalModelThinking');
    expect(thinkingBlock).toContain('本地模型正在本机生成答案');
    expect(thinkingBlock).toContain('首次启动后的第一问可能较慢');
    expect(thinkingBlock).not.toContain('马上给出结果');
    expect(inputArea).toContain('本地端点已就绪，正在生成首个回答');
    expect(inputArea).toContain('首次暖机提示');
    expect(inputArea).toContain('本地 Qwen3.5-9B 刚启动时要加载权重和预热上下文');
    expect(inputArea).toContain('服务累计处理');
    expect(read('desktop/src/react/components/StatusBar.tsx')).toContain('服务累计处理');
    expect(read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx')).toContain('服务累计处理');
    expect(inputArea).not.toContain('本进程累计');
    expect(read('desktop/src/react/components/StatusBar.tsx')).not.toContain('本进程累计');
    expect(inputArea).not.toContain('首次启动后的第一问正在暖机，可能 30-60 秒；后续会明显更快。');
    expect(inputArea).not.toContain('可接收');
  });
});
