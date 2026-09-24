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
}) {
  const [backendAgents, setBackendAgents] = useState<BotSummary[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [roomMemberLimit, setRoomMemberLimit] = useState(6);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  /** 智能体控制/来信快照（UI-03 状态点）：暂停、待处理、失败 */
  const [agentFlags, setAgentFlags] = useState<Record<string, { paused: boolean; pendingMail: number; failedMail: number }>>({});
  const agentFlagsRef = useRef(agentFlags);
  const seenRoomsRef = useRef<Map<string, number>>(new Map());
  const activeChannelIdRef = useRef('');
  const agentsRef = useRef<BotSummary[]>([]);
  const roomsRef = useRef<RoomView[]>([]);
  const channelsRef = useRef<ChannelItem[]>([]);
  const roomMemberLimitRef = useRef(6);

  useEffect(() => {
    agentsRef.current = backendAgents;
  }, [backendAgents]);

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    roomMemberLimitRef.current = roomMemberLimit;
  }, [roomMemberLimit]);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

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
    if (!roomData && !agents) return channelsRef.current;

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
        setUnread((current) => {
          const next = { ...current };
          for (const [roomId, increment] of Object.entries(updates)) {
            next[roomId] = Math.min((current[roomId] ?? 0) + increment, 99);
          }
          return next;
        });
      }
    } else if (agents) {
      // 房间拉取失败但智能体成功：保持智能体更新（rooms 由上次状态保留）
    }

    const rebuilt: ChannelItem[] = [
      ...roomList(roomData ?? { rooms: roomsRef.current, memberLimit: roomMemberLimitRef.current }),
      ...agentList(agents ?? agentsRef.current),
    ];
    setChannels(rebuilt);
    return rebuilt;

    function roomList(data: NonNullable<typeof roomData>): ChannelItem[] {
      return data.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        time: formatClock(room.updatedAt),
        lastMessage: room.lastMessage?.text ?? '还没有人说话',
        color: room.members[0]?.color ?? '#b89b6a',
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

  const sidebarChannels = useMemo(
    () =>
      channels.map((item) => ({
        ...item,
        unread: unread[item.id] ?? 0,
        ...(item.kind === 'agent' ? (agentFlags[item.id] ?? {}) : {}),
      })),
    [channels, unread, agentFlags],
  );

  useEffect(() => {
    agentFlagsRef.current = agentFlags;
  }, [agentFlags]);

  // 状态点数据源：控制视图与来信队列（UI-03）。失败不打扰主流程，下个周期再试。
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      const list = agentsRef.current.filter((bot) => !bot.hidden);
      const flags: Record<string, { paused: boolean; pendingMail: number; failedMail: number }> = {};
      await Promise.all(
        list.map(async (bot) => {
          try {
            const [control, inbox] = await Promise.all([
              api.fetchAgentControl(bot.id),
              api.fetchAgentInbox(bot.id),
            ]);
            flags[bot.id] = {
              paused: control.autoActivation === 'paused',
              pendingMail: inbox.pending,
              failedMail: inbox.failed,
            };
          } catch {
            // 单个智能体拉取失败：保持上次已知状态，不清点
            flags[bot.id] = agentFlagsRef.current[bot.id] ?? { paused: false, pendingMail: 0, failedMail: 0 };
          }
        }),
      );
      if (!disposed) setAgentFlags(flags);
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 15000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

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
  };
}
