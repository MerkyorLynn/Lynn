// Brain v2 · Router with multi-turn server-side tool execution
// 原则:只做兜底(universalOrder + cooldown + capability gate)+ 服务端工具回灌
import { universalOrder, getProvider, isInCooldown, markUnhealthy, clearUnhealthy } from './provider-registry.js';
import { getAdapter } from './wire-adapter/index.js';
import { isServerTool, executeServerTool, mergeWithServerTools } from './tool-exec/index.js';


// [verifier helper v1] extract latest user-role text for verifier prompt
function _extractLatestUserMessageText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
          .filter(Boolean)
          .join(' ');
      }
      try { return JSON.stringify(m.content); } catch { return ''; }
    }
  }
  return '';
}
// [FIX 2026-05-06 → Lynn#4] 3 → 6: 调研类任务多轮搜索常见 5-6 轮(广搜 → 锁源 → 深挖 → 验证 → 合成),
// 原 3 轮上限会让模型 3 轮全用来调 parallel_research,没机会写最终答案。
// 配合下方"撞顶强合成轮"兜底,即便撞 6 也强制再走一轮 tools=null 让模型基于已有材料合成。
const MAX_ITERATIONS = Number(process.env.BRAIN_V2_MAX_ITERATIONS || 6);
// Default 3 means: at least two completed tool rounds, then a short stop on the third round.
// This avoids re-synthesizing legitimate one-tool short answers such as weather/price snippets.
const SHORT_STOP_SYNTHESIS_MIN_ITER = Number(process.env.BRAIN_V2_SHORT_STOP_SYNTHESIS_MIN_ITER || 3);
const SHORT_STOP_SYNTHESIS_MAX_CHARS = Number(process.env.BRAIN_V2_SHORT_STOP_SYNTHESIS_MAX_CHARS || 200);
const RESEARCH_SYNTHESIS_MIN_ITER = Number(process.env.BRAIN_V2_RESEARCH_SYNTHESIS_MIN_ITER || 2);
const RESEARCH_FINAL_MIN_CHARS = Number(process.env.BRAIN_V2_RESEARCH_FINAL_MIN_CHARS || 900);
// Lynn#4: local Lynn closes long turns at ~120s. Start synthesis before that so final content arrives in time.
const SYNTHESIS_BUDGET_MS = Number(process.env.BRAIN_V2_SYNTHESIS_BUDGET_MS || 80_000);
// P1#4: empty_response 不立即 cooldown 5min。短期 cooldown(30s),且需累计 ≥ 2 次
const EMPTY_RESPONSE_COOLDOWN_MS = Number(process.env.BRAIN_V2_EMPTY_COOLDOWN_MS || 30_000);
const EMPTY_THRESHOLD = Number(process.env.BRAIN_V2_EMPTY_THRESHOLD || 2);
const _emptyCounters = new Map();  // providerId → consecutive empty count

function _bumpEmpty(providerId) {
  const n = (_emptyCounters.get(providerId) || 0) + 1;
  _emptyCounters.set(providerId, n);
  return n;
}
function _resetEmpty(providerId) {
  _emptyCounters.delete(providerId);
}

