/**
 * ChannelRouter — 频道调度（从 engine.js 搬出）
 *
 * 频道 = 内部 Channel，和 Telegram/飞书一样通过 Hub 路由。
 * 包装 channel-ticker（不改 ticker，只提供回调）。
 *
 * 搬出的方法：
 *   _getChannelAgentOrder  → getAgentOrder()
 *   _executeChannelCheck   → _executeCheck()
 *   _executeChannelReply   → _executeReply()
 *   _channelMemorySummarize → _memorySummarize()
 *   _setupChannelPostHandler → setupPostHandler()
 *   toggleChannels          → toggle()
 */

import fs from "fs";
import path from "path";
import { createChannelTicker } from "../lib/channels/channel-ticker.js";
import {
  appendMessage,
  formatMessagesForLLM,
  getChannelMembers,
  parseChannel,
} from "../lib/channels/channel-store.js";
import { loadConfig } from "../lib/memory/config-loader.js";
import { callText } from "../core/llm-client.js";
import { runAgentSession } from "./agent-executor.js";
import { debugLog } from "../lib/debug-log.js";
import { getLocale } from "../server/i18n.js";

export class ChannelRouter {
  /**
   * @param {object} opts
   * @param {import('./index.js').Hub} opts.hub
   */
  static _AGENT_ORDER_TTL = 30_000; // 30 秒

