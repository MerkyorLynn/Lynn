import { getLocale } from "../i18n.js";

export const LOCAL_COMPLETION_TOOLS = new Set(["bash", "write", "edit", "edit-diff"]);

export function buildLocalToolSuccessFallback(ss) {
  const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  const localTools = tools.filter((tool) => LOCAL_COMPLETION_TOOLS.has(tool.name));
  if (!localTools.length) return "";

  const commandCount = localTools.filter((tool) => tool.name === "bash").length;
  const fileCount = localTools.filter((tool) => tool.filePath).length;
  const snippets = localTools
    .map((tool) => tool.command || tool.filePath || tool.outputPreview)
    .filter(Boolean)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-3);

  const parts = ["已完成本轮本地操作。"];
  if (commandCount > 0) parts.push(`已成功执行 ${commandCount} 个命令`);
  if (fileCount > 0) parts.push(`处理了 ${fileCount} 个文件/路径`);
  let text = parts.join("，") + "。";
  if (snippets.length > 0) {
    text += "\n\n执行摘要：\n" + snippets.map((snippet) => `- ${snippet.slice(0, 160)}`).join("\n");
  }
  text += "\n\n你可以在目标文件夹里检查结果；如果需要，我也可以继续帮你核对整理后的文件列表。";
  return text;
}

export function buildSuccessfulToolNoTextFallback(ss) {
  const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  if (!tools.length) return "";

  const isZh = getLocale().startsWith("zh");
  const snippets = tools
    .map((tool) => tool.outputPreview || tool.command || tool.filePath || tool.name)
    .filter(Boolean)
    .map((text) => String(text).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-3);
  const names = [...new Set(tools.map((tool) => tool.name).filter(Boolean))].slice(-4);

  if (isZh) {
    const parts = [
      `工具已成功执行${names.length ? `（${names.join("、")}）` : ""}，但模型没有整合出最终文字。`,
    ];
    if (snippets.length) {
      parts.push("结果摘要：\n" + snippets.map((snippet) => `- ${snippet.slice(0, 180)}`).join("\n"));
    }
    parts.push("你可以直接基于上面的工具结果继续追问，我也可以重新整理成更完整的答案。");
    return parts.join("\n\n");
  }

  const parts = [
    `The tool call completed successfully${names.length ? ` (${names.join(", ")})` : ""}, but the model did not produce final text.`,
  ];
  if (snippets.length) {
    parts.push("Result summary:\n" + snippets.map((snippet) => `- ${snippet.slice(0, 180)}`).join("\n"));
  }
  parts.push("You can ask me to reformat this into a fuller answer.");
  return parts.join("\n\n");
}

export function buildToolContinuationRetryPrompt(originalPrompt, visibleText) {
  const parts = [
    "【严格执行要求】你已经执行了部分真实工具，但随后只写了“开始/接下来/准备执行”等计划，没有继续调用真实工具完成任务。",
    "现在请基于刚才工具结果继续调用真实工具完成用户原始任务。",
    "不要只描述计划；不要输出 <bash>、web_search(...) 或任何伪工具文本；需要创建、移动、复制、读取或查询时，必须直接调用真实工具。",
    "完成后明确告诉用户实际执行了哪些动作、处理了几个文件/项目，以及目标位置。",
  ];

  const previous = String(visibleText || "").trim();
  if (previous) parts.push(`【上一段未完成回复】\n${previous.slice(-800)}`);

  const prompt = String(originalPrompt || "").trim();
  if (prompt) parts.push(`【用户原始问题】\n${prompt.slice(-1200)}`);

  return parts.join("\n\n");
}

function commandLooksLikeLocalMutation(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s])(?:mkdir|mv|cp|rsync|rm|rmdir|trash|touch|install\s+-d|ditto|osascript)\b/i.test(text)
    || /(?:>|>>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/.test(text)
    || /\b(?:shutil\.(?:move|copy|copy2|copytree|rmtree)|os\.(?:rename|renames|replace|remove|unlink|makedirs|mkdir|rmdir)|Path\([^)]*\)\.mkdir|fs\.(?:rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|writeFile|writeFileSync))\b/.test(text);
}

function commandLooksLikeMoveOrCopy(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s])(?:mv|cp|rsync|ditto)\b/i.test(text)
    || /\b(?:shutil\.(?:move|copy|copy2|copytree)|os\.(?:rename|renames|replace)|fs\.(?:rename|renameSync|copyFile|copyFileSync))\b/.test(text);
}

function commandLooksLikeCreate(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s])(?:mkdir|touch|install\s+-d)\b/i.test(text)
    || /(?:>|>>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/.test(text)
    || /\b(?:os\.(?:makedirs|mkdir)|Path\([^)]*\)\.mkdir|fs\.(?:mkdir|mkdirSync|writeFile|writeFileSync))\b/.test(text);
}

function commandLooksLikeDelete(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s])(?:rm|rmdir|trash)\b/i.test(text)
    || /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir)|fs\.(?:rm|rmSync|unlink|unlinkSync))\b/.test(text);
}

