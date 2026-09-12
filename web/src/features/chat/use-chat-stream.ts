import { useCallback, useRef, useState } from 'react';
import * as api from '../../api';
import { applyEvent, errorMessage, now } from './message-reducer';
import type {
  AgentEvent,
  ArtifactView,
  BotSummary,
  DisplayMessage,
  InteractionRequest,
  RoomEvent,
} from '../../types';
import type { ChannelItem } from '../../components/Sidebar';

/**
 * useChatStream（E2.5c 拆出，E3.4 第二步改为「发送只回执、事件走订阅」）。
 *
 * 发送：乐观占位 + POST 202 回执（失败才写错误气泡）。
 * 事件：由 useEventStream 推来 handleEntry，按 agentId/roomId 路由到频道：
 *   - agent 事件 → 消息 reducer、流式增量、交互卡、产物
 *   - room 事件 → 群消息、回合气泡、沉默提示
 *   - run 事件 → 忙闲、挂起提示、忙完拉真相
 */
export function useChatStream(input: {
  getSession: () => {
    activeAgentId: string | null;
    activeChannel: ChannelItem;
    activeChannelId: string;
    model: string;
    ownerName: string;
  };
  /** 事件按频道路由时取频道信息（名字/颜色） */
  getChannel: (channelId: string) => ChannelItem | undefined;
  setChannelHistories: (updater: (prev: Record<string, DisplayMessage[]>) => Record<string, DisplayMessage[]>) => void;
  setArtifacts: (updater: (curr: ArtifactView[]) => ArtifactView[]) => void;
  setNotices: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  setRoundActive: (member: { id: string; name: string; color: string } | null) => void;
  setSilentNotes: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  agentsRef: React.MutableRefObject<BotSummary[]>;
  handleInteractionRequest: (request: InteractionRequest) => void;
  handleInteractionClosed: (id: string) => void;
  onMemoryBump: () => void;
  syncWorkspace: () => Promise<unknown>;
  reloadChannel: (channelId: string) => Promise<void>;
}) {
  const deps = input;
  const [busy, setBusy] = useState(false);
  /** 每个频道正在跑的回合数：忙是「有人发起的回合在跑」 */
  const busyCountsRef = useRef(new Map<string, number>());
  const [liveText, setLiveText] = useState('');
  const [liveChannelId, setLiveChannelId] = useState('');
  const liveChannelRef = useRef('');
  /** 每个频道最后发出去的原话：错误气泡的「重试」要用 */
  const pendingTextRef = useRef(new Map<string, string>());

  const bumpBusy = useCallback((channelId: string, delta: 1 | -1) => {
    const counts = busyCountsRef.current;
    const next = (counts.get(channelId) ?? 0) + delta;
    if (next > 0) counts.set(channelId, next);
    else counts.delete(channelId);
    setBusy(counts.size > 0);
  }, []);

  const clearLive = useCallback((channelId: string) => {
    if (liveChannelRef.current !== channelId) return;
    liveChannelRef.current = '';
    setLiveChannelId('');
    setLiveText('');
  }, []);

  const isActiveChannel = useCallback(
    (channelId: string) => deps.getSession().activeChannelId === channelId,
    [deps],
  );

  /** 发一句话：先落占位、后端回执；回合照跑，其余都靠事件回来 */
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // 幂等键：同一键重复提交，服务端返回原消息（E3.2）
      const clientMessageId = crypto.randomUUID();
      const { activeAgentId, activeChannel, activeChannelId, model, ownerName } = deps.getSession();
      if (!activeAgentId) {
        deps.setChannelHistories((prev) => ({
          ...prev,
          [activeChannelId]: [
            ...(prev[activeChannelId] ?? []),
            errorMessage(activeChannel, '后端未连接，找不到这个频道对应的智能体'),
          ],
        }));
        return;
      }

      const placeholder: DisplayMessage = {
        id: `pending-${clientMessageId}`,
        role: 'user',
        senderName: ownerName,
        content: trimmed,
        toolCalls: [],
        createdAt: now(),
      };
      deps.setChannelHistories((prev) => ({
        ...prev,
        [activeChannelId]: [...(prev[activeChannelId] ?? []), placeholder],
      }));
      pendingTextRef.current.set(activeChannelId, trimmed);
      bumpBusy(activeChannelId, 1);
      if (activeChannel.kind === 'room') {
        deps.setSilentNotes((prev) => ({ ...prev, [activeChannelId]: [] }));
      } else {
        liveChannelRef.current = activeChannelId;
        setLiveChannelId(activeChannelId);
        setLiveText('');
      }

      try {
        if (activeChannel.kind === 'room') {
          await api.sendRoomMessage(activeChannelId, {
            text: trimmed,
            model: model || undefined,
            ownerName,
            clientMessageId,
          });
        } else {
          const receipt = await api.sendChat({
            botId: activeAgentId,
            message: trimmed,
            model: model || undefined,
            clientMessageId,
          });
          if (receipt.duplicate) {
            // 重复提交：占位换成原消息；历史里已经有就只摘占位，不重复渲染
            deps.setChannelHistories((prev) => {
              const list = prev[activeChannelId] ?? [];
              if (list.some((item) => item.id === receipt.messageId)) {
                return {
                  ...prev,
                  [activeChannelId]: list.filter((item) => item.id !== placeholder.id),
                };
              }
              return {
                ...prev,
                [activeChannelId]: list.map((item) =>
                  item.id === placeholder.id ? { ...item, id: receipt.messageId ?? item.id } : item,
                ),
              };
            });
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        pendingTextRef.current.delete(activeChannelId);
        bumpBusy(activeChannelId, -1);
        clearLive(activeChannelId);
        deps.setChannelHistories((prev) => ({
          ...prev,
          [activeChannelId]: [
            ...(prev[activeChannelId] ?? []),
            errorMessage(activeChannel, `发送失败：${reason}`, trimmed),
          ],
        }));
      }
    },
    [deps, bumpBusy, clearLive],
  );

  const handleAgentEvent = useCallback(
    (channelId: string, event: AgentEvent) => {
      if (event.type === 'delta') {
        if (liveChannelRef.current === channelId) setLiveText((current) => current + event.text);
        return;
      }
      if (event.type === 'interaction') {
        deps.handleInteractionRequest(event.request);
        return;
      }
      if (event.type === 'interaction_closed') {
        deps.handleInteractionClosed(event.id);
        return;
      }
      if (event.type === 'message' && event.message.role === 'assistant' && event.message.content.type === 'text') {
        if (liveChannelRef.current === channelId) setLiveText('');
      }
      deps.setChannelHistories((prev) => ({
        ...prev,
        [channelId]: applyEvent(prev[channelId] ?? [], event),
      }));
      if (event.type === 'message' && event.message.content.type === 'tool_calls') {
        for (const call of event.message.content.calls) {
          try {
            const args = JSON.parse(call.arguments || '{}') as { path?: unknown };
            if (typeof args.path !== 'string' || !args.path) continue;
            const path = args.path;
            deps.setArtifacts((curr) =>
              curr.some((item) => item.path === path)
                ? curr
                : [...curr, { path, tool: call.name, createdAt: now() }],
            );
          } catch {
            // 参数还不是合法 JSON
          }
        }
      }
    },
    [deps],
  );

  const handleRoomEvent = useCallback(
    (channelId: string, event: RoomEvent) => {
      if (event.type === 'room_message') {
        const message = event.message;
        deps.setChannelHistories((prev) => {
          const list = prev[channelId] ?? [];
          if (message.senderKind === 'user') {
            const index = list.findIndex(
              (item) => item.id.startsWith('pending-') && item.content === message.text,
            );
            if (index >= 0) {
              const next = [...list];
              next[index] = {
                ...next[index]!,
                id: message.id,
                senderName: message.senderName,
                createdAt: new Date(message.createdAt).toISOString(),
              };
              return { ...prev, [channelId]: next };
            }
          }
          if (list.some((item) => item.id === message.id)) return prev;
          return {
            ...prev,
            [channelId]: [
              ...list,
              {
                id: message.id,
                role: message.senderKind === 'user' ? 'user' : 'assistant',
                content: message.text,
                senderName: message.senderName,
                senderColor: message.senderColor,
                toolCalls: [],
                createdAt: new Date(message.createdAt).toISOString(),
              },
            ],
          };
        });
        return;
      }
      if (event.type === 'round_start') {
        // 只在正看着这个群时播放「谁在回合中」，后台回合不打扰当前频道
        if (!isActiveChannel(channelId)) return;
        const color =
          deps.agentsRef.current.find((bot) => bot.id === event.agentId)?.color ?? '#8b5cf6';
        deps.setRoundActive({ id: event.agentId, name: event.agentName, color });
        return;
      }
      if (event.type === 'round_end') {
        const outcome = event.outcome;
        if (isActiveChannel(channelId)) deps.setRoundActive(null);
        if (outcome.status !== 'spoke') {
          deps.setSilentNotes((prev) => ({
            ...prev,
            [channelId]: [
              ...(prev[channelId] ?? []),
              `${outcome.agentName} ${outcome.status === 'error' ? '出错' : '看过，没开口'}`,
            ],
          }));
        }
        return;
      }
      // fanout_done：这一轮结束，收掉回合气泡
      if (isActiveChannel(channelId)) deps.setRoundActive(null);
    },
    [deps, isActiveChannel],
  );

  /** 订阅推来的事件：按频道路由（E3.4 第二步） */
  const handleEntry = useCallback(
    (entry: api.JournalEntry) => {
      const channelId = entry.roomId ?? entry.agentId;
      if (!channelId) return;

      if (entry.kind === 'room') {
        handleRoomEvent(channelId, entry.payload as RoomEvent);
        return;
      }
      if (entry.kind === 'agent') {
        // 群回合里的 agent 事件只关心交互卡；群消息走 room 事件
        if (entry.roomId) {
          const event = entry.payload as AgentEvent;
          if (event.type === 'interaction') deps.handleInteractionRequest(event.request);
          else if (event.type === 'interaction_closed') deps.handleInteractionClosed(event.id);
          return;
        }
        handleAgentEvent(channelId, entry.payload as AgentEvent);
        return;
      }

      const payload = entry.payload as { phase?: string; stopReason?: string; message?: string };
      if (payload.phase === 'done') {
        bumpBusy(channelId, -1);
        pendingTextRef.current.delete(channelId);
        clearLive(channelId);
        if (payload.stopReason === 'parked') {
          deps.setNotices((prev) => ({
            ...prev,
            [channelId]: [
              ...(prev[channelId] ?? []).slice(-4),
              '⏸ 有一条任务被新指令插队挂起，做完手头的事会自动接着做',
            ],
          }));
        }
        // 忙完拉真相：历史取服务端为准，侧边栏/未读一起对齐
        void deps.reloadChannel(channelId);
        void deps.syncWorkspace();
        deps.onMemoryBump();
        return;
      }
      if (payload.phase === 'error') {
        bumpBusy(channelId, -1);
        clearLive(channelId);
        const retryText = pendingTextRef.current.get(channelId);
        pendingTextRef.current.delete(channelId);
        const channel =
          deps.getChannel(channelId) ?? { id: channelId, name: '同事', time: '', lastMessage: '' };
        deps.setChannelHistories((prev) => ({
          ...prev,
          [channelId]: [
            ...(prev[channelId] ?? []),
            errorMessage(channel, `执行出错：${payload.message ?? '未知错误'}`, retryText),
          ],
        }));
      }
    },
    [deps, bumpBusy, clearLive, handleAgentEvent, handleRoomEvent],
  );

  return { send, handleEntry, busy, liveText, liveChannelId };
}
