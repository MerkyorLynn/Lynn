const INTERNAL_CONTROL_PATTERNS = [
  /【严格执行要求】/u,
  /上一轮把工具调用写成了正文文本/u,
  /上一轮错误地说自己没有\s*shell/u,
  /上一轮只输出了[“"']?我来查询/u,
  /你刚才在正文里输出了伪工具调用标记/u,
  /Do not simulate tool calls in plain text/i,
  /The previous attempt simulated tool calls in plain text/i,
  /Use the real tool interface, finish the task/i,
  /立即停止输出任何伪工具调用文本/u,
  /改为使用真实工具接口继续完成当前任务/u,
];

export function isInternalRecoveryPromptText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return INTERNAL_CONTROL_PATTERNS.some((pattern) => pattern.test(normalized));
}
