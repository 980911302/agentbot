import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar, type ChannelItem } from './components/Sidebar';
import { BotScreen } from './components/BotScreen';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { SettingsDialog } from './components/SettingsDialog';
import { CreateDialog } from './components/CreateDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { BotProfileDialog } from './components/BotProfileDialog';
import { RenameDialog } from './components/RenameDialog';
import { MemberPanel } from './components/MemberPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { InteractionCard } from './components/InteractionCard';
import { IconClose } from './icons';
import { usePresence } from './motion';
import { useTheme } from './theme';
import * as api from './api';
import { formatClock } from './format';
import { applyEvent, errorMessage, now, uid } from './features/chat/message-reducer';
import { ensureNotifyPermission, notifyIfHidden } from './notify';
import { useInteractions } from './features/interactions/use-interactions';
import { useChatStream } from './features/chat/use-chat-stream';
import { useWorkspace } from './features/workspace/use-workspace';
import type {
  AgentEvent,
  ArtifactView,
  BotSummary,
  DisplayMessage,
  HealthInfo,
  InteractionRequest,
  RoomView,
} from './types';

export default function App() {
  const { preference, setPreference } = useTheme();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [online, setOnline] = useState(true);

  // 侧边栏 = 群（扇出）+ 智能体（1:1），全部来自后端
  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const [channelHistories, setChannelHistories] = useState<Record<string, DisplayMessage[]>>({});

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
    reloadChannel,
  } = useWorkspace({
    activeChannelId,
    setChannelHistories,
  });
  /** 群回合：正在进入回合的成员（谁的回合谁的气泡在动） */
  const [roundActive, setRoundActive] = useState<{ id: string; name: string; color: string } | null>(
    null,
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
  /** 抽屉卸载前先播完退出动画 */
  const drawerPresence = usePresence(screenOpen);
  const [drawerTab, setDrawerTab] = useState<'screen' | 'memory' | 'members'>('screen');
  const [memoryToken, setMemoryToken] = useState(0);
  /** 正在等用户回答的卡片（E2.5b 拆出） */
  const { interactions, handleRequest, handleClose: closeInteraction, answer: answerRequest } = useInteractions();

  const { send, busy, liveText, liveChannelId } = useChatStream({
    getSession: () => ({
      activeAgentId,
      activeChannel,
      activeChannelId,
      model,
      ownerName,
    }),
    setChannelHistories,
    setArtifacts,
    setNotices,
    setRoundActive,
    setSilentNotes,
    agentsRef,
    handleInteractionRequest: handleRequest,
    handleInteractionClosed: closeInteraction,
    onMemoryBump: () => setMemoryToken((token) => token + 1),
    syncWorkspace,
    reloadChannel,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newBotOpen, setNewBotOpen] = useState(false);
  /** 右键菜单选中的待删对象，确认后才真正动手 */
  const [pendingDelete, setPendingDelete] = useState<ChannelItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 正在编辑资料的智能体 / 正在改名的群 */
  const [editingBot, setEditingBot] = useState<BotSummary | null>(null);
  const [renamingChannel, setRenamingChannel] = useState<ChannelItem | null>(null);
  const [model, setModel] = useState('');
  /** 主人显示名：本地发言、群消息、侧栏都用它；存 localStorage */
  const [ownerName, setOwnerNameState] = useState(
    () => localStorage.getItem('agentbot.ownerName') || '主人',
  );
  const prevBusyRef = useRef(false);

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
        if (info) setModel((curr) => curr || info.model);

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

  /**
   * 保存智能体资料（名字 / 职责 / 配色）。
   * 成功就同步侧边栏与抽屉用的智能体表；失败把原因还给对话框展示。
   */
  const saveBotProfile = useCallback(
    async (input: { name: string; instructions: string; color: string }) => {
      if (!editingBot) return '没有正在编辑的智能体';
      try {
        const updated = await api.updateBot(editingBot.id, input);
        setBackendAgents((current) =>
          current.map((bot) => (bot.id === updated.id ? { ...bot, ...updated } : bot)),
        );
        setChannels((current) =>
          current.map((item) =>
            item.id === updated.id
              ? { ...item, name: updated.name, color: updated.color, role: updated.role || item.role }
              : item,
          ),
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [editingBot],
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
    const trimmed = name.trim() || '主人';
    localStorage.setItem('agentbot.ownerName', trimmed);
    setOwnerNameState(trimmed);
  }, []);

  const models = health?.models ?? [];
  const tools = health?.tools ?? [];
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
      role: record?.role ?? activeChannel.role ?? '',
      color: record?.color ?? activeChannel.color ?? '#a855f7',
      status: busy ? (liveText ? 'thinking' : 'working') : (record?.status ?? 'idle'),
      activity: runningTool ?? '',
      conversationCount: record?.conversationCount ?? 0,
      createdAt: record?.createdAt ?? '',
      updatedAt: record?.updatedAt ?? '',
    };
  }, [activeChannel, backendAgents, busy, currentMessages, liveText]);

  /** 侧边栏数据 = 频道 + 未读数合并 */

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
        onModelChange={setModel}
      />
    ),
    [activeChannel.name, activeChannel.kind, activeChannel.members, busy, model, models, send, tools],
  );

  const endpoint = useMemo(() => {
    if (typeof window === 'undefined') return '127.0.0.1:8787';
    return window.location.host || '127.0.0.1:8787';
  }, []);

  return (
    <div className={`app${screenOpen && !screenFull ? ' with-screen' : ''}`}>
      {/* 1. 左侧导航栏 */}
      <Sidebar
        channels={sidebarChannels}
        activeId={activeChannelId}
        onSelect={(id) => {
          // 忙碌也能自由查看别的频道：事件仍会写进发起发送的那个频道
          setActiveChannelId(id);
        }}
        onNew={() => setNewBotOpen(true)}
        onOpenMarket={() => setSettingsOpen(true)}
        onOpenProfile={() => setSettingsOpen(true)}
        onDelete={(channel) => {
          if (busy) return;
          setPendingDelete(channel);
        }}
        onEdit={(channel) => {
          if (busy) return;
          const bot = backendAgents.find((item) => item.id === channel.id) ?? null;
          if (bot) setEditingBot(bot);
        }}
        onRename={(channel) => {
          if (busy) return;
          setRenamingChannel(channel);
        }}
        ownerName={ownerName}
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
        liveText={liveChannelId === activeChannelId ? liveText : ''}
        notices={notices[activeChannelId] ?? []}
        composer={composer}
        onToggleInfo={() => setScreenOpen((prev) => !prev)}
        isGroup={activeChannel.kind === 'room'}
        members={activeChannel.members ?? []}
        channelKey={activeChannelId}
        roundActive={roundActive}
        doneFlash={doneFlash}
        silentNotes={silentNotes[activeChannelId] ?? []}
        onOpenProfile={
          activeChannel.kind === 'room'
            ? undefined
            : () => {
                const bot = backendAgents.find((item) => item.id === activeChannel.id) ?? null;
                if (bot) setEditingBot(bot);
              }
        }
        onRetry={(text) => void send(text)}
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
        ownerName={ownerName}
        onTheme={setPreference}
        onModel={setModel}
        onOwnerName={setOwnerName}
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

      <BotProfileDialog
        bot={editingBot}
        onClose={() => setEditingBot(null)}
        onSave={saveBotProfile}
      />

      {renamingChannel ? (
        <RenameDialog
          title="重命名群"
          initial={renamingChannel.name}
          onClose={() => setRenamingChannel(null)}
          onSubmit={submitRoomRename}
        />
      ) : null}
    </div>
  );
}
