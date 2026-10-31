import path from "node:path";
import { registerCreatedToolFiles } from "../../lib/session-tool-files.js";
import { isPrivateHost } from "../../shared/network-address.cjs";
import { modelStreamFetch } from "../../shared/model-stream-fetch.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { sanitizeMessagesBeforePrompt } from "../session-prompt-sanitizer.js";
import { normalizeToolAliasName } from "../engine-tool-runtime.js";
import {
  filterOutBrainManagedCustomTools,
  isBrainManagedCustomToolName,
} from "../brain-managed-tools.js";
import { isBrainProvider } from "../../shared/brain-provider.js";
import { brainToolEvidenceMessages } from "../../shared/brain-tool-evidence.js";
import { readModelCallTimeouts, resolveModelCallTimeouts } from "./model-call-timeouts.js";
import {
  STEP_EXECUTE_TOOL_NAME,
  ModelCallTimeoutError,
  ModelCallStreamError,
  appendToolDelta,
  asRecord,
  buildFallbackSynthesisMessages,
  buildPromptUserContent,
  buildRequestBody,
  buildStepExecutorPolicyPrompt,
  chatCompletionsUrl,
  contentToText,
  countAnyStepDelegationEvidenceToolMessages,
  countUsableStepDelegationEvidenceToolMessages,
  createTimedSignal,
  eventError,
  eventTextDelta,
  eventThinkingDelta,
  extractToolCallsFromContent,
  fallbackInstruction,
  fallbackInstructionWithToolUse,
  fallbackModelCallTimeoutMs,
  fallbackRank,
  finalizeToolCalls,
  hasAnyToolEvidence,
  isExecutableToolCall,
  isStepExecutorModel,
  isUnsafeFinalAnswerText,
  latestUserQuestion,
  maybeJson,
  maybeString,
  modelIdentity,
  normalizeFinalAnswerText,
  normalizeToolCallForExecution,
  normalizeToolResult,
  normalizeTools,
  parsePayload,
  parseSseBlocks,
  roleMessage,
  stringField,
  toolNameKey,
  toolResultToMessageContent,
  type ModelCallOptions,
  type ModelFallbackReason,
  type RuntimeTool,
  type StreamToolCallAccumulator,
} from "./session-runtime-helpers.js";
import {
  filterToolsForTurn,
  hasExplicitDeliverableIntent,
  hasExplicitImageToolIntent,
  hasTaskToolIntent,
  isStructurallyCompletePartialAnswer,
  shouldRecoverIncompleteVisibleAnswer,
} from "./turn-tool-policy.js";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  Api,
  ChatAssistantToolCall,
  ChatMessage,
  ImageContent,
  LoadExtensionsResult,
  MessageContent,
  Model,
  PromptOptions,
  ResourceLoader,
  TextContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./types.js";

export interface LynnCreateAgentSessionOptions {
  cwd?: string;
  agentDir?: string;
  authStorage?: unknown;
  modelRegistry?: ModelRegistry;
  model?: Model | null;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Record<string, unknown>;
  tools?: ToolDefinition[];
  customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader;
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  requestHeaders?: Record<string, string>;
  getRequestHeaders?: (model: Model) => Record<string, string>;
  requestMetadata?: Record<string, unknown>;
  getModelCallTimeouts?: () => unknown;
  [key: string]: unknown;
}

const NO_REMAINING_CONTENT_RE = /^(?:(?:没有|无)(?:可继续输出的|可补充的|更多的)?(?:剩余)?(?:正文|内容)|(?:正文|内容)(?:已经)?(?:完整|结束))(?:[。.!！])?$/u;

export class LynnAgentSession {
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly resourceLoader: ResourceLoader;
  readonly modelRegistry?: ModelRegistry;
  readonly scopedModels?: Record<string, unknown>;
  readonly requestHeaders: Record<string, string>;
  private readonly getRequestHeaders?: (model: Model) => Record<string, string>;
  private readonly requestHeaderOrigin: string | undefined;
  readonly requestMetadata?: Record<string, unknown>;
  private readonly getModelCallTimeouts: () => unknown;
  readonly messages: ChatMessage[] = [];
  readonly agent: { state: { messages: ChatMessage[] }; replaceMessages: (messages: ChatMessage[]) => void };
  retryAttempt = 0;
  isStreaming = false;
  model: Model;
  thinkingLevel: ThinkingLevel;
  _customTools: RuntimeTool[];
  _baseToolsOverride: RuntimeTool[] | Record<string, RuntimeTool> | null = null;

  private readonly fallbackBaseTools: RuntimeTool[];
  private readonly fallbackCustomTools: RuntimeTool[];
  private tools: RuntimeTool[];
  private listeners = new Set<AgentSessionEventListener>();
  private readonly textToolCallIds = new Set<string>();
  private abortController: AbortController | null = null;
  private pendingPrompts: Array<{ prompt: string; options?: PromptOptions }> = [];
  private activeTurnModel: Model | null = null;
  private disposed = false;
  private stepExecuteDepth = 0;
  private activeTurnAllowsDeliverables = true;
  private activeTurnAllowsImageTools = true;
  private activeTurnAllowsTaskTools = true;