export function classifyRequestedLocalMutation(prompt = "") {
  const text = String(prompt || "");
  const requiresDelete = /(?:删除|删掉|移除|清理掉|trash|delete|remove)/i.test(text);
  const requiresMove = /(?:移动|挪到|挪进|挪去|放到|放进|归档|归类|整理|分类|复制|拷贝|\bmove\b|\bcopy\b|\barchive\b|\borganize\b)/i.test(text);
  const requiresCreate = /(?:新建|创建|建立|建一个|生成|写入|写到|保存到|文件夹|目录|\bmkdir\b|\bcreate\b|\bwrite\b|\bsave\b)/i.test(text);
  if (!requiresDelete && !requiresMove && !requiresCreate) return null;
  return { requiresDelete, requiresMove, requiresCreate };
}

export function shouldRetryUnverifiedLocalMutation(ss, visibleText = "") {
  if (!ss || !ss.hasToolCall || ss.hasError) return false;
  const requirement = classifyRequestedLocalMutation(ss.originalPromptText || ss.effectivePromptText || "");
  if (!requirement) return false;
  const tools = Array.isArray(ss.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  const localCommands = tools
    .filter((tool) => tool?.name === "bash")
    .map((tool) => String(tool.command || "").trim())
    .filter(Boolean);
  if (!localCommands.length) return false;

  const hasMove = localCommands.some(commandLooksLikeMoveOrCopy);
  const hasCreate = localCommands.some(commandLooksLikeCreate);
  const hasDelete = localCommands.some(commandLooksLikeDelete);
  const hasAnyMutation = localCommands.some(commandLooksLikeLocalMutation);
  const text = String(visibleText || "");

  if (requirement.requiresDelete && !hasDelete) return true;
  if (requirement.requiresMove && !hasMove) return true;
  if (!requirement.requiresMove && requirement.requiresCreate && !hasCreate) return true;

  if (!hasAnyMutation && /(?:已|已经|完成|全部|都).{0,24}(?:移动|放进|放到|挪到|整理|归档|删除|创建|新建|复制|拷贝|写入|保存)/i.test(text)) {
    return true;
  }
  return false;
}

export function buildLocalMutationContinuationRetryPrompt(originalPrompt, visibleText, successfulTools = []) {
  const commands = (Array.isArray(successfulTools) ? successfulTools : [])
    .filter((tool) => tool?.name === "bash" && tool.command)
    .map((tool) => `- ${String(tool.command).replace(/\s+/g, " ").trim().slice(0, 240)}`)
    .slice(-6);
  return [
    "【严格执行要求】用户要求的是本地文件变更任务，但目前没有看到对应的 mkdir / mv / cp / rm / 写入等真实变更命令；如果上一轮只是在计划、说明、搜索或扫描文件，也不能算完成。",
    "如果目前只看到扫描/列出类命令，说明没有继续调用真实工具完成任务，不能宣称已经完成。",
    "不要把“找到文件”当成“已经移动/整理完成”。现在必须继续调用真实工具完成变更，并在变更后再用 ls/find 验证目标文件夹内容。",
    "完成后明确告诉用户：实际移动/复制/创建/删除了多少个文件、目标路径是什么、是否有跳过或失败的文件。",
    commands.length ? `【已执行命令】\n${commands.join("\n")}` : "",
    String(visibleText || "").trim() ? `【上一段可见文本】\n${String(visibleText || "").trim().slice(-800)}` : "",
    String(originalPrompt || "").trim() ? `【用户原始问题】\n${String(originalPrompt || "").trim().slice(-1200)}` : "",
  ].filter(Boolean).join("\n\n");
}

export function buildEmptyReplyFallbackText(ss) {
  const isZh = getLocale().startsWith("zh");
  const kind = ss?.pseudoToolSteered ? "pseudo_tool_after_retry" : ss?.routeIntent || "empty_reply";
  return isZh
    ? `本轮模型没有生成可见答案，Lynn 已结束这次空转以免卡住会话。你可以直接重试一次，或把任务说得更具体一点。类型：${kind}`
    : `The model did not produce a visible answer. Lynn ended this empty turn to avoid locking the conversation. Please retry or make the task more specific. Kind: ${kind}`;
}

export function buildEmptyReplyRetryPrompt(originalPromptText, routeIntent) {
  const userPrompt = String(originalPromptText || "").trim();
  return getLocale().startsWith("zh")
    ? [
        "[系统提示] 上一轮模型没有生成任何可见答案。本轮请不要调用工具，不要输出思考占位或准备语句，直接用纯文本完成用户任务。",
        `任务类型：${routeIntent || "chat"}`,
        "如果用户要求长文/研究/创作，请直接展开完整正文；如果信息不足，也要先给出可用的最小答案和缺口。",
        "【用户原始问题】",
        userPrompt,
      ].filter(Boolean).join("\n")
    : [
        "[System] The previous model turn produced no visible answer. Do not call tools; do not output planning placeholders. Complete the user's task directly in plain text.",
        `Route: ${routeIntent || "chat"}`,
        "If the user asked for long-form analysis or writing, produce the full answer now. If information is missing, provide the best minimal answer and state the gap.",
        "Original user request:",
        userPrompt,
      ].filter(Boolean).join("\n");
}

export function buildShortLeadInRetryPrompt(originalPromptText, partialText) {
  return getLocale().startsWith("zh")
    ? [
        "[系统提示] 上一轮只输出了准备/开场句，没有完成用户任务。请不要再说“我先/接下来/准备”，也不要调用工具，直接完成最终内容。",
        "【上一轮可见文本】",
        String(partialText || "").trim(),
        "【用户原始问题】",
        String(originalPromptText || "").trim(),
      ].join("\n")
    : [
        "[System] The previous turn only produced a preparatory lead-in and did not complete the user task. Do not say you will do it; do not call tools. Produce the final content now.",
        "Previous visible text:",
        String(partialText || "").trim(),
        "Original user request:",
        String(originalPromptText || "").trim(),
      ].join("\n");
}

export function looksLikeTruncatedStructuredAnswer(visibleText = "", rawText = "") {
  const visible = String(visibleText || "").trim();
  if (!visible) return false;
  const raw = String(rawText || "");
  const lines = visible.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  const visibleLen = visible.length;

  // Markdown tables are a common failure mode with weak/cold local models: the
  // model emits a heading and the separator row, then stops before any data.
  if (/^\|[\s:|.-]+$/.test(lastLine) && /\|.*\|/.test(visible)) return true;
  if (/\|\s*-{3,}(?:\s*\|\s*:?-{3,}:?\s*)*$/.test(lastLine)) return true;

  const hasStructureStart = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:计算|分析|建议|步骤|结果|结论|summary|analysis|recommendations?|result)s?(?:\*\*)?\s*[:：]?\s*$/i.test(visible)
    || /(?:^|\n)\s*\|[^|\n]+\|[^|\n]+\|/.test(visible);
  const endsAbruptly = /[:：,，;；、|]$/.test(visible)
    || /^\s*(?:[-*+]|\d+[.)、])\s*\S{0,12}$/.test(lastLine);
  if (visibleLen < 220 && hasStructureStart && endsAbruptly) return true;

  const hiddenReflectWasLong = /<\/reflect>/i.test(raw) && raw.length > visible.length + 180;
  return hiddenReflectWasLong && visibleLen < 160 && (hasStructureStart || endsAbruptly);
}

