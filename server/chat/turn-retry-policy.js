import os from "os";
import path from "path";

import { getLocale } from "../i18n.js";
import { buildVisionEmptyFallbackText } from "../../shared/vision-prompt.js";

export const LOCAL_COMPLETION_TOOLS = new Set(["bash", "write", "edit", "edit-diff"]);

export function buildLocalToolSuccessFallback(ss) {
  const tools = Array.isArray(ss?.lastSuccessfulTools) ? ss.lastSuccessfulTools : [];
  const localTools = tools.filter((tool) => LOCAL_COMPLETION_TOOLS.has(tool.name));
  if (!localTools.length) return "";
  if (!hasRequiredLocalMutationForFallback(ss, localTools)) return "";

  const commandCount = localTools.filter((tool) => tool.name === "bash").length;
  const fileCount = localTools.filter((tool) => tool.filePath).length;
  const snippets = localTools
    .map((tool) => tool.command || tool.filePath || tool.outputPreview)
    .filter(Boolean)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-3);

  const parts = ["已完成本轮本地操作"];
  if (commandCount > 0) parts.push(`已成功执行 ${commandCount} 个命令`);
  if (fileCount > 0) parts.push(`处理了 ${fileCount} 个文件/路径`);
  let text = parts.join("，") + "。";
  if (snippets.length > 0) {
    text += "\n\n执行摘要：\n" + snippets.map((snippet) => `- ${snippet.slice(0, 160)}`).join("\n");
  }
  text += "\n\n你可以在目标文件夹里检查结果；如果需要，我也可以继续帮你核对整理后的文件列表。";
  return text;
}

function hasRequiredLocalMutationForFallback(ss, localTools) {
  const requirement = classifyRequestedLocalMutation(ss?.originalPromptText || ss?.effectivePromptText || "");
  if (!requirement) return true;

  const commands = (Array.isArray(localTools) ? localTools : [])
    .filter((tool) => tool?.name === "bash")
    .map((tool) => String(tool.command || "").trim())
    .filter(Boolean);
  if (!commands.length) return false;

  if (requirement.requiresDelete && !commands.some(commandLooksLikeDelete)) return false;
  if (requirement.requiresMove && !commands.some(commandLooksLikeMoveOrCopy)) return false;
  if (!requirement.requiresMove && requirement.requiresCreate && !commands.some(commandLooksLikeCreate)) return false;
  return true;
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

export function buildFailedToolFallbackText(ss) {
  const failedTools = Array.isArray(ss?.lastFailedTools) ? ss.lastFailedTools : [];
  const names = [...new Set(failedTools.filter(Boolean))].slice(-4);
  const isZh = getLocale().startsWith("zh");
  const originalPrompt = String(ss?.originalPromptText || ss?.effectivePromptText || "").trim();
  const looksLocalOperation = names.some((name) => LOCAL_COMPLETION_TOOLS.has(name))
    || /(?:删除|移动|整理|新建|创建|复制|改名|重命名|写入|下载文件夹|桌面|文件夹|文件|delete|remove|move|copy|rename|write|mkdir|folder|file)/i.test(originalPrompt);

  if (isZh) {
    if (looksLocalOperation) {
      return [
        `这轮本地操作没有执行成功${names.length ? `（${names.join("、")}）` : ""}。`,
        "我没有确认任何文件已被删除、移动或修改；如果你刚才拒绝了授权，那本轮就是安全取消。",
        originalPrompt ? `原始任务：${originalPrompt.slice(0, 180)}` : "",
      ].filter(Boolean).join("\n\n");
    }
    return [
      `这轮工具调用失败${names.length ? `（${names.join("、")}）` : ""}，没有拿到可靠实时结果。`,
      "我不会把未核验的数据当成事实。你可以稍后重试，或改用官方来源/交易所/天气源/新闻源核验。",
      originalPrompt ? `原始任务：${originalPrompt.slice(0, 180)}` : "",
    ].filter(Boolean).join("\n\n");
  }

  if (looksLocalOperation) {
    return [
      `The local operation did not complete${names.length ? ` (${names.join(", ")})` : ""}.`,
      "I have not confirmed that any files were deleted, moved, or changed. If authorization was rejected, this turn was safely cancelled.",
      originalPrompt ? `Original task: ${originalPrompt.slice(0, 180)}` : "",
    ].filter(Boolean).join("\n\n");
  }

  return [
    `The tool call failed${names.length ? ` (${names.join(", ")})` : ""}, so I do not have reliable live evidence for this turn.`,
    "I will not present unverified data as fact. Please retry later or verify against an official source.",
    originalPrompt ? `Original task: ${originalPrompt.slice(0, 180)}` : "",
  ].filter(Boolean).join("\n\n");
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

export function commandLooksLikeLocalMutation(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  // P0 (2026-05-05): leading set 加 `/`(识别 /bin/rm 等绝对路径),
  // trailing 用 lookahead 要 boundary char(空白/EOL/分隔)代替 `\b`,
  // 避免 `rmdir-nope` `cp-suffix` 等文件名误识别为命令
  return /(^|[;&|()\s/])(?:mkdir|mv|cp|rsync|rm|rmdir|trash|touch|install\s+-d|ditto|osascript)(?=\s|$|[;&|()])/i.test(text)
    || /(?:>|>>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/.test(text)
    || /\b(?:shutil\.(?:move|copy|copy2|copytree|rmtree)|os\.(?:rename|renames|replace|remove|unlink|makedirs|mkdir|rmdir)|Path\([^)]*\)\.mkdir|fs\.(?:rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|writeFile|writeFileSync))\b/.test(text);
}

export function commandLooksLikeMoveOrCopy(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s/])(?:mv|cp|rsync|ditto)(?=\s|$|[;&|()])/i.test(text)
    || /\b(?:shutil\.(?:move|copy|copy2|copytree)|os\.(?:rename|renames|replace)|fs\.(?:rename|renameSync|copyFile|copyFileSync))\b/.test(text);
}

