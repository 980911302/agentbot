import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Sidebar, type ChannelItem } from './components/Sidebar';
import { BotScreen } from './components/BotScreen';
import { ChatView } from './components/ChatView';
import { useShortcuts } from './hooks/use-shortcuts';
import { clampPanelWidth, loadPanelWidth, panelLayoutKind, savePanelWidth, type PanelWidthStore } from './features/chat/panel-view';
import { sidebarAutoMini, sidebarIsDrawer } from './features/chat/layout-view';
import { Composer } from './components/Composer';
import { SettingsDialog } from './components/SettingsDialog';
import { ChatWelcome } from './components/ChatWelcome';
import { CreateDialog } from './components/CreateDialog';
import { saveAvatarShape, type AvatarShape } from './components/LivingAvatar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { BotProfileDialog } from './components/BotProfileDialog';
import { BotProfileDrawer } from './components/BotProfileDrawer';
import { RenameDialog } from './components/RenameDialog';
import { MemberPanel } from './components/MemberPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { InteractionCard } from './components/InteractionCard';
import { IconClose } from './icons';
import { usePresence } from './motion';
import { ToastProvider } from './components/ui/Toast.js';
import { useTheme } from './theme';
import * as api from './api';
import { formatClock } from './format';
import { errorMessage, uid } from './features/chat/message-reducer';
import { ensureNotifyPermission } from './notify';
import { useInteractions } from './features/interactions/use-interactions';
import { useChatStream } from './features/chat/use-chat-stream';
import { useChatEngine } from './features/chat/use-chat-engine';
import { useEventStream } from './features/events/use-event-stream';
import { useWorkspace } from './features/workspace/use-workspace';
import type {
  AgentEvent,
  ArtifactView,
  BotSummary,
  DisplayMessage,
  HealthInfo,
  InteractionRequest,
  ModelOption,
  RoomView,
} from './types';