export function buildTruncatedStructuredRetryPrompt(originalPromptText, partialText) {
  return getLocale().startsWith("zh")
    ? [
        "[系统提示] 上一轮回复在结构化答案开头就中断了，用户只看到了不完整的表格/标题/半截内容。",
        "本轮请不要调用工具，不要输出 <reflect>/<think> 或任何隐藏思考标记，不要再只给表格头。",
        "请直接从头给出完整最终答案；如果涉及计算，必须列出关键数字和结论；如果有建议，完整给完。",
        "【上一轮不完整可见文本】",
        String(partialText || "").trim().slice(-800),
        "【用户原始问题】",
        String(originalPromptText || "").trim(),
      ].join("\n")
    : [
        "[System] The previous reply stopped at the beginning of a structured answer, leaving only an incomplete table/header.",
        "Do not call tools. Do not output <reflect>/<think> or hidden-reasoning tags. Do not stop after a table header.",
        "Start over and provide the complete final answer. Include all key numbers/conclusions and finish the recommendations.",
        "Incomplete visible text:",
        String(partialText || "").trim().slice(-800),
        "Original user request:",
        String(originalPromptText || "").trim(),
      ].join("\n");
}

export function buildToolFailedRetryPrompt(originalPromptText, partialText, failedToolNames) {
  const isZh = getLocale().startsWith("zh");
  const failed = Array.isArray(failedToolNames) && failedToolNames.length
    ? failedToolNames.join(", ")
    : "";
  return isZh
    ? [
        "[系统提示] 上一轮调用的工具失败了，且模型只输出了开场句没有完成任务。",
        failed ? `失败的工具：${failed}` : "",
        "本轮请：(1) 不要再次调用工具；(2) 如果你有相关常识或上下文可推断，给出审慎答案并明确标注「基于公开常识/未实时核实」；(3) 否则诚实告知用户「未能查到 X 的最新数据」，并给出 1-2 条用户可以自己验证的来源建议（如官网/搜索关键词）。不要再写「我来查/我先/接下来」。",
        "【上一轮可见文本】",
        String(partialText || "").trim(),
        "【用户原始问题】",
        String(originalPromptText || "").trim(),
      ].filter(Boolean).join("\n")
    : [
        "[System] The tool call in the previous turn failed and the model only produced a preparatory lead-in.",
        failed ? `Failed tools: ${failed}` : "",
        "This turn: (1) do not call any tools again; (2) if you have relevant common knowledge or context, give a cautious answer clearly labeled as 'based on general knowledge / not verified live'; (3) otherwise honestly tell the user the latest data could not be retrieved and suggest 1-2 sources they can check themselves. Do not write 'let me check / I will / next'.",
        "Previous visible text:",
        String(partialText || "").trim(),
        "Original user request:",
        String(originalPromptText || "").trim(),
      ].filter(Boolean).join("\n");
}
