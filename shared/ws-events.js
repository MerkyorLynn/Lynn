export const CLIENT_EVENT_TYPES = Object.freeze([
  "abort",
  "compact",
  "context_usage",
  "prompt",
  "resume_stream",
  "steer",
  "toggle_plan_mode",
]);

export const REACT_CHAT_EVENT_TYPES = Object.freeze([
  "artifact",
  "browser_screenshot",
  "compaction_end",
  "compaction_start",
  "cron_confirmation",
  "file_diff",
  "file_output",
  "mood_end",
  "mood_start",
  "mood_text",
  "settings_confirmation",
  "skill_activated",
  "text_delta",
  "thinking_delta",
  "thinking_end",
  "thinking_start",
  "tool_authorization",
  "tool_end",
  "tool_progress",
  "tool_start",
  "turn_end",
  "xing_end",
  "xing_start",
  "xing_text",
]);

export const SERVER_EVENT_TYPES = Object.freeze([
  ...REACT_CHAT_EVENT_TYPES,
  "activity_update",
  "apply_frontend_setting",
  "bridge_message",
  "bridge_status",
  "browser_bg_status",
  "browser_status",
  "channel_archived",
  "channel_new_message",
  "confirmation_resolved",
  "context_usage",
  "desk_changed",
  "devlog",
  "dm_new_message",
  "error",
  "jian_update",
  "model_hint",
  "notification",
  "plan_mode",
  "review_progress",
  "review_result",
  "review_start",
  "security_mode",
  "session_relay",
  "session_title",
  "status",
  "steered",
  "stream_resume",
  "task_update",
  "turn_retry",
]);

export const SERVER_EVENT_REQUIRED_FIELDS = Object.freeze({
  activity_update: ["activity"],
  apply_frontend_setting: ["key"],
  artifact: ["artifactId", "title", "content"],
  bridge_message: ["message"],
  bridge_status: ["platform", "status"],
  browser_bg_status: ["running"],
  browser_screenshot: ["base64", "mimeType"],
  browser_status: ["running"],
  channel_archived: ["channelName"],
  channel_new_message: ["channelName"],
  compaction_end: [],
  compaction_start: [],
  confirmation_resolved: ["confirmId", "action"],
  context_usage: [],
  cron_confirmation: ["jobData"],
  desk_changed: [],
  devlog: ["text"],
  dm_new_message: [],
  error: ["message"],
  file_diff: ["filePath", "diff"],
  file_output: ["filePath", "label", "ext"],
  jian_update: ["content"],
  model_hint: ["model"],
  mood_end: [],
  mood_start: [],
  mood_text: ["delta"],
  notification: ["title"],
  plan_mode: ["enabled"],
  review_progress: ["reviewId", "stage"],
  review_result: ["reviewId"],
  review_start: ["reviewId", "reviewerName"],
  security_mode: ["mode"],
  session_relay: ["newSessionPath"],
  session_title: ["title", "path"],
  settings_confirmation: ["confirmId", "settingKey"],
  skill_activated: ["skillName", "skillFilePath"],
  status: ["isStreaming"],
  steered: [],
  stream_resume: ["sessionPath", "sinceSeq", "nextSeq", "events"],
  task_update: ["task"],
  text_delta: ["delta"],
  thinking_delta: ["delta"],
  thinking_end: [],
  thinking_start: [],
  tool_authorization: ["confirmId", "command"],
  tool_end: ["name", "success"],
  tool_progress: ["event", "name"],
  tool_start: ["name"],
  turn_end: [],
  turn_retry: ["reason"],
  xing_end: [],
  xing_start: [],
  xing_text: ["delta"],
});

export const CLIENT_EVENT_REQUIRED_FIELDS = Object.freeze({
  abort: [],
  compact: [],
  context_usage: [],
  prompt: [],
  resume_stream: ["sessionPath", "sinceSeq"],
  steer: ["text"],
  toggle_plan_mode: [],
});

const serverTypeSet = new Set(SERVER_EVENT_TYPES);
const clientTypeSet = new Set(CLIENT_EVENT_TYPES);
const reactChatTypeSet = new Set(REACT_CHAT_EVENT_TYPES);

function validateEvent(event, typeSet, requiredFields, label) {
  if (!event || typeof event !== "object") {
    return { ok: false, errors: [`${label} event must be an object`] };
  }
  if (typeof event.type !== "string" || !event.type) {
    return { ok: false, errors: [`${label} event type must be a non-empty string`] };
  }
  if (!typeSet.has(event.type)) {
    return { ok: false, errors: [`unknown ${label} event type: ${event.type}`] };
  }
  const missing = (requiredFields[event.type] || []).filter((field) => event[field] === undefined);
  if (missing.length) {
    return { ok: false, errors: [`${label} event ${event.type} missing required field(s): ${missing.join(", ")}`] };
  }
  return { ok: true, errors: [] };
}

export function isKnownServerEventType(type) {
  return serverTypeSet.has(type);
}

export function isKnownClientEventType(type) {
  return clientTypeSet.has(type);
}

export function isReactChatEventType(type) {
  return reactChatTypeSet.has(type);
}

export function validateServerEvent(event) {
  return validateEvent(event, serverTypeSet, SERVER_EVENT_REQUIRED_FIELDS, "server");
}

export function validateClientEvent(event) {
  return validateEvent(event, clientTypeSet, CLIENT_EVENT_REQUIRED_FIELDS, "client");
}

export function createWsProtocolSnapshot() {
  return {
    clientEventTypes: [...CLIENT_EVENT_TYPES],
    reactChatEventTypes: [...REACT_CHAT_EVENT_TYPES],
    serverEventTypes: [...SERVER_EVENT_TYPES],
    clientRequiredFields: CLIENT_EVENT_REQUIRED_FIELDS,
    serverRequiredFields: SERVER_EVENT_REQUIRED_FIELDS,
  };
}
