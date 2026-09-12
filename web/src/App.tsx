import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar, type ChannelItem } from './components/Sidebar';
import { BotScreen } from './components/BotScreen';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { SettingsDialog } from './components/SettingsDialog';
import { CreateDialog } from './components/CreateDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MemberPanel } from './components/MemberPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { InteractionCard } from './components/InteractionCard';
import { IconClose } from './icons';
import { usePresence } from './motion';
import { useTheme } from './theme';
import * as api from './api';
import type {
  AgentEvent,
  ArtifactView,
  BotSummary,
  DisplayMessage,
  HealthInfo,
  InteractionRequest,
  RoomView,
} from './types';

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function now(): string {
  return new Date().toISOString();
}

function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '刚刚';
  const date = new Date(timestamp);
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 24 * 60 * 60 * 1000) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function errorMessage(channel: ChannelItem, text: string): DisplayMessage {
  return {
    id: uid(),
    role: 'assistant',
    senderName: channel.name,
    senderColor: channel.color,
    content: `⚠️ ${text}`,
    toolCalls: [],
    createdAt: now(),
    error: true,
  };
}

function updateLastAssistant(
  messages: DisplayMessage[],
  mutate: (message: DisplayMessage) => void,
): DisplayMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const candidate = next[index];
    if (candidate && candidate.role === 'assistant') {
      const clone: DisplayMessage = {
        ...candidate,
        toolCalls: candidate.toolCalls.map((call) => ({ ...call })),
      };
      mutate(clone);
      next[index] = clone;
      return next;
    }
  }
  const created: DisplayMessage = {
    id: uid(),
    role: 'assistant',
    content: '',
    toolCalls: [],
    createdAt: now(),
  };
  mutate(created);
  return [...next, created];
}

/**
 * 把后端的事件流折成界面消息。
 *
 * 后端事件是消息制的：
 *   message(role=user)          → 我自己的那条（替换本地占位）
 *   message(role=assistant,text)      → 一段回复
 *   message(role=assistant,tool_calls)→ 挂到当前这条助手消息上
 *   message(role=tool,tool_result)    → 回填对应工具调用的结果
 */
function applyEvent(messages: DisplayMessage[], event: AgentEvent): DisplayMessage[] {
  if (event.type !== 'message') return messages;

  const wire = event.message;

  if (wire.role === 'user') {
    if (wire.content.type !== 'text') return messages;
    const text = wire.content.text;
    const index = messages.findIndex(
      (item) => item.id.startsWith('pending-') && item.content === text,
    );
    if (index >= 0) {
      const next = [...messages];
      next[index] = { ...next[index]!, id: wire.id };
      return next;
    }
    return messages;
  }

  if (wire.role === 'assistant') {
    if (wire.content.type === 'text') {
      const text = wire.content.text;
      if (!text.trim()) return messages;
      return [
        ...messages,
        {
          id: wire.id,
          role: 'assistant',
          content: text,
          toolCalls: [],
          createdAt: new Date(wire.createdAt).toISOString(),
        },
      ];
    }

    if (wire.content.type === 'tool_calls') {
      const calls = wire.content.calls;
      return updateLastAssistant(messages, (message) => {
        for (const call of calls) {
          if (message.toolCalls.some((item) => item.id === call.id)) continue;
          message.toolCalls.push({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: 'running',
          });
        }
      });
    }
    return messages;
  }

  // role === 'tool'
  if (wire.content.type === 'tool_result') {
    const { callId, result, durationMs, ok } = wire.content;
    return updateLastAssistant(messages, (message) => {
      const call = message.toolCalls.find((item) => item.id === callId);
      if (!call) return;
      call.result = result;
      call.durationMs = durationMs;
      call.status = ok ? 'ok' : 'error';
    });
  }
  return messages;
}