  constructor(options: LynnCreateAgentSessionOptions = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.sessionManager = options.sessionManager || SessionManager.create(this.cwd);
    this.settingsManager = options.settingsManager || SettingsManager.inMemory();
    this.resourceLoader = options.resourceLoader || new DefaultResourceLoader({ cwd: this.cwd, agentDir: options.agentDir });
    this.modelRegistry = options.modelRegistry;
    const fallbackModel = this.modelRegistry?.getAll?.()[0] || {
      provider: "brain",
      id: "default",
      api: "openai-completions" as Api,
      baseUrl: "",
      apiKey: "local",
    };
    this.model = (options.model || fallbackModel) as Model;
    this.thinkingLevel = options.thinkingLevel || "auto";
    this.scopedModels = options.scopedModels as Record<string, unknown> | undefined;
    this.requestHeaders = options.requestHeaders || {};
    this.getRequestHeaders = options.getRequestHeaders;
    try { this.requestHeaderOrigin = new URL(chatCompletionsUrl(this.model)).origin; }
    catch { this.requestHeaderOrigin = undefined; }
    this.requestMetadata = options.requestMetadata;
    this.getModelCallTimeouts = options.getModelCallTimeouts || readModelCallTimeouts;
    this.fallbackBaseTools = normalizeTools(options.tools);
    this.fallbackCustomTools = normalizeTools(options.customTools);
    this.tools = isBrainProvider(this.model?.provider)
      ? filterOutBrainManagedCustomTools(this.fallbackBaseTools)
      : [...this.fallbackBaseTools];
    this._customTools = isBrainProvider(this.model?.provider)
      ? filterOutBrainManagedCustomTools(this.fallbackCustomTools)
      : [...this.fallbackCustomTools];
    this.agent = {
      state: { messages: this.messages },
      replaceMessages: (messages: ChatMessage[]) => {
        this.messages.splice(0, this.messages.length, ...messages);
        this.agent.state.messages = this.messages;
      },
    };
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.clearQueue();
    this.sessionManager.close();
    this.abort();
    this.listeners.clear();
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.isStreaming = false;
  }

  clearQueue(): void {
    this.pendingPrompts = [];
  }

  async prompt(prompt: string, options?: PromptOptions): Promise<void> {
    if (this.disposed) throw new Error("Session is closed");
    if (this.isStreaming) {
      const behavior = String(options?.streamingBehavior || "");
      if (behavior === "steer" || behavior === "followUp") {
        this.pendingPrompts.push({
          prompt,
          options: { ...options, streamingBehavior: undefined },
        });
        return;
      }
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    const userMessage = roleMessage("user", buildPromptUserContent(prompt, options));
    this.sessionManager.appendMessage(userMessage);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
    this.activeTurnAllowsDeliverables = hasExplicitDeliverableIntent(prompt);
    this.activeTurnAllowsImageTools = hasExplicitImageToolIntent(prompt);
    this.activeTurnAllowsTaskTools = hasTaskToolIntent(prompt);
    this.activeTurnModel = options?.modelOverride || null;
    try {
      await this.runTurn();
    } finally {
      this.activeTurnModel = null;
      this.drainPendingPrompts();
    }
  }

  async steer(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, { ...options, streamingBehavior: "steer" });
  }