async function runRound({
  messages,
  tools,
  capabilityRequired,
  signal,
  onChunk,
  log,
  extraBody,
  reasoningEffort,
  bufferContent = false,
  requireContentOrTool = false,
  rejectPseudoToolMarkup = false,
  allowToolCallsAsValid = true,
}) {
  const errors = [];
  for (const providerId of universalOrder) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    if (capabilityRequired?.vision && !provider.capability.vision) continue;
    if (capabilityRequired?.audio && !provider.capability.audio) continue;
    if (isInCooldown(providerId)) {
      log && log('info', `provider ${providerId} in cooldown, skip`);
      continue;
    }
    const adapter = getAdapter(provider.wire);
    let anyEmit = false;
    let finishReason = null;
    let contentAccum = '';
    const toolCallsAcc = [];
    const bufferedContentChunks = [];
    let bufferedFinishChunk = null;
    try {
      log && log('info', `→ provider ${providerId}`);
      for await (const chunk of adapter({ provider, messages, tools, signal, log, extraBody, reasoningEffort })) {
        anyEmit = true;
        if (chunk.type === 'content') {
          contentAccum += chunk.delta;
          if (bufferContent) {
            bufferedContentChunks.push(chunk);
            continue;
          }
          await onChunk(chunk, { providerId });
          continue;
        }
        if (chunk.type === 'tool_call_delta') {
          for (const d of (chunk.delta || [])) {
            const idx = d.index ?? 0;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (d.id) toolCallsAcc[idx].id = d.id;
            if (d.function?.name) toolCallsAcc[idx].function.name += d.function.name;
            if (d.function?.arguments) toolCallsAcc[idx].function.arguments += d.function.arguments;
          }
          await onChunk(chunk, { providerId });
          continue;
        }
        if (chunk.type === 'finish') {
          finishReason = chunk.reason;
          if (bufferContent || requireContentOrTool) {
            bufferedFinishChunk = chunk;
            continue;
          }
          await onChunk(chunk, { providerId });
          continue;
        }
        await onChunk(chunk, { providerId });
      }
      if (!anyEmit) {
        // P1#4: 累积 empty,达阈值才 cooldown(短)
        const n = _bumpEmpty(providerId);
        log && log('warn', `provider ${providerId} empty (${n}/${EMPTY_THRESHOLD})`);
        if (n >= EMPTY_THRESHOLD) {
          log && log('warn', `provider ${providerId} reached empty threshold, ${EMPTY_RESPONSE_COOLDOWN_MS}ms cooldown`);
          markUnhealthy(providerId, 'empty_response_threshold');
          // 短 cooldown:覆写 provider.cooldown_ms 临时(只为 markUnhealthy 用)
          // 简化:不动 PROVIDERS,直接靠 isInCooldown 的 timer
        }
        continue;
      }
      const completedToolCalls = toolCallsAcc.filter(Boolean);
      const hasValidContent = hasUsableVisibleContent(contentAccum, { rejectPseudoToolMarkup });
      const hasValidToolCall = allowToolCallsAsValid && completedToolCalls.length > 0;
      if (requireContentOrTool && !hasValidContent && !hasValidToolCall) {
        const why = hasPseudoToolMarkup(contentAccum) ? 'pseudo_tool_markup' : 'no_visible_content';
        log && log('warn', `provider ${providerId} emitted ${why}, fallback`);
        continue;
      }
      if (requireContentOrTool && !bufferContent && bufferedFinishChunk) {
        await onChunk(bufferedFinishChunk, { providerId });
      }
      _resetEmpty(providerId);
      clearUnhealthy(providerId);
      return {
        ok: true,
        providerId,
        finishReason,
        contentAccum,
        toolCalls: completedToolCalls,
        bufferedContentChunks,
        bufferedFinishChunk,
      };
    } catch (e) {
      errors.push({ providerId, error: e.message });
      log && log('warn', `provider ${providerId} failed: ${e.message}, fallback`);
      markUnhealthy(providerId, e.message);
      continue;
    }
  }
  const err = new Error('all providers failed');
  err.errors = errors;
  throw err;
}

function normalizedVisibleLength(text) {
  return String(text || '')
    .replace(/<lynn_tool_progress\b[^>]*><\/lynn_tool_progress>/gi, '')
    .replace(/\s+/g, '')
    .trim()
    .length;
}

function hasPseudoToolMarkup(text) {
  const s = String(text || '');
  return /<\s*\/?\s*tool_call\b/i.test(s)
    || /<\s*function\s*=/i.test(s)
    || /<\s*parameter\s*=/i.test(s)
    || /<\|tool_code_(?:begin|end)\|>/i.test(s)
    || /<\s*\/?\s*(?:web_search|bash|find_files|create_docx)\b/i.test(s);
}

function hasUsableVisibleContent(text, { rejectPseudoToolMarkup = false } = {}) {
  if (normalizedVisibleLength(text) === 0) return false;
  if (rejectPseudoToolMarkup && hasPseudoToolMarkup(text)) return false;
  return true;
}

function isOverSynthesisBudget(startedAt, budgetMs = SYNTHESIS_BUDGET_MS) {
  return Number.isFinite(startedAt) && Date.now() - startedAt >= budgetMs;
}

