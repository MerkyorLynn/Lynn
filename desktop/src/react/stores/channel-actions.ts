/**
 * channel-actions.ts — Channel 副作用操作（网络请求 + 状态联动）
 *
 * 从 channel-slice.ts 提取，所有函数通过 useStore.getState() / useStore.setState() 访问 store。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- API 响应 JSON 及 catch(err: any) */

import { useStore } from './index';
import { hanaFetch, hanaFetchAllowError } from '../hooks/use-hana-fetch';
import { loadAgents } from './agent-actions';
import type { Channel } from '../types';

const CHANNEL_STORAGE_KEY = 'hana-current-channel';

async function confirmDeleteChannel(channelId: string): Promise<boolean> {
  const channel = useStore.getState().channels.find((item) => item.id === channelId);
  const displayName = channel?.name || channelId;
  return await window.platform?.confirmAction?.({
    title: window.t?.('channel.deleteChannel') || 'Delete channel',
    message: window.t?.('channel.deleteConfirm', { name: displayName }) || '',
    confirmLabel: window.t?.('common.delete') || 'Delete',
    cancelLabel: window.t?.('common.cancel') || 'Cancel',
  }) ?? false;
}

async function confirmArchiveChannel(channelId: string): Promise<boolean> {
  const channel = useStore.getState().channels.find((item) => item.id === channelId);
  const displayName = channel?.name || channelId;
  return await window.platform?.confirmAction?.({
    title: window.t?.('channel.archiveChannel') || 'Archive channel',
    message: window.t?.('channel.archiveConfirm', { name: displayName }) || '',
    confirmLabel: window.t?.('channel.archiveAction') || 'Archive',
    cancelLabel: window.t?.('common.cancel') || 'Cancel',
  }) ?? false;
}

function isArchivedChannel(value: unknown): boolean {
  return value === true || value === 'true';
}

function buildChannelMembersText(memberCount: number, archived: boolean): string {
  const base = String(memberCount) + ' ' + (window.t?.('channel.membersCount') || 'members');
  return archived ? base + ' · ' + (window.t?.('channel.archivedStatus') || 'Archived') : base;
}

function tr(key: string, fallback: string, vars?: Record<string, string | number>): string {
  const value = window.t?.(key, vars);
  return !value || value === key ? fallback : String(value);
}

function formatActionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^hanaFetch\s+\S+:\s*/, '').trim();
}

function showChannelError(key: string, fallback: string, err: unknown, dedupeKey?: string): void {
  const detail = formatActionError(err);
  const text = detail ? tr(key, fallback) + ': ' + detail : tr(key, fallback);
  useStore.getState().addToast(text, 'error', 5000, dedupeKey ? { dedupeKey } : undefined);
}

function getChannelStorageKey(agentId: string | null | undefined): string {
  return agentId ? `${CHANNEL_STORAGE_KEY}:${agentId}` : CHANNEL_STORAGE_KEY;
}

export function getStoredChannelId(agentId: string | null | undefined): string | null {
  try {
    return localStorage.getItem(getChannelStorageKey(agentId)) || null;
  } catch {
    return null;
  }
}

