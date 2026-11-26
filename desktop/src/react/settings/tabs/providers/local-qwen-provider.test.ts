import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Local Qwen provider UX guards', () => {
  it('explains detected capacity and never bypasses installation memory checks', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    const choice = read('desktop/src/react/components/input/LocalModelSetupChoice.tsx');
    expect(source).toContain('nvidia-smi');
    expect(source).toContain('不叠加多卡');
    expect(source).toContain('13GB 容量不足');
    expect(source).toContain('selectedTier.minimumMemoryGib');
    expect(source).not.toContain('!manualTierId && !endpointRunning');
    expect(choice).toContain('手动选档不能跳过显存检查');
    expect(choice).not.toContain('已了解显存要求，手动选择此方案');
  });
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

  it('uses hardware-adaptive Q3/Q2 defaults and keeps legacy tiers separate', () => {
    const source = read('server/routes/local-qwen35.ts');
    expect(source).not.toContain('qwen36-27b-q4km-imatrix');
    // Existing Q4 identifiers remain readable; they are not the new default.
    expect(source).toContain('local-qwen35-9b-q4km-imatrix');
    expect(source).toContain('qwen36-27b-dsv4pro-coding-q4-mtp');
    expect(source).toContain('Q4-imatrix-MTP-00001-of-00004.gguf');
    expect(source).toContain('detectLocalModelHardware');
    expect(source).toContain('detected.recommended_model_id');
    expect(source).toContain('can_enable: usable');
    expect(source).not.toContain('id: "qwen35-9b-q4km-imatrix"');
    expect(source).not.toContain('id: "qwen35-4b-q4km"');
    expect(source).not.toContain('低配降级');
    // 35B = 32GB+ DS-V4-Pro thinking distilled orchestrator with objective metrics.
    expect(source).toContain('qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix');
    expect(source).toContain('DSV4Pro Thinking Distill');
    expect(source).toContain('GPQA-Diamond 80.3%');
    expect(source).toContain('端到端编排 26.6s');
    expect(source).toContain('32GB 显存/统一内存+ 可选');
    expect(source).toContain('默认推荐 Qwen3.8-27B Coder390：24GB 及以上 Q3，24GB 以下（16GB 档） Q2。');
    expect(source).not.toContain('默认仍首推 27B Q4');
    expect(source).not.toContain('Spark/远端兜底');
    expect(source).toContain('https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF');
    expect(source).toContain('下载到本机');
    expect(source).toContain('Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf');
    expect(source).toContain('LOCAL_QWEN35_RUNTIME_POLICY');
    expect(source).toContain('warm_pool_default: false');
    expect(source).toContain('idle_unload: true');
    expect(source).toContain('tool_schema_limit');
    expect(source).toContain('failure_fallback_provider');
    expect(source).toContain('step-3.7-flash');
  });

  it('makes advanced local models actionable instead of passive cards', () => {
    const source = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    const helper = read('desktop/src/react/settings/tabs/providers/ProviderDetail.helpers.ts');
    const renderedSource = `${source}\n${helper}`;
    expect(source).not.toContain('Coding100 82/100');
    expect(source).toContain('评测详见模型卡');
    expect(source).not.toContain('LBC100 71/100');
    expect(source).toContain('GUI 交互优先');
    expect(source).toContain('本地单并发');
    expect(source).toContain('忙时 CLI 转 StepFun');
    expect(source).toContain('QoS 单槽:本地忙时跳过 Spark');
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
    expect(source).toContain('24GB 及以上是 Q3，24GB 以下（16GB 档）是 Q2');
    expect(source).not.toContain('9B、4B 仅作为低配降级');
    expect(renderedSource).not.toContain('thinking-on 可能长思考后无正文');
    expect(source).toContain('localModelActionErrorText');
  });

  it('keeps local model IPC commands explicit and guarded', () => {
    const main = read('desktop/main.cjs');
    const localModelController = read('desktop/local-model-controller.cjs');
    const preload = read('desktop/preload.cjs');
    const profiles = read('desktop/llamacpp-profiles.cjs');
    const controller = read('desktop/src/react/components/input/useLocalQwenStatusController.ts');
    const detail = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(main).toContain('createLocalModelController');
    expect(localModelController).toContain('const LOCAL_MODEL_IPC = Object.freeze');
    expect(localModelController).toContain('parseStartDownloadPayload');
    expect(localModelController).toContain('download-boundary-invalid');
    expect(localModelController).toContain('model-path-not-allowed');
    expect(localModelController).toContain('isLocalModelPathAllowed');
    expect(localModelController).toContain('startup auto-start disabled');
    expect(localModelController).toContain('binaryPath = new LlamaCppManager({ lynnHome }).resolveBinaryPath()');
    expect(localModelController).toContain('LYNN_LOCAL_MODEL_AUTO_START === "1"');
    expect(localModelController).toContain('parsedPayload.startAfterDownload || profile.autoStart');
    expect(profiles).toContain('...QWEN38_PROFILES');
    expect(profiles).toContain('autoStart: false');
    expect(controller).toContain('startAfterDownload: true');
    expect(detail).toContain('startAfterDownload: true');
    expect(detail).toContain('observed.llama_server || llamaState.binaryPath');
    expect(preload).toContain('llamacppStartDownload: (payload)');
    expect(preload).toContain('llamacppStartCustomModel: (modelPath)');
  });

  it('downloads the recommended 27B default and 35B high-end models through Lynn with checksum and parallel ranges', () => {
    const profiles = read('desktop/llamacpp-profiles.cjs');
    const downloader = read('desktop/model-downloader.cjs');
    const preload = read('desktop/preload.cjs');
    expect(profiles).toContain('qwen36-27b-dsv4pro-coding-q4-mtp');
    expect(profiles).toContain('19_575_379_360');
    expect(profiles).toContain('49d0384e09242c3ea301e09ce79566cf085abbbef3f8ea83f7a6335fb473cab6');
    expect(downloader).toContain('defaultCatalog.modelCardUrl');
    expect(profiles).toContain('DEFAULT_CODING_27B_Q4_FILES');
    // 2026-06-27: canonical 35B high-end = DS-V4-Pro thinking distilled Q5_K_M MTP;old 35B ids remain backward-compatible aliases.
    expect(profiles).toContain('qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix');
    expect(profiles).toContain('25_347_529_344');
    expect(profiles).toContain('7d47617afbf52fdb25e803f2d77cd22c65411741d165def0373f15a3fc5d68f7');
    expect(profiles).toContain('parallelSegments: 4');
    expect(profiles).toContain('Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf');
    expect(profiles).toContain('Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF');
    // legacy alias still maps old stored ids to the new canonical profile.
    expect(profiles).toContain('"qwen36-35b-a3b-q4km-imatrix": DISTILLED_35B_MODEL_ID');
    expect(profiles).toContain('"qwen36-35b-a3b-apex-mtp": DISTILLED_35B_MODEL_ID');
    expect(preload).toContain('llamacppStartDownload: (payload)');
    expect(downloader).toContain('_downloadFromSourceParallel');
    expect(downloader).toContain('"Range"');
  });

  it('keeps onboarding, status badge, and chat routing on the server-side local provider id', () => {
    const constants = read('desktop/src/react/onboarding/constants.ts');
    const onboardingStep = read('desktop/src/react/onboarding/steps/LocalModelDownloadStep.tsx');
    const badge = read('desktop/src/react/components/ProviderStatusBadge.tsx');
    expect(constants).toContain("providerName: 'local-qwen35-9b-q4km-imatrix'");
    expect(constants).toContain("defaultModelId: 'qwen38-27b-coder390-q3-lynnstyle'");
    expect(onboardingStep).toContain('/api/local-qwen35-9b/status');
    expect(onboardingStep).toContain('llamaState.startDownload');
    expect(onboardingStep).not.toContain('/api/local-qwen35-9b/setup');
    expect(onboardingStep).toContain('desktop-installer-required');
    expect(onboardingStep).toContain('canEnableDefault');
    expect(onboardingStep).toContain('hardwareNotRecommended');
    expect(badge).toContain('/api/local-qwen35-9b/status');
    expect(badge).not.toContain('/api/local-qwen35-9b/setup');
    expect(badge).not.toContain("LLAMACPP_PROVIDER_ID = 'llamacpp'");
    expect(onboardingStep).toContain('useLlamacppState');
  });

  it('keeps the status endpoint on the Python-free desktop downloader path', () => {
    const route = read('server/routes/local-qwen35.ts');
    expect(route).toContain('setup_backend: "desktop_llamacpp_manager"');
    expect(route).toContain('python_bootstrap_required: false');
    expect(route).toContain('local_model_downloader_available: true');
    expect(route).toContain('const status = await fastReadyPlan(runtime);');
    expect(route).toContain('LYNN_LOCAL_QWEN35_USE_BOOTSTRAP');
    expect(route).toContain('error: "desktop_downloader_required"');
    expect(route).toContain('旧版 Python bootstrap 不可用');
  });

  it('surfaces llama.cpp launch failures from the main chat local-model controller', () => {
    const controller = read('desktop/src/react/components/input/useLocalQwenStatusController.ts');
    const types = read('desktop/src/react/types.ts');
    expect(types).toContain('onLlamacppState?');
    expect(controller).toContain('onLlamacppState');
    expect(controller).toContain("managerStatus !== 'failed' && managerStatus !== 'crashed'");
    expect(controller).toContain('local-qwen-start-failed');
    expect(controller).toContain('setOptimisticStarting(false)');
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

  it('keeps local provider refresh callbacks stable to avoid status refresh flicker', () => {
    const providersTab = read('desktop/src/react/settings/tabs/ProvidersTab.tsx');
    const detail = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(providersTab).toContain('const refreshProviders = useCallback');
    expect(providersTab).toContain('onRefresh={refreshProviders}');
    expect(providersTab).not.toContain('onRefresh={async () => { await loadSettingsConfig(); await loadSummary(); }}');
    expect(detail).toContain('lastEndpointRefreshKeyRef');
    expect(detail).toContain("|| 'default-running'");
    expect(detail).toContain('lastEndpointRefreshKeyRef.current !== modelKey');
  });

  it('surfaces local llama.cpp realtime TPS without replacing cumulative token stats', () => {
    const route = read('server/routes/local-qwen35.ts');
    const localQwenController = read('desktop/src/react/components/input/useLocalQwenStatusController.ts');
    const localQwenStack = read('desktop/src/react/components/input/LocalQwenStatusStack.tsx');
    const localStatus = read('desktop/src/react/components/input/local-qwen-status.ts');
    const statusBar = read('desktop/src/react/components/StatusBar.tsx');
    const providerDetail = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    expect(route).toContain('predicted_tps');
    expect(route).toContain('tps_window_seconds');
    expect(route).toContain('tokens_predicted_total');
    expect(route).toContain('withMetricRates(parseMetrics(metricsText), pid)');
    expect(localStatus).toContain('deriveLocalQwenRuntimeState');
    expect(localStatus).toContain('predicted_tps');
    expect(localStatus).toContain('当前 ${predictedTps');
    expect(localStatus).toContain('服务累计处理');
    expect(localQwenStack).toContain('等待下一次采样');
    expect(localQwenController).toContain('intervalMs = active ? 3_000 : 15_000');
    expect(statusBar).toContain('formatTps');
    expect(statusBar).toContain("status.model.currentSpeed");
    expect(read('desktop/src/locales/zh.json')).toContain('当前 {speed}');
    expect(read('desktop/src/locales/en.json')).toContain('current {speed}');
    expect(providerDetail).toContain('formatLocalTps');
    expect(providerDetail).toContain('速度等待采样');
    expect(providerDetail).toContain('setInterval(() =>');
    expect(providerDetail).toContain('}, 3000)');
    expect(localStatus).toContain('服务累计处理');
    expect(statusBar).toContain("status.model.totalTokens");
    expect(read('desktop/src/locales/zh.json')).toContain('服务累计处理 {tokens} tokens');
    expect(providerDetail).toContain('服务累计处理');
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

  it('uses the Lynn 27B Coding Q4 MTP artifact for the default local download and keeps 9B as downgrade', () => {
    const profiles = read('desktop/llamacpp-profiles.cjs');
    const downloader = read('desktop/model-downloader.cjs');
    const route = read('server/routes/local-qwen35.ts');
    expect(profiles).toContain('Q4-imatrix-MTP-00001-of-00004.gguf');
    expect(profiles).toContain('revision: "2026-07-07-dsv4pro-glm52-sft-gpt55-rl-coding-q4-mtp"');
    expect(profiles).toContain('ed8bdbded5e70d6c960f98117acd91f199b0df1e064a51eb4fce0a8abb7318c8');
    expect(downloader).toContain('Merkyor/Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-GGUF');
    expect(downloader).toContain('nerkyor/Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-GGUF');
    expect(profiles).toContain('Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf');
    expect(profiles).toContain('revision: "2026-05-28-mtp"');
    expect(profiles).toContain('supersedesFileNames');
    expect(profiles).toContain('Qwen3.5-9B-Q4_K_M-imatrix.gguf');
    expect(profiles).toContain('0f292ba0d1058065a6624883a76a2adf00b266d07b9396ed67b155ff522e18d4');
    expect(route).not.toContain('Qwen3.5-9B Q4_K_M imatrix MTP');
    expect(route).not.toContain('Qwen3.5-4B Q4_K_M imatrix (低配降级)');
    expect(route).not.toContain('Qwen3.5-4B Q4_K_M (unsloth)');
  });

  it('detects older 9B GGUF files as upgrade candidates instead of default-ready 27B MTP', () => {
    const panel = read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx');
    const bootstrap = read('scripts/local_qwen35_9b_client_bootstrap.py');
    const setup = read('scripts/local_qwen35_9b_setup.sh');
    expect(panel).toContain("modelFileName === selectedTier.fileName.split('/').pop()");
    expect(panel).toContain('needs_model_upgrade');
    expect(panel).toContain('安装 ${selectedTier.quantization} 并启动');
    expect(panel).toContain('旧版模型');
    expect(panel).toContain('Coder390 Q3/Q2 待下载');
    expect(panel).not.toContain('9B 或 4B');
    expect(panel).toContain('llamacppStartDownload');
    expect(bootstrap).toContain('LEGACY_MODEL_FILE_NAMES');
    expect(setup).toContain('find_legacy_gguf');
  });

  it('keeps local model progress out of model-visible thinking', () => {
    const route = read('server/routes/chat.ts');
    const localBridge = read('server/chat/local-model-bridge.ts');
    const chatRuntime = `${route}\n${localBridge}`;
    const thinkingBlock = read('desktop/src/react/components/chat/ThinkingBlock.tsx');
    const assistantMessage = read('desktop/src/react/components/chat/AssistantMessage.tsx');
    const inputArea = read('desktop/src/react/components/InputArea.tsx');
    const localQwenController = read('desktop/src/react/components/input/useLocalQwenStatusController.ts');
    const localQwenStack = read('desktop/src/react/components/input/LocalQwenStatusStack.tsx');
    const localStatus = read('desktop/src/react/components/input/local-qwen-status.ts');
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
    expect(localQwenController).toContain('本地端点已就绪，正在生成首个回答');
    expect(localQwenStack).toContain('首次暖机提示');
    expect(localQwenStack).toContain('本地 Qwen3.8-27B 刚启动时要加载权重和预热上下文');
    expect(localStatus).toContain('服务累计处理');
    expect(read('desktop/src/react/components/StatusBar.tsx')).toContain('status.model.totalTokens');
    expect(read('desktop/src/react/settings/tabs/providers/ProviderDetail.tsx')).toContain('服务累计处理');
    expect(inputArea).not.toContain('本进程累计');
    expect(read('desktop/src/react/components/StatusBar.tsx')).not.toContain('本进程累计');
    expect(inputArea).not.toContain('首次启动后的第一问正在暖机，可能 30-60 秒；后续会明显更快。');
    expect(inputArea).not.toContain('可接收');
  });

  it('keeps local installation in settings without promoting it in chat', () => {
    const localQwenStack = read('desktop/src/react/components/input/LocalQwenStatusStack.tsx');
    expect(localQwenStack).not.toContain('安装并启动');
    expect(localQwenStack).not.toContain('7 天后提醒');
    expect(localQwenStack).toContain('onClick={props.onStart}>{L(\'启动\', \'Start\')}</button>');
  });
});