export default function App() {
  const { preference, setPreference } = useTheme();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [online, setOnline] = useState(true);

  // 侧边栏 = 群（扇出）+ 智能体（1:1），全部来自后端
  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const chatEngine = useChatEngine();
  // runs 是引擎内部原地增删的 Map，引用终生不变；订阅版本号才能让下面的 memo 跟随运行状态刷新
  const chatEngineVersion = useSyncExternalStore(chatEngine.subscribe, chatEngine.getVersion);
  const channelHistories = chatEngine.histories;
  const setChannelHistories = chatEngine.setHistories;

  // 工作台状态（E2.5d 拆出）：频道、轮询、未读、reloadChannel
  const {
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
    agentFlags,
    refreshAgentFlags,
  } = useWorkspace({
    activeChannelId,
  });
  /** 是否有一笔停止正在这个频道生效（UI-05：chat state 里 kind=stop 的活动 run） */
  const stopInFlight = useMemo(
    () =>
      [...chatEngine.runs.values()].some(
        run => run.agentId === activeChannelId && run.kind === 'stop' &&
          (run.status === 'queued' || run.status === 'running' || run.status === 'finalizing'),
      ),
    [chatEngine.runs, chatEngineVersion, activeChannelId],
  );
  /** 群成员进行中也由运行记录推导；丢 round_end 时仍可由快照收口。 */
  const roomRun = [...chatEngine.runs.values()].reverse().find(run => run.roomId === activeChannelId &&
    run.kind === 'agent' && (run.status === 'queued' || run.status === 'running'));
  const roomAgent = roomRun ? backendAgents.find(agent => agent.id === roomRun.agentId) : undefined;
  const roundActive = roomAgent ? { id: roomAgent.id, name: roomAgent.name, color: roomAgent.color } : null;
  const workingAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of chatEngine.runs.values()) {
      if (run.agentId && (run.status === 'queued' || run.status === 'running')) ids.add(run.agentId);
    }
    return ids;
  }, [chatEngine.runs, chatEngineVersion]);
  const liveSidebarChannels = useMemo(
    () =>
      sidebarChannels.map((channel) => ({
        ...channel,
        status: workingAgentIds.has(channel.id) ? 'working' : channel.status,
        members: channel.members?.map((member) => ({
          ...member,
          status: workingAgentIds.has(member.id) ? 'working' : member.status,
        })),
      })),
    [sidebarChannels, workingAgentIds],
  );
  const liveMembers = useMemo(
    () =>
      (activeChannelId
        ? liveSidebarChannels.find((item) => item.id === activeChannelId)?.members
        : undefined) ?? [],
    [liveSidebarChannels, activeChannelId],
  );
  /** 回合/回复刚结束的短暂绿勾（done 的在场感） */
  const [doneFlash, setDoneFlash] = useState(false);
  /** 这一轮谁沉默了（沉默是合法结果，只做轻提示，不进正文） */
  const [silentNotes, setSilentNotes] = useState<Record<string, string[]>>({});

  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  /** 频道内的轻状态行（挂起/停止这类系统提示） */
  const [notices, setNotices] = useState<Record<string, string[]>>({});
  const [screenOpen, setScreenOpen] = useState(false);
  const [screenFull, setScreenFull] = useState(false);
  /** 右侧面板宽度（UI-06）：320–480，可拖，记忆在 localStorage */
  const [panelWidth, setPanelWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 340 : loadPanelWidth(window.localStorage as unknown as PanelWidthStore),
  );
  const [isResizingPanel, setIsResizingPanel] = useState(false);

  const onPanelResize = useCallback((width: number) => {
    const next = clampPanelWidth(width);
    setPanelWidth(next);
    if (typeof window !== 'undefined') {
      savePanelWidth(window.localStorage as unknown as PanelWidthStore, next);
    }
  }, []);
  /** 抽屉卸载前先播完退出动画 */
  const drawerPresence = usePresence(screenOpen);
  /** 单栏档侧栏抽屉开合（UI-09）：顶栏菜单按钮 / Esc 控制 */
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  /** 面板形态：<1280 时是覆盖层（带遮罩、Esc 关闭，规范 5.10）。
      跟随窗口宽度——拖窗口跨过 1280 时形态要跟着变。 */
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const panelLayout = panelLayoutKind(viewportWidth, drawerPresence.mounted && !screenFull);
  const [drawerTab, setDrawerTab] = useState<'screen' | 'memory' | 'members' | 'profile'>('screen');
  const [memoryToken, setMemoryToken] = useState(0);
  /** 正在等用户回答的卡片（E2.5b 拆出） */
  const { interactions, handleRequest, handleClose: closeInteraction, answer: answerRequest } = useInteractions(chatEngine);

  const { send, handleEntry, busy, respondingChannelIds, reloadChannel, resync } = useChatStream({
    engine: chatEngine,
    getSession: () => ({
      activeAgentId,
      activeChannel,
      activeChannelId,
      model,
      ownerName,
    }),
    setArtifacts,
    setNotices,
    setSilentNotes,
    agentsRef,
    handleInteractionRequest: handleRequest,
    handleInteractionClosed: closeInteraction,
    onMemoryBump: () => setMemoryToken((token) => token + 1),
    syncWorkspace,
  });
  // 独立事件订阅（E3.4 第二步）：发送只收回执，回合进度与结果都从这里来
  useEventStream({
    onEntry: handleEntry,
    onResync: resync,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'general' | 'models'>('general');
  const [newBotOpen, setNewBotOpen] = useState(false);
  /** 右键菜单选中的待删对象，确认后才真正动手 */
  const [pendingDelete, setPendingDelete] = useState<ChannelItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 正在编辑资料的智能体 / 正在改名的群 */
  const [editingBot, setEditingBot] = useState<BotSummary | null>(null);
  const [renamingChannel, setRenamingChannel] = useState<ChannelItem | null>(null);
  const [model, setModel] = useState('');
  /** 用户显示名：本地发言、群消息、侧栏都用它；存 localStorage */
  const [ownerName, setOwnerNameState] = useState(
    () => {
      const stored = localStorage.getItem('agentbot.ownerName');
      return stored && stored !== '主人' ? stored : 'linlin zhang';
    },
  );
  /** 侧边栏宽度与是否拖拽中（支持拖拽拉动并在 <160px 锁定折叠） */
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('agentbot.sidebarWidth');
    if (saved) {
      const parsed = Number(saved);
      if (Number.isFinite(parsed) && parsed >= 64 && parsed <= 500) return parsed;
    }
    return 260;
  });
  const [isResizing, setIsResizing] = useState(false);
  // 响应式档位（UI-09）：窄档侧栏强制迷你 72px，单栏档侧栏变抽屉（宽 280，覆盖在聊天上）。
  // 迷你/抽屉都只改「渲染宽度」，用户拖出来的宽度仍留在 sidebarWidth 里，窗口变宽就还原。
  const drawerSidebar = sidebarIsDrawer(viewportWidth);
  const renderedSidebarWidth = drawerSidebar ? 280 : sidebarAutoMini(viewportWidth) ? 72 : sidebarWidth;
  /** 侧栏占的网格宽度：抽屉档它脱离网格（fixed 覆盖层），不留列 */
  const sidebarGridWidth = drawerSidebar ? 0 : renderedSidebarWidth;
  useEffect(() => {
    // 离开单栏档就收起侧栏抽屉：抽屉只属于 <768
    if (!drawerSidebar) setSidebarDrawerOpen(false);
  }, [drawerSidebar]);
  const prevBusyRef = useRef(false);

  // 全局快捷键（UI-10）：⌘K 搜索、⌘, 设置、⌘\\ 右侧面板、⌘⇧I 资料页、Esc 关最上层浮层
  const dismissTopmostOverlay = useCallback(() => {
    // 从上往下关：确认框 → 改名 → 新建 → 设置 → 侧栏抽屉 → 右侧抽屉
    if (sidebarDrawerOpen) { setSidebarDrawerOpen(false); return; }
    if (pendingDelete) { setPendingDelete(null); return; }
    if (renamingChannel) { setRenamingChannel(null); return; }
    if (editingBot) { setEditingBot(null); return; }
    if (newBotOpen) { setNewBotOpen(false); return; }
    if (settingsOpen) { setSettingsOpen(false); return; }
    if (drawerPresence.mounted && !screenFull) { setScreenOpen(false); return; }
  }, [sidebarDrawerOpen, pendingDelete, renamingChannel, editingBot, newBotOpen, settingsOpen, drawerPresence.mounted, screenFull]);

  useShortcuts({
    onFocusSearch: () => window.dispatchEvent(new CustomEvent('agentbot:focus-search')),
    onOpenSettings: () => setSettingsOpen(true),
    onTogglePanel: () => {
      if (screenFull) { setScreenFull(false); return; }
      setScreenOpen((open) => !open);
    },
    onToggleProfile: () => {
      setScreenOpen((open) => {
        if (open && drawerTab === 'profile') return false;
        setDrawerTab('profile');
        setScreenFull(false);
        return true;
      });
    },
    onDismissTop: dismissTopmostOverlay,
  });

  const activeChannel = useMemo<ChannelItem>(
    () =>
      channels.find((item) => item.id === activeChannelId) ??
      channels[0] ?? {
        id: '',
        name: '暂无智能体',
        time: '',
        lastMessage: '点击左上方 + 创建智能体',
      },
    [channels, activeChannelId],
  );

  /** 控制状态条输入（UI-05）：当前 1:1 智能体的许可态 + 来信积压 + 停止中。
   *  群没有单智能体许可态，不显示。 */
  const controlNoticeInput = useMemo(() => {
    const flags = agentFlags[activeChannelId];
    const isAgentChannel = Boolean(activeChannelId) && activeChannel.kind !== 'room';
    if (!flags || !isAgentChannel) return null;
    return {
      autoActivation: flags.paused ? ('paused' as const) : ('enabled' as const),
      held: flags.held,
      faulted: flags.faulted,
      pendingMail: flags.pendingMail,
      failedMail: flags.failedMail,
      stopInFlight,
    };
  }, [agentFlags, activeChannelId, activeChannel.kind, stopInFlight]);

  const currentMessages = channelHistories[activeChannelId] ?? [];
  /**
   * 频道历史加载态（bug_d2xiqthtxdmm）：切频道时消息是异步 load 的，期间聊天区
   * 会白一片。对还没拉到过快照的频道显示骨架，且只在等过 300ms 之后——数据快
   * 到位时不闪那一下。用两个 state 而不是只在 effect 里翻 ref：ref 会留着上一个
   * 频道的值，切过去那一刻把上一频道的「加载中」带到新频道，骨架闪一下就没了。
   */
  const channelLoaded = activeChannelId ? chatEngine.loadedChannels[activeChannelId] === true : true;
  const [waitingTooLong, setWaitingTooLong] = useState(false);
  useEffect(() => {
    if (!activeChannelId) return undefined;
    if (channelLoaded) {
      setWaitingTooLong(false);
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      if (live) setWaitingTooLong(true);
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
      setWaitingTooLong(false);
    };
  }, [activeChannelId, channelLoaded]);
  /** 当前频道是否还在等一条可见回复；后台记忆收尾不算。 */
  const activeResponding = respondingChannelIds.includes(activeChannelId);
  const activeLiveText = chatEngine.liveFor(activeChannelId);

  useEffect(() => {
    agentsRef.current = backendAgents;
  }, [backendAgents]);



  // busy 落下时闪一个短暂的绿勾：完成了，但不用你做任何事
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (wasBusy && !busy) {
      setDoneFlash(true);
      const timer = window.setTimeout(() => setDoneFlash(false), 2500);
      return () => window.clearTimeout(timer);
    }
  }, [busy]);

  /** 群 → 用房间 id；私聊 → 用智能体 id（记忆面板也用它） */
  const activeAgentId = useMemo(() => {
    if (activeChannel?.kind === 'room') {
      const first = activeChannel.members?.[0];
      return first?.id ?? null;
    }
    if (backendAgents.some((agent) => agent.id === activeChannelId)) return activeChannelId;
    return backendAgents[0]?.id ?? null;
  }, [activeChannel, activeChannelId, backendAgents]);

  useEffect(() => {
    if (!activeChannelId) return undefined;
    let cancelled = false;

    // 成员页只对群有意义，切到私聊时回到屏幕页
    if (activeChannel?.kind !== 'room') {
      setDrawerTab((current) => (current === 'members' ? 'screen' : current));
    }

    void (async () => {
      try {
        const snapshot = await reloadChannel(activeChannelId);
        if (cancelled) return;
        setArtifacts(snapshot?.channels[activeChannelId]?.artifacts ?? []);
      } catch {
        // 保持现有内容
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeChannel?.kind, activeChannelId, reloadChannel]);

  /** 群 + 智能体 → 侧边栏条目 */
  useEffect(() => {
    let cancelled = false;
    // 尽早拿通知授权（Electron 静默授权；浏览器会在首次通知前再确认）
    void ensureNotifyPermission();
    void (async () => {
      try {
        const info = await api.fetchHealth();
        if (cancelled) return;
        setHealth(info);
        setOnline(Boolean(info));
        if (info) {
          setModel((curr) => curr || info.model);
        }

        const channelList = await syncWorkspace();
        if (cancelled) return;

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
  }, [syncWorkspace]);

  /** 新建智能体：只有服务端确认建成才进侧栏，避免出现发不出消息的死频道 */
  const createAgent = useCallback(
    async (input: { name: string; role: string; color?: string; shape?: AvatarShape }) => {
      const created = await api.createBot({
        name: input.name,
        role: input.role,
        color: input.color,
      }).catch(() => null);
      if (!created) {
        setChannels((current) => [
          {
            id: `failed-${uid()}`,
            name: '创建失败',
            time: formatClock(Date.now()),
            lastMessage: '后端未连接，智能体没有创建成功',
            color: '#e24b4b',
          },
          ...current,
        ]);
        return;
      }
      if (input.shape) saveAvatarShape(created.id, input.shape);
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
        color: room.members[0]?.color ?? '#b89b6a',
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

  /**
   * 保存智能体资料（名字 / 标签 / 描述 / 职责 / 配色）。
   * 成功就同步侧边栏与抽屉用的智能体表；失败把原因还给调用方展示。
   */
  const saveBotProfile = useCallback(
    async (
      botId: string,
      input: {
        name?: string;
        section?: string;
        title?: string;
        description?: string;
        instructions?: string;
        color?: string;
        hidden?: boolean;
      },
    ) => {
      try {
        const updated = await api.updateBot(botId, input);
        setBackendAgents((current) =>
          current.map((bot) => (bot.id === updated.id ? { ...bot, ...updated } : bot)),
        );
        setChannels((current) =>
          current.map((item) =>
            item.id === updated.id
              ? {
                  ...item,
                  name: updated.name ?? item.name,
                  color: updated.color ?? item.color,
                  role: updated.role || item.role,
                }
              : item,
          ),
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [],
  );

  /** 群改名：群有独立的 PATCH；智能体改名走资料编辑 */
  const submitRoomRename = useCallback(
    async (name: string) => {
      if (!renamingChannel) return '没有正在改名的群';
      try {
        await api.renameRoom(renamingChannel.id, name);
        setChannels((current) =>
          current.map((item) => (item.id === renamingChannel.id ? { ...item, name } : item)),
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [renamingChannel],
  );


  const answerInteraction = useCallback(
    (id: string, answer: { value?: string; secret?: string; cancelled?: boolean }) =>
      answerRequest(id, answer),
    [answerRequest],
  );

  const setOwnerName = useCallback((name: string) => {
    const trimmed = name.trim() || 'linlin zhang';
    localStorage.setItem('agentbot.ownerName', trimmed);
    setOwnerNameState(trimmed);
  }, []);

  const models = health?.models ?? [];
  const tools = health?.tools ?? [];

  const refreshHealth = useCallback(async () => {
    try {
      const info = await api.fetchHealth();
      setHealth(info);
      setOnline(Boolean(info));
      if (info?.model) setModel(info.model);
    } catch {
      setOnline(false);
    }
  }, []);

  const handleModelChange = useCallback(
    async (next: string, picked?: ModelOption) => {
      setModel(next);
      // 优先用下拉直接传来的整项：同一上游模型可能挂在多个供应商下，
      // 只按 id 反查会命中第一个，激活到用户没点的那个供应商
      const option = picked ?? models.find((item) => item.id === next);
      if (option?.providerId && option?.modelConfigId) {
        try {
          await api.setActiveProviderModel(option.providerId, option.modelConfigId);
          await refreshHealth();
        } catch {
          // 本地已切换；持久化失败时下次启动会回到服务端当前模型
        }
      }
    },
    [models, refreshHealth],
  );

  /**
   * health 只在启动时拉过一次：模型与工具清单之后再不刷新，
   * 设置里改完（或在别处改完）输入框还显示旧模型。这里补上定时刷新和
   * 窗口重新聚焦时的刷新——切回窗口就该看到最新状态。
   */
  useEffect(() => {
    const timer = window.setInterval(() => void refreshHealth(), 20000);
    const onFocus = () => void refreshHealth();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshHealth();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshHealth]);

  const handleManageModels = useCallback(() => {
    setSettingsSection('models');
    setSettingsOpen(true);
  }, []);
  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeChannelId) ?? null,
    [rooms, activeChannelId],
  );

  // 当前频道的 BotSummary：真实记录优先，状态/活动取自本机流与本轮工具调用，不编造
  const currentBotSummary: BotSummary = useMemo(() => {
    const record = backendAgents.find((bot) => bot.id === activeChannel.id) ?? null;
    let runningTool: string | null = null;
    for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
      const call = currentMessages[index]?.toolCalls.find((item) => item.status === 'running');
      if (call) {
        runningTool = call.name;
        break;
      }
    }
    return {
      id: activeChannel.id,
      name: record?.name ?? activeChannel.name,
      title: record?.title,
      description: record?.description,
      instructions: record?.instructions,
      avatar: record?.avatar,
      section: record?.section,
      hidden: record?.hidden,
      role: record?.role ?? activeChannel.role ?? '',
      color: record?.color ?? activeChannel.color ?? '#b89b6a',
      status: activeResponding ? (activeLiveText ? 'thinking' : 'working') : (record?.status ?? 'idle'),
      activity: runningTool ?? '',
      conversationCount: record?.conversationCount ?? 0,
      createdAt: record?.createdAt ?? '',
      updatedAt: record?.updatedAt ?? '',
    };
  }, [activeChannel, activeLiveText, activeResponding, backendAgents, currentMessages]);

  /** 侧边栏数据 = 频道 + 未读数合并 */

  const composer = useMemo(
    () => (
      <Composer
        busy={activeResponding}
        botName={activeChannel.name}
        isGroup={activeChannel.kind === 'room'}
        members={liveMembers}
        model={model}
        models={models}
        tools={tools}
        onSend={(text) => void send(text)}
        onModelChange={(next, option) => void handleModelChange(next, option)}
        onManageModels={handleManageModels}
      />
    ),
    [
      activeChannel.name,
      activeChannel.kind,
      liveMembers,
      activeResponding,
      model,
      models,
      send,
      tools,
      handleModelChange,
      handleManageModels,
    ],
  );

  const endpoint = useMemo(() => {
    if (typeof window === 'undefined') return '127.0.0.1:8787';
    return window.location.host || '127.0.0.1:8787';
  }, []);

  return (
    <ToastProvider>
    <div
      className={`app${drawerPresence.mounted && !screenFull ? ' with-screen' : ''}${panelLayout === 'overlay' ? ' panel-overlay' : ''}${sidebarDrawerOpen ? ' drawer-open' : ''}${isResizing ? ' resizing' : ''}`}
      style={{ '--sidebar-w': `${sidebarGridWidth}px`, '--panel-w-dyn': `${panelWidth}px` } as React.CSSProperties}
    >
      {/* 1. 左侧导航栏 */}
      <Sidebar
        channels={liveSidebarChannels}
        activeId={activeChannelId}
        onSelect={(id) => {
          // 忙碌也能自由查看别的频道：事件仍会写进发起发送的那个频道
          setActiveChannelId(id);
          // 单栏档选完就收起抽屉，别让它继续盖着聊天（UI-09）
          if (drawerSidebar) setSidebarDrawerOpen(false);
        }}
        onNew={() => setNewBotOpen(true)}
        onOpenProfile={() => {
          setSettingsSection('general');
          setSettingsOpen(true);
        }}
        onDelete={(channel) => {
          if (busy) return;
          setPendingDelete(channel);
        }}
        onEdit={(channel) => {
          if (busy) return;
          const bot = backendAgents.find((item) => item.id === channel.id) ?? null;
          if (bot) {
            setActiveChannelId(channel.id);
            setDrawerTab('profile');
            setScreenOpen(true);
            setScreenFull(false);
          }
        }}
        onRename={(channel) => {
          if (busy) return;
          setRenamingChannel(channel);
        }}
        ownerName={ownerName}
        width={renderedSidebarWidth}
        onResize={(w) => {
          // 迷你档与抽屉档的宽度由档位决定，拖动不写持久态（否则窗口变宽会跳回拖出来的值）
          if (drawerSidebar || sidebarAutoMini(viewportWidth)) return;
          setSidebarWidth(w);
          localStorage.setItem('agentbot.sidebarWidth', String(w));
        }}
        onResizingChange={setIsResizing}
      />

      {/* 2. 主消息区：如果无智能体或未选中，展示欢迎与引导页 */}
      {channels.length === 0 || !activeChannel ? (
        <div className="empty-workbench-view">
          <ChatWelcome
            ownerName={ownerName}
            isWorkspaceEmpty={true}
            onCreateAgent={() => setNewBotOpen(true)}
          />
        </div>
      ) : (
        <ChatView
          ownerName={ownerName}
          bot={currentBotSummary}
          interactions={interactions}
          onAnswerInteraction={(id, answer) => void answerInteraction(id, answer)}
          channelTitle={activeChannel.name}
          messages={currentMessages}
          artifacts={artifacts}
          busy={activeResponding}
          liveText={activeLiveText}
          notices={notices[activeChannelId] ?? []}
          composer={composer}
          onToggleInfo={() => {
            if (screenOpen) {
              if (drawerTab === 'profile') {
                setDrawerTab('screen');
              } else {
                setScreenOpen(false);
              }
            } else {
              setDrawerTab('screen');
              setScreenOpen(true);
            }
          }}
          onToggleSidebar={() => setSidebarDrawerOpen((open) => !open)}
          onOpenMembers={() => {
            if (screenOpen && drawerTab === 'members') {
              setScreenOpen(false);
              setDrawerTab('screen');
              return;
            }
            setDrawerTab('members');
            setScreenOpen(true);
            setScreenFull(false);
          }}
          isGroup={activeChannel.kind === 'room'}
          members={liveMembers}
          channelKey={activeChannelId}
          loading={!channelLoaded && waitingTooLong && currentMessages.length === 0}
          roundActive={roundActive}
          doneFlash={doneFlash}
          memberLimit={roomMemberLimit}
          controlInput={controlNoticeInput}
          onControlChanged={() => void refreshAgentFlags()}
          onOpenProfile={
            activeChannel.kind === 'room'
              ? undefined
              : () => {
                  if (screenOpen && drawerTab === 'profile') {
                    setScreenOpen(false);
                  } else {
                    setDrawerTab('profile');
                    setScreenOpen(true);
                    setScreenFull(false);
                  }
                }
          }
          onRetry={(text, clientMessageId) => void send(text, clientMessageId)}
          // 「重新编辑」：只把原文填回输入框（Composer 监听 agentbot:use_prompt）
          onEditMessage={(text) =>
            window.dispatchEvent(new CustomEvent('agentbot:use_prompt', { detail: text }))
          }
        />
      )}

      {/* 3. 右侧抽屉：Bot 的屏幕 / 它的记忆 / 资料 */}
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
          <div className={`drawer ${drawerPresence.state}`} style={{ width: panelLayout === 'dock' ? panelWidth : undefined }}>
            {panelLayout === 'dock' ? (
              <div
                className="drawer-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整面板宽度"
                title="拖动调整面板宽度（320–480）"
                onMouseDown={(event) => {
                  event.preventDefault();
                  const startX = event.clientX;
                  const startWidth = panelWidth;
                  const onMove = (move: MouseEvent) => onPanelResize(startWidth + (startX - move.clientX));
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                  };
                  document.body.style.cursor = 'col-resize';
                  document.body.style.userSelect = 'none';
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                }}
              />
            ) : null}
            <div className="drawer-tabs">
              {activeChannel.kind !== 'room' ? (
                <button
                  type="button"
                  className={`drawer-tab${drawerTab === 'profile' ? ' active' : ''}`}
                  onClick={() => setDrawerTab('profile')}
                >
                  资料
                </button>
              ) : null}
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
              {drawerTab === 'profile' ? (
                <BotProfileDrawer
                  bot={currentBotSummary}
                  onClose={() => {
                    setScreenOpen(false);
                    setScreenFull(false);
                  }}
                  onSave={saveBotProfile}
                />
              ) : drawerTab === 'screen' ? (
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

      {/* 5. 模型管理与偏好设置弹窗 */}
      <SettingsDialog
        open={settingsOpen}
        openSection={settingsSection}
        theme={preference}
        model={model}
        models={models}
        endpoint={endpoint}
        toolCount={tools.length}
        ownerName={ownerName}
        onTheme={setPreference}
        onModel={(next) => void handleModelChange(next)}
        onOwnerName={setOwnerName}
        onClose={() => {
          setSettingsOpen(false);
          void refreshHealth();
        }}
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

      <BotProfileDialog
        bot={editingBot}
        onClose={() => setEditingBot(null)}
        onSave={(input) =>
          editingBot ? saveBotProfile(editingBot.id, input) : Promise.resolve('没有正在编辑的智能体')
        }
      />

      <RenameDialog
        title="重命名群"
        initial={renamingChannel?.name ?? ''}
        open={renamingChannel !== null}
        onClose={() => setRenamingChannel(null)}
        onSubmit={submitRoomRename}
      />
    </div>
    </ToastProvider>
  );
}