function shouldForceSynthesisAfterShortStop(iter, result) {
  if (iter < SHORT_STOP_SYNTHESIS_MIN_ITER) return false;
  if (result?.finishReason !== 'stop') return false;
  if (Array.isArray(result?.toolCalls) && result.toolCalls.length > 0) return false;
  return normalizedVisibleLength(result?.contentAccum) > 0
    && normalizedVisibleLength(result?.contentAccum) < SHORT_STOP_SYNTHESIS_MAX_CHARS;
}

function stringifyMessageContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try { return JSON.stringify(content); } catch { return String(content); }
}

function compactText(text, maxChars = 12_000) {
  const s = stringifyMessageContent(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n...[truncated]';
}

function extractUserText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(m => m?.role === 'user')
    .map(m => stringifyMessageContent(m.content))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function isResearchLikeRequest(messages) {
  const text = extractUserText(messages);
  if (!text) return false;
  return /(?:深度|深入|完整|系统性|多维度|调研|研究|研报|报告|分析报告|行业分析|竞品分析|受众|用户画像|传播策略|内容生态|市场规模|来源包括|但不限于|学术界|咨询领域|小红书|抖音|快手|视频号|公众号|形成\s*(?:docx|文档)|docx\s*格式)/i.test(text);
}

function isDocLikeRequest(messages) {
  return /(?:docx|word|文档|报告附件|形成\s*报告|生成\s*报告)/i.test(extractUserText(messages));
}

function extractResearchQuestions(messages) {
  const text = extractUserText(messages);
  if (!text) return [];
  const lines = text
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  const numbered = [];
  for (const line of lines) {
    const m = line.match(/^(?:[-*]\s*)?(?:\d+[.、)]|[一二三四五六七八九十]+[、.])\s*(.+)$/);
    if (m?.[1]) numbered.push(m[1].trim());
  }
  if (numbered.length) return numbered.slice(0, 10);
  return text
    .split(/[；;。！？!?]\s*/)
    .map(s => s.trim())
    .filter(s => s.length >= 12)
    .slice(0, 8);
}

function parseToolCallArgs(args) {
  try {
    const obj = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {});
    if (!obj || typeof obj !== 'object') return '';
    return obj.query || obj.city || obj.location || obj.url || obj.code || obj.name || JSON.stringify(obj).slice(0, 180);
  } catch {
    return String(args || '').slice(0, 180);
  }
}

function buildEvidenceLedger(messages) {
  const callsById = new Map();
  const entries = [];
  let fallbackIndex = 0;
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!tc?.id) continue;
        callsById.set(tc.id, {
          name: tc.function?.name || 'tool',
          query: parseToolCallArgs(tc.function?.arguments),
        });
      }
      continue;
    }
    if (m?.role !== 'tool') continue;
    fallbackIndex += 1;
    const call = callsById.get(m.tool_call_id) || { name: 'tool', query: '' };
    const content = stringifyMessageContent(m.content).trim();
    const urls = Array.from(new Set(content.match(/https?:\/\/[^\s)\]}>"]+/g) || [])).slice(0, 4);
    const dates = Array.from(new Set(content.match(/\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?\b/g) || [])).slice(0, 3);
    entries.push({
      index: entries.length + 1,
      tool: call.name,
      query: call.query || `tool-result-${fallbackIndex}`,
      chars: content.length,
      urls,
      dates,
      excerpt: compactText(content.replace(/\s+/g, ' '), 900),
    });
  }
  return entries;
}

