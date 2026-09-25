import { useCallback, useState } from 'react';
import { usePresence } from '../../motion';
import type { ChannelItem } from '../../components/Sidebar';
import type { BotSummary } from '../../types';
import {
  deleteConfirmCopy,
  drawerTabOnChannelChange,
  infoToggleIntent,
  membersToggleIntent,
  panelToggleIntent,
  profileToggleIntent,
  topmostOverlay,
  type DrawerIntent,
  type DrawerTab,
  type SettingsSection,
} from './dialog-view';

/**
 * 对话框 / 抽屉 / 浮层的开关状态（OPT-04 从 App.tsx 抽出）。
 *
 * 判定在 dialog-view.ts（纯、可单测）；这里只持有 useState 并执行意图。
 * 浮层之间的优先级与「Esc 关谁」的顺序都来自那份纯模块，App 不再自己拼。
 */
export function useDialogs(input: { busy: boolean }) {
  const { busy } = input;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [newBotOpen, setNewBotOpen] = useState(false);
  /** 右键菜单选中的待删对象，确认后才真正动手 */
  const [pendingDelete, setPendingDelete] = useState<ChannelItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 正在编辑资料的智能体 / 正在改名的群 */
  const [editingBot, setEditingBot] = useState<BotSummary | null>(null);
  const [renamingChannel, setRenamingChannel] = useState<ChannelItem | null>(null);
  const [screenOpen, setScreenOpen] = useState(false);
  const [screenFull, setScreenFull] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('screen');
  /** 单栏档侧栏抽屉开合（UI-09）：顶栏菜单按钮 / Esc 控制 */
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  /** 抽屉卸载前先播完退出动画 */
  const drawerPresence = usePresence(screenOpen);

  const applyDrawerIntent = useCallback((intent: DrawerIntent) => {
    switch (intent.action) {
      case 'close':
        setScreenOpen(false);
        if (intent.tab) setDrawerTab(intent.tab);
        return;
      case 'setOpen':
        setScreenOpen(intent.open);
        return;
      case 'setTab':
        setDrawerTab(intent.tab);
        return;
      case 'showTab':
        setDrawerTab(intent.tab);
        setScreenOpen(true);
        if (intent.fullscreen !== undefined) setScreenFull(intent.fullscreen);
        return;
      case 'setFullscreen':
        setScreenFull(intent.fullscreen);
    }
  }, []);

  const openSettings = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  /** 快捷键 ⌘,：只打开设置，停在用户上次看的分区 */
  const showSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const openCreate = useCallback(() => setNewBotOpen(true), []);
  const closeCreate = useCallback(() => setNewBotOpen(false), []);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const closeRename = useCallback(() => setRenamingChannel(null), []);

  /**
   * 右键删除 / 改名：一轮回合没结束时不允许（原 App 里的 busy 门禁）——
   * 免得频道在回合中途被摘掉。判定只此一处，左栏两个入口共用。
   */
  const requestDelete = useCallback(
    (channel: ChannelItem) => {
      if (busy) return;
      setPendingDelete(channel);
    },
    [busy],
  );
  const requestRename = useCallback(
    (channel: ChannelItem) => {
      if (busy) return;
      setRenamingChannel(channel);
    },
    [busy],
  );

  const closeEditBot = useCallback(() => setEditingBot(null), []);

  /** 关闭右侧抽屉（含退出全屏）：tabs 的 × 与抽屉内关闭走这条 */
  const closeDrawer = useCallback(() => {
    setScreenOpen(false);
    setScreenFull(false);
  }, []);
  /** 只关抽屉、不动全屏：抽屉内各面板的关闭 */
  const closeDrawerPanel = useCallback(() => setScreenOpen(false), []);

  const toggleInfo = useCallback(
    () => applyDrawerIntent(infoToggleIntent(screenOpen, drawerTab)),
    [applyDrawerIntent, drawerTab, screenOpen],
  );
  const openMembers = useCallback(
    () => applyDrawerIntent(membersToggleIntent(screenOpen, drawerTab)),
    [applyDrawerIntent, drawerTab, screenOpen],
  );
  const toggleProfile = useCallback(
    () => applyDrawerIntent(profileToggleIntent(screenOpen, drawerTab)),
    [applyDrawerIntent, drawerTab, screenOpen],
  );
  /** 快捷键 ⌘\：全屏时退全屏，否则开合抽屉（不动页签） */
  const togglePanel = useCallback(
    () => applyDrawerIntent(panelToggleIntent(screenFull, screenOpen)),
    [applyDrawerIntent, screenFull, screenOpen],
  );
  /** 侧栏右键编辑智能体：切到它并打开资料页 */
  const openProfileDrawer = useCallback(
    () => applyDrawerIntent({ action: 'showTab', tab: 'profile', fullscreen: false }),
    [applyDrawerIntent],
  );
  const showFullscreen = useCallback(() => setScreenFull(true), []);
  const exitFullscreen = useCallback(() => setScreenFull(false), []);

  const toggleSidebarDrawer = useCallback(() => setSidebarDrawerOpen((open) => !open), []);
  const closeSidebarDrawer = useCallback(() => setSidebarDrawerOpen(false), []);

  /** 切到私聊时成员页没有意义：回到屏幕页（判定在 dialog-view） */
  const syncDrawerTabOnChannelChange = useCallback((kind: ChannelItem['kind']) => {
    setDrawerTab((current) => drawerTabOnChannelChange(kind, current));
  }, []);

  /** Esc 关最上层：顺序在 dialog-view.topmostOverlay */
  const dismissTopmostOverlay = useCallback(() => {
    const layer = topmostOverlay({
      sidebarDrawer: sidebarDrawerOpen,
      confirmDelete: pendingDelete !== null,
      rename: renamingChannel !== null,
      profileEdit: editingBot !== null,
      create: newBotOpen,
      settings: settingsOpen,
      drawer: drawerPresence.mounted && !screenFull,
    });
    switch (layer) {
      case 'sidebarDrawer':
        setSidebarDrawerOpen(false);
        return;
      case 'confirmDelete':
        setPendingDelete(null);
        return;
      case 'rename':
        setRenamingChannel(null);
        return;
      case 'profileEdit':
        setEditingBot(null);
        return;
      case 'create':
        setNewBotOpen(false);
        return;
      case 'settings':
        setSettingsOpen(false);
        return;
      case 'drawer':
        setScreenOpen(false);
        return;
      default:
        return;
    }
  }, [
    drawerPresence.mounted,
    editingBot,
    newBotOpen,
    pendingDelete,
    renamingChannel,
    screenFull,
    settingsOpen,
    sidebarDrawerOpen,
  ]);

  return {
    settingsOpen,
    settingsSection,
    setSettingsSection,
    openSettings,
    showSettings,
    closeSettings,
    newBotOpen,
    openCreate,
    closeCreate,
    pendingDelete,
    setPendingDelete,
    deleting,
    setDeleting,
    confirmCopy: deleteConfirmCopy(pendingDelete, deleting),
    requestDelete,
    requestRename,
    cancelDelete,
    editingBot,
    setEditingBot,
    closeEditBot,
    renamingChannel,
    closeRename,
    screenOpen,
    screenFull,
    drawerTab,
    setDrawerTab,
    drawerPresence,
    /** 抽屉占位（含退场动画）且不是全屏 = 右侧面板真的在显示 */
    panelVisible: drawerPresence.mounted && !screenFull,
    sidebarDrawerOpen,
    toggleSidebarDrawer,
    closeSidebarDrawer,
    toggleInfo,
    openMembers,
    toggleProfile,
    togglePanel,
    openProfileDrawer,
    closeDrawer,
    closeDrawerPanel,
    showFullscreen,
    exitFullscreen,
    syncDrawerTabOnChannelChange,
    dismissTopmostOverlay,
  };
}