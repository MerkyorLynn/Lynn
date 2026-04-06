/**
 * WebSocket 消息协议定义
 *
 * Client → Server:
 *   { type: "prompt", text: "..." }
 *   { type: "abort" }
 *   { type: "resume_stream", sessionPath: "...", streamId: "...", sinceSeq: 128 }  (按事件序号续传)
 *
 * Server → Client:
 *   { type: "text_delta", delta: "..." }
 *   { type: "mood_start" }
 *   { type: "mood_text", delta: "..." }
 *   { type: "mood_end" }
 *   { type: "thinking_start" }
 *   { type: "thinking_delta", delta: "..." }
 *   { type: "thinking_end" }
 *   { type: "tool_start", name: "..." }
 *   { type: "tool_end", name: "...", success: bool, details?: object }
 *   { type: "turn_end" }
 *   { type: "error", message: "..." }
 *   { type: "status", isStreaming: bool }
 *   { type: "session_title", title: "...", path: "..." }
 *   { type: "jian_update", content: "..." }
 *   { type: "devlog", text: "...", level: "info"|"heartbeat"|"error" }
 *   { type: "activity_update", activity: { id, type, startedAt, finishedAt, summary, sessionFile, status, taskId?, source? } }
 *   { type: "task_update", task: { taskId, title, status, source, sessionPath?, metadata?, resultSummary?, error? } }
 *   { type: "file_output", filePath: "...", label: "...", ext: "pdf"|"docx"|"xlsx"|... }  (由 present_files 工具触发，每个文件一条)
 *   { type: "file_diff", filePath: "...", diff: "...", linesAdded: number, linesRemoved: number, rollbackId?: "..." }  (由 edit/edit-diff 工具触发，用于审查与回滚)
 *   { type: "artifact", artifactId: "...", artifactType: "html"|"code"|"markdown", title: "...", content: "...", language?: "..." }  (由 create_artifact 工具触发)
 *   { type: "browser_screenshot", base64: "...", mimeType: "image/jpeg" }  (由 browser 工具 screenshot 操作触发)
 *   { type: "browser_status", running: bool, url: "...", thumbnail?: "..." }  (浏览器状态变更，用于前端浮动卡片)
 *   { type: "skill_activated", skillName: "...", skillFilePath: "..." }  (skill 被激活时推送，用于聊天页显示卡片)
 *   { type: "cron_confirmation", jobData: { type, schedule, prompt, label } }  (cron add 操作需要用户确认)
 *   { type: "bridge_status", platform: "telegram"|"feishu", status: "connected"|"disconnected"|"error", error?: "..." }  (外部平台连接状态变更)
 *   { type: "review_start", reviewId: "...", reviewerName: "...", reviewerAgent: "..." }  (review 开始，前端显示 loading 卡片)
 *   { type: "review_progress", reviewId: "...", stage: "packing_context"|"reviewing"|"structuring"|"done", findingsCount?: number, verdict?: "pass"|"concerns"|"blocker", workflowGate?: "clear"|"follow_up"|"hold" }  (review 进度更新)
 *   { type: "review_result", reviewId: "...", reviewerName: "...", reviewerAgent: "...", content: "...", structured?: object, contextPack?: object, error?: "..." }  (review 结果到达)
 *   { type: "stream_resume", sessionPath: "...", streamId: "...", sinceSeq: number, nextSeq: number, reset: bool, truncated: bool, isStreaming: bool, events: [{ seq, event, ts }] }  (新协议)
 */

/** 安全地发送 JSON 消息到 WebSocket */
export function wsSend(ws, msg) {
  if (ws.readyState === 1) { // OPEN
    ws.send(JSON.stringify(msg));
  }
}

/** 安全地解析 WebSocket 消息（兼容 Buffer / string / ArrayBuffer） */
export function wsParse(data) {
  try {
    const str = typeof data === "string" ? data : (data?.toString?.() ?? String(data));
    return JSON.parse(str);
  } catch {
    return null;
  }
}