function formatResearchContextForSynthesis(originalMessages, workingMessages) {
  if (!isResearchLikeRequest(originalMessages)) return '';
  const questions = extractResearchQuestions(originalMessages);
  const ledger = buildEvidenceLedger(workingMessages);
  const lines = [];
  lines.push('【研究拆题清单】');
  if (questions.length) {
    questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  } else {
    lines.push('1. 按用户原始问题拆成可回答的研究维度。');
  }
  lines.push('');
  lines.push('【证据账本】');
  if (ledger.length) {
    for (const e of ledger.slice(0, 12)) {
      const meta = [
        `工具:${e.tool}`,
        e.query ? `查询:${e.query}` : '',
        `长度:${e.chars}`,
        e.dates.length ? `日期:${e.dates.join(',')}` : '',
        e.urls.length ? `来源:${e.urls.join(' ; ')}` : '',
      ].filter(Boolean).join(' | ');
      lines.push(`${e.index}. ${meta}`);
      lines.push(`   摘要:${e.excerpt}`);
    }
  } else {
    lines.push('暂无可用工具结果。若证据不足,最终答案必须明确标注缺口。');
  }
  lines.push('');
  lines.push('【合成门禁】');
  lines.push('- 必须逐项覆盖研究拆题清单;不能只说“继续深挖/还要搜索/摘要较粗”。');
  lines.push('- 必须把证据账本中的来源、时间或缺口写清楚;不能把未核验内容当事实。');
  lines.push('- 若用户要求 docx/报告,先输出完整可复制正文;没有真实附件时不要假装附件已生成。');
  return lines.join('\n');
}

function isResearchProgressNarration(text) {
  const s = stringifyMessageContent(text).trim();
  if (!s) return false;
  return /(?:继续(?:深挖|调研|搜索|抓取|整理)|初步搜索|拿到了方向|摘要(?:较|太)粗|搜索结果(?:较|太)简略|还需要(?:补充|进一步)|下一轮|第\s*\d+\s*轮工具调用完成|正在(?:调研|搜索|整理|生成)|稍后(?:继续|再)|我来(?:继续|进一步)|需要抓取更详细)/i.test(s);
}

function shouldForceResearchSynthesisAfterStop(originalMessages, iter, result) {
  if (!isResearchLikeRequest(originalMessages)) return false;
  if (iter < RESEARCH_SYNTHESIS_MIN_ITER) return false;
  if (result?.finishReason !== 'stop') return false;
  if (Array.isArray(result?.toolCalls) && result.toolCalls.length > 0) return false;
  const len = normalizedVisibleLength(result?.contentAccum);
  if (len <= 0) return true;
  if (isResearchProgressNarration(result?.contentAccum)) return true;
  if (isDocLikeRequest(originalMessages) && len < RESEARCH_FINAL_MIN_CHARS) return true;
  return false;
}

function flattenMessagesForSynthesis(messages) {
  const list = [];
  let toolIndex = 0;
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      const content = stringifyMessageContent(m.content).trim();
      if (content) list.push({ role: 'system', content });
      continue;
    }
    if (m.role === 'user') {
      const content = stringifyMessageContent(m.content).trim();
      if (content) list.push({ role: 'user', content });
      continue;
    }
    if (m.role === 'tool') {
      toolIndex += 1;
      const content = compactText(m.content).trim();
      if (content) list.push({ role: "user", content: "【工具结果 " + toolIndex + "】\n" + content });
      continue;
    }
    if (m.role === 'assistant') {
      const content = stringifyMessageContent(m.content).trim();
      if (content && hasUsableVisibleContent(content, { rejectPseudoToolMarkup: true })) {
        list.push({ role: 'assistant', content: compactText(content) });
      }
      // Do not carry tool_calls across providers in synthesis fallback. Some providers reject
      // assistant tool-call history generated by a different model/wire protocol.
    }
  }
  return list;
}

function withSynthesisSystemMessage(messages, instruction) {
  const list = Array.isArray(messages) ? [...messages] : [];
  const systemIndex = list.findIndex(m => m?.role === 'system');
  if (systemIndex < 0) {
    return [{ role: 'system', content: instruction }, ...list];
  }
  const current = list[systemIndex];
  const previous = current.content == null
    ? ''
    : (typeof current.content === 'string' ? current.content : JSON.stringify(current.content));
  list[systemIndex] = {
    ...current,
    content: [previous, instruction].filter(Boolean).join('\n\n'),
  };
  return list;
}