  async followUp(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, { ...options, streamingBehavior: "followUp" });
  }

  async sendUserMessage(prompt: string, options?: PromptOptions): Promise<void> {
    return this.prompt(prompt, options);
  }

  async sendCustomMessage(message: ChatMessage): Promise<void> {
    this.sessionManager.appendMessage(message);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
  }

  async compact(): Promise<void> {
    if (this.isStreaming) throw new Error("Wait for the current answer before compacting the conversation");
    const entries = this.sessionManager.getBranch().filter(entry => entry.type === "message");
    const users = entries.flatMap((entry, index) => (entry.message as ChatMessage)?.role === "user" ? [index] : []);
    if (users.length <= 4) return;
    const cut = users[users.length - 4];
    const older = entries.slice(0, cut);
    const usage = this.getContextUsage();
    // Bounded extractive compaction remains available even when a model's window
    // is already full. Keep whole recent user turns, including their tool pairs.
    const bounded = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit / 2)}\n[omitted middle]\n${text.slice(-limit / 2)}`;
    const summary = bounded(older.map(entry => {
      const message = entry.message as ChatMessage;
      return `${message.role}: ${bounded(contentToText(message.content), 1600)}`;
    }).join("\n\n"), 16_000);
    this.sessionManager.appendCompaction(summary, entries[cut].id, Number(usage.usedTokens), { strategy: "extractive" });
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages);
    this.emit({ type: "auto_compaction_end", tokensBefore: usage.usedTokens, tokensAfter: this.getContextUsage().usedTokens });
  }

  async newSession(): Promise<void> {
    this.agent.replaceMessages([]);
  }

  setModel(model: Model): void {
    this.model = model;
    const isBrain = isBrainProvider(model?.provider);
    this.tools = isBrain ? filterOutBrainManagedCustomTools(this.fallbackBaseTools) : [...this.fallbackBaseTools];
    this._customTools = isBrain ? filterOutBrainManagedCustomTools(this.fallbackCustomTools) : [...this.fallbackCustomTools];
    if (isBrain && Array.isArray(this._baseToolsOverride)) {
      this._baseToolsOverride = filterOutBrainManagedCustomTools(this._baseToolsOverride);
    } else if (isBrain && this._baseToolsOverride && typeof this._baseToolsOverride === "object") {
      this._baseToolsOverride = Object.fromEntries(
        Object.entries(this._baseToolsOverride)
          .filter(([, tool]) => !isBrainManagedCustomToolName(tool?.name)),
      );
    }
    this.sessionManager.appendModelChange(model.provider, model.id);
  }

  cycleModel(): Model {
    const models = this.modelRegistry?.getAll?.() || [];
    if (!models.length) return this.model;
    const index = Math.max(0, models.findIndex((candidate) => candidate.provider === this.model.provider && candidate.id === this.model.id));
    this.setModel(models[(index + 1) % models.length]);
    return this.model;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
    this.sessionManager.appendThinkingLevelChange(String(level));
  }

  cycleThinkingLevel(): ThinkingLevel {
    const levels = this.getAvailableThinkingLevels();
    const index = Math.max(0, levels.indexOf(this.thinkingLevel));
    const next = levels[(index + 1) % levels.length];
    this.setThinkingLevel(next);
    return next;
  }

  getAvailableThinkingLevels(): ThinkingLevel[] {
    return ["none", "low", "medium", "high", "auto"];
  }

  supportsThinking(): boolean {
    return this.model.reasoning === true;
  }

  supportsXhighThinking(): boolean {
    return false;
  }

  setSteeringMode(): void {}
  setFollowUpMode(): void {}

  getAllTools(): RuntimeTool[] {
    const override = this._baseToolsOverride;
    const base = Array.isArray(override)
      ? override
      : override && typeof override === "object"
        ? Object.values(override)
        : this.tools;
    const activeModel = this.activeTurnModel || this.model;
    const tools = isBrainProvider(activeModel?.provider)
      ? filterOutBrainManagedCustomTools([...base, ...this._customTools])
      : [...base, ...this._customTools];
    const stepExecute = this._baseToolsOverride != null && !base.some(tool => toolNameKey(tool.name) === "bash")
      ? null : this.createStepExecuteTool();
    if (stepExecute && !tools.some((tool) => toolNameKey(tool.name) === toolNameKey(STEP_EXECUTE_TOOL_NAME))) {
      tools.push(stepExecute);
    }
    return tools;
  }

  private getFallbackTools(): RuntimeTool[] {
    const allowed = new Set(this.getActiveToolNames());
    return [...this.fallbackBaseTools.filter(tool => allowed.has(tool.name)), ...this.fallbackCustomTools];
  }

  private findStepExecutorModel(): Model | null {
    const activeModel = this.activeTurnModel || this.model;
    if (isStepExecutorModel(activeModel)) return null;
    const models = this.modelRegistry?.getAll?.() || [];
    return models.find((candidate) => {
      if (!candidate || isBrainProvider(candidate.provider)) return false;
      if (!isStepExecutorModel(candidate)) return false;
      if (modelIdentity(candidate) === modelIdentity(activeModel)) return false;
      return Boolean(candidate.baseUrl || candidate.baseURL);
    }) || null;
  }

  private createStepExecuteTool(): RuntimeTool | null {
    const stepModel = this.findStepExecutorModel();
    if (!stepModel) return null;
    return {
      name: STEP_EXECUTE_TOOL_NAME,
      description: [
        "Step 3.7 Flash 是高速执行/总结器；把一个明确子任务交给它完成。",
        "当已有搜索/行情/赛程/天气等工具证据、需要整理表格/列表/代码/文档，或工具调用已超过 1 次仍需形成答案时优先调用。",
        "只传一个清晰可执行的 task 和必要 context；闲聊、澄清、复查、文件修改/删除、命令执行、付款等有副作用任务不要调用。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "要交给 Step 3.7 Flash 执行的明确子任务。",
          },
          context: {
            type: "string",
            description: "必要上下文或已知事实，保持精简。",
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
      execute: async (_toolCallId, params) => this.executeStepTask(stepModel, params),
    };
  }

  private shouldAutoDelegateToStep(messages: ChatMessage[], round: number): boolean {
    if (isStepExecutorModel(this.activeTurnModel || this.model)) return false;
    if (!this.findStepExecutorModel()) return false;
    const anyEvidenceToolCount = countAnyStepDelegationEvidenceToolMessages(messages);
    const evidenceToolCount = countUsableStepDelegationEvidenceToolMessages(messages);
    if (anyEvidenceToolCount > 0 && evidenceToolCount === 0) return true;
    if (evidenceToolCount >= 2) return true;
    return round >= 2 && evidenceToolCount >= 1;
  }

  private async executeStepTask(stepModel: Model, params: unknown): Promise<ToolResult> {
    if (this.stepExecuteDepth > 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "step_execute 已在执行中，避免递归调用。" }],
      };
    }
    const record = asRecord(params);
    const task = stringField(record, ["task", "prompt", "instruction", "query"]) || latestUserQuestion(this.messages);
    const context = stringField(record, ["context", "evidence", "background", "notes"]);
    if (!task) {
      return {
        isError: true,
        content: [{ type: "text", text: "step_execute 缺少可执行的 task。" }],
      };
    }
    const messages: ChatMessage[] = [
      roleMessage("system", [
        "你是 Step 3.7 Flash 执行器。",
        "你的职责是完成调用方交给你的一个明确子任务，并返回可直接使用的结果。",
        "不要调用工具，不要解释内部路由；如果信息不足，列出已知内容和缺口。",
      ].join("\n")),
      roleMessage("user", [
        `任务：${task}`,
        context ? `\n上下文：\n${context}` : "",
        "\n请输出简明、可执行、可直接交回主模型使用的结果。",
      ].filter(Boolean).join("\n")),
    ];
    this.stepExecuteDepth += 1;
    try {
      const result = await this.callModel(messages, {
        model: stepModel,
        tools: [],
        streamText: false,
        timeoutMs: fallbackModelCallTimeoutMs(),
      });
      const text = contentToText(result.assistant.content).trim();
      if (!text) {
        return {
          isError: true,
          content: [{ type: "text", text: "Step 3.7 Flash 执行器没有返回可见内容。" }],
        };
      }
      return {
        content: [{ type: "text", text: `Step 3.7 Flash 执行结果：\n${text}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Step 3.7 Flash 执行器失败：${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    } finally {
      this.stepExecuteDepth -= 1;
    }
  }

  getActiveToolNames(): string[] {
    return this.getAllTools().map((tool) => tool.name);
  }

  private resolveToolByName(name: string, tools = this.getAllTools()): RuntimeTool | undefined {
    const exact = tools.find((candidate) => candidate.name === name);
    if (exact) return exact;
    const normalized = normalizeToolAliasName(name);
    if (!normalized) return undefined;
    return tools.find((candidate) => normalizeToolAliasName(candidate.name) === normalized);
  }

  setActiveToolsByName(names: string[]): void {
    const allow = new Set(names);
    this._baseToolsOverride = Object.fromEntries(this.tools.filter((tool) => allow.has(tool.name)).map((tool) => [tool.name, tool]));
  }

  getSessionStats(): Record<string, unknown> {
    return { messages: this.messages.length, model: `${this.model.provider}/${this.model.id}` };
  }

  getContextUsage(): Record<string, unknown> {
    return { usedTokens: Math.ceil(JSON.stringify(this.messages).length / 4), maxTokens: this.model.contextWindow || 0, estimated: true };
  }

  _buildRuntime(opts?: { activeToolNames?: string[]; signal?: AbortSignal }): Record<string, unknown> {
    if (Array.isArray(opts?.activeToolNames)) {
      const allowed = new Set(opts.activeToolNames);
      const base = this._baseToolsOverride == null ? this.tools : Object.values(this._baseToolsOverride);
      this._baseToolsOverride = Object.fromEntries(base.filter((tool) => allowed.has(tool.name)).map((tool) => [tool.name, tool]));
      this._customTools = this._customTools.filter((tool) => allowed.has(tool.name));
    }
    return {
      cwd: this.cwd,
      session: this,
      sessionManager: this.sessionManager,
      signal: opts?.signal || this.abortController?.signal,
    };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener failures should not break the turn.
      }
    }
  }

  private finishAssistantAnswer(
    content: string,
    reasoning: string | undefined,
    opts: { streamedText?: boolean; contentDeltas?: string[] } = {},
  ): void {
    const finalContent = normalizeFinalAnswerText(content);
    if (!opts.streamedText) {
      // Buffered model paths have not exposed any content yet, so emit only
      // the normalized final answer. Replaying raw provider chunks here can
      // re-introduce <reflect> scaffolding that normalization intentionally
      // removed from the persisted message.
      if (finalContent) this.emit(eventTextDelta(finalContent));
    }
    const finalMessage: ChatMessage = {
      role: "assistant",
      content: finalContent,
      reasoning_content: reasoning || undefined,
    };
    this.sessionManager.appendMessage(finalMessage);
    this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
    this.emit({ type: "message_end", role: "assistant", message: finalMessage });
    this.emit({ type: "agent_end", messages: this.messages });
  }

  private fallbackModels(currentModel: Model): Model[] {
    const models = this.modelRegistry?.getAll?.() || [];
    const blocked = new Set([modelIdentity(currentModel), modelIdentity(this.model)]);
    const seen = new Set<string>();
    return models
      .map((model) => ({ model, rank: fallbackRank(model), identity: modelIdentity(model) }))
      .filter(({ model, rank, identity }) => {
        const crossProvider = model.provider !== currentModel.provider;
        const isLocal = (candidate: Model) => {
          if (/^local(?:-|$)/i.test(candidate.provider)) return true;
          try { return isPrivateHost(new URL(candidate.baseUrl || candidate.baseURL || "").hostname); } catch { return false; }
        };
        if (crossProvider && (currentModel.compat?.allowCrossProviderFallback !== true || isLocal(currentModel))) return false;
        if (isLocal(currentModel) && (model.baseUrl || model.baseURL) !== (currentModel.baseUrl || currentModel.baseURL)) return false;
        if (!Number.isFinite(rank) || blocked.has(identity) || seen.has(identity)) return false;
        if (!model.baseUrl && !model.baseURL) return false;
        seen.add(identity);
        return true;
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ model }) => model);
  }

  private emitFallbackRoute(activeModel: Model, fromModel: Model, reason: ModelFallbackReason): void {
    this.emit({
      type: "provider_meta",
      activeProvider: activeModel.id || activeModel.provider,
      fallbackFrom: [{
        id: fromModel.id || fromModel.provider,
        provider: fromModel.provider,
        reason,
      }],
    });
  }

  private async finishWithFallback(
    baseMessages: ChatMessage[],
    reason: ModelFallbackReason,
    fromModel: Model,
    turnSignal?: AbortSignal,
  ): Promise<boolean> {
    if (turnSignal?.aborted) return false;
    const candidates = hasAnyToolEvidence(baseMessages)
      ? [fromModel, ...this.fallbackModels(fromModel)]
      : this.fallbackModels(fromModel);
    let sharedMessages = [...baseMessages];
    for (const candidate of candidates) {
      try {
        if (turnSignal?.aborted) return false;
        this.emitFallbackRoute(candidate, fromModel, reason);
        const existingAnyEvidence = hasAnyToolEvidence(sharedMessages);
        const availableFallbackTools = this.getFallbackTools();
        const allowTools = !existingAnyEvidence && availableFallbackTools.length > 0;
        const fallbackTools = allowTools ? availableFallbackTools : [];
        let workingMessages = existingAnyEvidence
          ? buildFallbackSynthesisMessages(sharedMessages, reason)
          : [
            ...sharedMessages,
            roleMessage("user", allowTools ? fallbackInstructionWithToolUse(reason) : fallbackInstruction(reason)),
          ];
        const maxFallbackToolRounds = allowTools ? 1 : 0;
        for (let round = 0; round <= maxFallbackToolRounds; round += 1) {
          const result = await this.callModel(workingMessages, {
            model: candidate,
            tools: round < maxFallbackToolRounds ? fallbackTools : [],
            streamText: false,
            timeoutMs: fallbackModelCallTimeoutMs(),
          });
          if (turnSignal?.aborted) return false;
          result.toolCalls = result.toolCalls.filter(isExecutableToolCall);
          const content = normalizeFinalAnswerText(contentToText(result.assistant.content));
          if (content.trim() && !isUnsafeFinalAnswerText(content, { hasToolEvidence: hasAnyToolEvidence(workingMessages) })) {
            this.finishAssistantAnswer(content, result.reasoning, {
              streamedText: false,
            });
            return true;
          }
          if (!result.toolCalls.length || round >= maxFallbackToolRounds) break;
          const assistantForHistory: ChatMessage = {
            role: "assistant",
            content: "",
            tool_calls: result.toolCalls as ChatAssistantToolCall[],
          };
          workingMessages.push(assistantForHistory);
          this.sessionManager.appendMessage(assistantForHistory);
          this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
          for (const toolCall of result.toolCalls) {
            const toolResult = await this.executeToolCall(toolCall, fallbackTools, turnSignal);
            if (turnSignal?.aborted) return false;
            const toolMessage: ChatMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: toolResultToMessageContent(toolResult),
            };
            workingMessages.push(toolMessage);
            this.sessionManager.appendMessage(toolMessage);
          }
          this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
          if (hasAnyToolEvidence(workingMessages)) {
            workingMessages = buildFallbackSynthesisMessages(workingMessages, reason);
          }
        }
        sharedMessages = workingMessages;
      } catch {
        // Try the next fallback model. The visible turn should end with either a
        // usable answer or the explicit safety fallback below, not intermediate noise.
      }
    }
    if (turnSignal?.aborted) return false;
    return false;
  }

  private async runTurn(): Promise<void> {
    this.isStreaming = true;
    const turnController = new AbortController();
    this.abortController = turnController;
    let fallbackMessages: ChatMessage[] = [];
    try {
      const turnModel = this.activeTurnModel || this.model;
      const stepExecutorPolicy = this.findStepExecutorModel() ? buildStepExecutorPolicyPrompt() : "";
      const system = [
        await maybeString(this.resourceLoader.getSystemPrompt?.()),
        await maybeString(this.resourceLoader.getAppendSystemPrompt?.()),
        stepExecutorPolicy,
      ].filter(Boolean).join("\n\n");
      const rawContext = this.sessionManager.buildSessionContext().messages || [];
      const sanitizedContext = sanitizeMessagesBeforePrompt(rawContext);
      if (sanitizedContext.removed > 0 || sanitizedContext.rewritten > 0) {
        this.agent.replaceMessages(sanitizedContext.messages);
      }
      const baseContext = sanitizedContext.messages;
      const messages: ChatMessage[] = system ? [{ role: "system", content: system }, ...baseContext] : [...baseContext];
      fallbackMessages = messages;
      const maxToolRounds = 3;
      for (let round = 0; round < maxToolRounds; round += 1) {
        const result = await this.callModel(messages, { model: turnModel });
        if (turnController.signal.aborted) return;
        result.toolCalls = result.toolCalls.filter(isExecutableToolCall);
        if (!result.toolCalls.length) {
          let content = normalizeFinalAnswerText(contentToText(result.assistant.content));
          let recoveredIncompleteAnswer = false;
          if (shouldRecoverIncompleteVisibleAnswer(content, result.reasoning.length, result.finishReason)) {
            const continuationMessages = [
              ...messages,
              ...(content ? [roleMessage("assistant", content)] : []),
              roleMessage("user", content
                ? "上一个可见回答在中途结束了。请从中断处继续完成，不要重新开头，不要调用工具，直接输出剩余正文。"
                : "上一个回答只返回了内部推理，没有可见结论。不要重复推理，不要调用工具，直接输出完整的最终答案。"),
            ];
            const continuation = await this.callModel(continuationMessages, {
              model: turnModel,
              tools: [],
              streamText: result.streamedText,
            });
            if (turnController.signal.aborted) return;
            const extra = normalizeFinalAnswerText(contentToText(continuation.assistant.content));
            if (extra.trim() && !(content.trim() && NO_REMAINING_CONTENT_RE.test(extra.trim()))) {
              content = `${content}${extra}`;
              recoveredIncompleteAnswer = true;
            }
          }
          if (!content.trim()) {
            const handled = await this.finishWithFallback(messages, "empty_response", turnModel, turnController.signal);
            if (handled) return;
            this.finishAssistantAnswer(
              "模型这次没有返回可见内容。本轮已安全结束，避免空回复污染后续上下文；请点击「编辑重发」重试，或换个更明确的问题。",
              result.reasoning,
              { streamedText: false },
            );
            return;
          }
          if (isUnsafeFinalAnswerText(content, { hasToolEvidence: hasAnyToolEvidence(messages) })) {
            const handled = await this.finishWithFallback(messages, "empty_response", turnModel, turnController.signal);
            if (handled) return;
            this.finishAssistantAnswer(
              "模型返回的答案与当前日期或已有证据冲突。本轮已停止输出以避免误导；请点击「编辑重发」重新查询。",
              result.reasoning,
              { streamedText: false },
            );
            return;
          }
          this.finishAssistantAnswer(content, result.reasoning, {
            streamedText: result.streamedText,
            contentDeltas: result.streamedText
              ? undefined
              : recoveredIncompleteAnswer ? [content] : result.contentDeltas,
          });
          return;
        }
        const assistantForHistory: ChatMessage = {
          role: "assistant",
          content: "",
          tool_calls: result.toolCalls as ChatAssistantToolCall[],
        };
        messages.push(assistantForHistory);
        this.sessionManager.appendMessage(assistantForHistory);
        this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
        for (const toolCall of result.toolCalls) {
          const toolResult = await this.executeToolCall(toolCall, undefined, turnController.signal);
          if (turnController.signal.aborted) return;
          const content = toolResultToMessageContent(toolResult);
          const toolMessage: ChatMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content,
          };
          messages.push(toolMessage);
          this.sessionManager.appendMessage(toolMessage);
        }
        this.agent.replaceMessages(this.sessionManager.buildSessionContext().messages || []);
        fallbackMessages = messages;
        if (this.shouldAutoDelegateToStep(messages, round)) {
          const handled = await this.finishWithFallback(messages, "tool_round_limit", turnModel, turnController.signal);
          if (handled) return;
        }
      }
      const handled = await this.finishWithFallback(messages, "tool_round_limit", turnModel, turnController.signal);
      if (handled) return;
      this.finishAssistantAnswer(
        "工具链已执行多轮但没有形成最终回复。本轮已安全结束，请缩小问题范围后重试。",
        undefined,
        { streamedText: false },
      );
    } catch (err) {
      const isAbortError = (err as any)?.name === "AbortError";
      if (turnController.signal.aborted) return;
      if (err instanceof ModelCallStreamError) {
        const partial = normalizeFinalAnswerText(err.partialContent);
        const hasEvidence = hasAnyToolEvidence(fallbackMessages);
        if (
          isStructurallyCompletePartialAnswer(partial)
          && !isUnsafeFinalAnswerText(partial, { hasToolEvidence: hasEvidence })
        ) {
          if (err.cause instanceof ModelCallTimeoutError) this.emit(eventError(err.cause.message));
          this.finishAssistantAnswer(partial, err.partialReasoning, { streamedText: err.streamedText });
          return;
        }
      }
      const handled = fallbackMessages.length
        ? await this.finishWithFallback(fallbackMessages, "model_error", this.activeTurnModel || this.model, turnController.signal)
        : false;
      if (handled) return;
      this.emit(eventError(isAbortError ? "aborted" : err instanceof Error ? err.message : String(err)));
      this.emit({ type: "agent_end", messages: this.messages });
    } finally {
      if (this.abortController === turnController) {
        this.isStreaming = false;
        this.abortController = null;
        this.activeTurnAllowsDeliverables = true;
        this.activeTurnAllowsImageTools = true;
        this.activeTurnAllowsTaskTools = true;
      }
    }
  }

  private drainPendingPrompts(): void {
    if (this.disposed || this.isStreaming || this.pendingPrompts.length === 0) return;
    const next = this.pendingPrompts.shift();
    if (!next) return;
    void this.prompt(next.prompt, next.options);
  }

  private async callModel(messages: ChatMessage[], options: ModelCallOptions = {}): Promise<{
    assistant: ChatMessage;
    toolCalls: ToolCall[];
    reasoning: string;
    contentDeltas: string[];
    streamedText: boolean;
    finishReason?: string | null;
  }> {
    if (this.disposed) throw new DOMException("Session is closed", "AbortError");
    const model = options.model || this.activeTurnModel || this.model;
    const tools = filterToolsForTurn(
      options.tools ?? this.getAllTools(),
      {
        allowDeliverables: this.activeTurnAllowsDeliverables,
        allowImageTools: this.activeTurnAllowsImageTools,
        allowTaskTools: this.activeTurnAllowsTaskTools,
      },
    );
    const streamTextImmediately = options.streamText ?? tools.length === 0;
    const body = buildRequestBody(model, messages, tools, this.thinkingLevel);
    if (options.tools?.length === 0) body.tool_choice = "none";
    const requestUrl = chatCompletionsUrl(model);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(new URL(requestUrl).origin === this.requestHeaderOrigin ? this.requestHeaders : {}),
      ...this.getRequestHeaders?.(model),
    };
    if (model.apiKey && !headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${model.apiKey}`;
    }
    const timeouts = resolveModelCallTimeouts(this.getModelCallTimeouts(), model.provider);
    if (options.timeoutMs != null) timeouts.totalMs = options.timeoutMs;
    const timed = createTimedSignal(this.abortController?.signal, timeouts);
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await modelStreamFetch(requestUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timed.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`LLM request failed: ${response.status} ${response.statusText}${text ? ` · ${text.slice(0, 500)}` : ""}`);
      }
      if (!response.body) throw new Error("LLM response did not include a stream body");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const toolDeltas = new Map<number, StreamToolCallAccumulator>();
      let buffer = "";
      let finishReason: string | null | undefined;
      streamLoop: while (true) {
        const { value, done } = await reader.read();
        timed.signal.throwIfAborted();
        if (done) break;
        if (value.byteLength > 0) timed.activity();
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;
        for (const payload of parsed.payloads) {
          if (payload === "[DONE]") break streamLoop;
          this.handleLynnSideEvent(payload, isBrainProvider(model.provider), messages);
          const chunk = parsePayload(payload);
          if (!chunk) continue;
          if (chunk.error && !chunk.choices) throw new Error(typeof chunk.error === "string" ? chunk.error : maybeJson(chunk.error));
          for (const choice of chunk.choices || []) {
            if (choice.finish_reason != null) finishReason = choice.finish_reason;
            const delta = choice.delta || choice.message || {};
            const reasoning = typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta.reasoning === "string" ? delta.reasoning : "";
            if (reasoning) {
              reasoningParts.push(reasoning);
              this.emit(eventThinkingDelta(reasoning));
            }
            if (typeof delta.content === "string" && delta.content) {
              textParts.push(delta.content);
              if (streamTextImmediately) this.emit(eventTextDelta(delta.content));
            }
            const rawToolCalls = delta.tool_calls || delta.toolCalls;
            if (Array.isArray(rawToolCalls)) {
              rawToolCalls.forEach((raw, index) => appendToolDelta(toolDeltas, raw, index));
            }
            const rawFunctionCall = delta.function_call || delta.functionCall;
            if (rawFunctionCall) {
              appendToolDelta(toolDeltas, { index: 0, function: rawFunctionCall }, 0);
            }
          }
        }
      }
      const content = textParts.join("");
      const toolCalls = finalizeToolCalls(toolDeltas);
      const allowsTextCalls = /^local(?:-|$)/i.test(model.provider)
        && (model.compat?.text_tool_calls === true || model.compat?.textToolCalls === true);
      const parsedContentToolCalls = toolCalls.length || !tools.length || !allowsTextCalls
        ? []
        : extractToolCallsFromContent(content, tools);
      for (const call of parsedContentToolCalls) this.textToolCallIds.add(call.id);
      return {
        assistant: { role: "assistant", content, reasoning_content: reasoningParts.join("") || undefined },
        toolCalls: toolCalls.length ? toolCalls : parsedContentToolCalls,
        reasoning: reasoningParts.join(""),
        contentDeltas: textParts,
        streamedText: streamTextImmediately,
        finishReason,
      };
    } catch (err) {
      const failure = timed.timeoutError() || err;
      if (textParts.length > 0) {
        throw new ModelCallStreamError(
          failure,
          textParts.join(""),
          reasoningParts.join(""),
          streamTextImmediately,
        );
      }
      throw failure;
    } finally {
      timed.cleanup();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }

  private handleLynnSideEvent(payload: string, trustedBrain: boolean, messages: ChatMessage[]): void {
    const parsed = parsePayload(payload);
    if (!parsed) return;
    if (parsed.object === "lynn.provider") {
      this.emit({ type: "provider_meta", meta: parsed.meta || {} });
    }
    if (parsed.object === "lynn.tool_progress" && trustedBrain) {
      const progress = asRecord(parsed.tool_progress);
      const evidenceMessages = brainToolEvidenceMessages({ ...progress, toolCall: progress.tool_call });
      if (evidenceMessages.length && !messages.some((message) => message.role === "tool" && message.tool_call_id === evidenceMessages[1].tool_call_id && message.content === evidenceMessages[1].content)) {
        for (const message of evidenceMessages) {
          messages.push(message);
          this.sessionManager.appendMessage(message);
        }
      }
      this.emit({
        type: "tool_progress",
        source: "brain",
        name: String(progress.name || ""),
        event: String(progress.event || ""),
        ms: typeof progress.ms === "number" ? progress.ms : undefined,
        ok: typeof progress.ok === "boolean" ? progress.ok : undefined,
        summary: typeof progress.summary === "string" ? progress.summary : undefined,
        details: Array.isArray(progress.details) ? progress.details : undefined,
        argsSummary: typeof progress.args_summary === "string" ? progress.args_summary : undefined,
      });
    }
  }

  private async executeToolCall(
    toolCall: ToolCall,
    tools = filterToolsForTurn(this.getAllTools(), {
      allowDeliverables: this.activeTurnAllowsDeliverables,
      allowImageTools: this.activeTurnAllowsImageTools,
      allowTaskTools: this.activeTurnAllowsTaskTools,
    }),
    signal = this.abortController?.signal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const normalized = normalizeToolCallForExecution(toolCall.function.name, toolCall.function.arguments, tools);
    // A turn may have started before a mode change. Never execute a tool that
    // has since been removed from the active runtime.
    tools = tools.filter(candidate => this.getAllTools().some(active => active.name === candidate.name)
      || (isBrainProvider((this.activeTurnModel || this.model).provider) && isBrainManagedCustomToolName(candidate.name)));
    toolCall.function.name = normalized.name;
    toolCall.function.arguments = maybeJson(normalized.args);
    let tool = this.resolveToolByName(toolCall.function.name, tools);
    const textToolCall = this.textToolCallIds.delete(toolCall.id);
    if (!tool?.execute && isBrainManagedCustomToolName(toolCall.function.name)) {
      tool = this.resolveToolByName(
        toolCall.function.name,
        filterToolsForTurn(this.getFallbackTools(), {
          allowDeliverables: this.activeTurnAllowsDeliverables,
          allowImageTools: this.activeTurnAllowsImageTools,
          allowTaskTools: this.activeTurnAllowsTaskTools,
        }),
      );
    }
    const safeTextTools = new Set(["read", "grep", "find", "ls", "websearch", "webfetch", "weather", "sports", "stockmarket", "exchangerate"]);
    if (textToolCall && !safeTextTools.has(toolNameKey(toolCall.function.name).replace(/-/g, "")) && tool?._textCallConfirmation !== true) tool = undefined;
    const args = normalized.args;
    this.emit({
      type: "message_update",
      role: "assistant",
      assistantMessageEvent: { type: "toolcall_start", toolCall },
    });
    this.emit({
      type: "tool_execution_start",
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      args,
      toolCall,
    });
    if (!tool?.execute) {
      const result = {
        isError: true,
        content: [{
          type: "text",
          text: `工具当前不可用：${toolCall.function.name}。请改用 web_search 或 web_fetch 获取公开来源。`,
        }],
      };
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: true,
      });
      return result;
    }
    try {
      const result = normalizeToolResult(await tool.execute(toolCall.id, args, { ...this._buildRuntime({ signal }), textToolCall }));
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      registerCreatedToolFiles(this.sessionManager.getSessionFile?.(), toolCall.function.name, args, result, this.cwd);
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: result.isError === true,
      });
      this.emit({
        type: "message_update",
        role: "assistant",
        assistantMessageEvent: { type: "toolcall_end", toolCall },
      });
      return result;
    } catch (err) {
      if (signal?.aborted || (err as any)?.name === "AbortError") throw err;
      const result = {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
      this.emit({
        type: "tool_execution_end",
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args,
        result,
        isError: true,
      });
      return result;
    }
  }
}

export async function createLynnAgentSession(options: LynnCreateAgentSessionOptions = {}): Promise<{
  session: LynnAgentSession;
  extensionsResult: LoadExtensionsResult;
}> {
  const session = new LynnAgentSession(options);
  await session.resourceLoader.reload?.();
  return {
    session,
    extensionsResult: { extensions: [], diagnostics: [] },
  };
}
