/**
 * qq-adapter.js — QQ 机器人适配器（v2 API）
 *
 * 使用 QQ 开放平台 v2 鉴权（AppID + AppSecret → access_token）。
 * 自建 WebSocket 连接接收消息，支持频道消息和 C2C 私信。
 *
 * 凭证：appID + appSecret，从 QQ 机器人开放平台获取。
 */

import WebSocket from "ws";
import { debugLog } from "../debug-log.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const MAX_MSG_SIZE = 100_000;

// WebSocket OpCode
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// Intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

/**
 * @param {object} opts
 * @param {string} opts.appID
 * @param {string} opts.appSecret
 * @param {(msg: object) => void} opts.onMessage
 * @param {Record<string,string>} [opts.dmGuildMap]
 * @param {(userId: string, guildId: string) => void} [opts.onDmGuildDiscovered]
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 */
export function createQQAdapter({ appID, appSecret, onMessage, dmGuildMap, onDmGuildDiscovered, onStatus }) {
  let accessToken = null;
  let tokenExpiresAt = 0;
  let ws = null;
  let heartbeatTimer = null;
  let lastSeq = null;
  let sessionId = null;
  let stopped = false;
  let reconnectAttempts = 0;

  const userGuildMap = new Map(Object.entries(dmGuildMap || {}));

  // ── Token 管理 ──

  async function refreshToken() {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: appID, clientSecret: appSecret }),
    });
    const data = await res.json();
    if (!data.access_token) {
      throw new Error(`获取 access_token 失败: ${JSON.stringify(data)}`);
    }
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    debugLog()?.log("bridge", `[qq] token 已刷新，有效期 ${data.expires_in}s`);
    return accessToken;
  }

  async function getToken() {
    // 提前 5 分钟刷新
    if (!accessToken || Date.now() > tokenExpiresAt - 5 * 60 * 1000) {
      return refreshToken();
    }
    return accessToken;
  }

  // ── API 请求 ──

  async function apiRequest(method, path, body) {
    const token = await getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QQ API [${path}] ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // ── WebSocket ──

  async function connect() {
    if (stopped) return;
    try {
      const token = await getToken();
      const { url } = await apiRequest("GET", "/gateway");

      ws = new WebSocket(url);

      ws.on("open", () => {
        debugLog()?.log("bridge", "[qq] WebSocket 已连接");
        reconnectAttempts = 0;
      });

      ws.on("message", (raw) => {
        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        handlePayload(payload, token);
      });

      ws.on("close", (code) => {
        debugLog()?.log("bridge", `[qq] WebSocket 断开 (code: ${code})`);
        stopHeartbeat();
        if (!stopped) scheduleReconnect();
      });

      ws.on("error", (err) => {
        console.error("[qq] WebSocket error:", err.message);
        debugLog()?.error("bridge", `[qq] WebSocket error: ${err.message}`);
        onStatus?.("error", err.message);
      });
    } catch (err) {
      console.error("[qq] 连接失败:", err.message);
      onStatus?.("error", err.message);
      if (!stopped) scheduleReconnect();
    }
  }

  function handlePayload(payload, token) {
    const { op, d, s, t } = payload;
    if (s) lastSeq = s;

    switch (op) {
      case OP.HELLO:
        startHeartbeat(d.heartbeat_interval);
        // 鉴权
        if (sessionId) {
          // Resume
          wsSend({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } });
        } else {
          // Identify
          wsSend({
            op: OP.IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
              shard: [0, 1],
            },
          });
        }
        break;

      case OP.DISPATCH:
        if (t === "READY") {
          sessionId = d.session_id;
          debugLog()?.log("bridge", `[qq] 鉴权成功，session: ${sessionId}`);
          onStatus?.("connected");
        } else if (t === "RESUMED") {
          debugLog()?.log("bridge", "[qq] 会话已恢复");
          onStatus?.("connected");
        } else {
          handleEvent(t, d);
        }
        break;

      case OP.HEARTBEAT_ACK:
        break;

      case OP.RECONNECT:
        debugLog()?.log("bridge", "[qq] 收到重连指令");
        ws?.close();
        break;

      case OP.INVALID_SESSION:
        debugLog()?.log("bridge", "[qq] 会话失效，重新鉴权");
        sessionId = null;
        lastSeq = null;
        ws?.close();
        break;
    }
  }

  function handleEvent(type, data) {
    // C2C 私信
    if (type === "C2C_MESSAGE_CREATE") {
      const text = (data.content || "").trim();
      if (!text || text.length > MAX_MSG_SIZE) return;
      onMessage({
        platform: "qq",
        chatId: data.author?.user_openid || data.author?.id,
        userId: data.author?.user_openid || data.author?.id,
        sessionKey: `qq_dm_${data.author?.user_openid || data.author?.id}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: false,
        _msgId: data.id,
      });
    }
    // 群聊消息
    else if (type === "GROUP_AT_MESSAGE_CREATE") {
      let text = (data.content || "").replace(/<@!?\d+>/g, "").trim();
      if (!text || text.length > MAX_MSG_SIZE) return;
      onMessage({
        platform: "qq",
        chatId: data.group_openid,
        userId: data.author?.member_openid || data.author?.id,
        sessionKey: `qq_group_${data.group_openid}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: true,
        _msgId: data.id,
      });
    }
    // 频道公域消息（兼容旧的频道机器人）
    else if (type === "AT_MESSAGE_CREATE") {
      let text = (data.content || "").replace(/<@!?\d+>/g, "").trim();
      if (!text) return;
      onMessage({
        platform: "qq",
        chatId: data.channel_id,
        userId: data.author?.id,
        sessionKey: `qq_group_${data.channel_id}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: true,
        _msgId: data.id,
      });
    }
    // 频道私信
    else if (type === "DIRECT_MESSAGE_CREATE") {
      const text = (data.content || "").trim();
      if (!text) return;
      const chatId = data.guild_id;
      if (data.author?.id && chatId) {
        if (userGuildMap.get(data.author.id) !== chatId) {
          userGuildMap.set(data.author.id, chatId);
          onDmGuildDiscovered?.(data.author.id, chatId);
        }
      }
      onMessage({
        platform: "qq",
        chatId,
        userId: data.author?.id,
        sessionKey: `qq_dm_${data.author?.id}`,
        text: text.slice(0, MAX_MSG_SIZE),
        senderName: data.author?.username || "User",
        isGroup: false,
        _msgId: data.id,
      });
    }
  }

  function wsSend(data) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function startHeartbeat(interval) {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      wsSend({ op: OP.HEARTBEAT, d: lastSeq });
    }, interval);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(reconnectAttempts, delays.length - 1)];
    reconnectAttempts++;
    debugLog()?.log("bridge", `[qq] ${delay / 1000}s 后重连（第 ${reconnectAttempts} 次）`);
    setTimeout(() => connect(), delay);
  }

  // ── 启动 ──
  connect();

  // ── Token 定时刷新 ──
  const tokenRefreshTimer = setInterval(async () => {
    try { await refreshToken(); } catch (err) {
      console.error("[qq] token 刷新失败:", err.message);
    }
  }, 60 * 60 * 1000); // 每小时刷新

  let lastBlockTs = 0;

  return {
    async sendReply(chatId, text, _msgId) {
      const MAX = 2000;
      for (let i = 0; i < text.length; i += MAX) {
        const chunk = text.slice(i, i + MAX);
        const body = { content: chunk, msg_type: 0 };
        if (_msgId) body.msg_id = _msgId;

        // 尝试 C2C → 群聊 → 频道，根据 chatId 格式判断
        // v2 API: C2C 用 user_openid，群用 group_openid，频道用 channel_id
        try {
          // 先尝试 C2C（openid 格式）
          await apiRequest("POST", `/v2/users/${chatId}/messages`, body);
        } catch {
          try {
            // 再尝试群聊
            await apiRequest("POST", `/v2/groups/${chatId}/messages`, body);
          } catch {
            // 最后尝试频道
            await apiRequest("POST", `/channels/${chatId}/messages`, { content: chunk, ...(msgId ? { msg_id: _msgId } : {}) });
          }
        }
      }
    },

    async sendBlockReply(chatId, text, _msgId) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200;
      if (lastBlockTs && elapsed < delay) {
        await new Promise((r) => setTimeout(r, delay - elapsed));
      }
      await this.sendReply(chatId, text, _msgId);
      lastBlockTs = Date.now();
    },

    stop() {
      stopped = true;
      stopHeartbeat();
      clearInterval(tokenRefreshTimer);
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
    },

    async getMe() {
      return apiRequest("GET", "/users/@me");
    },

    resolveOwnerChatId(userId) {
      return userGuildMap.get(userId) || null;
    },
  };
}