export function setStoredChannelId(agentId: string | null | undefined, channelId: string): void {
  try {
    localStorage.setItem(getChannelStorageKey(agentId), channelId);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function clearStoredChannelId(agentId: string | null | undefined): void {
  try {
    localStorage.removeItem(getChannelStorageKey(agentId));
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export function pickChannelToOpen(
  channels: Channel[],
  currentChannel: string | null | undefined,
  preferredChannelId?: string | null,
): Channel | null {
  if (channels.length === 0) return null;

  if (currentChannel && channels.some((channel) => channel.id === currentChannel)) {
    return null;
  }

  if (preferredChannelId) {
    const preferred = channels.find((channel) => channel.id === preferredChannelId);
    if (preferred) return preferred;
  }

  return channels.find((channel) => !channel.isDM && !channel.archived)
    || channels.find((channel) => !channel.isDM)
    || channels[0]
    || null;
}

export async function loadChannels(): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  try {
    const [chRes, dmRes] = await Promise.all([
      hanaFetchAllowError('/api/channels'),
      hanaFetchAllowError('/api/dm'),
    ]);

    if (!chRes.ok && !dmRes.ok) {
      throw new Error('channels ' + chRes.status + ', dm ' + dmRes.status);
    }

    const chData = chRes.ok ? await chRes.json() : { channels: [] };
    const dmData = dmRes.ok ? await dmRes.json() : { dms: [] };

    const channels: Channel[] = (chData.channels || []).map((ch: any) => ({
      ...ch,
      archived: isArchivedChannel(ch.archived),
      archivedAt: ch.archivedAt || '',
      isDM: false,
    }));

    const dms: Channel[] = (dmData.dms || []).map((dm: any) => ({
      id: `dm:${dm.peerId}`,
      name: dm.peerName || dm.peerId,
      members: [dm.peerId],
      lastMessage: dm.lastMessage || '',
      lastSender: dm.lastSender || '',
      lastTimestamp: dm.lastTimestamp || '',
      newMessageCount: 0,
      isDM: true,
      peerId: dm.peerId,
      peerName: dm.peerName,
    }));

    const allChannels = [...channels, ...dms];
    const totalUnread = allChannels.reduce((sum, ch) => sum + (ch.newMessageCount || 0), 0);
    useStore.setState({ channels: allChannels, channelTotalUnread: totalUnread });

    const preferredChannelId = getStoredChannelId(useStore.getState().currentAgentId);
    const nextChannel = pickChannelToOpen(allChannels, useStore.getState().currentChannel, preferredChannelId);
    if (nextChannel) {
      void openChannel(nextChannel.id, nextChannel.isDM);
    }
  } catch (err) {
    console.error('[channels] load failed:', err);
    showChannelError('channel.loadFailed', 'Failed to load channels', err, 'channel-load-failed');
  }
}

export async function openChannel(channelId: string, isDM?: boolean): Promise<void> {
  const s = useStore.getState();
  const ch = s.channels.find((c: Channel) => c.id === channelId);
  const isThisDM = isDM ?? ch?.isDM ?? false;
  const t = window.t;
  const prevViewState = {
    currentChannel: s.currentChannel,
    channelMessages: s.channelMessages,
    channelMembers: s.channelMembers,
    channelHeaderName: s.channelHeaderName,
    channelHeaderMembersText: s.channelHeaderMembersText,
    channelIsDM: s.channelIsDM,
    channelArchived: s.channelArchived,
    channelInfoName: s.channelInfoName,
  };

  setStoredChannelId(s.currentAgentId, channelId);

  const peerId = isThisDM ? (ch?.peerId || channelId.replace('dm:', '')) : '';
  const peerName = isThisDM ? (ch?.name || peerId) : '';
  useStore.setState({
    currentChannel: channelId,
    channelMessages: [],
    channelMembers: isThisDM ? [peerId] : [],
    channelHeaderName: isThisDM ? peerName : '',
    channelHeaderMembersText: '',
    channelIsDM: isThisDM,
    channelArchived: isThisDM ? false : !!ch?.archived,
    channelInfoName: isThisDM ? peerName : '',
  });

  try {
    if (isThisDM) {
      const res = await hanaFetch(`/api/dm/${encodeURIComponent(peerId)}`);
      if (res.ok) {
        const data = await res.json();
        useStore.setState({
          channelMessages: data.messages || [],
          channelHeaderName: data.peerName || peerName,
          channelInfoName: data.peerName || peerName,
          channelArchived: false,
        });
      }
    } else {
      const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const members = data.members || [];
      const archived = isArchivedChannel(data.archived);
      const userEntry = useStore.getState().userName || 'user';
      const memberCount = members.includes(userEntry) || members.includes('user')
        ? members.length
        : members.length + 1;
      useStore.setState({
        channelMessages: data.messages || [],
        channelMembers: members,
        channelHeaderName: `# ${data.name || channelId}`,
        channelHeaderMembersText: buildChannelMembersText(memberCount, archived),
        channelIsDM: false,
        channelArchived: archived,
        channelInfoName: data.name || channelId,
      });

      const msgs = data.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg) {
        hanaFetch(`/api/channels/${encodeURIComponent(channelId)}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: lastMsg.timestamp }),
        }).catch((err: unknown) => console.warn('[channel-actions] mark-as-read failed', err));

        const fresh = useStore.getState();
        const freshCh = fresh.channels.find((c: Channel) => c.id === channelId);
        if (freshCh) {
          const newTotal = Math.max(0, fresh.channelTotalUnread - (freshCh.newMessageCount || 0));
          const updatedChannels = fresh.channels.map((c: Channel) =>
            c.id === channelId ? { ...c, newMessageCount: 0 } : c,
          );
          useStore.setState({ channelTotalUnread: newTotal, channels: updatedChannels });
        }
      }
    }
  } catch (err) {
    if (prevViewState.currentChannel) {
      setStoredChannelId(s.currentAgentId, prevViewState.currentChannel);
    } else {
      clearStoredChannelId(s.currentAgentId);
    }
    useStore.setState(prevViewState);
    console.error('[channels] open failed:', err);
    showChannelError('channel.openFailed', 'Failed to open channel', err, 'channel-open-failed');
  }
}

export async function sendChannelMessage(text: string): Promise<boolean> {
  const s = useStore.getState();
  if (!text.trim() || !s.currentChannel) return false;

  try {
    const res = await hanaFetch(`/api/channels/${encodeURIComponent(s.currentChannel)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (data.ok && data.timestamp) {
      const fresh = useStore.getState();
      useStore.setState({
        channelMessages: [...fresh.channelMessages, {
          sender: fresh.userName || 'user',
          timestamp: data.timestamp,
          body: text,
        }],
      });
      return true;
    }

    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    useStore.getState().addToast(
      msg.toLowerCase().includes('archived')
        ? (window.t?.('channel.archivedReadOnly') || 'Archived channels are read-only')
        : `${window.t?.('channel.sendFailed') || 'Send failed'}: ${msg}`,
      'error',
    );
    console.error('[channels] send failed:', err);
    return false;
  }
}

export async function deleteChannel(channelId: string): Promise<void> {
  const s = useStore.getState();
  const addToast = useStore.getState().addToast;
  if (!(await confirmDeleteChannel(channelId))) return;

  try {
    const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (getStoredChannelId(s.currentAgentId) === channelId) {
        clearStoredChannelId(s.currentAgentId);
      }
      if (s.currentChannel === channelId) {
        useStore.setState({
          currentChannel: null,
          channelMessages: [],
          channelHeaderName: '',
          channelHeaderMembersText: '',
          channelIsDM: false,
          channelArchived: false,
        });
      }
      await loadChannels();
      addToast(window.t?.('channel.deleted') || 'Channel deleted', 'success');
    } else {
      const suffix = data.error ? `: ${data.error}` : '';
      addToast(`${window.t?.('channel.deleteFailed') || 'Delete failed'}${suffix}`, 'error');
      console.error('[channels] delete failed:', data.error);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addToast(`${window.t?.('channel.deleteFailed') || 'Delete failed'}: ${msg}`, 'error');
    console.error('[channels] delete failed:', err);
  }
}

export async function archiveChannel(channelId: string): Promise<void> {
  const s = useStore.getState();
  const addToast = useStore.getState().addToast;
  if (!(await confirmArchiveChannel(channelId))) return;

  try {
    const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}/archive`, {
      method: 'POST',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    await loadChannels();
    if (s.currentChannel === channelId) {
      await openChannel(channelId);
    }
    addToast(window.t?.('channel.archived') || 'Channel archived', 'success');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addToast(`${window.t?.('channel.archiveFailed') || 'Archive failed'}: ${msg}`, 'error');
    console.error('[channels] archive failed:', err);
  }
}

export async function toggleChannelsEnabled(): Promise<boolean> {
  const s = useStore.getState();
  const newEnabled = !s.channelsEnabled;
  useStore.setState({ channelsEnabled: newEnabled });

  if (newEnabled) {
    await loadChannels();
  }

  try {
    await hanaFetch('/api/channels/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled }),
    });
  } catch (err) {
    useStore.setState({ channelsEnabled: s.channelsEnabled });
    console.error('[channels] toggle backend failed:', err);
    showChannelError('channel.toggleFailed', 'Failed to update channels', err, 'channel-toggle-failed');
    return s.channelsEnabled;
  }

  return newEnabled;
}

export async function createChannel(name: string, members: string[], intro?: string, spawnedExpertIds?: string[]): Promise<string | null> {
  try {
    const res = await hanaFetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        members,
        intro: intro || undefined,
        spawnedExpertIds: spawnedExpertIds || undefined,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    await loadChannels();
    if (data.id) {
      await openChannel(data.id);
    }
    return data.id || null;
  } catch (err: any) {
    console.error('[channels] create failed:', err);
    throw err;
  }
}

function resolvePrimaryChannelAgent() {
  const { agents, currentAgentId } = useStore.getState();
  return agents.find((agent) => agent.id === currentAgentId)
    || agents.find((agent) => agent.isPrimary)
    || agents[0]
    || null;
}

export async function spawnExpertAgent(
  slug: string,
  opts: {
    channelId?: string;
    modelId?: string;
    provider?: string;
    userId?: string;
    persistent?: boolean;
  } = {},
): Promise<{ agentId: string; name: string }> {
  const res = await hanaFetchAllowError(`/api/experts/${encodeURIComponent(slug)}/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channelId: opts.channelId,
      modelId: opts.modelId,
      provider: opts.provider,
      userId: opts.userId,
      persistent: opts.persistent,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.agentId) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return {
    agentId: data.agentId,
    name: data.name || data.agentId,
  };
}

export async function addExpertToChannel(
  channelId: string,
  slug: string,
  opts: { modelId?: string; provider?: string } = {},
): Promise<{ agentId: string; name: string }> {
  const spawned = await spawnExpertAgent(slug, {
    channelId,
    modelId: opts.modelId,
    provider: opts.provider,
  });
  await loadAgents();
  await addMembersToChannel(channelId, [spawned.agentId]);
  return spawned;
}

export async function createChannelWithExpert(
  slug: string,
  opts: { channelName?: string; intro?: string; modelId?: string; provider?: string } = {},
): Promise<string | null> {
  const baseAgent = resolvePrimaryChannelAgent();
  if (!baseAgent) {
    throw new Error(window.t?.('channel.createNeedAssistant') || 'No assistant available');
  }

  const spawned = await spawnExpertAgent(slug, {
    modelId: opts.modelId,
    provider: opts.provider,
  });
  await loadAgents();
  return await createChannel(
    opts.channelName || spawned.name,
    [baseAgent.id, spawned.agentId],
    opts.intro,
    [spawned.agentId],
  );
}

export async function addMembersToChannel(channelId: string, memberIds: string[]): Promise<string[]> {
  const res = await hanaFetch(`/api/channels/${encodeURIComponent(channelId)}/members`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ add: memberIds }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const agentMap = new Map(useStore.getState().agents.map(agent => [agent.id, agent]));
  const members = Array.isArray(data.members) ? data.members : [];
  useStore.setState({
    channels: useStore.getState().channels.map((channel) => {
      if (channel.id !== channelId) return channel;
      const peerId = channel.isDM ? channel.peerId : channel.peerId;
      const peerAgent = peerId ? agentMap.get(peerId) : null;
      return {
        ...channel,
        members,
        peerName: channel.isDM && peerAgent ? peerAgent.name : channel.peerName,
      };
    }),
  });

  if (useStore.getState().currentChannel === channelId) {
    useStore.setState({
      channelMembers: members,
      channelHeaderMembersText: buildChannelMembersText(members.length + 1, useStore.getState().channelArchived),
      channelInfoName: useStore.getState().channelInfoName,
    });
  }

  const addedNames = memberIds
    .map((id) => agentMap.get(id)?.name || id)
    .filter(Boolean);
  const toastText = addedNames.length > 0
    ? `${window.t?.('channel.memberAdded') || 'Member added'}: ${addedNames.join(', ')}`
    : (window.t?.('channel.memberAdded') || 'Member added');
  useStore.getState().addToast(toastText, 'success');

  return members;
}
