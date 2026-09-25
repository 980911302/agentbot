import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api';
import { formatRelativeTime } from '../../format';
import type { BotSummary, DisplayMessage, RoomView } from '../../types';
import type { ChannelItem } from '../../components/Sidebar';
import {
  loadReadMarks,
  reconcileUnread,
  sameUnread,
  saveReadMarks,
  type ReadMarks,
  type ReadMarksStore,
} from './unread-view';

/** 智能体控制/来信快照（UI-03）：暂停、待处理、失败 */
export interface AgentControlFlags {
  paused: boolean;
  pendingMail: number;
  failedMail: number;
  /** 因暂停被扣住的来信数（控制面 held，UI-05 状态条用） */
  held: number;
  /** 控制存储是否损坏（UI-05 状态条用） */
  faulted: boolean;
}

/**
 * useWorkspace（E2.5d）：侧边栏工作台状态。
 * 拥有 channels/backendAgents/rooms/未读 与 15s 轮询；App 只消费。
 */
export function useWorkspace(deps: { activeChannelId: string }) {
  const [backendAgents, setBackendAgents] = useState<BotSummary[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [roomMemberLimit, setRoomMemberLimit] = useState(6);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  /** 智能体控制/来信快照（UI-03 状态点）：暂停、待处理、失败 */
  const [agentFlags, setAgentFlags] = useState<Record<string, AgentControlFlags>>({});
  const agentFlagsRef = useRef<Record<string, AgentControlFlags>>({});
  /** 各频道「已读到第几条」，落 localStorage，重启不丢（群与私聊同一套） */
  const readMarksRef = useRef<ReadMarks | null>(null);
  /** 最近一次拿到的各频道条数（群 / 私聊分开存，一边拉取失败时沿用上次）：切进频道时立刻按它记已读 */
  const roomCountsRef = useRef<Record<string, number>>({});
  const agentCountsRef = useRef<Record<string, number>>({});
  /** 上次同步后离开过的频道：在里面时来的消息已经看过，下一轮同步按已读收口 */
  const leftChannelsRef = useRef<Set<string>>(new Set());
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
    const previous = activeChannelIdRef.current;
    if (previous && previous !== deps.activeChannelId) leftChannelsRef.current.add(previous);
    activeChannelIdRef.current = deps.activeChannelId;
    // 切进频道就是看过了：已读位置立刻跟到已知条数并落盘，红点清掉
    const id = deps.activeChannelId;
    const known = roomCountsRef.current[id] ?? agentCountsRef.current[id];
    const marks = ensureReadMarks(readMarksRef);
    if (id && known !== undefined && marks[id] !== known) {
      marks[id] = known;
      saveReadMarks(readMarksStore(), marks);
    }
    setUnread((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
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
    }

    // 未读（群 + 私聊）：条数 − 已读位置；当前频道与刚离开的频道按已读收口。
    // 房间或同事有一边拉取失败：那一边沿用上次的条数，不清也不新增未读。
    if (roomData) {
      roomCountsRef.current = Object.fromEntries(roomData.rooms.map((room) => [room.id, room.messageCount]));
    }
    if (agents) {
      agentCountsRef.current = Object.fromEntries(
        agents.filter((bot) => !bot.hidden).map((bot) => [bot.id, bot.conversationCount]),
      );
    }
    const result = reconcileUnread({
      counts: { ...roomCountsRef.current, ...agentCountsRef.current },
      marks: ensureReadMarks(readMarksRef),
      readThrough: [activeChannelIdRef.current, ...leftChannelsRef.current],
      complete: Boolean(roomData && agents),
    });
    leftChannelsRef.current.clear();
    readMarksRef.current = result.marks;
    if (result.changed) saveReadMarks(readMarksStore(), result.marks);
    setUnread((current) => (sameUnread(current, result.unread) ? current : result.unread));

    const rebuilt: ChannelItem[] = [
      ...roomList(roomData ?? { rooms: roomsRef.current, memberLimit: roomMemberLimitRef.current }),
      ...agentList(agents ?? agentsRef.current),
    ].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    setChannels(rebuilt);
    return rebuilt;

    function roomList(data: NonNullable<typeof roomData>): ChannelItem[] {
      return data.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        time: formatRelativeTime(room.updatedAt),
        updatedAt: room.updatedAt,
        lastMessage: room.lastMessage?.text ?? '还没有人说话',
        color: room.members[0]?.color ?? '#b89b6a',
        role: `${room.members.length} 位成员`,
        isGroup: true,
        kind: 'room' as const,
        // 后端房间视图不带成员在场状态；把轮询拿到的控制态合进来，
        // 群里才看得出谁被暂停（UI-11：暂停不当成沉默）。
        members: room.members.map((m) => {
          const flags = agentFlagsRef.current[m.id];
          return flags?.paused ? { ...m, status: 'paused' as const } : m;
        }),
      }));
    }
    function agentList(agents: BotSummary[]): ChannelItem[] {
      return agents
        .filter((bot) => !bot.hidden)
        .map((bot) => ({
          id: bot.id,
          name: bot.name,
          time: formatRelativeTime(Date.parse(bot.updatedAt)),
          updatedAt: Date.parse(bot.updatedAt) || 0,
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
        // 群成员的在场状态：后端房间视图不带，用轮询到的控制态补（UI-11）
        members: item.members?.map((member) => {
          const flags = agentFlags[member.id];
          return flags?.paused ? { ...member, status: 'paused' as const } : member;
        }),
      })),
    [channels, unread, agentFlags],
  );

  useEffect(() => {
    agentFlagsRef.current = agentFlags;
  }, [agentFlags]);

  // 状态点数据源：控制视图与来信队列（UI-03）。失败不打扰主流程，下个周期再试。
  // 同一份数据也喂给控制状态条（UI-05）：held（暂停扣住的信）与 faulted 一起取回。
  const pollAgentFlags = useCallback(async () => {
    const list = agentsRef.current.filter((bot) => !bot.hidden);
    const flags: Record<string, AgentControlFlags> = {};
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
            held: control.held,
            faulted: control.faulted,
          };
        } catch {
          // 单个智能体拉取失败：保持上次已知状态，不清点
          flags[bot.id] = agentFlagsRef.current[bot.id] ?? {
            paused: false,
            pendingMail: 0,
            failedMail: 0,
            held: 0,
            faulted: false,
          };
        }
      }),
    );
    if (!agentFlagsPollDisposed.current) setAgentFlags(flags);
  }, []);

  const agentFlagsPollDisposed = useRef(false);
  /** 同事列表的身份（id 序列）：列表到位或增删时立即重拉一次控制态 */
  const agentIds = backendAgents.map((bot) => bot.id).join(',');

  useEffect(() => {
    agentFlagsPollDisposed.current = false;
    // 冷启动那一刻 agentsRef 还是空的，按空列表拉到的 flags 是空对象；等列表到位再拉一次，
    // 否则暂停横幅/待处理数要等下一次 15 秒轮询（bug_ob1vlpotsy48）
    if (agentIds) void pollAgentFlags();
    const timer = window.setInterval(() => void pollAgentFlags(), 15000);
    return () => {
      agentFlagsPollDisposed.current = true;
      window.clearInterval(timer);
    };
  }, [pollAgentFlags, agentIds]);

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
    /** 控制/来信快照（UI-05 控制状态条用） */
    agentFlags,
    /** 操作（恢复/重试）后立刻重取一次，不用等下一个 15s 周期 */
    refreshAgentFlags: pollAgentFlags,
  };
}

/** localStorage 在隐私模式下访问即抛：包一层，读写失败都交给 unread-view 静默处理 */
function readMarksStore(): ReadMarksStore {
  try {
    return window.localStorage;
  } catch {
    return {
      getItem: () => null,
      setItem: () => undefined,
    };
  }
}

/** 已读位置：首次用到时从 localStorage 读一次，之后以内存为准 */
function ensureReadMarks(ref: { current: ReadMarks | null }): ReadMarks {
  if (!ref.current) ref.current = loadReadMarks(readMarksStore());
  return ref.current;
}
