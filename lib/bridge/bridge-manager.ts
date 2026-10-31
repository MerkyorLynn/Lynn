import { t } from "../../shared/i18n-runtime.js";
/**
 * bridge-manager.ts — 外部平台接入管理器
 *
 * 统一管理 Telegram / 飞书等外部消息平台的生命周期。
 * 每个平台一个 adapter，共享 engine 的 _executeExternalMessage()。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { debugLog } from "../debug-log.js";
import { createTelegramAdapter } from "./telegram-adapter.js";
import { createFeishuAdapter } from "./feishu-adapter.js";
import { createQQAdapter } from "./qq-adapter.js";
import { createWechatAdapter } from "./wechat-adapter.js";
import { detectMime, splitMediaFromOutput, setMediaLocalRoots } from "./media-utils.js";
import { resolveBridgeAttachments, sendBridgeMediaItem } from "./bridge-attachments.js";
import type {
  BridgeAdapter,
  BridgeAttachment,
  BridgeMessageHandler,
  BridgeMessagePayload,
  BridgeStatus,
} from "./adapter-types.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";

const BRIDGE_PLATFORMS = ["telegram", "feishu", "qq", "wechat"] as const;
type BridgePlatform = typeof BRIDGE_PLATFORMS[number];
type BridgeRole = "owner" | "guest";

interface TelegramCredentials {
  token: string;
}

interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

interface QQCredentials {
  appID: string;
  appSecret: string;
  dmGuildMap?: Record<string, string>;
}

interface WechatCredentials {
  botToken: string;
  hanaHome: string;
}

type BridgeCredentials =
  | TelegramCredentials
  | FeishuCredentials
  | QQCredentials
  | WechatCredentials;

export interface BridgePlatformConfig {
  enabled?: boolean;
  token?: string;
  appId?: string;
  appSecret?: string;
  appID?: string;
  dmGuildMap?: Record<string, string>;
  botToken?: string;
  _hanaHome?: string;
}

interface BridgeOwnerRouting {
  owner?: Record<string, string>;
  allowlist?: Record<string, string[]>;
}

interface BridgePreferences {
  bridge?: Partial<Record<BridgePlatform, BridgePlatformConfig>> & BridgeOwnerRouting;
  [key: string]: unknown;
}

export type { BridgeAdapter, BridgeAttachment, BridgeMessagePayload, BridgeStatus } from "./adapter-types.js";

interface BridgeMessageMeta {
  name?: string | null;
  avatarUrl?: string | null;
  userId?: string;
}

interface SplitMediaResult {
  text: string;
  mediaUrls: string[];
}

interface BridgeAdapterHooks {
  onEvent?: (evt: unknown) => void;
  onQqDmGuild?: (userId: string, guildId: string) => void;
  onStatus?: (status: BridgeStatus, error?: string) => void;
}

interface AdapterRegistryEntry {
  create(
    creds: BridgeCredentials,
    onMessage: BridgeMessageHandler,
    hooks: BridgeAdapterHooks,
  ): BridgeAdapter | Promise<BridgeAdapter>;
  getCredentials(cfg: BridgePlatformConfig): BridgeCredentials | null;
  ownerSessionKey(userId: string): string;
}

interface BridgePlatformEntry {
  adapter: BridgeAdapter | null;
  status: BridgeStatus;
  error?: string | null;
}

interface PendingBridgeEntry {
  lines: string[];
  attachments: BridgeAttachment[];
  platform: string;
  chatId: string;
  senderName?: string | null;
  avatarUrl?: string | null;
  userId?: string;
  isGroup?: boolean;
  isOwner: boolean;
  agentId?: string | null;
  timer?: NodeJS.Timeout;
}

interface BridgeMessageLogEntry {
  platform: string;
  direction: "in" | "out";
  sessionKey: string;
  sender: string;
  text: string;
  isGroup?: boolean;
  ts: number;
}

interface BridgeExternalErrorReply {
  __bridgeError: true;
  message?: string;
}

type BridgeExternalReply = string | BridgeExternalErrorReply | null | undefined;

interface BridgeHubSendOptions {
  sessionKey: string;
  agentId?: string | null;
  role: BridgeRole;
  meta?: BridgeMessageMeta;
  isGroup: boolean;
  systemAppend?: string;
  onDelta?: (delta: string) => void;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

interface BridgeHub {
  eventBus: {
    emit(evt: unknown, target: unknown): void;
  };
  send(prompt: string, opts: BridgeHubSendOptions): Promise<string | null | undefined>;
}

interface BridgeEngine {
  getBridgeSessionPath?(sessionKey: string, agentId?: string): string | null;
  agentName: string;
  currentAgentId?: string | null;
  lynnHome: string;
  agent?: {
    deskManager?: {
      homePath?: string;
    };
  };
  getPreferences(): BridgePreferences;
  savePreferences(prefs: BridgePreferences): void;
  isBridgeSessionStreaming(sessionKey: string): boolean;
  abortBridgeSession(sessionKey: string): Promise<unknown>;
  steerBridgeSession(sessionKey: string, text: string): boolean;
}

export interface BridgeManagerDeps {
  engine: BridgeEngine;
  hub: BridgeHub;
}

export interface BridgeProactiveResult {
  platform: string;
  chatId: string;
  sessionKey: string;
}

function isBridgePlatform(platform: string): platform is BridgePlatform {
  return (BRIDGE_PLATFORMS as readonly string[]).includes(platform);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isBridgeErrorReply(reply: BridgeExternalReply): reply is BridgeExternalErrorReply {
  return !!reply && typeof reply === "object" && reply.__bridgeError === true;
}

const makeQQAdapter = createQQAdapter as unknown as (opts: {
  appID: string;
  appSecret: string;
  onMessage: BridgeMessageHandler;
  dmGuildMap?: Record<string, string>;
  onDmGuildDiscovered?: BridgeAdapterHooks["onQqDmGuild"];
  onStatus?: BridgeAdapterHooks["onStatus"];
}) => BridgeAdapter;

const makeWechatAdapter = createWechatAdapter as unknown as (opts: {
  botToken: string;
  hanaHome: string;
  onMessage: BridgeMessageHandler;
  onStatus?: BridgeAdapterHooks["onStatus"];
}) => BridgeAdapter;

// ── Adapter Registry ─────────────────────────────────────
// 每个平台注册：create 工厂、凭证提取、owner sessionKey 构造。
// 新增平台只需在此注册 + 提供 adapter 文件。
const ADAPTER_REGISTRY: Record<BridgePlatform, AdapterRegistryEntry> = {
  telegram: {
    create: (creds, onMessage, hooks) => {
      const telegramCreds = creds as TelegramCredentials;
      return createTelegramAdapter({ token: telegramCreds.token, onMessage, onStatus: hooks?.onStatus });
    },
    getCredentials: (cfg) => cfg?.enabled && cfg?.token ? { token: cfg.token } : null,
    ownerSessionKey: (userId) => `tg_dm_${userId}`,
  },
  feishu: {
    create: (creds, onMessage, hooks) => {
      const feishuCreds = creds as FeishuCredentials;
      return createFeishuAdapter({ appId: feishuCreds.appId, appSecret: feishuCreds.appSecret, onMessage, onStatus: hooks?.onStatus });
    },
    getCredentials: (cfg) => cfg?.enabled && cfg?.appId && cfg?.appSecret ? { appId: cfg.appId, appSecret: cfg.appSecret } : null,
    ownerSessionKey: (userId) => `fs_dm_${userId}`,
  },
  qq: {
    create: (creds, onMessage, hooks) => {
      const qqCreds = creds as QQCredentials;
      return makeQQAdapter({
        appID: qqCreds.appID,
        appSecret: qqCreds.appSecret,
        onMessage,
        dmGuildMap: qqCreds.dmGuildMap,
        onDmGuildDiscovered: hooks?.onQqDmGuild,
        onStatus: hooks?.onStatus,
      });
    },
    getCredentials: (cfg) => {
      const secret = cfg?.appSecret || cfg?.token; // 兼容旧版 token 字段
      return cfg?.enabled && cfg?.appID && secret
        ? { appID: cfg.appID, appSecret: secret, dmGuildMap: cfg.dmGuildMap }
        : null;
    },
    ownerSessionKey: (userId) => `qq_dm_${userId}`,
  },
  wechat: {
    create: (creds, onMessage, hooks) => {
      const wechatCreds = creds as WechatCredentials;
      return makeWechatAdapter({
        botToken: wechatCreds.botToken,
        hanaHome: wechatCreds.hanaHome,
        onMessage,
        onStatus: hooks?.onStatus,
      });
    },
    getCredentials: (cfg) => cfg?.enabled && cfg?.botToken ? { botToken: cfg.botToken, hanaHome: cfg._hanaHome || "" } : null,
    ownerSessionKey: (userId) => `wx_dm_${userId}`,
  },
};

import {
  BRIDGE_IDENTITY_GUARD,
  BlockChunker,
  StreamCleaner,
  bridgeIdentityFallback,
  containsBridgeIdentityLeak,
  timeTag,
} from "./bridge-streaming.js";

export class BridgeManager {
  engine: BridgeEngine;
  _hub: BridgeHub;
  _platforms: Map<string, BridgePlatformEntry>;
  _pending: Map<string, PendingBridgeEntry>;
  _processing: Set<string>;
  _messageLog: BridgeMessageLogEntry[];
  _messageLogMax: number;
  blockStreaming: boolean;
  private readonly guestRates = new Map<string, { start: number; count: number }>();

  constructor({ engine, hub }: BridgeManagerDeps) {
    this.engine = engine;
    this._hub = hub;
    this._platforms = new Map<string, BridgePlatformEntry>();
    /** per-sessionKey 消息缓冲（debounce + abort） */
    this._pending = new Map<string, PendingBridgeEntry>();
    /** per-sessionKey 处理锁（防止 debounce 触发和 abort 重发并发） */
    this._processing = new Set<string>();
    /** 最近消息环形缓冲（最多 200 条） */
    this._messageLog = [];
    this._messageLogMax = 200;

    // Local output is authorized per session in sendBridgeMediaItem, never by home-directory access.
    setMediaLocalRoots([]);
    /** block streaming 模式（默认开，多气泡发送） */
    this.blockStreaming = true;
  }

  /** 读取 preferences 中的 bridge 配置，自动启动已启用的平台 */
  autoStart(): void {
    const prefs = this.engine.getPreferences();
    const bridge = prefs.bridge || {};

    for (const platform of BRIDGE_PLATFORMS) {
      const spec = ADAPTER_REGISTRY[platform];
      const cfg = bridge[platform] || {};
      if (platform === "wechat") cfg._hanaHome = this.engine.lynnHome;
      const creds = spec.getCredentials(cfg);
      if (creds) this.startPlatform(platform, creds);
    }
  }

  /**
   * 从 preferences 配置启动平台（route 层用，不需要知道凭证结构）
   */
  startPlatformFromConfig(platform: string, cfg: BridgePlatformConfig): void {
    if (!isBridgePlatform(platform)) return;
    const spec = ADAPTER_REGISTRY[platform];
    if (platform === "wechat") cfg._hanaHome = this.engine.lynnHome;
    const creds = spec.getCredentials(cfg);
    if (creds) this.startPlatform(platform, creds);
  }

  /**
   * 启动指定平台
   */
  async startPlatform(platform: string, credentials: BridgeCredentials): Promise<void> {
    this.stopPlatform(platform);

    if (!isBridgePlatform(platform)) throw new Error(`Unknown platform: ${platform}`);
    const spec = ADAPTER_REGISTRY[platform];

    try {
      const onMessage: BridgeMessageHandler = (msg) => this._handleMessage(platform, msg);
      const hooks: BridgeAdapterHooks = {
        onEvent: (evt) => this._hub.eventBus.emit(evt, null),
        onQqDmGuild: (userId, guildId) => this._persistQqDmGuild(userId, guildId),
        onStatus: (status, error) => {
          const entry = this._platforms.get(platform);
          if (entry) { entry.status = status; entry.error = error || null; }
          this._emitStatus(platform, status, error);
        },
      };
      const adapter = await Promise.resolve(spec.create(credentials, onMessage, hooks));

      // Adapter creation now completes its required handshake before returning.
      // Runtime reconnects continue to update status through onStatus.
      const initialStatus = "connected";

      this._platforms.set(platform, { adapter, status: initialStatus });
      console.log(`[bridge] ${platform} 已启动`);
      debugLog()?.log("bridge", `${platform} started`);

      this._emitStatus(platform, initialStatus);
    } catch (err: unknown) {
      const msg = errorMessage(err);
      console.error(`[bridge] ${platform} 启动失败:`, msg);
      debugLog()?.error("bridge", `${platform} start failed: ${msg}`);
      this._platforms.set(platform, { adapter: null, status: "error", error: msg });
      this._emitStatus(platform, "error", msg);
    }
  }

  /** 持久化 QQ userId→guildId 映射到 preferences */
  _persistQqDmGuild(userId: string, guildId: string): void {
    try {
      const prefs = this.engine.getPreferences();
      const qq = prefs.bridge?.qq || {};
      const map: Record<string, string> = qq.dmGuildMap || {};
      if (map[userId] === guildId) return;
      map[userId] = guildId;
      qq.dmGuildMap = map;
      if (!prefs.bridge) prefs.bridge = {};
      prefs.bridge.qq = qq;

      // 立即写入（PreferencesManager 内存缓存保证高效）。
      // 旧实现 debounce flush 时重新 getPreferences() 导致丢失累积修改。
      this.engine.savePreferences(prefs);
    } catch (err: unknown) {
      console.error("[bridge] persist QQ dmGuildMap failed:", errorMessage(err));
      errorBus.report(new AppError('BRIDGE_SEND_FAILED', { cause: err, context: { platform: 'qq', operation: 'flush dmGuildMap' } }));
    }
  }

  /** 停止指定平台 */
  stopPlatform(platform: string): void {
    const entry = this._platforms.get(platform);
    if (!entry) return;

    try {
      entry.adapter?.stop();
    } catch {}
    this._platforms.delete(platform);
    console.log(`[bridge] ${platform} 已停止`);
    debugLog()?.log("bridge", `${platform} stopped`);
    this._emitStatus(platform, "disconnected");
  }

  /** 停止所有平台 */
  stopAll(): void {
    const platforms = [...this._platforms.keys()];
    for (const platform of platforms) {
      this.stopPlatform(platform);
    }
  }

  /** 获取所有平台状态 */
  getStatus(): Record<string, { status: BridgeStatus; error: string | null }> {
    const result: Record<string, { status: BridgeStatus; error: string | null }> = {};
    for (const [platform, entry] of this._platforms) {
      result[platform] = { status: entry.status, error: entry.error || null };
    }
    return result;
  }

  /**
   * 核心：收到外部消息
   *
   * 群聊：直接发送，不 debounce 不 abort（轻量 guest 快速回复）
   * 私聊：debounce 聚合 → 如正在处理则 abort → 合并发送
   */
  async _handleMessage(platform: string, msg: BridgeMessagePayload): Promise<void> {
    const { sessionKey, text, senderName, avatarUrl, userId, isGroup, chatId, attachments } = msg;
    const entry = this._platforms.get(platform);
    if (!entry?.adapter) return;
    const safeAttachments = attachments ?? [];

    // ── 白名单检查：如果配置了白名单，拒绝非白名单用户 ──
    if (!this._isAllowed(platform, userId)) {
      debugLog()?.log("bridge", `✗ ${platform} message from ${userId} rejected (not in allowlist)`);
      return;
    }

    const hasAttachments = safeAttachments.length > 0;
    debugLog()?.log("bridge", `← ${platform} ${isGroup ? "group" : "dm"} (${text.length} chars${hasAttachments ? `, ${safeAttachments.length} attachment(s)` : ""})`);

    // 广播收到的消息
    this._pushMessage({
      platform, direction: "in", sessionKey,
      sender: senderName || "用户", text: text || (hasAttachments ? `[${safeAttachments.length} 个附件]` : ""),
      isGroup, ts: Date.now(),
    });

    const isOwner = this._isOwner(platform, userId);

    // ── /stop 命令：abort 当前生成，不触发新回复 ──
    if (isOwner && /^\/(stop|abort)$/i.test(text.trim())) {
      this.engine.abortBridgeSession(sessionKey).catch(() => {});
      debugLog()?.log("bridge", `abort ${platform} active session: /stop command`);
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);
      return;
    }

    // ── 群聊：快速路径，不 debounce 不 abort ──
    if (isGroup) {
      const line = senderName ? `${senderName}: ${text}` : text;
      const meta = { name: senderName, avatarUrl, userId };
      this._flushGroupMessage(platform, chatId, sessionKey, line, meta, attachments);
      return;
    }

    // ── 私聊：debounce + abort ──
    const line = !isOwner && senderName
      ? `${senderName}: ${text}` : text;

    let pending = this._pending.get(sessionKey);
    if (!pending) {
      pending = { lines: [], attachments: [], platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId: this.engine.currentAgentId };
      this._pending.set(sessionKey, pending);
    }
    pending.lines.push(line);
    if (hasAttachments) pending.attachments.push(...safeAttachments);
    Object.assign(pending, { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner });

    const isActive = this.engine.isBridgeSessionStreaming(sessionKey);

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._flushPending(sessionKey), isActive ? 1000 : 2000);
  }

  async _flushGroupMessage(
    platform: string,
    chatId: string,
    sessionKey: string,
    line: string,
    meta: BridgeMessageMeta,
    attachments?: BridgeAttachment[],
  ): Promise<void> {
    const entry = this._platforms.get(platform);
    if (!entry?.adapter) return;

    debugLog()?.log("bridge", `flush ${platform} group message (${line.length} chars)`);

    const { images, textNotes } = await resolveBridgeAttachments(entry.adapter, attachments);
    const prompt = textNotes ? `${line}\n${textNotes}` : line;

    const tagged = `${timeTag()} ${prompt}`;
    try {
      const reply = await this._hub.send(tagged, {
        sessionKey,
        agentId: this.engine.currentAgentId,
        role: "guest",
        meta,
        isGroup: true,
        systemAppend: BRIDGE_IDENTITY_GUARD,
        images: images.length ? images : undefined,
      });

      if (reply && entry?.adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        // batch 模式：提取媒体
        const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned) as SplitMediaResult;
        if (textOnly.trim()) await entry.adapter.sendReply(chatId, textOnly);
        // Group sessions are guests: model text cannot trigger media delivery.
        debugLog()?.log("bridge", `→ ${platform} group reply (${cleaned.length} chars)`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup: true, ts: Date.now(),
        });
      }
    } catch (err: unknown) {
      const msg = errorMessage(err);
      if (!msg.includes("aborted")) {
        console.error(`[bridge] ${platform} 群聊消息处理失败:`, msg);
        debugLog()?.error("bridge", `${platform} group message failed: ${msg}`);
      }
    }
  }

  /**
   * debounce 到期：合并缓冲消息并发送给 LLM
   */
  async _flushPending(sessionKey: string): Promise<void> {
    const pending = this._pending.get(sessionKey);
    if (!pending || pending.lines.length === 0) return;

    // 防止并发触发
    if (this._processing.has(sessionKey)) return;

    // 取出所有缓冲消息和附件
    const lines = pending.lines.splice(0);
    const pendingAttachments = pending.attachments?.splice(0) || [];
    const { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId } = pending;
    this._pending.delete(sessionKey);
    const entry = this._platforms.get(platform);
    const adapter = entry?.adapter;

    const { images, textNotes } = await resolveBridgeAttachments(adapter, pendingAttachments);
    const prompt = textNotes ? `${lines.join("\n")}\n${textNotes}` : lines.join("\n");
    const merged = `${timeTag()} ${prompt}`;
    const meta = { name: senderName, avatarUrl, userId };

    // 如果 agent 正在 streaming，用 steer 注入而不是新建 prompt
    // 但如果有图片附件，不走 steer（Pi SDK 不支持往 streaming 中追加图片），等当前回复结束后正常处理
    if (!images.length && this.engine.steerBridgeSession(sessionKey, merged)) {
      debugLog()?.log("bridge", `steer ${platform} dm (${lines.length} msg(s))`);
      return;
    }

    this._processing.add(sessionKey);

    debugLog()?.log("bridge", `flush ${platform} dm (${lines.length} msg(s), ${merged.length} chars${images.length ? `, ${images.length} image(s)` : ""})`);

    // ── 流式输出（adapter 支持 sendBlockReply 即可流式）──
    const canStream = !!adapter?.sendBlockReply && !isGroup;
    const useBlockStream = canStream && this.blockStreaming;
    const useDraft = canStream && !this.blockStreaming && !!adapter?.sendDraft;

    let cleaner: StreamCleaner | null = null;
    let chunker: BlockChunker | null = null;
    let blockSentAny = false;
    let lastDraftTs = 0;
    let draftFailed = false;
    const THROTTLE = 500;

    // block streaming: 多气泡发送
    if (useBlockStream) {
      cleaner = new StreamCleaner();
      chunker = new BlockChunker({
        onFlush: async (text) => {
          blockSentAny = true;
          await adapter!.sendBlockReply!(chatId, text);
        },
      });
    }

    const onDelta: ((delta: string) => void) | undefined = canStream ? (_delta: string) => {
      if (useBlockStream) {
        if (!cleaner || !chunker) return;
        const inc = cleaner.feed(_delta);
        if (inc) chunker.feed(inc);
      } else if (useDraft) {
        if (draftFailed) return;
        if (!cleaner) cleaner = new StreamCleaner();
        cleaner.feed(_delta);
        const now = Date.now();
        if (now - lastDraftTs < THROTTLE) return;
        if (!cleaner.cleaned.trim()) return;
        lastDraftTs = now;
        adapter!.sendDraft!(chatId, cleaner.cleaned).catch(() => { draftFailed = true; });
      }
    } : undefined;

    try {
      let reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        role: isOwner ? "owner" : "guest",
        meta,
        isGroup: false,
        systemAppend: BRIDGE_IDENTITY_GUARD,
        onDelta,
        images: images.length ? images : undefined,
      }) as BridgeExternalReply;

      // bridge-session 返回 error 标记时，发送简短错误提示给用户
      if (isBridgeErrorReply(reply)) {
        if (adapter) {
          const errMsg = t("error.bridgeRequestFailed");
          try { await adapter.sendReply(chatId, errMsg); } catch {}
        }
        reply = null;
      }

      if (typeof reply === "string" && reply && adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        let allMediaUrls: string[] = [];

        // flush StreamCleaner 行缓冲中剩余的不完整行
        if (cleaner) {
          const tail = cleaner.flushLineBuf();
          if (tail) {
            cleaner.cleaned += tail;
            if (chunker) chunker.feed(tail);
          }
        }

        if (useBlockStream && chunker) {
          await chunker.finish();
          allMediaUrls = cleaner?.extractedMedia || [];
          if (!blockSentAny) {
            const textOnly = (cleaner?.cleaned || cleaned).trim();
            if (textOnly) await adapter.sendReply(chatId, textOnly);
          }
        } else if (useDraft && cleaner) {
          // draft 模式：用 cleaner.cleaned（已剥离媒体标记）发送最终文本
          allMediaUrls = cleaner.extractedMedia || [];
          const textOnly = cleaner.cleaned.trim();
          if (textOnly) {
            try { await adapter.sendDraft!(chatId, textOnly); }
            catch { await adapter.sendReply(chatId, textOnly); }
          }
        } else {
          // batch 模式：提取媒体
          const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned) as SplitMediaResult;
          allMediaUrls = mediaUrls;
          if (textOnly.trim()) await adapter.sendReply(chatId, textOnly);
        }

        // 统一发送所有提取到的媒体
        for (const url of isOwner ? allMediaUrls : []) {
          try { await sendBridgeMediaItem(adapter, chatId, url, this.engine.getBridgeSessionPath?.(sessionKey, agentId || undefined) || undefined); }
          catch (err: unknown) { debugLog()?.warn("bridge", `media send failed: ${errorMessage(err)} (${url.slice(0, 60)})`); }
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${useBlockStream ? "block" : useDraft ? "draft" : "batch"}${allMediaUrls.length ? `, ${allMediaUrls.length} media` : ""})`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup, ts: Date.now(),
        });
      }
    } catch (err: unknown) {
      const msg = errorMessage(err);
      if (!msg.includes("aborted")) {
        console.error(`[bridge] ${platform} 消息处理失败:`, msg);
        debugLog()?.error("bridge", `${platform} message handling failed: ${msg}`);
      }
    } finally {
      // 确保 chunker 的异步 flush 链完成，即使 hub.send 中途抛错
      if (chunker) {
        try { await chunker.finish(); } catch {}
      }
      this._processing.delete(sessionKey);
    }

    // 处理期间可能又有新消息进来了，检查并重新 flush
    const newPending = this._pending.get(sessionKey);
    if (newPending && newPending.lines.length > 0) {
      if (newPending.timer) clearTimeout(newPending.timer);
      newPending.timer = setTimeout(() => this._flushPending(sessionKey), 500);
    }
  }

  /** 判断消息发送者是否为 owner */
  _isOwner(platform: string, userId?: string): boolean {
    if (!userId) return false;
    const prefs = this.engine.getPreferences();
    const ownerId = prefs.bridge?.owner?.[platform];
    return !!ownerId && ownerId === userId;
  }

  /**
   * 判断消息发送者是否在白名单内。
   *
   * 白名单配置位于 prefs.bridge.allowlist[platform]（字符串数组）。
   * - 白名单未配置 / 空数组 → 仅允许 owner
   * - 白名单非空 → 仅 owner + 白名单中的 userId 允许
   *
   * @returns {boolean} true 表示允许处理该消息
   */
  _isAllowed(platform: string, userId?: string): boolean {
    const prefs = this.engine.getPreferences();
    const list = prefs.bridge?.allowlist?.[platform];
    // owner 始终放行
    if (this._isOwner(platform, userId)) return true;
    // 检查白名单
    if (!userId || !Array.isArray(list) || !list.includes(userId)) return false;
    const now = Date.now();
    const key = `${platform}:${userId}`;
    let rate = this.guestRates.get(key);
    if (!rate || now - rate.start >= 60_000) {
      for (const [oldKey, oldRate] of this.guestRates) if (now - oldRate.start >= 60_000) this.guestRates.delete(oldKey);
      if (this.guestRates.size >= 1000) return false;
      rate = { start: now, count: 0 };
      this.guestRates.set(key, rate);
    }
    rate.count += 1;
    return rate.count <= 10;
  }

  /**
   * 清理发给外部平台的回复：
   * - 去除 MOOD 代码块
   * - 去除 <tool_code> 标签
   * - 去除 pulse / reflect 区块
   */
  _cleanReplyForPlatform(text: string): string {
    let cleaned = text;
    // 内省标签：backtick 和 XML 两种格式
    cleaned = cleaned.replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*/gi, "");
    cleaned = cleaned.replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\s*/g, "");
    // <tool_code> 标签
    cleaned = cleaned.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, "");
    if (containsBridgeIdentityLeak(cleaned)) return bridgeIdentityFallback();
    return cleaned.trim();
  }


  /**
   * 主动发送消息给 owner（不需要用户先发消息）
   * 用于心跳/cron 升级到 IM 的场景。
   *
   */
  async sendProactive(text: string): Promise<BridgeProactiveResult | null> {
    const prefs = this.engine.getPreferences();
    const ownerIds = prefs.bridge?.owner || {};
    const cleaned = this._cleanReplyForPlatform(text);
    if (!cleaned) return null;

    // 按优先级尝试已连接的平台
    for (const [platform, entry] of this._platforms) {
      if (entry.status !== "connected" || !entry.adapter) continue;
      const ownerId = ownerIds[platform];
      if (!ownerId) continue;

      // QQ 私信需要 guild_id 而非 userId，通过 adapter 解析
      const chatId = entry.adapter.resolveOwnerChatId?.(ownerId) || ownerId;

      // 跳过不支持主动推送的平台（如微信 iLink，需要对方先发消息才能回复）
      if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
        debugLog()?.log("bridge", `→ ${platform} skipped proactive (no reply context for ${chatId})`);
        continue;
      }

      const spec = isBridgePlatform(platform) ? ADAPTER_REGISTRY[platform] : null;
      try {
        await entry.adapter.sendReply(chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platform} proactive to owner (${cleaned.length} chars)`);

        const sessionKey = spec?.ownerSessionKey?.(ownerId) || `${platform}_dm_${ownerId}`;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup: false, ts: Date.now(),
        });

        return { platform, chatId, sessionKey };
      } catch (err: unknown) {
        const msg = errorMessage(err);
        console.error(`[bridge] proactive send failed (${platform}): ${msg}`);
        debugLog()?.error("bridge", `proactive send failed (${platform}): ${msg}`);
      }
    }

    return null;
  }

  /**
   * 从桌面端发送本地文件到 bridge 平台
   */
  async sendMediaFile(platform: string, chatId: string, filePath: string): Promise<void> {
    const entry = this._platforms.get(platform);
    if (!entry?.adapter) throw new Error(`platform ${platform} not connected`);

    // 不支持主动推送的平台需要检查是否有回复窗口
    if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
      throw new Error(`${platform}: 需要对方最近发过消息才能发送文件`);
    }

    const buffer = fs.readFileSync(filePath);
    const mime = detectMime(buffer, "application/octet-stream");
    const filename = path.basename(filePath);

    // 优先用 sendMediaBuffer（接受 Buffer 的直传方法），fallback 到 sendMedia（URL）
    if (entry.adapter.sendMediaBuffer) {
      await entry.adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
    } else if (mime.startsWith("image/") && entry.adapter.sendMedia) {
      // data URL fallback（飞书 sendMedia 内部通过 downloadMedia 解析 data URL）
      // 注：QQ 的 sendMedia 需要公开 HTTP URL，data URL 不支持
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      await entry.adapter.sendMedia(chatId, dataUrl);
    } else {
      await entry.adapter.sendReply(chatId, `[文件: ${filename}]`);
    }
  }

  /** 广播状态到前端（通过 Hub EventBus） */
  _emitStatus(platform: string, status: BridgeStatus, error?: string | null): void {
    this._hub.eventBus.emit(
      { type: "bridge_status", platform, status, error: error || null },
      null,
    );
  }

  /** 记录消息并广播到前端 */
  _pushMessage(entry: BridgeMessageLogEntry): void {
    this._messageLog.push(entry);
    if (this._messageLog.length > this._messageLogMax) {
      this._messageLog.shift();
    }
    this._hub.eventBus.emit(
      { type: "bridge_message", message: entry },
      null,
    );
  }

  /** 获取最近消息日志（供 REST API 使用） */
  getMessages(limit = 50): BridgeMessageLogEntry[] {
    return this._messageLog.slice(-limit);
  }
}
