import { useMemo, useState, useSyncExternalStore } from 'react';
import { Sidebar } from './components/Sidebar';
import { WorkspaceMain } from './components/WorkspaceMain';
import { WorkspaceDrawer } from './components/WorkspaceDrawer';
import { AppDialogs } from './components/AppDialogs';
import { Composer } from './components/Composer';
import { ToastProvider } from './components/ui/Toast.js';
import { useShortcuts } from './hooks/use-shortcuts';
import { useTheme } from './theme';
import { useInteractions } from './features/interactions/use-interactions';
import { useChatEngine } from './features/chat/use-chat-engine';
import { useSend } from './features/chat/use-send';
import { useLiveView } from './features/chat/use-live-view';
import { useChatViewState } from './features/chat/use-chat-view-state';
import { useWorkspace } from './features/workspace/use-workspace';
import { useWorkspaceSession } from './features/workspace/use-session';
import { useDialogs } from './features/workspace/use-dialogs';
import { useChannelActions } from './features/workspace/use-channel-actions';
import { useShellLayout } from './features/workspace/use-shell-layout';
import { activeAgentIdFor, activeRoomFor, selectActiveChannel } from './features/workspace/channel-select';

/**
 * App（OPT-04 收敛）：只做两件事——
 *   1. 组合 hooks：工作台 / 会话与后端设置 / 发送与事件流 / 当前频道视图状态 /
 *      浮层开关 / 频道 CRUD / 外壳布局；
 *   2. 摆布局：左栏 + 主消息区 + 右侧抽屉 + 弹窗。
 * 业务判定都在 features/ 的 hooks 与其纯模块里，这里不再自己算状态，也不再自己调 api。
 */
