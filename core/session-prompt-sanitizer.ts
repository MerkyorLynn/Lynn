import { createModuleLogger } from "../lib/debug-log.js";

const log = createModuleLogger("session");

type AnyRecord = Record<string, any>;
type SessionLike = AnyRecord;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

function messageContentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (!part) return "";
      if (typeof part === "string") return part;
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isRecoverableProviderErrorMessage(message: AnyRecord | null | undefined) {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "error") return false;
  const errorMessage = String(message.errorMessage || "");
  if (/all providers failed/i.test(errorMessage)) return true;
  return !messageContentText(message.content).trim();
}

function isInternalRetryPromptMessage(message: AnyRecord | null | undefined) {
  if (!message || message.role !== "user") return false;
  const text = messageContentText(message.content).trim();
  return text.startsWith("[系统提示] 这是空回复后的补救回答")
    || text.startsWith("[System] This is a recovery answer after an empty model turn");
}

function isTransientRecoveredToolPlaceholder(message: AnyRecord | null | undefined) {
  if (!message || message.role !== "assistant") return false;
  const text = messageContentText(message.content).trim();
  return text === "正在取回工具结果，稍后会整理成回答。";
}

export function sanitizeMessagesBeforePrompt(messages: unknown) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: Array.isArray(messages) ? messages : [], removed: 0 };
  }
  const cleaned = [];
  let removed = 0;
  for (const message of messages) {
    if (
      isRecoverableProviderErrorMessage(message) ||
      isInternalRetryPromptMessage(message) ||
      isTransientRecoveredToolPlaceholder(message)
    ) {
      removed += 1;
      continue;
    }
    cleaned.push(message);
  }
  return { messages: cleaned, removed };
}

export function sanitizeActiveSessionContextForPrompt(session: SessionLike | null | undefined, sessionPath: string | null | undefined) {
  const manager = session?.sessionManager;
  const replaceMessages = session?.agent?.replaceMessages;
  if (!manager?.buildSessionContext || typeof replaceMessages !== "function") return 0;
  try {
    const context = manager.buildSessionContext();
    const currentMessages = Array.isArray(context?.messages) ? context.messages : [];
    const { messages, removed } = sanitizeMessagesBeforePrompt(currentMessages);
    if (removed > 0 && messages.length > 0) {
      replaceMessages.call(session?.agent, messages);
      log.warn(`[prompt] scrubbed ${removed} transient provider/retry message(s) from active context · session=${sessionPath || "unknown"}`);
    }
    return removed;
  } catch (err) {
    log.warn(`[prompt] active context scrub failed · session=${sessionPath || "unknown"} · ${errMessage(err)}`);
    return 0;
  }
}

export function createReplyIntegrityTracker() {
  return {
    replyText: "",
    sawToolCall: false,
    handle(event: AnyRecord) {
      if (event?.type === "message_update") {
        const sub = event.assistantMessageEvent;
        if (sub?.type === "text_delta") {
          this.replyText += sub.delta || "";
        } else if (sub?.type === "toolcall_start" || sub?.type === "toolcall_end") {
          this.sawToolCall = true;
        }
        return;
      }

      if (event?.type === "tool_execution_start" || event?.type === "tool_execution_end") {
        this.sawToolCall = true;
      }
    },
  };
}

export function ensureValidReplyExecution(_tracker: ReturnType<typeof createReplyIntegrityTracker>) {
  return;
}

export async function runPromptWithIntegrity(
  session: SessionLike,
  text: string,
  promptOptions?: unknown,
  opts: { passOptionsArgument?: boolean } = {},
) {
  const tracker = createReplyIntegrityTracker();
  const unsub = session.subscribe((event: AnyRecord) => {
    tracker.handle(event);
  });
  try {
    if (opts.passOptionsArgument || promptOptions !== undefined) {
      await session.prompt(text, promptOptions);
    } else {
      await session.prompt(text);
    }
    ensureValidReplyExecution(tracker);
    return tracker.replyText;
  } finally {
    unsub?.();
  }
}
