import { describe, expect, it } from "vitest";
import {
  CLIENT_EVENT_TYPES,
  REACT_CHAT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  createWsProtocolSnapshot,
  validateClientEvent,
  validateServerEvent,
} from "../shared/ws-events.js";

describe("WebSocket protocol contract", () => {
  it("keeps the server/client event names in one snapshot", () => {
    expect(createWsProtocolSnapshot()).toMatchInlineSnapshot(`
      {
        "clientEventTypes": [
          "abort",
          "compact",
          "context_usage",
          "prompt",
          "resume_stream",
          "steer",
          "toggle_plan_mode",
        ],
        "clientRequiredFields": {
          "abort": [],
          "compact": [],
          "context_usage": [],
          "prompt": [],
          "resume_stream": [
            "sessionPath",
            "sinceSeq",
          ],
          "steer": [
            "text",
          ],
          "toggle_plan_mode": [],
        },
        "reactChatEventTypes": [
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
        ],
        "serverEventTypes": [
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
        ],
        "serverRequiredFields": {
          "activity_update": [
            "activity",
          ],
          "apply_frontend_setting": [
            "key",
          ],
          "artifact": [
            "artifactId",
            "title",
            "content",
          ],
          "bridge_message": [
            "message",
          ],
          "bridge_status": [
            "platform",
            "status",
          ],
          "browser_bg_status": [
            "running",
          ],
          "browser_screenshot": [
            "base64",
            "mimeType",
          ],
          "browser_status": [
            "running",
          ],
          "channel_archived": [
            "channelName",
          ],
          "channel_new_message": [
            "channelName",
          ],
          "compaction_end": [],
          "compaction_start": [],
          "confirmation_resolved": [
            "confirmId",
            "action",
          ],
          "context_usage": [],
          "cron_confirmation": [
            "jobData",
          ],
          "desk_changed": [],
          "devlog": [
            "text",
          ],
          "dm_new_message": [],
          "error": [
            "message",
          ],
          "file_diff": [
            "filePath",
            "diff",
          ],
          "file_output": [
            "filePath",
            "label",
            "ext",
          ],
          "jian_update": [
            "content",
          ],
          "model_hint": [
            "model",
          ],
          "mood_end": [],
          "mood_start": [],
          "mood_text": [
            "delta",
          ],
          "notification": [
            "title",
          ],
          "plan_mode": [
            "enabled",
          ],
          "review_progress": [
            "reviewId",
            "stage",
          ],
          "review_result": [
            "reviewId",
          ],
          "review_start": [
            "reviewId",
            "reviewerName",
          ],
          "security_mode": [
            "mode",
          ],
          "session_relay": [
            "newSessionPath",
          ],
          "session_title": [
            "title",
            "path",
          ],
          "settings_confirmation": [
            "confirmId",
            "settingKey",
          ],
          "skill_activated": [
            "skillName",
            "skillFilePath",
          ],
          "status": [
            "isStreaming",
          ],
          "steered": [],
          "stream_resume": [
            "sessionPath",
            "sinceSeq",
            "nextSeq",
            "events",
          ],
          "task_update": [
            "task",
          ],
          "text_delta": [
            "delta",
          ],
          "thinking_delta": [
            "delta",
          ],
          "thinking_end": [],
          "thinking_start": [],
          "tool_authorization": [
            "confirmId",
            "command",
          ],
          "tool_end": [
            "name",
            "success",
          ],
          "tool_progress": [
            "event",
            "name",
          ],
          "tool_start": [
            "name",
          ],
          "turn_end": [],
          "turn_retry": [
            "reason",
          ],
          "xing_end": [],
          "xing_start": [],
          "xing_text": [
            "delta",
          ],
        },
      }
    `);
  });

  it("keeps chat routed event names inside the full server event list", () => {
    for (const type of REACT_CHAT_EVENT_TYPES) {
      expect(SERVER_EVENT_TYPES).toContain(type);
    }
  });

  it("validates representative client and server payloads", () => {
    expect(validateClientEvent({ type: "prompt", text: "hi" }).ok).toBe(true);
    expect(validateClientEvent({ type: "steer" })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("missing required field")],
    });
    expect(validateServerEvent({ type: "text_delta", delta: "hi" }).ok).toBe(true);
    expect(validateServerEvent({ type: "text_delta" })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("missing required field")],
    });
    expect(validateServerEvent({ type: "renamed_event" })).toMatchObject({
      ok: false,
      errors: ["unknown server event type: renamed_event"],
    });
  });

  it("does not duplicate protocol event names", () => {
    expect(new Set(CLIENT_EVENT_TYPES).size).toBe(CLIENT_EVENT_TYPES.length);
    expect(new Set(REACT_CHAT_EVENT_TYPES).size).toBe(REACT_CHAT_EVENT_TYPES.length);
    expect(new Set(SERVER_EVENT_TYPES).size).toBe(SERVER_EVENT_TYPES.length);
  });
});