export function commandLooksLikeCreate(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s/])(?:mkdir|touch|install\s+-d)(?=\s|$|[;&|()])/i.test(text)
    || /(?:>|>>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/.test(text)
    || /\b(?:os\.(?:makedirs|mkdir)|Path\([^)]*\)\.mkdir|fs\.(?:mkdir|mkdirSync|writeFile|writeFileSync))\b/.test(text);
}

export function commandLooksLikeDelete(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s/])(?:rm|rmdir|trash)(?=\s|$|[;&|()])/i.test(text)
    || /\bfind\b[^|;&]*\s-delete\b/i.test(text)
    || /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir)|fs\.(?:rm|rmSync|unlink|unlinkSync))\b/.test(text);
}

function buildKnownFolderAliasLines() {
  const home = os.homedir();
  return [
    `下载文件夹 / Downloads = ${path.join(home, "Downloads")}`,
    `桌面 / Desktop = ${path.join(home, "Desktop")}`,
    `文稿 / Documents = ${path.join(home, "Documents")}`,
  ];
}

export function classifyRequestedLocalMutation(prompt = "") {
  const text = String(prompt || "");
  const requiresDelete = /(?:删除|删掉|移除|清理掉|trash|delete|remove)/i.test(text);
  const requiresMove = /(?:移动|挪到|挪进|挪去|放到|放进|归档|归类|整理|分类|复制|拷贝|\bmove\b|\bcopy\b|\barchive\b|\borganize\b)/i.test(text);
  const requiresCreate = !requiresDelete && /(?:新建|创建|建立|建一个|生成|写入|写到|保存到|文件夹|目录|\bmkdir\b|\bcreate\b|\bwrite\b|\bsave\b)/i.test(text);
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
  const requirement = classifyRequestedLocalMutation(originalPrompt);
  const commands = (Array.isArray(successfulTools) ? successfulTools : [])
    .filter((tool) => tool?.name === "bash" && tool.command)
    .map((tool) => `- ${String(tool.command).replace(/\s+/g, " ").trim().slice(0, 240)}`)
    .slice(-6);
  const lines = [
    "【严格执行要求】用户要求的是本地文件变更任务，但目前没有看到对应的 mkdir / mv / cp / rm / 写入等真实变更命令；如果上一轮只是在计划、说明、搜索或扫描文件，也不能算完成。",
    "如果目前只看到扫描/列出类命令，说明没有继续调用真实工具完成任务，不能宣称已经完成。",
    "不要把“找到文件”当成“已经移动/整理完成”。现在必须继续调用真实工具完成变更，并在变更后再用 ls/find 验证目标文件夹内容。",
    "完成后明确告诉用户：实际移动/复制/创建/删除了多少个文件、目标路径是什么、是否有跳过或失败的文件。",
    `【常用目录别名】\n${buildKnownFolderAliasLines().map((line) => `- ${line}`).join("\n")}`,
    requirement?.requiresDelete
      ? "【删除任务安全要求】这是删除类任务。必须先用 find/ls 列出匹配文件和数量；如果用户已经明确点名当前工作目录内的具体文件，可以继续调用真实 bash 工具触发 rm/trash，系统会弹出确认卡并等待确认。若没有匹配项，必须贴出实际检查的目录、匹配模式和空结果，不能空口说“没有文件”。"
      : "",
    commands.length ? `【已执行命令】\n${commands.join("\n")}` : "",
    String(visibleText || "").trim() ? `【上一段可见文本】\n${String(visibleText || "").trim().slice(-800)}` : "",
    String(originalPrompt || "").trim() ? `【用户原始问题】\n${String(originalPrompt || "").trim().slice(-1200)}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}

function buildLocalMutationEmptyFallbackText(ss) {
  const originalPrompt = ss?.originalPromptText || ss?.effectivePromptText || "";
  const requirement = classifyRequestedLocalMutation(originalPrompt);
  if (!requirement) return "";
  const isZh = getLocale().startsWith("zh");
  const aliases = buildKnownFolderAliasLines();
  if (isZh) {
    const parts = [
      "这轮本地文件任务没有真正完成，我也不能确认已经移动/删除了任何文件。",
      requirement.requiresDelete
        ? "这是删除类操作，不能在没有真实列出匹配文件并确认前继续假装执行。"
        : "模型在工具调用上空转了，Lynn 已停止这次尝试，避免误操作。",
      "请直接重试一次；我会先按下面的真实路径检查文件，再继续执行或请求确认：",
      aliases.map((line) => `- ${line}`).join("\n"),
    ];
    if (requirement.requiresDelete) {
      parts.push("如果你确认要删除，请回复“确认删除”，我会先列出匹配文件数量和文件名，再触发安全确认或执行删除。");
      rememberPendingDeleteConfirmation(ss, originalPrompt, requirement);
    }
    return parts.join("\n\n");
  }
  const parts = [
    "This local file task did not actually complete, and I cannot confirm that any files were moved or deleted.",
    requirement.requiresDelete
      ? "Because this is a delete operation, Lynn must list matching files and get confirmation before deleting."
      : "The model got stuck around tool execution, so Lynn stopped this attempt to avoid unsafe changes.",
    "Please retry; Lynn should use these concrete paths:",
    aliases.map((line) => `- ${line}`).join("\n"),
  ];
  if (requirement.requiresDelete) {
    parts.push("If you want to confirm the deletion, reply \"confirm delete\" and Lynn will list the matching files and trigger the safety confirmation before any rm runs.");
    rememberPendingDeleteConfirmation(ss, originalPrompt, requirement);
  }
  return parts.join("\n\n");
}

const PENDING_MUTATION_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

const MUTATION_CONFIRMATION_PATTERN = /^\s*(?:确认删除|确认执行|确认|执行删除|继续执行|继续|执行|是的|是|对|好的|好|可以|ok|okay|yes|y|confirm(?:\s+delete)?|do\s+it|go\s+ahead|proceed)\s*[。.!！,，]?\s*$/i;

function rememberPendingDeleteConfirmation(ss, originalPrompt, requirement) {
  if (!ss || !originalPrompt || !requirement?.requiresDelete) return;
  ss.pendingMutationContext = {
    originalPrompt: String(originalPrompt).slice(0, 4000),
    requirement,
    recordedAt: Date.now(),
  };
}

export function recordPendingDeleteRequest(ss, originalPrompt) {
  if (!ss || !originalPrompt) return false;
  const requirement = classifyRequestedLocalMutation(originalPrompt);
  if (!requirement?.requiresDelete) return false;
  rememberPendingDeleteConfirmation(ss, originalPrompt, requirement);
  return true;
}

export function clearPendingMutationOnSuccessfulDelete(ss, command) {
  if (!ss || !ss.pendingMutationContext) return false;
  if (!commandLooksLikeDelete(command)) return false;
  ss.pendingMutationContext = null;
  return true;
}

export function buildPostRehydrateEscalationPrompt(originalPrompt) {
  const isZh = getLocale().startsWith("zh");
  const prompt = String(originalPrompt || "").trim().slice(0, 1200);
  const aliasLines = buildKnownFolderAliasLines();
  if (isZh) {
    return [
      "[严重升级] 用户已经明确确认要执行这个本地文件变更任务，但你上一轮再次没有真的调用 bash 工具去做事（只输出了说明、空答、或 placeholder 命令）。",
      "本轮你只能做一件事：调用 bash 工具，发送一个真实可执行的 shell 命令；不要再输出任何前置说明、思考、伪工具文本。",
      "如果是删除任务：必须用真实 rm/trash/find -delete 命令，路径要解析成绝对路径。",
      "如果是移动/复制：必须用真实 mv/cp 命令。",
      "禁止：① 输出 \"command\" / \"placeholder\" 之类占位字符串作为命令；② 写 <bash>/<web_search> 等伪工具文本；③ 只说 \"明白\"/\"好的\"/\"直接执行\" 等嘴炮；④ 重复列文件而不动。",
      "",
      "【常用目录别名】",
      ...aliasLines.map((line) => `- ${line}`),
      "",
      "【用户原始问题(已二次确认要执行)】",
      prompt,
    ].join("\n");
  }
  return [
    "[CRITICAL ESCALATION] The user has explicitly confirmed this local file mutation, but the previous turn still failed to actually invoke the bash tool (you only emitted narration, an empty turn, or a placeholder command).",
    "This turn must do exactly one thing: call the bash tool with a real, runnable shell command. Do not emit any narration, thinking, or pseudo-tool markup.",
    "Delete tasks: use a real rm / trash / find -delete command; resolve paths to absolute.",
    "Move / copy tasks: use a real mv / cp command.",
    "Forbidden: (1) emitting \"command\" / \"placeholder\" as the command argument; (2) writing <bash>/<web_search> pseudo-tool text; (3) only saying \"got it\" / \"understood\" / \"executing now\" without a real tool call; (4) re-listing files without acting.",
    "",
    "Known directory aliases:",
    ...aliasLines.map((line) => `- ${line}`),
    "",
    "Original user request (already confirmed twice for execution):",
    prompt,
  ].join("\n");
}

export function consumeMutationConfirmation(ss, userInput, { now = Date.now() } = {}) {
  if (!ss || !ss.pendingMutationContext) return null;
  const ctx = ss.pendingMutationContext;
  const recordedAt = Number(ctx?.recordedAt) || 0;
  if (!recordedAt || now - recordedAt > PENDING_MUTATION_CONFIRMATION_TTL_MS) {
    ss.pendingMutationContext = null;
    return null;
  }
  const text = String(userInput || "").trim();
  if (!text || !MUTATION_CONFIRMATION_PATTERN.test(text)) return null;
  ss.pendingMutationContext = null;
  const originalPrompt = String(ctx.originalPrompt || "").slice(0, 4000);
  if (!originalPrompt) return null;
  const retryPrompt = buildLocalMutationContinuationRetryPrompt(originalPrompt, "", []);
  return {
    originalPrompt,
    requirement: ctx.requirement || null,
    retryPrompt,
  };
}

export function buildEmptyReplyFallbackText(ss) {
  const isZh = getLocale().startsWith("zh");
  const kind = ss?.pseudoToolSteered ? "pseudo_tool_after_retry" : ss?.routeIntent || "empty_reply";
  if (ss?.pseudoToolSteered) {
    const localFallback = buildLocalMutationEmptyFallbackText(ss);
    if (localFallback) return localFallback;
  }
  if (kind === "vision") {
    return buildVisionEmptyFallbackText({ locale: getLocale() });
  }
  return isZh
    ? "本轮模型没有生成可见答案，Lynn 已结束这次空转以免卡住会话。你可以直接重试一次，或把任务说得更具体一点。"
    : "The model did not produce a visible answer. Lynn ended this empty turn to avoid locking the conversation. Please retry or make the task more specific.";
}

export function buildEmptyReplyRetryPrompt(originalPromptText, routeIntent) {
  const userPrompt = String(originalPromptText || "").trim();
  if (classifyRequestedLocalMutation(userPrompt)) {
    return buildLocalMutationContinuationRetryPrompt(userPrompt, "", []);
  }
  return getLocale().startsWith("zh")
    ? [
        "[系统提示] 这是空回复后的补救回答，不是新的计划阶段。",
        "本轮必须产出用户可见的最终答案。不要调用工具；不要输出 REFLECT / MOOD / PULSE / Premise / Conduct / Reflection / Act；不要只说“我来查一下”“让我看看”“稍等”后结束。",
        "不要把任何系统/路由元数据当成回答的一部分输出（包括但不限于“任务类型”“类型”“Route”“Kind”这类标签）。",
        "如果用户问“你知道 X 吗 / X 是什么 / 介绍一下 X”，先用 2-5 句话直接说明 X 是什么、主要用途、你当前能确认的来源方向；需要最新资料时，把“仍需联网核验”的部分单独标明，但不能空答。",
        "如果原任务依赖实时/工具资料但本轮没有可用工具结果：基于已有上下文给出最小可用答案，并明确哪些点未核验；不要把未核验数据说成事实，也不要显示通用兜底话术。",
        "如果用户要求长文/研究/创作，请直接展开完整正文；如果信息不足，也要先给出可用的最小答案和缺口。",
        "【用户原始问题】",
        userPrompt,
      ].filter(Boolean).join("\n")
    : [
        "[System] This is a recovery answer after an empty model turn, not a new planning phase.",
        "You must produce a user-visible final answer now. Do not call tools; do not output REFLECT / MOOD / PULSE / Premise / Conduct / Reflection / Act; do not only say that you will check or look something up.",
        "Do not echo any system or routing metadata as part of your answer (including but not limited to labels like \"Route\", \"Kind\", \"任务类型\", \"类型\").",
        "If the user asks whether you know X, what X is, or asks for an introduction to X, first explain what X is, what it is used for, and what sources would verify it in 2-5 sentences. Mark anything that still needs live verification, but do not answer with an empty fallback.",
        "If the task depends on live/tool data and no tool result is available, provide the best minimal answer from context, clearly label unverified parts, and never present unverified data as fact.",
        "If the user asked for long-form analysis or writing, produce the full answer now. If information is missing, provide the best minimal answer and state the gap.",
        "Original user request:",
        userPrompt,
      ].filter(Boolean).join("\n");
}

const ROUTE_METADATA_LEAK_RE = /(?:^|\n|\s)(?:任务类型|类型|Route|Kind)\s*[：:]\s*(?:chat|utility|utility_large|vision|writing|coding|search|research|tool|empty_reply|pseudo_tool_after_retry|generic|default)\b[\s\S]{0,40}?(?=\n|$)/gi;

export function stripRouteMetadataLeaks(text) {
  const value = String(text || "");
  if (!value) return value;
  return value.replace(ROUTE_METADATA_LEAK_RE, "").replace(/\n{3,}/g, "\n\n");
}

export function buildShortLeadInRetryPrompt(originalPromptText, partialText) {
  return getLocale().startsWith("zh")
    ? [
        "[系统提示] 上一轮只输出了准备/开场句，没有完成用户任务。现在是补救回答，必须产出用户可见的最终内容。",
        "请不要再说“我先/接下来/准备/让我查一下”，也不要调用工具。若需要实时资料但没有工具结果，就先给出最小可用答案并标明未核验点。",
        "【上一轮可见文本】",
        String(partialText || "").trim(),
        "【用户原始问题】",
        String(originalPromptText || "").trim(),
      ].join("\n")
    : [
        "[System] The previous turn only produced a preparatory lead-in and did not complete the user task. This is a recovery answer and must produce user-visible final content.",
        "Do not again say that you will check, prepare, or look something up. Do not call tools. If live data is needed but no tool result is available, provide the best minimal answer and mark the unverified gap.",
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