export default function App() {
  const { preference, setPreference } = useTheme();
  const [activeChannelId, setActiveChannelId] = useState('');

  const chatEngine = useChatEngine();
  // runs 是引擎内部原地增删的 Map，引用终生不变；订阅版本号才能让下面的 memo 跟随运行状态刷新
  const engineVersion = useSyncExternalStore(chatEngine.subscribe, chatEngine.getVersion);
  /** 聊天流写、聊天区读的视图状态（artifacts / 系统提示行 / 记忆刷新令牌） */
  const chatView = useChatViewState();

  const workspace = useWorkspace({ activeChannelId });
  const session = useWorkspaceSession({ syncWorkspace: workspace.syncWorkspace, setActiveChannelId });
  const interactions = useInteractions(chatEngine);

  const activeChannel = useMemo(
    () => selectActiveChannel(workspace.channels, activeChannelId),
    [workspace.channels, activeChannelId],
  );
  const activeAgentId = useMemo(
    () => activeAgentIdFor(activeChannel, activeChannelId, workspace.backendAgents),
    [activeChannel, activeChannelId, workspace.backendAgents],
  );
  const activeRoom = useMemo(
    () => activeRoomFor(workspace.rooms, activeChannelId),
    [workspace.rooms, activeChannelId],
  );

  /** 发送与重试 + 独立事件订阅（E3.4）：发送只收回执，回合进度与结果都从事件流来 */
  const stream = useSend({
    engine: chatEngine,
    getSession: () => ({
      activeAgentId,
      activeChannel,
      activeChannelId,
      model: session.model,
      ownerName: session.ownerName,
    }),
    ...chatView.sinks,
    agentsRef: workspace.agentsRef,
    handleInteractionRequest: interactions.handleRequest,
    handleInteractionClosed: interactions.handleClose,
    syncWorkspace: workspace.syncWorkspace,
  });
  const dialogs = useDialogs({ busy: stream.busy });
  const layout = useShellLayout({
    panelVisible: dialogs.panelVisible,
    onLeaveCompact: dialogs.closeSidebarDrawer,
  });

  /** 当前频道的视图状态：消息 / 回复中 / 流式增量 / 在场 / 骨架与绿勾，并顺带拉一次快照 */
  const live = useLiveView({
    engine: chatEngine,
    engineVersion,
    activeChannelId,
    activeChannel,
    backendAgents: workspace.backendAgents,
    sidebarChannels: workspace.sidebarChannels,
    agentFlags: workspace.agentFlags,
    busy: stream.busy,
    reloadChannel: stream.reloadChannel,
    onArtifacts: chatView.sinks.setArtifacts,
    onChannelChange: dialogs.syncDrawerTabOnChannelChange,
  });

  /** 频道 CRUD：建同事 / 建群 / 拉人踢人 / 删除 / 改名 / 保存资料 */
  const actions = useChannelActions({
    pendingDelete: dialogs.pendingDelete,
    deleting: dialogs.deleting,
    setDeleting: dialogs.setDeleting,
    closeDelete: dialogs.cancelDelete,
    renamingChannel: dialogs.renamingChannel,
    closeRename: dialogs.closeRename,
    setChannels: workspace.setChannels,
    setRooms: workspace.setRooms,
    setBackendAgents: workspace.setBackendAgents,
    setActiveChannelId,
    setChannelHistories: chatEngine.setHistories,
    syncWorkspace: workspace.syncWorkspace,
  });

  // 全局快捷键（UI-10）：⌘K 搜索、⌘, 设置、⌘\ 右侧面板、⌘⇧I 资料页、Esc 关最上层浮层
  useShortcuts({
    onFocusSearch: () => window.dispatchEvent(new CustomEvent('agentbot:focus-search')),
    onOpenSettings: dialogs.showSettings,
    onTogglePanel: dialogs.togglePanel,
    onToggleProfile: dialogs.toggleProfile,
    onDismissTop: dialogs.dismissTopmostOverlay,
  });

  const composer = useMemo(
    () => (
      <Composer
        // 按频道换实例：草稿、@ 菜单、菜单开合都不串频道；草稿本身按 channelId 存取
        key={activeChannelId}
        channelId={activeChannelId}
        busy={live.responding}
        botName={activeChannel.name}
        isGroup={activeChannel.kind === 'room'}
        members={live.liveMembers}
        model={session.model}
        models={session.models}
        onSend={stream.send}
        onModelChange={(next, option) => void session.handleModelChange(next, option)}
        onManageModels={() => dialogs.openSettings('models')}
      />
    ),
    [
      activeChannelId,
      activeChannel.kind,
      activeChannel.name,
      dialogs.openSettings,
      live.liveMembers,
      live.responding,
      session.handleModelChange,
      session.model,
      session.models,
      stream.send,
    ],
  );

  return (
    <ToastProvider>
      <div
        className={`app${dialogs.panelVisible ? ' with-screen' : ''}${layout.panelLayout === 'overlay' ? ' panel-overlay' : ''}${dialogs.sidebarDrawerOpen ? ' drawer-open' : ''}${layout.isResizing ? ' resizing' : ''}`}
        style={
          {
            '--sidebar-w': `${layout.sidebarGridWidth}px`,
            '--panel-w-dyn': `${layout.panelWidth}px`,
          } as React.CSSProperties
        }
      >
        {/* 1. 左侧导航栏 */}
        <Sidebar
          channels={live.liveSidebarChannels}
          activeId={activeChannelId}
          onSelect={(id) => {
            // 忙碌也能自由查看别的频道：事件仍会写进发起发送的那个频道
            setActiveChannelId(id);
            // 单栏档选完就收起抽屉，别让它继续盖着聊天（UI-09）
            if (layout.drawerSidebar) dialogs.closeSidebarDrawer();
          }}
          onNew={dialogs.openCreate}
          onOpenProfile={() => dialogs.openSettings('general')}
          onDelete={dialogs.requestDelete}
          onRename={dialogs.requestRename}
          onEdit={(channel) => {
            if (stream.busy) return;
            const bot = workspace.backendAgents.find((item) => item.id === channel.id) ?? null;
            if (bot) {
              setActiveChannelId(channel.id);
              dialogs.openProfileDrawer();
            }
          }}
          ownerName={session.ownerName}
          width={layout.renderedSidebarWidth}
          onResize={layout.onSidebarResize}
          onResizingChange={layout.setIsResizing}
        />

        {/* 2. 主消息区：无频道时是引导页，否则是聊天视图 */}
        <WorkspaceMain
          ownerName={session.ownerName}
          empty={workspace.channels.length === 0}
          onCreateAgent={dialogs.openCreate}
          bot={live.botSummary}
          messages={live.messages}
          artifacts={chatView.artifacts}
          busy={live.responding}
          liveText={live.liveText}
          notices={chatView.notices[activeChannelId] ?? []}
          composer={composer}
          interactions={interactions.interactions}
          onAnswerInteraction={(id, answer) => void interactions.answer(id, answer)}
          channelTitle={activeChannel.name}
          isGroup={activeChannel.kind === 'room'}
          members={live.liveMembers}
          channelKey={activeChannelId}
          loading={live.loading}
          roundActive={live.roundActive}
          doneFlash={live.doneFlash}
          memberLimit={workspace.roomMemberLimit}
          controlInput={live.controlInput}
          onControlChanged={() => void workspace.refreshAgentFlags()}
          onToggleInfo={dialogs.toggleInfo}
          onToggleSidebar={dialogs.toggleSidebarDrawer}
          onOpenMembers={dialogs.openMembers}
          onOpenProfile={activeChannel.kind === 'room' ? undefined : dialogs.toggleProfile}
          onRetry={stream.send}
          onEditMessage={stream.editPrompt}
        />

        {/* 3. 右侧抽屉：Bot 的屏幕 / 它的记忆 / 资料 / 群成员 */}
        <WorkspaceDrawer
          mounted={dialogs.drawerPresence.mounted}
          presenceState={dialogs.drawerPresence.state}
          screenFull={dialogs.screenFull}
          drawerTab={dialogs.drawerTab}
          onSelectTab={dialogs.setDrawerTab}
          panelLayout={layout.panelLayout}
          panelWidth={layout.panelWidth}
          onPanelResize={layout.onPanelResize}
          onPanelResizingChange={layout.setIsResizing}
          bot={live.botSummary}
          messages={live.messages}
          artifacts={chatView.artifacts}
          isGroup={activeChannel.kind === 'room'}
          room={activeRoom}
          agents={workspace.backendAgents}
          memberLimit={workspace.roomMemberLimit}
          busy={stream.busy}
          agentId={activeAgentId}
          channelName={activeChannel.name}
          memoryToken={chatView.memoryToken}
          onSaveMembers={(ids) => {
            if (activeRoom) void actions.saveMembers(activeRoom.id, ids);
          }}
          onSaveProfile={actions.saveBotProfile}
          onCloseDrawer={dialogs.closeDrawer}
          onClosePanel={dialogs.closeDrawerPanel}
          onEnterFullscreen={dialogs.showFullscreen}
          onExitFullscreen={dialogs.exitFullscreen}
        />

        {/* 4. 弹窗与提示条：新建 / 设置 / 删除确认 / 资料 / 改名 */}
        <AppDialogs
          createOpen={dialogs.newBotOpen}
          agents={workspace.backendAgents}
          memberLimit={workspace.roomMemberLimit}
          onCreateAgent={(input) => {
            void actions.createAgent(input);
            dialogs.closeCreate();
          }}
          onCreateRoom={(input) => {
            void actions.createRoom(input);
            dialogs.closeCreate();
          }}
          onCloseCreate={dialogs.closeCreate}
          settingsOpen={dialogs.settingsOpen}
          settingsSection={dialogs.settingsSection}
          theme={preference}
          endpoint={session.endpoint}
          tools={session.tools}
          ownerName={session.ownerName}
          onTheme={setPreference}
          onModel={(next) => void session.handleModelChange(next)}
          onOwnerName={session.setOwnerName}
          onCloseSettings={() => {
            dialogs.closeSettings();
            void session.refreshHealth();
          }}
          online={session.online}
          deleteOpen={dialogs.pendingDelete !== null}
          deleteCopy={dialogs.confirmCopy}
          onConfirmDelete={() => void actions.confirmDelete()}
          onCancelDelete={dialogs.cancelDelete}
          editingBot={dialogs.editingBot}
          onCloseEditBot={dialogs.closeEditBot}
          onSaveBotProfile={(input) =>
            dialogs.editingBot
              ? actions.saveBotProfile(dialogs.editingBot.id, input)
              : Promise.resolve('没有正在编辑的智能体')
          }
          renamingChannel={dialogs.renamingChannel}
          onCloseRename={dialogs.closeRename}
          onSubmitRename={actions.submitRoomRename}
        />
      </div>
    </ToastProvider>
  );
}