async function runSynthesisRound({
  originalMessages,
  workingMessages,
  capabilityRequired,
  signal,
  onChunk,
  log,
  extraBody,
  reasoningEffort,
  lastProviderId,
  iter,
  reason,
}) {
  const hitMax = reason === 'max_iterations';
  const hitTimeBudget = reason === 'time_budget';
  const reasonText = hitMax
    ? `已用完 ${MAX_ITERATIONS} 轮工具调用预算`
    : (hitTimeBudget ? '已接近本地会话时间上限' : '检测到多轮工具后仅有短进度文字');
  log && log('warn', hitMax
    ? `hit MAX_ITERATIONS=${MAX_ITERATIONS}, forcing synthesis round`
    : (hitTimeBudget
      ? `iter ${iter}: time budget reached, forcing synthesis round`
      : `iter ${iter}: short stop content after tool rounds, forcing synthesis round`));
  await onChunk(
    { type: 'reasoning', delta: `\n[brain] ${reasonText},基于已有材料给最终答案...\n` },
    { providerId: lastProviderId }
  );
  const baseInstruction = hitMax
    ? '本轮资料收集阶段已经结束。请基于以上对话历史中的工具结果直接给用户最终答案,不要再规划或请求更多检索。'
    : (hitTimeBudget
      ? '本轮资料收集阶段已经接近本地会话时间上限。请基于以上对话历史中的工具结果直接给用户最终答案,不要再规划或请求更多检索。'
      : '已经完成多轮资料收集。请基于以上对话历史中的工具结果直接给用户最终答案,不要再规划或请求更多检索。');
  const synthesisInstruction = baseInstruction + '\n只输出用户可见的最终内容;不要输出任何工具标签、XML、JSON 工具调用或文档创建指令。若用户要求 docx/html 等交付格式但当前没有实际附件,请直接输出可复制到文档中的完整正文,不要提及工具被禁用或无法生成附件。';
  const researchContext = formatResearchContextForSynthesis(originalMessages, workingMessages);
  const finalInstruction = researchContext
    ? synthesisInstruction + '\n\n' + researchContext
    : synthesisInstruction;
  const synthesisMessages = withSynthesisSystemMessage(flattenMessagesForSynthesis(workingMessages), finalInstruction);
  try {
    let suppressedToolCallChunks = 0;
    const synthesisOnChunk = async (chunk, meta) => {
      if (chunk?.type === 'tool_call_delta') {
        suppressedToolCallChunks += 1;
        log && log('warn', `synthesis round suppressed hallucinated tool_call_delta (${suppressedToolCallChunks})`);
        return;
      }
      if (chunk?.type === 'finish' && chunk.reason === 'tool_calls') {
        await onChunk({ ...chunk, reason: 'stop' }, meta);
        return;
      }
      await onChunk(chunk, meta);
    };
    const synthesisResult = await runRound({
      messages: synthesisMessages,
      tools: null,
      capabilityRequired,
      signal,
      onChunk: synthesisOnChunk,
      log,
      extraBody,
      reasoningEffort,
      bufferContent: true,
      requireContentOrTool: true,
      rejectPseudoToolMarkup: true,
      allowToolCallsAsValid: false,
    });
    for (const bufferedChunk of (synthesisResult.bufferedContentChunks || [])) {
      await onChunk(bufferedChunk, { providerId: synthesisResult.providerId || lastProviderId });
    }
    if (synthesisResult.bufferedFinishChunk) {
      const finishChunk = synthesisResult.bufferedFinishChunk.reason === 'tool_calls'
        ? { ...synthesisResult.bufferedFinishChunk, reason: 'stop' }
        : synthesisResult.bufferedFinishChunk;
      await onChunk(finishChunk, { providerId: synthesisResult.providerId || lastProviderId });
    }
    return {
      ok: true,
      providerId: synthesisResult.providerId || lastProviderId,
      iterations: iter + 1,
      hitMaxIterations: hitMax || undefined,
      synthesisRound: true,
      synthesisReason: reason,
    };
  } catch (e) {
    log && log('error', `synthesis round failed: ${e.message}`);
    await onChunk(
      { type: 'content', delta: '\n本轮工具结果合成失败，Lynn 已安全结束本次任务。你可以直接重试一次，或把任务范围缩小后再试。' },
      { providerId: lastProviderId }
    );
    return {
      ok: true,
      providerId: lastProviderId,
      iterations: iter,
      hitMaxIterations: hitMax || undefined,
      synthesisReason: reason,
    };
  }
}

