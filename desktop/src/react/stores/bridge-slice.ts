import type { BridgeSession } from '../types';

export interface BridgeIncomingMessage {
  platform: string;
  sessionKey: string;
  direction: string;
  sender: string;
  text: string;
  isGroup: boolean;
  ts: number;
}

export interface BridgeSlice {
  /** 最新收到的 bridge 消息（ws-message-handler 写入，BridgePanel 订阅） */
  bridgeLatestMessage: BridgeIncomingMessage | null;
  /** 递增计数器，每次 bridge_status 事件 +1，代替 loadStatus 回调 */
  bridgeStatusTrigger: number;
  /** Bridge sessions shown in sidebar (IM fixed channels) */
  bridgeSessions: BridgeSession[];
  /** Currently active bridge session key (null = viewing normal session) */
  activeBridgeSessionKey: string | null;
  /** Messages for the active bridge session */
  activeBridgeMessages: Array<{ role: string; content: string; ts: string | null }>;
  /** 写入一条 bridge 消息 */
  addBridgeMessage: (msg: BridgeIncomingMessage) => void;
  /** 触发 bridge 状态重载 */
  triggerBridgeReload: () => void;
  /** Set bridge sessions list */
  setBridgeSessions: (sessions: BridgeSession[]) => void;
  /** Set active bridge session key */
  setActiveBridgeSessionKey: (key: string | null) => void;
  /** Set active bridge messages */
  setActiveBridgeMessages: (msgs: Array<{ role: string; content: string; ts: string | null }>) => void;
}

export const createBridgeSlice = (
  set: (partial: Partial<BridgeSlice> | ((s: BridgeSlice) => Partial<BridgeSlice>)) => void,
): BridgeSlice => ({
  bridgeLatestMessage: null,
  bridgeStatusTrigger: 0,
  bridgeSessions: [],
  activeBridgeSessionKey: null,
  activeBridgeMessages: [],
  addBridgeMessage: (msg) => set({ bridgeLatestMessage: msg }),
  triggerBridgeReload: () =>
    set((s) => ({ bridgeStatusTrigger: s.bridgeStatusTrigger + 1 })),
  setBridgeSessions: (sessions) => set({ bridgeSessions: sessions }),
  setActiveBridgeSessionKey: (key) => set({ activeBridgeSessionKey: key }),
  setActiveBridgeMessages: (msgs) => set({ activeBridgeMessages: msgs }),
});
