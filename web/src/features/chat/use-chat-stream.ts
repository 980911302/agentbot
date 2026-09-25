import { useCallback, useEffect, useRef } from 'react';
import * as api from '../../api';
import { artifactFromEvent } from './artifacts';
import type { ChatEngine } from './chat-engine';
import type { AgentEvent, ArtifactView, BotSummary, InteractionRequest, RoomEvent } from '../../types';
import type { ChannelItem } from '../../components/Sidebar';

/** UI 适配器：命令交给 API，消息/运行交给 engine，交互卡和通知交给页面。 */
export function useChatStream(input: {
  engine: ChatEngine;
  getSession: () => { activeAgentId: string | null; activeChannel: ChannelItem; activeChannelId: string; model: string; ownerName: string };
  setArtifacts: (updater: (curr: ArtifactView[]) => ArtifactView[]) => void;
  setNotices: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  setSilentNotes: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  agentsRef: React.MutableRefObject<BotSummary[]>;
  handleInteractionRequest: (request: InteractionRequest) => void;
  handleInteractionClosed: (id: string) => void;
  onMemoryBump: () => void;
  syncWorkspace: () => Promise<unknown>;
}) {
  const ref = useRef(input); ref.current = input;
  const engine = input.engine;

  const reloadChannel = useCallback(async (channelId: string) => {
    if (!channelId) return;
    return engine.load(() => api.fetchChatSnapshot([channelId]));
  }, [engine]);

  const resync = useCallback(async () => {
    const active = ref.current.getSession().activeChannelId;
    const channels = [...new Set([...Object.keys(engine.histories), active,
      ...[...engine.runs.values()].map(run => run.channelId)].filter(Boolean))];
    const snapshot = await engine.load(() => api.fetchChatSnapshot(channels));
    void ref.current.syncWorkspace().catch(() => undefined);
    if (ref.current.getSession().activeChannelId === active && snapshot.channels[active]) ref.current.setArtifacts(() => snapshot.channels[active]!.artifacts);
    return snapshot.cursor;
  }, [engine]);

  const send = useCallback(async (text: string, retryClientMessageId?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { activeAgentId, activeChannel, activeChannelId, model, ownerName } = ref.current.getSession();
    if (!activeChannelId) return;
    const key = retryClientMessageId ?? crypto.randomUUID();
    // ownerName 只用于本地乐观占位：群消息的**权威显示名**取后端设置（E5.7），
    // 所以不再随请求体发出去——否则旧窗口的 localStorage 缓存会覆盖服务端设置。
    engine.beginSend(activeChannelId, key, trimmed, ownerName);
    if (activeChannel.kind === 'room') ref.current.setSilentNotes(prev => ({ ...prev, [activeChannelId]: [] }));
    try {
      if (!activeAgentId) throw new Error('后端未连接，找不到智能体');
      const receipt = activeChannel.kind === 'room'
        ? await api.sendRoomMessage(activeChannelId, { text: trimmed, model: model || undefined, clientMessageId: key })
        : await api.sendChat({ botId: activeAgentId, message: trimmed, model: model || undefined, clientMessageId: key });
      engine.acceptReceipt(receipt);
    } catch (error) { engine.sendFailed(key, error instanceof Error ? error.message : String(error)); }
  }, [engine]);

  const handleEntry = useCallback((entry: api.JournalEntry) => {
    if (!engine.applyEntry(entry)) return;
    const deps = ref.current;
    const channelId = entry.roomId ?? entry.agentId;
    if (!channelId) return;
    if (entry.kind === 'agent') {
      const event = entry.payload as AgentEvent;
      if (event.type === 'interaction' && engine.interactions.some(item => item.id === event.request.id)) deps.handleInteractionRequest(event.request);
      if (event.type === 'interaction_closed' && !engine.interactions.some(item => item.id === event.id)) deps.handleInteractionClosed(event.id);
      const artifact = artifactFromEvent(event);
      if (artifact && deps.getSession().activeChannelId === channelId) deps.setArtifacts(curr => curr.some(item => item.path === artifact.path) ? curr : [...curr, artifact]);
    } else if (entry.kind === 'room') {
      const event = entry.payload as RoomEvent;
      if (event.type === 'flow_updated') {
        window.dispatchEvent(new CustomEvent('agentbot:flow_updated', { detail: event.flow }));
      } else if (event.type === 'round_end') {
        if (event.outcome.status !== 'spoke') deps.setSilentNotes(prev => ({ ...prev, [channelId]: [...(prev[channelId] ?? []).slice(-19),
          `${event.outcome.agentName} ${event.outcome.status === 'error' ? '出错' : '看过，没开口'}`] }));
      }
    } else {
      const payload = entry.payload as { phase?: string; stopReason?: string };
      if (payload.phase === 'done' || payload.phase === 'error') {
        if (payload.stopReason === 'parked') deps.setNotices(prev => ({ ...prev, [channelId]: [...(prev[channelId] ?? []).slice(-4), '⏸ 原任务已挂起，新任务结束后会继续。'] }));
        void reloadChannel(channelId).catch(() => undefined);
        void deps.syncWorkspace().catch(() => undefined);
        deps.onMemoryBump();
      }
    }
  }, [engine, reloadChannel]);

  // 控制面对账：最后一个终态事件丢失或半开连接也不会永远显示“处理中”。
  useEffect(() => {
    let inFlight = false;
    const timer = setInterval(() => {
      if (!engine.busy || inFlight) return;
      inFlight = true;
      void resync().catch(() => undefined).finally(() => { inFlight = false; });
    }, 10_000);
    return () => clearInterval(timer);
  }, [engine, resync]);
  return { send, handleEntry, reloadChannel, resync, busy: engine.busy, respondingChannelIds: engine.respondingChannelIds };
}