export default function App() {
  const { preference, setPreference } = useTheme();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [online, setOnline] = useState(true);

  // 侧边栏 = 群（扇出）+ 智能体（1:1），全部来自后端
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const [channelHistories, setChannelHistories] = useState<Record<string, DisplayMessage[]>>({});
  const [roomMemberLimit, setRoomMemberLimit] = useState(6);
  /** 正在进入回合的成员，用于「谁在看」的实时提示 */
  const [roundActive, setRoundActive] = useState<string | null>(null);
  /** 这一轮谁沉默了（沉默是合法结果，只做轻提示，不进正文） */
  const [silentNotes, setSilentNotes] = useState<Record<string, string[]>>({});

  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [busy, setBusy] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);
  const [screenFull, setScreenFull] = useState(false);
  /** 抽屉卸载前先播完退出动画 */
  const drawerPresence = usePresence(screenOpen);
  const [drawerTab, setDrawerTab] = useState<'screen' | 'memory' | 'members'>('screen');
  const [memoryToken, setMemoryToken] = useState(0);
  const [backendAgents, setBackendAgents] = useState<BotSummary[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  /** 正在等用户回答的卡片 */
  const [interactions, setInteractions] = useState<InteractionRequest[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newBotOpen, setNewBotOpen] = useState(false);
  /** 右键菜单选中的待删对象，确认后才真正动手 */
  const [pendingDelete, setPendingDelete] = useState<ChannelItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [model, setModel] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const activeChannel = useMemo<ChannelItem>(
    () =>
      channels.find((item) => item.id === activeChannelId) ??
      channels[0] ?? {
        id: '',
        name: '未连接',
        time: '',
        lastMessage: '后端未连接',
      },
    [channels, activeChannelId],
  );

  const currentMessages = channelHistories[activeChannelId] ?? [];

  /** 群 → 用房间 id；私聊 → 用智能体 id（记忆面板也用它） */
  const activeAgentId = useMemo(() => {
    if (activeChannel?.kind === 'room') {
      const first = activeChannel.members?.[0];
      return first?.id ?? null;
    }
    if (backendAgents.some((agent) => agent.id === activeChannelId)) return activeChannelId;
    return backendAgents[0]?.id ?? null;
  }, [activeChannel, activeChannelId, backendAgents]);

  /** 打开一个频道：群读房间时间线，私聊读它自己的对话 */
  useEffect(() => {
    if (!activeChannelId) return undefined;
    let cancelled = false;

    // 成员页只对群有意义，切到私聊时回到屏幕页
    if (activeChannel?.kind !== 'room') {
      setDrawerTab((current) => (current === 'members' ? 'screen' : current));
    }

    void (async () => {
      try {
        if (activeChannel?.kind === 'room') {
          const messages = await api.fetchRoomMessages(activeChannelId);
          if (cancelled) return;
          setChannelHistories((prev) => ({
            ...prev,
            [activeChannelId]: messages.map((message) => ({
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

        const detail = await api.fetchSession(activeChannelId);
        if (cancelled) return;
        setChannelHistories((prev) => ({
          ...prev,
          [activeChannelId]: detail.messages,
        }));
      } catch {
        // 保持现有内容
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeChannel?.kind, activeChannelId]);

  /** 群 + 智能体 → 侧边栏条目 */
  const buildChannels = useCallback(
    (roomList: RoomView[], agents: BotSummary[]): ChannelItem[] => [
      ...roomList.map((room) => ({
        id: room.id,
        name: room.name,
        time: formatClock(room.updatedAt),
        lastMessage: room.lastMessage?.text ?? '还没有人说话',
        color: room.members[0]?.color ?? '#a855f7',
        role: `${room.members.length} 位成员`,
        isGroup: true,
        kind: 'room' as const,
        members: room.members,
      })),
      ...agents
        .filter((bot) => !bot.hidden)
        .map((bot) => ({
          id: bot.id,
          name: bot.name,
          time: formatClock(Date.parse(bot.updatedAt)),
          lastMessage: bot.activity || bot.title || bot.role || '准备就绪',
          color: bot.color,
          role: bot.title || bot.role,
          kind: 'agent' as const,
        })),
    ],
    [],
  );

  /**
   * 重新拉工作台并重建侧边栏。
   *
   * 智能体可以通过工具建同事/建群/拉人（工作台写操作），
   * 这些改动必须立刻反映到界面上——不然「建好了但侧边栏看不见」。
   */
  // 载入健康状态、真实房间与后台 Agent
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.fetchHealth();
        if (cancelled) return;
        setHealth(info);
        setOnline(Boolean(info));
        if (info) setModel((curr) => curr || info.model);

        const [roomData, backendBots] = await Promise.all([
          api.fetchRooms().catch(() => ({ rooms: [], memberLimit: 6 })),
          api.fetchBots().catch(() => [] as BotSummary[]),
        ]);
        if (cancelled) return;

        setBackendAgents(backendBots);
        setRoomMemberLimit(roomData.memberLimit);
        setRooms(roomData.rooms);

        // 侧边栏 = 群（扇出）+ 智能体（1:1）
        const channelList = buildChannels(roomData.rooms, backendBots);
        setChannels(channelList);
        setActiveChannelId((current) =>
          channelList.some((item) => item.id === current)
            ? current
            : (channelList[0]?.id ?? ''),
        );
      } catch {
        if (!cancelled) setOnline(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildChannels]);

  const syncWorkspace = useCallback(async () => {
    const [roomData, agents] = await Promise.all([
      api.fetchRooms().catch(() => null),
      api.fetchBots().catch(() => null),
    ]);
    if (!roomData && !agents) return;

    if (agents) setBackendAgents(agents);
    if (roomData) {
      setRooms(roomData.rooms);
      setRoomMemberLimit(roomData.memberLimit);
    }

    setChannels((current) => {
      const roomsNow = roomData?.rooms ?? [];
      const agentsNow = agents ?? [];
      const rebuilt = buildChannels(roomsNow, agentsNow);
      // 后端还没回来的那一半保留旧值，避免整列表闪一下
      if (!roomData) {
        return [...current.filter((item) => item.kind === 'room'), ...rebuilt.filter((i) => i.kind === 'agent')];
      }
      if (!agents) {
        return [...rebuilt.filter((i) => i.kind === 'room'), ...current.filter((item) => item.kind === 'agent')];
      }
      return rebuilt;
    });
  }, [buildChannels]);

  /** 新建智能体：只有服务端确认建成才进侧栏，避免出现发不出消息的死频道 */
  const createAgent = useCallback(
    async (input: { name: string; role: string }) => {
      const created = await api.createBot(input).catch(() => null);
      if (!created) {
        setChannels((current) => [
          {
            id: `failed-${uid()}`,
            name: '创建失败',
            time: formatClock(Date.now()),
            lastMessage: '后端未连接，智能体没有创建成功',
            color: '#f87171',
          },
          ...current,
        ]);
        return;
      }
      await syncWorkspace();
      const channel: ChannelItem = {
        id: created.id,
        name: created.name,
        time: '刚刚',
        lastMessage: created.role || '准备就绪',
        color: created.color,
        role: created.role,
        kind: 'agent',
      };
      setChannels((current) =>
        current.some((item) => item.id === created.id) ? current : [channel, ...current],
      );
      setActiveChannelId(created.id);
      setChannelHistories((prev) => ({ ...prev, [created.id]: [] }));
    },
    [syncWorkspace],
  );

  /** 新建群：建完立刻可进，成员表由服务端校验 */
  const createRoom = useCallback(
    async (input: { name: string; memberIds: string[] }) => {
      const room = await api.createRoom(input).catch(() => null);
      if (!room) return;
      setRooms((current) => [room, ...current.filter((item) => item.id !== room.id)]);
      const channel: ChannelItem = {
        id: room.id,
        name: room.name,
        time: formatClock(room.updatedAt),
        lastMessage: '还没有人说话',
        color: room.members[0]?.color ?? '#a855f7',
        role: `${room.members.length} 位成员`,
        isGroup: true,
        kind: 'room',
        members: room.members,
      };
      setChannels((current) =>
        current.some((item) => item.id === room.id) ? current : [channel, ...current],
      );
      setActiveChannelId(room.id);
      setChannelHistories((prev) => ({ ...prev, [room.id]: [] }));
    },
    [],
  );

  /** 拉人 / 踢人：改成员表，从下一回合生效 */
  const saveMembers = useCallback(async (roomId: string, memberIds: string[]) => {
    const room = await api.updateRoomMembers(roomId, memberIds).catch(() => null);
    if (!room) return;
    setRooms((current) => current.map((item) => (item.id === room.id ? room : item)));
    setChannels((current) =>
      current.map((item) =>
        item.id === room.id
          ? {
              ...item,
              role: `${room.members.length} 位成员`,
              members: room.members,
              lastMessage: room.lastMessage?.text ?? item.lastMessage,
            }
          : item,
      ),
    );
  }, []);

  // 安全网：后台可能被别的入口改动（另一个窗口、脚本），定期同步一次
  useEffect(() => {
    const timer = window.setInterval(() => void syncWorkspace(), 15000);
    return () => window.clearInterval(timer);
  }, [syncWorkspace]);

  /**
   * 右键删除。
   *
   * 群是解散，智能体是删除（连带它的消息与记忆）。
   * 先请求后端，成功了才从界面上摘掉——失败时频道还在，错误直接写进它的时间线。
   */
  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target || deleting) return;
    setDeleting(true);

    try {
      if (target.kind === 'room') await api.deleteRoom(target.id);
      else await api.deleteBot(target.id);

      setChannels((current) => {
        const next = current.filter((item) => item.id !== target.id);
        setActiveChannelId((active) =>
          active === target.id ? (next[0]?.id ?? '') : active,
        );
        return next;
      });
      setChannelHistories((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
      setPendingDelete(null);
      await syncWorkspace();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setChannelHistories((prev) => ({
        ...prev,
        [target.id]: [...(prev[target.id] ?? []), errorMessage(target, `删除失败：${reason}`)],
      }));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [deleting, pendingDelete, syncWorkspace]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      if (!activeAgentId) {
        setChannelHistories((prev) => ({
          ...prev,
          [activeChannelId]: [
            ...(prev[activeChannelId] ?? []),
            {
              id: uid(),
              role: 'assistant',
              senderName: activeChannel.name,
              senderColor: activeChannel.color,
              content: '⚠️ 后端未连接，找不到这个频道对应的智能体',
              toolCalls: [],
              createdAt: now(),
              error: true,
            },
          ],
        }));
        return;
      }

      const userMsg: DisplayMessage = {
        id: `pending-${uid()}`,
        role: 'user',
        senderName: 'linlin zhang',
        content: trimmed,
        toolCalls: [],
        createdAt: now(),
      };

      setChannelHistories((prev) => ({
        ...prev,
        [activeChannelId]: [...(prev[activeChannelId] ?? []), userMsg],
      }));

      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;

      // 群：扇出给全体成员，各自决定开口还是沉默
      if (activeChannel.kind === 'room') {
        setSilentNotes((prev) => ({ ...prev, [activeChannelId]: [] }));
        try {
          await api.streamRoom(
            activeChannelId,
            trimmed,
            {
              // 房间时间线：谁说了什么，实时进界面
              onMessage: (message) => {
                setChannelHistories((prev) => {
                  const list = prev[activeChannelId] ?? [];

                  // 服务器会回显我自己的那条，替换掉本地乐观添加的占位，避免重复
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
                      return { ...prev, [activeChannelId]: next };
                    }
                  }

                  if (list.some((item) => item.id === message.id)) return prev;
                  return {
                    ...prev,
                    [activeChannelId]: [
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
              },
              onRoundStart: ({ agentName }) => setRoundActive(agentName),
              onRoundEnd: (outcome) => {
                setRoundActive(null);
                if (outcome.status !== 'spoke') {
                  setSilentNotes((prev) => ({
                    ...prev,
                    [activeChannelId]: [
                      ...(prev[activeChannelId] ?? []),
                      `${outcome.agentName} ${outcome.status === 'error' ? '出错' : '看过，没开口'}`,
                    ],
                  }));
                }
              },
              onError: (err) => {
                setChannelHistories((prev) => ({
                  ...prev,
                  [activeChannelId]: [...(prev[activeChannelId] ?? []), errorMessage(activeChannel, err)],
                }));
              },
            },
            controller.signal,
            model || undefined,
          );
        } catch (error) {
          const aborted = error instanceof DOMException && error.name === 'AbortError';
          if (!aborted) {
            setChannelHistories((prev) => ({
              ...prev,
              [activeChannelId]: [
                ...(prev[activeChannelId] ?? []),
                errorMessage(activeChannel, `请求异常：${error instanceof Error ? error.message : String(error)}`),
              ],
            }));
          }
        } finally {
          abortRef.current = null;
          setBusy(false);
          setRoundActive(null);
          // 回合里可能建了同事 / 拉了人，立刻反映到侧边栏
          void syncWorkspace();
        }
        return;
      }

      try {
        await api.streamChat(
          {
            botId: activeAgentId,
            message: trimmed,
            model: model || undefined,
          },
          {
            onEvent: (event) => {
              if (event.type === 'interaction') {
                setInteractions((current) =>
                  current.some((item) => item.id === event.request.id)
                    ? current
                    : [...current, event.request],
                );
                return;
              }
              if (event.type === 'interaction_closed') {
                setInteractions((current) => current.filter((item) => item.id !== event.id));
                return;
              }

              setChannelHistories((prev) => ({
                ...prev,
                [activeChannelId]: applyEvent(prev[activeChannelId] ?? [], event),
              }));

              // 记住了哪些文件：从工具调用参数里抽 path
              if (event.type === 'message' && event.message.content.type === 'tool_calls') {
                for (const call of event.message.content.calls) {
                  try {
                    const args = JSON.parse(call.arguments || '{}') as { path?: unknown };
                    if (typeof args.path !== 'string' || !args.path) continue;
                    const path = args.path;
                    setArtifacts((curr) =>
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
            onError: (err) => {
              setChannelHistories((prev) => ({
                ...prev,
                [activeChannelId]: [
                  ...(prev[activeChannelId] ?? []),
                  {
                    id: uid(),
                    role: 'assistant',
                    senderName: activeChannel.name,
                    senderColor: activeChannel.color,
                    content: `⚠️ ${err}`,
                    toolCalls: [],
                    createdAt: now(),
                    error: true,
                  },
                ],
              }));
            },
          },
          controller.signal,
        );
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (!aborted) {
          setChannelHistories((prev) => ({
            ...prev,
            [activeChannelId]: [
              ...(prev[activeChannelId] ?? []),
              {
                id: uid(),
                role: 'assistant',
                senderName: activeChannel.name,
                senderColor: activeChannel.color,
                content: `⚠️ 请求异常：${error instanceof Error ? error.message : String(error)}`,
                toolCalls: [],
                createdAt: now(),
                error: true,
              },
            ],
          }));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setMemoryToken((token) => token + 1);
        // 工作台工具可能改了同事 / 群，同步一次
        void syncWorkspace();
      }
    },
    [activeAgentId, activeChannel, activeChannelId, busy, model, syncWorkspace],
  );

  const answerInteraction = useCallback(
    async (id: string, answer: { value?: string; secret?: string; cancelled?: boolean }) => {
      // 先从界面移除，回答失败再放回来
      setInteractions((current) => current.filter((item) => item.id !== id));
      try {
        await api.answerInteraction(id, answer);
      } catch {
        const list = await api.fetchInteractions().catch(() => null);
        if (list) setInteractions(list);
      }
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  const models = health?.models ?? [];
  const tools = health?.tools ?? [];
  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeChannelId) ?? null,
    [rooms, activeChannelId],
  );

  // 当前对应的虚拟或真实 BotSummary 供右侧抽屉面板显示
  const currentBotSummary: BotSummary = useMemo(
    () => ({
      id: activeChannel.id,
      name: activeChannel.name,
      role: activeChannel.role || '智能协作助理',
      color: activeChannel.color || '#a855f7',
      status: busy ? 'working' : 'idle',
      activity: busy ? '正在协同推理…' : '待命中',
      conversationCount: currentMessages.length,
      createdAt: now(),
      updatedAt: now(),
    }),
    [activeChannel, busy, currentMessages.length],
  );

  const composer = useMemo(
    () => (
      <Composer
        busy={busy}
        botName={activeChannel.name}
        isGroup={activeChannel.kind === 'room'}
        members={activeChannel.members ?? []}
        model={model}
        models={models}
        tools={tools}
        onSend={(text) => void send(text)}
        onStop={stop}
        onModelChange={setModel}
      />
    ),
    [
      activeChannel.name,
      activeChannel.kind,
      activeChannel.members,
      busy,
      model,
      models,
      send,
      stop,
      tools,
    ],
  );

  const endpoint = useMemo(() => {
    if (typeof window === 'undefined') return '127.0.0.1:8787';
    return window.location.host || '127.0.0.1:8787';
  }, []);

  return (
    <div className={`app${screenOpen && !screenFull ? ' with-screen' : ''}`}>
      {/* 1. 左侧导航栏 */}
      <Sidebar
        channels={channels}
        activeId={activeChannelId}
        onSelect={(id) => {
          if (!busy) setActiveChannelId(id);
        }}
        onNew={() => setNewBotOpen(true)}
        onOpenMarket={() => setSettingsOpen(true)}
        onOpenProfile={() => setSettingsOpen(true)}
        onDelete={(channel) => {
          if (busy) return;
          setPendingDelete(channel);
        }}
      />

      {/* 2. 主消息区 */}
      <ChatView
        bot={currentBotSummary}
        interactions={interactions}
        onAnswerInteraction={(id, answer) => void answerInteraction(id, answer)}
        channelTitle={activeChannel.name}
        messages={currentMessages}
        artifacts={artifacts}
        busy={busy}
        composer={composer}
        onToggleInfo={() => setScreenOpen((prev) => !prev)}
        isGroup={activeChannel.kind === 'room'}
        members={activeChannel.members ?? []}
        channelKey={activeChannelId}
        roundActive={roundActive}
        silentNotes={silentNotes[activeChannelId] ?? []}
      />

      {/* 3. 右侧抽屉：Bot 的屏幕 / 它的记忆 */}
      {drawerPresence.mounted ? (
        screenFull && drawerTab === 'screen' ? (
          <BotScreen
            bot={currentBotSummary}
            messages={currentMessages}
            artifacts={artifacts}
            fullscreen
            onToggleFullscreen={() => setScreenFull(false)}
            onClose={() => {
              setScreenOpen(false);
              setScreenFull(false);
            }}
          />
        ) : (
          <div className={`drawer ${drawerPresence.state}`}>
            <div className="drawer-tabs">
              <button
                type="button"
                className={`drawer-tab${drawerTab === 'screen' ? ' active' : ''}`}
                onClick={() => setDrawerTab('screen')}
              >
                屏幕
              </button>
              <button
                type="button"
                className={`drawer-tab${drawerTab === 'memory' ? ' active' : ''}`}
                onClick={() => setDrawerTab('memory')}
              >
                记忆
              </button>
              {activeChannel.kind === 'room' ? (
                <button
                  type="button"
                  className={`drawer-tab${drawerTab === 'members' ? ' active' : ''}`}
                  onClick={() => setDrawerTab('members')}
                >
                  成员
                </button>
              ) : null}
              <button
                type="button"
                className="screen-btn"
                aria-label="关闭"
                onClick={() => {
                  setScreenOpen(false);
                  setScreenFull(false);
                }}
              >
                <IconClose size={15} />
              </button>
            </div>

            <div className="swap" key={drawerTab}>
            {drawerTab === 'screen' ? (
              <BotScreen
                bot={currentBotSummary}
                messages={currentMessages}
                artifacts={artifacts}
                fullscreen={false}
                onToggleFullscreen={() => setScreenFull(true)}
                onClose={() => setScreenOpen(false)}
              />
            ) : drawerTab === 'members' && activeRoom ? (
              <MemberPanel
                room={activeRoom}
                agents={backendAgents}
                memberLimit={roomMemberLimit}
                busy={busy}
                onSave={(ids) => void saveMembers(activeRoom.id, ids)}
                onClose={() => setScreenOpen(false)}
              />
            ) : activeAgentId ? (
              <MemoryPanel
                agentId={activeAgentId}
                agentName={activeChannel.name}
                refreshToken={memoryToken}
                onClose={() => setScreenOpen(false)}
              />
            ) : (
              <div className="drawer">
                <p className="memory-empty">后端未连接，暂时读不到记忆</p>
              </div>
            )}
            </div>
          </div>
        )
      ) : null}

      {/* 4. 新建智能体 / 新建群 */}
      <CreateDialog
        open={newBotOpen}
        agents={backendAgents}
        memberLimit={roomMemberLimit}
        onCreateAgent={(input) => {
          void createAgent(input);
          setNewBotOpen(false);
        }}
        onCreateRoom={(input) => {
          void createRoom(input);
          setNewBotOpen(false);
        }}
        onClose={() => setNewBotOpen(false)}
      />

      {/* 5. 市场与用户偏好设置弹窗 */}
      <SettingsDialog
        open={settingsOpen}
        theme={preference}
        model={model}
        models={models}
        endpoint={endpoint}
        toolCount={tools.length}
        onTheme={setPreference}
        onModel={setModel}
        onClose={() => setSettingsOpen(false)}
      />

      {!online ? <div className="offline">后端服务未连接 · 当前展示本地联调视图</div> : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={pendingDelete?.isGroup ? '解散这个群？' : '删除这个智能体？'}
        message={
          pendingDelete?.isGroup
            ? `「${pendingDelete.name}」的成员表与群时间线会一起删掉，成员各自的记忆不受影响。解散后无法恢复。`
            : `「${pendingDelete?.name ?? ''}」的对话记录和它的长期记忆会一起删掉，无法恢复。`
        }
        confirmLabel={deleting ? '删除中…' : pendingDelete?.isGroup ? '解散' : '删除'}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
