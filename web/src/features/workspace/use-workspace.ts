import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api';
import { formatClock } from '../../format';
import type { BotSummary, DisplayMessage, RoomView } from '../../types';
import type { ChannelItem } from '../../components/Sidebar';

/**
 * useWorkspace（E2.5d）：侧边栏工作台状态。
 * 拥有 channels/backendAgents/rooms/未读 与 15s 轮询；App 只消费。
 */
export function useWorkspace(deps: {
  activeChannelId: string;
  setChannelHistories: (updater: (prev: Record<string, DisplayMessage[]>) => Record<string, DisplayMessage[]>) => void;
}) {
  const [backendAgents, setBackendAgents] = useState<BotSummary[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [roomMemberLimit, setRoomMemberLimit] = useState(6);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const seenRoomsRef = useRef<Map<string, number>>(new Map());
  const activeChannelIdRef = useRef('');
  const agentsRef = useRef<BotSummary[]>([]);

  useEffect(() => {
    agentsRef.current = backendAgents;
  }, [backendAgents]);

  useEffect(() => {
    activeChannelIdRef.current = deps.activeChannelId;
    // 切进频道就是看过了
    setUnread((current) =>
      current[deps.activeChannelId] ? { ...current, [deps.activeChannelId]: 0 } : current,
    );
  }, [deps.activeChannelId]);

  const syncWorkspace = useCallback(async (): Promise<ChannelItem[]> => {
    const [roomData, agents] = await Promise.all([
      api.fetchRooms().catch(() => null),
      api.fetchBots().catch(() => null),
    ]);
    if (!roomData && !agents) return [];

    if (agents) setBackendAgents(agents);
    if (roomData) {
      setRooms(roomData.rooms);
      setRoomMemberLimit(roomData.memberLimit);

      // 未读：首轮只记基线；之后 messageCount 增长且不在当前频道 → 累加差值
      const updates: Record<string, number> = {};
      for (const room of roomData.rooms) {
        const seen = seenRoomsRef.current.get(room.id);
        if (seen === undefined) {
          seenRoomsRef.current.set(room.id, room.messageCount);
          continue;
        }
        if (room.messageCount > seen) {
          seenRoomsRef.current.set(room.id, room.messageCount);
          if (room.id !== activeChannelIdRef.current) {
            updates[room.id] = (updates[room.id] ?? 0) + Math.min(room.messageCount - seen, 99);
          }
        } else if (room.messageCount < seen) {
          seenRoomsRef.current.set(room.id, room.messageCount);
        }
      }
      if (Object.keys(updates).length > 0) {
        setUnread((current) => ({ ...current, ...updates }));
      }
    } else if (agents) {
      // 房间拉取失败但智能体成功：保持智能体更新（rooms 由上次状态保留）
    }

    const rebuilt: ChannelItem[] = [
      ...roomList(roomData ?? { rooms: [], memberLimit: 0 }),
      ...agentList(agents ?? []),
    ];
    setChannels(rebuilt);
    return rebuilt;

    function roomList(data: NonNullable<typeof roomData>): ChannelItem[] {
      return data.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        time: formatClock(room.updatedAt),
        lastMessage: room.lastMessage?.text ?? '还没有人说话',
        color: room.members[0]?.color ?? '#a855f7',
        role: `${room.members.length} 位成员`,
        isGroup: true,
        kind: 'room' as const,
        members: room.members,
      }));
    }
    function agentList(agents: BotSummary[]): ChannelItem[] {
      return agents
        .filter((bot) => !bot.hidden)
        .map((bot) => ({
          id: bot.id,
          name: bot.name,
          time: formatClock(Date.parse(bot.updatedAt)),
          lastMessage: bot.activity || bot.title || bot.role || '准备就绪',
          color: bot.color,
          role: bot.title || bot.role,
          kind: 'agent' as const,
          status: bot.status,
        }));
    }
  }, []);

  const reloadChannel = useCallback(
    async (channelId: string) => {
      if (!channelId) return;
      const isRoom = rooms.some((room) => room.id === channelId);
      try {
        if (isRoom) {
          const messages = await api.fetchRoomMessages(channelId);
          deps.setChannelHistories((prev) => ({
            ...prev,
            [channelId]: messages.map((message) => ({
              id: message.id,
              role: message.senderKind === 'user' ? 'user' : 'assistant',
              content: message.text,
              senderName: message.senderName,
              senderColor: message.senderColor,
              toolCalls: [],
              createdAt: new Date(message.createdAt).toISOString(),
            })),
          }));
          return;
        }
        const detail = await api.fetchSession(channelId);
        deps.setChannelHistories((prev) => ({ ...prev, [channelId]: detail.messages }));
      } catch {
        // 保持现有内容
      }
    },
    [rooms, deps.setChannelHistories],
  );

  const sidebarChannels = useMemo(
    () => channels.map((item) => ({ ...item, unread: unread[item.id] ?? 0 })),
    [channels, unread],
  );

  return {
    backendAgents,
    setBackendAgents,
    agentsRef,
    rooms,
    setRooms,
    roomMemberLimit,
    channels,
    setChannels,
    sidebarChannels,
    syncWorkspace,
    reloadChannel,
  };
}