export async function run({ messages, tools, capabilityRequired, signal, onChunk, log, extraBody, reasoningEffort }) {
  const mergedTools = mergeWithServerTools(tools);
  let workingMessages = [...(messages || [])];
  const originalMessages = [...(messages || [])];
  let lastProviderId = null;
  let iter = 0;
  const startedAt = Date.now();

  while (iter < MAX_ITERATIONS) {
    iter++;
    const result = await runRound({
      messages: workingMessages, tools: mergedTools, capabilityRequired, signal, onChunk, log, extraBody, reasoningEffort, bufferContent: true,
    });
    lastProviderId = result.providerId;

    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      if (shouldForceSynthesisAfterShortStop(iter, result) || shouldForceResearchSynthesisAfterStop(originalMessages, iter, result)) {
        log && log('warn', `iter ${iter}: dropped ${result.bufferedContentChunks?.length || 0} buffered short-progress content chunks before synthesis`);
        return runSynthesisRound({
          originalMessages,
          workingMessages,
          capabilityRequired,
          signal,
          onChunk,
          log,
          extraBody,
          reasoningEffort,
          lastProviderId,
          iter,
          reason: 'short_stop',
        });
      }
      for (const bufferedChunk of (result.bufferedContentChunks || [])) {
        await onChunk(bufferedChunk, { providerId: lastProviderId });
      }
      if (result.bufferedFinishChunk) {
        await onChunk(result.bufferedFinishChunk, { providerId: lastProviderId });
      }
      return { ok: true, providerId: lastProviderId, iterations: iter };
    }

    const serverCalls = result.toolCalls.filter(tc => isServerTool(tc.function?.name));
    const clientCalls = result.toolCalls.filter(tc => !isServerTool(tc.function?.name));

    if (serverCalls.length > 0 && isOverSynthesisBudget(startedAt)) {
      log && log('warn', `iter ${iter}: time budget reached before executing ${serverCalls.length} more server tools, forcing synthesis`);
      return runSynthesisRound({
        originalMessages,
        workingMessages,
        capabilityRequired,
        signal,
        onChunk,
        log,
        extraBody,
        reasoningEffort,
        lastProviderId,
        iter,
        reason: 'time_budget',
      });
    }

    if (clientCalls.length > 0) {
      if (result.bufferedFinishChunk) {
        await onChunk(result.bufferedFinishChunk, { providerId: lastProviderId });
      }
      log && log('info', `iter ${iter}: ${clientCalls.length} client-side tool_calls forwarded, stop loop`);
      return {
        ok: true, providerId: lastProviderId, iterations: iter,
        forwardedToClient: true, clientToolCalls: clientCalls.length,
      };
    }

    if (result.bufferedContentChunks?.length) {
      log && log('warn', `iter ${iter}: suppressed ${result.bufferedContentChunks.length} buffered content chunks from tool-call round`);
    }
    if (result.bufferedFinishChunk) {
      await onChunk(result.bufferedFinishChunk, { providerId: lastProviderId });
    }
    log && log('info', `iter ${iter}: ${serverCalls.length} server-side tool_calls, executing...`);
    workingMessages.push({
      role: 'assistant',
      content: result.contentAccum || null,
      tool_calls: result.toolCalls,
    });
    for (const tc of serverCalls) {
      const t0 = Date.now();
      await onChunk(
        { type: 'content', delta: `<lynn_tool_progress event="start" name="${tc.function.name}"></lynn_tool_progress>` },
        { providerId: lastProviderId }
      );
      const toolResult = await executeServerTool(tc.function.name, tc.function.arguments || '{}', { log });
      const ms = Date.now() - t0;
      const ok = toolResult && !String(toolResult).startsWith('{"error"');
      // [verifier hook v1] log-only, fail-open, fire-and-forget (does NOT block user SSE)
      if (process.env.VERIFIER_ENABLED === '1' && ok) {
        const _toolResultSnapshot = toolResult;
        const _toolNameSnapshot = tc.function.name;
        const _userPromptText = _extractLatestUserMessageText(originalMessages);
        // fire-and-forget — verifier observability runs in background
        (async () => {
          try {
            const { verifyToolResult } = await import('./verifier-middleware.mjs');
            const _verifyMeta = await verifyToolResult({
              userPrompt: _userPromptText,
              toolName: _toolNameSnapshot,
              toolResult: _toolResultSnapshot,
              log,
            });
            if (_verifyMeta && !_verifyMeta.skipped) {
              const _scoresStr = _verifyMeta.scores
                ? `C1=${_verifyMeta.scores.C1} C2=${_verifyMeta.scores.C2} C3=${_verifyMeta.scores.C3}`
                : (_verifyMeta.failOpen ? `fail-open(${_verifyMeta.error || 'parse'})` : 'no-scores');
              log && log(
                'info',
                `[verifier-async] ${_toolNameSnapshot}: pass=${_verifyMeta.pass} avg=${_verifyMeta.avg?.toFixed(2) || 'n/a'} latency=${_verifyMeta.latencyMs}ms ${_scoresStr}`
              );
            }
          } catch (e) {
            log && log('warn', `[verifier-async] ${_toolNameSnapshot} hook error: ${e.message}`);
          }
        })();
      }
      // [/verifier hook v1]
      await onChunk(
        { type: 'content', delta: `<lynn_tool_progress event="end" name="${tc.function.name}" ms="${ms}" ok="${ok}"></lynn_tool_progress>` },
        { providerId: lastProviderId }
      );
      workingMessages.push({
        role: 'tool',
        tool_call_id: tc.id || ('tc-' + Math.random().toString(36).slice(2)),
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      });
    }
    // v0.77.7: emit progress heartbeat between iters (用户感受到进度,防 7min 空窗心慌)
    // 用 reasoning_content 流出 (Lynn UI thinking block 显示, 不污染最终 markdown 答案)
    if (isOverSynthesisBudget(startedAt)) {
      log && log('warn', `iter ${iter}: time budget reached after tool execution, forcing synthesis`);
      return runSynthesisRound({
        originalMessages,
        workingMessages,
        capabilityRequired,
        signal,
        onChunk,
        log,
        extraBody,
        reasoningEffort,
        lastProviderId,
        iter,
        reason: 'time_budget',
      });
    }

    const remaining = MAX_ITERATIONS - iter;
    if (remaining > 0) {
      await onChunk(
        { type: 'reasoning', delta: `\n[brain] 第 ${iter} 轮工具调用完成 (${serverCalls.length} 个 tool),继续整理...\n` },
        { providerId: lastProviderId }
      );
    }
  }
  // [FIX 2026-05-06 → Lynn#4] 撞顶强合成轮: 不再 silently return — 给模型一次"基于已有工具结果直接给最终答"的机会。
  // 原 bug: 3 轮全花在 parallel_research,撞顶后 silently return,模型最后一次 emit 的 progress 文字
  // ("继续深挖/需要抓取/搜索结果较简略")成了 user 看到的 final answer。
  // 修复策略(结构化兜底,不教模型该写啥):
  //   1) 禁工具(tools=null) — 模型 schema 里没工具就不会再 emit tool_call
  //   2) 加一条 system 消息客观陈述"工具预算已用完",让模型理解为何 tools 不可用
  //   3) 即便合成轮模型还 hallucinate tool_call,直接 return 不再 loop
  return runSynthesisRound({
    originalMessages,
    workingMessages,
    capabilityRequired,
    signal,
    onChunk,
    log,
    extraBody,
    reasoningEffort,
    lastProviderId,
    iter,
    reason: 'max_iterations',
  });
}

export function detectCapability(messages) {
  const result = { vision: false, audio: false };
  for (const m of (messages || [])) {
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url' || part.type === 'input_image') result.vision = true;
      if (part.type === 'input_audio' || part.type === 'audio_url') result.audio = true;
    }
  }
  return result;
}

export const __testing__ = {
  _emptyCounters,
  normalizedVisibleLength,
  hasPseudoToolMarkup,
  hasUsableVisibleContent,
  flattenMessagesForSynthesis,
  shouldForceSynthesisAfterShortStop,
  withSynthesisSystemMessage,
  isOverSynthesisBudget,
  isResearchLikeRequest,
  extractResearchQuestions,
  buildEvidenceLedger,
  formatResearchContextForSynthesis,
  isResearchProgressNarration,
  shouldForceResearchSynthesisAfterStop,
};