  constructor({ hub }) {
    this._hub = hub;
    this._ticker = null;
    this._agentOrderCache = null; // { list: string[], ts: number }
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get _engine() { return this._hub.engine; }

  // ──────────── 生命周期 ────────────

  start() {
    const engine = this._engine;
    if (!engine.channelsDir) return;

    this._ticker = createChannelTicker({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      getAgentOrder: () => this.getAgentOrder(),
      executeCheck: (agentId, channelName, newMessages, allUpdates, opts) =>
        this._executeCheck(agentId, channelName, newMessages, allUpdates, opts),
      onMemorySummarize: (agentId, channelName, contextText) =>
        this._memorySummarize(agentId, channelName, contextText),
      onAllReplied: (channelName, opts) =>
        this._executeHostSummary(channelName, opts),
      onEvent: (event, data) => {
        this._hub.eventBus.emit({ type: event, ...data }, null);
      },
    });
    this._ticker.start();
  }

  async stop() {
    if (this._ticker) {
      await this._ticker.stop();
      this._ticker = null;
    }
  }

  async toggle(enabled) {
    if (enabled) {
      if (this._ticker) return;
      this.start();
    } else {
      await this.stop();
    }
  }

  triggerImmediate(channelName, opts) {
    return this._ticker?.triggerImmediate(channelName, opts);
  }

  async triggerConclusion(channelName, opts) {
    return this._executeConclusion(channelName, opts);
  }

  /**
   * 注入频道 post 回调到当前 agent
   * agent 用 channel tool 发消息后，触发其他 agent 的 triage
   */
  setupPostHandler() {
    this._engine.agent._channelPostHandler = (channelName, senderId) => {
      debugLog()?.log("channel", `agent ${senderId} posted to #${channelName}, triggering triage`);
      this.triggerImmediate(channelName)?.catch(err =>
        console.error(`[channel] agent post triage 失败: ${err.message}`)
      );
    };
  }

  // ──────────── 频道 Agent 顺序 ────────────

  /** 获取参与频道轮转的 agent 列表（只含有 channels.md 的，30s TTL 缓存） */
  getAgentOrder() {
    const now = Date.now();
    if (this._agentOrderCache && now - this._agentOrderCache.ts < ChannelRouter._AGENT_ORDER_TTL) {
      return this._agentOrderCache.list;
    }
    try {
      const entries = fs.readdirSync(this._engine.agentsDir, { withFileTypes: true });
      const list = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const channelsMd = path.join(this._engine.agentsDir, e.name, "channels.md");
          return fs.existsSync(channelsMd);
        })
        .map(e => e.name);
      this._agentOrderCache = { list, ts: now };
      return list;
    } catch {
      return [];
    }
  }

  // ──────────── Triage + Reply ────────────

  /**
   * 频道检查回调：triage → 两轮 Agent Session → 写入回复
   * 从 engine._executeChannelCheck 搬入
   */
  async _executeCheck(agentId, channelName, newMessages, _allChannelUpdates, { signal, triggerMessage } = {}) {
    const engine = this._engine;
    const msgText = formatMessagesForLLM(newMessages);

    // ── 主持人跳过 triage：她只在 onAllReplied 阶段作为审查者+主持人发言 ──
    const isHost = agentId === engine.currentAgentId;

    // ── 读 agent 完整上下文 ──
    const readFile = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const agentDir = path.join(engine.agentsDir, agentId);

    // 复用 Agent 实例的 personality（identity + yuan + ishiki 已在内存中组装）
    const agentInstance = engine.agents?.get(agentId);
    const cfg = agentInstance?.config || loadConfig(path.join(agentDir, "config.yaml"));
    const agentName = cfg.agent?.name || agentId;

    const agentContext = agentInstance?.personality
      || [readFile(path.join(agentDir, "identity.md")),
          readFile(path.join(engine.productDir, "yuan", `${cfg.agent?.yuan || "hanako"}.md`)),
          readFile(path.join(agentDir, "ishiki.md"))].filter(Boolean).join("\n\n");

    // memory.md 和 user.md 内容会变，仍需从磁盘读取
    const memoryMd = readFile(path.join(agentDir, "memory", "memory.md"));
    const userMd = readFile(path.join(engine.userDir, "user.md"));
    const isZh = getLocale().startsWith("zh");
    const memoryContext = memoryMd?.trim()
      ? (isZh ? `\n\n你的记忆：\n${memoryMd}` : `\n\nYour memory:\n${memoryMd}`)
      : "";
    const userContext = userMd?.trim()
      ? (isZh ? `\n\n用户档案：\n${userMd}` : `\n\nUser profile:\n${userMd}`)
      : "";

    // ── 检测 @ ──
    const isMentioned = msgText.includes(`@${agentName}`) || msgText.includes(`@${agentId}`);

    // 主持人在没有被 @ 时跳过 triage（她只在 onAllReplied 阶段发言，避免说两遍话）
    if (isHost && !isMentioned) {
      debugLog()?.log("channel", `${agentId}/#${channelName}: 主持人跳过 triage（未被 @），等待 onAllReplied`);
      return { replied: false };
    }

    const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
    let channelMessages = [];
    let lastMsgIsUser = false;
    try {
      const parsed = parseChannel(fs.readFileSync(channelFile, "utf-8"));
      channelMessages = parsed.messages || [];
      const lastMessage = channelMessages[channelMessages.length - 1] || null;
      if (lastMessage) {
        let senderIsAgent = false;
        if (engine.agents) {
          for (const [id, ag] of engine.agents) {
            const name = ag?.config?.agent?.name || id;
            if (lastMessage.sender === id || lastMessage.sender === name) {
              senderIsAgent = true;
              break;
            }
          }
        }
        lastMsgIsUser = !senderIsAgent;
      }
    } catch {}

    const triggerSender = typeof triggerMessage?.sender === "string" ? triggerMessage.sender.trim() : "";
    const triggerTimestamp = triggerMessage?.timestamp || "";
    const triggeredByImmediateTurn = !!triggerTimestamp;
    const triggerIsSelf = triggerSender === agentId || triggerSender === agentName;
    const alreadyRepliedToTrigger = triggeredByImmediateTurn
      && channelMessages.some((message) =>
        message.timestamp > triggerTimestamp
        && (message.sender === agentId || message.sender === agentName)
      );

    if (triggerIsSelf || alreadyRepliedToTrigger) {
      return { replied: false };
    }

    // ── Step 1: Triage ──
    let shouldReply = isMentioned;

    // 普通轮询仍要求最后一条是用户消息；立即 triage 则绑定到触发消息，不被前一个 agent 的回复打断
    if (!shouldReply && !lastMsgIsUser && !triggeredByImmediateTurn) {
      return { replied: false };
    }

    if (!shouldReply) {
      try {
        const utilCfg = engine.resolveUtilityConfig() || {};
        const { utility_large: model, large_api_key: api_key, large_base_url: base_url, large_api: api } = utilCfg;
        if (api_key && base_url && api) {
          const triageSystem = agentContext + memoryContext + userContext
            + "\n\n---\n\n"
            + (isZh
              ? "你在一个群聊频道里。阅读以下最近的消息，判断你是否要回复。\n"
                + "回答 YES 的情况：有人跟你说话、@你、问了你能回答的问题、或者你有想说的话。\n"
                + "回答 NO 的情况：别人已经充分回答了问题（你没有新的补充）、话题跟你无关、你插不上话、或者你刚回复过且没人追问你。\n"
                + "只回答 YES 或 NO。"
              : "You are in a group chat channel. Read the recent messages below and decide whether you should reply.\n"
                + "Answer YES if: someone is talking to you, @-mentions you, asks a question you can answer, or you have something to say.\n"
                + "Answer NO if: the question has already been adequately answered (you have nothing new to add), the topic is irrelevant to you, you can't contribute, or you just replied and no one followed up.\n"
                + "Answer only YES or NO.");

          const triageTimeout = AbortSignal.timeout(10_000);
          const triageSignal = signal
            ? AbortSignal.any([signal, triageTimeout])
            : triageTimeout;
          const answer = await callText({
            api, model,
            apiKey: api_key,
            baseUrl: base_url,
            systemPrompt: triageSystem,
            messages: [{ role: "user", content: isZh ? `#${channelName} 频道最近消息：\n${msgText}` : `#${channelName} recent messages:\n${msgText}` }],
            temperature: 0,
            maxTokens: 10,
            timeoutMs: 10_000,
            signal: triageSignal,
          });
          shouldReply = answer.trim().toUpperCase().includes("YES");
        } else {
          // utility_large 凭证不完整，跳过 triage 直接回复
          shouldReply = true;
        }
      } catch (err) {
        // utility 模型未配置或 triage 调用失败 → 默认回复（让 agent 自己在 reply 阶段判断要不要说话）
        console.warn(`[channel] triage 不可用，默认回复 (${agentId}/#${channelName}): ${err.message}`);
        shouldReply = true;
      }
    }

    console.log(`\x1b[90m[channel] triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (@)" : ""}\x1b[0m`);
    debugLog()?.log("channel", `triage ${agentId}/#${channelName}: ${shouldReply ? "YES" : "NO"}${isMentioned ? " (mentioned)" : ""} (${newMessages.length} msgs)`);

    if (!shouldReply) {
      return { replied: false };
    }

    // ── Step 2: 两轮 Agent Session 生成回复 ──
    try {
      const replyText = await this._executeReply(agentId, channelName, msgText, { signal });

      if (!replyText) {
        console.log(`\x1b[90m[channel] ${agentId} 回复为空 (#${channelName})\x1b[0m`);
        return { replied: false };
      }

      // 写入频道文件（用 agentName 作为 sender，而非 agentId，让消息更可读）
      const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
      appendMessage(channelFile, agentName, replyText);

      console.log(`\x1b[90m[channel] ${agentName}(${agentId}) replied #${channelName} (${replyText.length} chars)\x1b[0m`);
      debugLog()?.log("channel", `${agentName}(${agentId}) replied #${channelName} (${replyText.length} chars)`);

      // WS 广播
      this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: agentId }, null);

      return { replied: true, replyContent: replyText };
    } catch (err) {
      console.error(`[channel] 回复失败 (${agentId}/#${channelName}): ${err.message}`);
      console.error(err.stack || err);
      debugLog()?.error("channel", `回复失败 (${agentId}/#${channelName}): ${err.message}`);
      return { replied: false };
    }
  }

  /**
   * 两轮 Agent Session 生成频道回复
   */
  async _executeReply(agentId, channelName, msgText, { signal } = {}) {
    const isZh = getLocale().startsWith("zh");
    const replyTimeout = AbortSignal.timeout(45_000);
    const replySignal = signal
      ? AbortSignal.any([signal, replyTimeout])
      : replyTimeout;
    const text = await runAgentSession(
      agentId,
      [
        {
          text: isZh
            ? `#${channelName} 频道的最近消息：\n\n${msgText}\n\n`
              + `请阅读这些消息，用 search_memory 查阅记忆来了解上下文和真实发生过的事。\n`
              + `注意：你现在的回复用户看不到，这是你的内部思考环节，仅用于查阅资料和理解上下文。下一轮才是你真正发到群聊的内容。`
            : `Recent messages in #${channelName}:\n\n${msgText}\n\n`
              + `Read these messages and use search_memory to look up memories for context and real events.\n`
              + `Note: your reply right now is invisible to users — this is your internal thinking phase, for research and understanding context only. The next round is what actually gets posted to the chat.`,
          capture: false,
        },
        {
          text: isZh
            ? `现在请给出你想在 #${channelName} 群聊中发送的回复。这条回复会直接发送到群聊，所有人都能看到。\n\n`
              + `回复规定：\n`
              + `- 简短回复控制在 50 tokens 以内（约 25 个中文字），像群里聊天一样自然\n`
              + `- 需要展开讨论时（分析问题、讲故事、详细解释），上限 800 tokens（约 400 字）\n`
              + `- 直接输出回复内容，不要加任何前缀、解释、MOOD/PULSE/沉思 区块或代码块\n`
              + `- 不要重复其他成员最近 3 条消息中已表达的观点\n`
              + `- 必须回应前面的具体内容（引用或补充），不要泛泛而谈\n`
              + `- 只说真实发生过的事，不要编造你没做过的活动或经历\n`
              + `- 如果你觉得没什么新观点可以补充，回复 [NO_REPLY]`
            : `Now give the reply you want to post in #${channelName}. This reply will be sent directly to the group chat — everyone can see it.\n\n`
              + `Reply rules:\n`
              + `- Short replies: max 50 tokens (~30 words), natural like group chat\n`
              + `- Extended discussion (analysis, stories, explanations): max 800 tokens (~400 words)\n`
              + `- Output the reply directly — no prefixes, explanations, MOOD/PULSE/reflect blocks, or code fences\n`
              + `- Don't repeat points already made in the last 3 messages by other members\n`
              + `- Must respond to specific prior content (quote or build on it), don't be generic\n`
              + `- Only mention things that actually happened — don't fabricate activities or experiences\n`
              + `- If you have no new perspective to add, reply [NO_REPLY]`,
          capture: true,
        },
      ],
      {
        engine: this._engine,
        signal: replySignal,
        sessionSuffix: `channel-${channelName}`,
        keepSession: true,
        readOnly: true,
        systemAppend: isZh
          ? `\n## 频道工具优先级\n1. search_memory — 先查记忆了解上下文\n2. web_search — 需要事实支撑时搜索\n3. 频道回复中禁止使用文件读写、bash、edit 等重工具`
          : `\n## Channel Tool Priority\n1. search_memory — check memory for context first\n2. web_search — search when facts are needed\n3. Do NOT use file read/write, bash, or edit tools in channel replies`,
      },
    );

    if (!text || text.includes("[NO_REPLY]")) {
      debugLog()?.log("channel", `${agentId}/#${channelName}: chose not to reply`);
      return null;
    }

    return text;
  }

  async _executeConclusion(channelName, { signal, reason = "manual" } = {}) {
    const engine = this._engine;
    const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
    if (!fs.existsSync(channelFile)) {
      throw new Error(`频道不存在: ${channelName}`);
    }

    const { meta, messages } = parseChannel(fs.readFileSync(channelFile, "utf-8"));
    const members = Array.isArray(meta.members) ? meta.members : getChannelMembers(channelFile);
    const isZh = getLocale().startsWith("zh");
    const hostId = this._resolveConclusionHostId(members);
    if (!hostId) {
      throw new Error(isZh ? "找不到可用的主持人来生成结论" : "No available host to generate conclusion");
    }

    const hostAgent = engine.agents?.get(hostId);
    const hostName = hostAgent?.config?.agent?.name || hostId;
    const recentMessages = messages.slice(-60);
    if (recentMessages.length === 0) {
      return { reportText: null, savedFactCount: 0, hostId };
    }

    const msgText = formatMessagesForLLM(recentMessages, { tokenBudget: 6000, maxCharsPerMsg: 1200 });
    const reportText = await runAgentSession(
      hostId,
      [{
        text: isZh
          ? `你是频道 #${channelName} 的主持人，请基于以下完整讨论生成一份结构化结论报告：\n\n${msgText}\n\n`
            + `输出要求：\n`
            + `- 使用 Markdown 标题\n`
            + `- 包含以下 5 部分：\n`
            + `  1. 核心问题\n`
            + `  2. 观点汇总\n`
            + `  3. 已达成共识\n`
            + `  4. 仍存分歧\n`
            + `  5. 下一步建议\n`
            + `- 每部分 2-5 条，尽量具体，不要空话\n`
            + `- 直接输出报告正文，不要加前缀、解释、MOOD 或代码块\n`
            + `- 如果讨论信息不足，也要明确写出当前结论和缺失信息\n`
            + (reason === "archive"
              ? `- 这是归档前的最终报告，语气收束一些，便于后续回看`
              : `- 这是用户主动请求的结论报告，重点给出当前阶段可执行建议`)
          : `You are the host of #${channelName}. Generate a structured conclusion report from the discussion below:\n\n${msgText}\n\n`
            + `Requirements:\n`
            + `- Use Markdown headings\n`
            + `- Include exactly these 5 sections:\n`
            + `  1. Core question\n`
            + `  2. Viewpoints\n`
            + `  3. Consensus\n`
            + `  4. Remaining disagreements\n`
            + `  5. Recommended next steps\n`
            + `- Give 2-5 concrete bullet points per section\n`
            + `- Output the report directly with no prefix, explanation, MOOD, or code fences\n`
            + `- If the discussion is incomplete, clearly state the current best conclusion and missing information\n`
            + (reason === "archive"
              ? `- This is the final archival report, so write it in a concise wrap-up tone`
              : `- This is an on-demand conclusion report, so emphasize actionable next steps`),
        capture: true,
      }],
      { engine, signal, sessionSuffix: `conclusion-${channelName}`, keepSession: true, noTools: true },
    );

    if (!reportText || reportText.includes("[NO_REPLY]")) {
      return { reportText: null, savedFactCount: 0, hostId };
    }

    const heading = isZh
      ? (reason === "archive" ? "## 最终归档报告" : "## 讨论结论")
      : (reason === "archive" ? "## Final Archived Report" : "## Discussion Conclusion");
    const finalText = reportText.trim().startsWith("##") ? reportText.trim() : `${heading}\n\n${reportText.trim()}`;

    appendMessage(channelFile, hostName, finalText);
    const savedFactCount = await this._saveConclusionFacts(channelName, members, finalText);
    this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: hostId }, null);
    debugLog()?.log("channel", `主持人 ${hostName} 生成结论 #${channelName} (${finalText.length} chars)`);

    return { reportText: finalText, savedFactCount, hostId };
  }

  _resolveConclusionHostId(members) {
    const engine = this._engine;
    if (engine.currentAgentId && members.includes(engine.currentAgentId)) {
      return engine.currentAgentId;
    }

    for (const memberId of members) {
      if (memberId === "user") continue;
      if (engine.agents?.has(memberId)) return memberId;
    }

    return engine.currentAgentId || null;
  }

  async _saveConclusionFacts(channelName, members, reportText) {
    const engine = this._engine;
    const isZh = getLocale().startsWith("zh");
    const agentIds = [...new Set((members || []).filter((agentId) => agentId && agentId !== "user"))];
    const now = new Date();
    let savedCount = 0;

    for (const agentId of agentIds) {
      try {
        const isCurrentAgent = agentId === engine.currentAgentId;
        let factStore = null;
        let needClose = false;

        if (isCurrentAgent && engine.agent?.factStore) {
          factStore = engine.agent.factStore;
        } else {
          const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
          if (!fs.existsSync(path.dirname(dbPath))) continue;
          const { FactStore } = await import("../lib/memory/fact-store.js");
          factStore = new FactStore(dbPath);
          needClose = true;
        }

        try {
          factStore.add({
            fact: `[#${channelName}] ${reportText}`,
            tags: [isZh ? "频道结论" : "channel-conclusion", channelName],
            time: now.toISOString().slice(0, 16),
            session_id: `channel-conclusion-${channelName}`,
          });
          savedCount += 1;
        } finally {
          if (needClose) factStore.close();
        }
      } catch (err) {
        console.warn(`[channel] 写入结论记忆失败 (${agentId}/#${channelName}): ${err.message}`);
      }
    }

    return savedCount;
  }

  /**
   * 频道记忆摘要（结构化版本，Auto Dream 频道版）
   * 将频道讨论整理为结构化记忆：话题 + 各方立场 + 共识 + 分歧
   */
  async _memorySummarize(agentId, channelName, contextText) {
    const engine = this._engine;
    try {
      const utilCfg = engine.resolveUtilityConfig() || {};
      const { utility: model, api_key, base_url, api } = utilCfg;
      if (!api_key || !base_url || !api) {
        console.log(`\x1b[90m[channel] ${agentId} 无 API 配置，跳过记忆摘要\x1b[0m`);
        return;
      }

      const isZhMem = getLocale().startsWith("zh");
      const summaryText = await callText({
        api, model,
        apiKey: api_key,
        baseUrl: base_url,
        systemPrompt: isZhMem
          ? "将频道讨论整理为结构化记忆。按以下格式输出，每项一句话，直接输出不要前缀：\n话题：...\n我的立场：...\n他人观点：...\n共识：...\n待定：..."
          : "Organize the channel discussion into structured memory. Output in this format, one sentence each, no prefix:\nTopic: ...\nMy stance: ...\nOthers' views: ...\nConsensus: ...\nOpen questions: ...",
        messages: [{ role: "user", content: isZhMem ? `频道 #${channelName}：\n${contextText.slice(0, 2000)}` : `Channel #${channelName}:\n${contextText.slice(0, 2000)}` }],
        temperature: 0.3,
        maxTokens: 300,
      });

      // 写入 agent 的 fact store
      const isCurrentAgent = (agentId === engine.currentAgentId);
      let factStore = null;
      let needClose = false;

      if (isCurrentAgent && engine.agent?.factStore) {
        factStore = engine.agent.factStore;
      } else {
        const { FactStore } = await import("../lib/memory/fact-store.js");
        const dbPath = path.join(engine.agentsDir, agentId, "memory", "facts.db");
        factStore = new FactStore(dbPath);
        needClose = true;
      }

      const now = new Date();
      try {
        factStore.add({
          fact: `[#${channelName}] ${summaryText}`,
          tags: [isZhMem ? "频道" : "channel", channelName],
          time: now.toISOString().slice(0, 16),
          session_id: `channel-${channelName}`,
        });
      } finally {
        if (needClose) factStore.close();
      }

      console.log(`\x1b[90m[channel] ${agentId} memory saved (#${channelName}, ${summaryText.length} chars)\x1b[0m`);
    } catch (err) {
      console.error(`[channel] 记忆摘要失败 (${agentId}/#${channelName}): ${err.message}`);
      debugLog()?.error("channel", `记忆摘要失败 (${agentId}/#${channelName}): ${err.message}`);
    }
  }

  /**
   * 频道主持人总结（Lynn/hanako 角色）
   * 在所有专家回复后自动触发，总结分歧、追问盲点、或引导下一步讨论。
   */
  async _executeHostSummary(channelName, { signal } = {}) {
    const engine = this._engine;
    const hostId = engine.currentAgentId; // Lynn = 当前活跃 agent（主持人兼验证者）
    if (!hostId) return;

    const channelFile = path.join(engine.channelsDir, `${channelName}.md`);
    if (!fs.existsSync(channelFile)) return;

    // 放宽 members 检查：主持人作为平台级角色，即使不在频道 members 中也可以总结
    // （用户通过 ExpertTeamGuide 创建频道时可能只选了专家没选主 agent）
    const { getChannelMembers: _getMembers } = await import("../lib/channels/channel-store.js");
    const members = _getMembers(channelFile);
    const agentMembers = members.filter(id => id !== hostId && id !== "user");
    if (agentMembers.length === 0) return; // 频道里没有专家，不总结

    const isZh = getLocale().startsWith("zh");
    const { getRecentMessages: getRecent, formatMessagesForLLM: fmtMsg } = await import("../lib/channels/channel-store.js");
    const recentMsgs = getRecent(channelFile, 20);
    if (recentMsgs.length < 2) return; // 至少需要 2 条消息

    const msgText = fmtMsg(recentMsgs);
    const hostAgent = engine.agents?.get(hostId);
    const hostName = hostAgent?.config?.agent?.name || hostId;

    try {
      const summaryText = await runAgentSession(
        hostId,
        [{
          text: isZh
            ? `你是频道 #${channelName} 的主持人兼独立审查者。以下是最近的讨论：\n\n${msgText}\n\n`
              + `请依次完成两个任务：\n\n`
              + `## 任务 1：审查（必做，50 tokens 以内）\n`
              + `- 指出讨论中的事实性错误或逻辑漏洞（如果有）\n`
              + `- 标记被忽略的重要角度（如果有）\n`
              + `- 如果全部观点都站得住，写"审查通过"\n\n`
              + `## 任务 2：主持（选最合适的一项，100-200 tokens）\n`
              + `1. 有分歧 → 总结各方观点和分歧点\n`
              + `2. 遗漏盲点 → 追问\n`
              + `3. 讨论充分 → 2-3 句结论\n`
              + `4. 只有一人回复 → 引导其他人参与\n\n`
              + `规则：直接输出，不加前缀/MOOD，如果不需要总结就回复 [NO_REPLY]`
            : `You are the host and independent reviewer of #${channelName}. Recent discussion:\n\n${msgText}\n\n`
              + `Complete two tasks in order:\n\n`
              + `## Task 1: Review (required, max 50 tokens)\n`
              + `- Point out factual errors or logical flaws (if any)\n`
              + `- Flag important angles that were missed (if any)\n`
              + `- If all viewpoints hold up, write "Review passed"\n\n`
              + `## Task 2: Moderate (pick the most appropriate, 100-200 tokens)\n`
              + `1. If experts disagree → summarize positions and key differences\n`
              + `2. If blind spots exist → ask about them\n`
              + `3. If discussion is thorough → give 2-3 sentence conclusion\n`
              + `4. If only one expert replied → nudge others to participate\n\n`
              + `Rules: output directly, no prefix/MOOD, reply [NO_REPLY] if no summary needed`,
          capture: true,
        }],
        { engine, signal, sessionSuffix: `host-${channelName}`, keepSession: true, noTools: true },
      );

      if (!summaryText || summaryText.includes("[NO_REPLY]")) return;

      appendMessage(channelFile, hostName, summaryText);
      this._hub.eventBus.emit({ type: "channel_new_message", channelName, sender: hostId }, null);
      console.log(`\x1b[90m[channel] 主持人 ${hostName} 审查+总结 #${channelName} (${summaryText.length} chars)\x1b[0m`);
      debugLog()?.log("channel", `主持人 ${hostName} 审查+总结 #${channelName} (${summaryText.length} chars)`);
    } catch (err) {
      if (signal?.aborted) return;
      console.error(`[channel] 主持人总结失败 (#${channelName}): ${err.message}`);
      debugLog()?.error("channel", `主持人总结失败 (#${channelName}): ${err.message}`);
    }
  }
}
