/**
 * 浮层与抽屉的纯状态判定（OPT-04 从 App.tsx 抽出）。
 *
 * 三类判定各只有一份出处，方便 node:test 盯住「顺序 / 该关哪一层」这类
 * 一改就容易错、又只靠肉眼看的行为：
 *   1. Esc 关最上层浮层的顺序（dismissTopmostOverlay）；
 *   2. 抽屉 tab 的点击意图（信息 / 成员 / 资料 / 快捷键）；
 *   3. 删除确认框的文案。
 */

/** 右侧抽屉的页签（work 为 E4.7 的「手头工作」） */
export type DrawerTab = 'screen' | 'memory' | 'members' | 'profile' | 'work';

/** 设置弹窗的初始分区 */
export type SettingsSection = 'general' | 'models';

/** Esc 可关的浮层，按「谁在最上层」从高到低排列 */
export type OverlayLayer =
  | 'sidebarDrawer'
  | 'confirmDelete'
  | 'rename'
  | 'profileEdit'
  | 'create'
  | 'settings'
  | 'drawer';

export interface OverlayStackState {
  /** 键名与 OverlayLayer 一一对应，调用方可以按层名直接翻 */
  sidebarDrawer: boolean;
  confirmDelete: boolean;
  rename: boolean;
  profileEdit: boolean;
  create: boolean;
  settings: boolean;
  /** 右侧抽屉是否挂在 DOM 上（含退出动画）且不是全屏态 */
  drawer: boolean;
}

/**
 * Esc 关最上层：从上往下关——侧栏抽屉 → 确认框 → 改名 → 新建 → 设置 → 右侧抽屉。
 * 顺序就是行为契约，改这里必须同步更新 test/dialog-view.test.ts。
 */
export function topmostOverlay(state: OverlayStackState): OverlayLayer | null {
  if (state.sidebarDrawer) return 'sidebarDrawer';
  if (state.confirmDelete) return 'confirmDelete';
  if (state.rename) return 'rename';
  if (state.profileEdit) return 'profileEdit';
  if (state.create) return 'create';
  if (state.settings) return 'settings';
  if (state.drawer) return 'drawer';
  return null;
}

/**
 * 抽屉操作意图。hook 只负责执行，不再自己判断该关还是该开——
 * 判断全在这里，行为一致且可测。
 */
export type DrawerIntent =
  | { action: 'close'; tab?: DrawerTab }
  | { action: 'setOpen'; open: boolean }
  | { action: 'setTab'; tab: DrawerTab }
  /** fullscreen 省略 = 不动全屏态（顶栏开屏幕是这种） */
  | { action: 'showTab'; tab: DrawerTab; fullscreen?: boolean }
  | { action: 'setFullscreen'; fullscreen: boolean };

/** 顶栏「侧边栏与屏幕」按钮：已开时在资料页就切回屏幕，否则关掉 */
export function infoToggleIntent(screenOpen: boolean, drawerTab: DrawerTab): DrawerIntent {
  if (!screenOpen) return { action: 'showTab', tab: 'screen' };
  return drawerTab === 'profile' ? { action: 'setTab', tab: 'screen' } : { action: 'close' };
}

/** 群顶栏成员叠放：已开成员页就关掉并回到屏幕页，否则打开成员页 */
export function membersToggleIntent(screenOpen: boolean, drawerTab: DrawerTab): DrawerIntent {
  if (screenOpen && drawerTab === 'members') return { action: 'close', tab: 'screen' };
  return { action: 'showTab', tab: 'members', fullscreen: false };
}

/** 私聊标题 / 快捷键 ⌘⇧I：已开资料页就关掉，否则打开资料页 */
export function profileToggleIntent(screenOpen: boolean, drawerTab: DrawerTab): DrawerIntent {
  if (screenOpen && drawerTab === 'profile') return { action: 'close' };
  return { action: 'showTab', tab: 'profile', fullscreen: false };
}

/** 快捷键 ⌘\：全屏时先退全屏；否则开合抽屉（不动页签） */
export function panelToggleIntent(screenFull: boolean, screenOpen: boolean): DrawerIntent {
  if (screenFull) return { action: 'setFullscreen', fullscreen: false };
  return { action: 'setOpen', open: !screenOpen };
}

export interface DeleteConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
}

/**
 * 删除确认框文案：群是解散（成员表与群时间线一起删），
 * 智能体是删除（连带对话记录与长期记忆）。
 */
export function deleteConfirmCopy(
  target: { name: string; isGroup?: boolean } | null,
  deleting: boolean,
): DeleteConfirmCopy {
  return {
    title: target?.isGroup ? '解散这个群？' : '删除这个智能体？',
    message: target?.isGroup
      ? `「${target.name}」的成员表与群时间线会一起删掉，成员各自的记忆不受影响。解散后无法恢复。`
      : `「${target?.name ?? ''}」的对话记录和它的长期记忆会一起删掉，无法恢复。`,
    confirmLabel: deleting ? '删除中…' : target?.isGroup ? '解散' : '删除',
  };
}

/** 切到私聊时成员页没有意义：回到屏幕页 */
export function drawerTabOnChannelChange(
  kind: 'room' | 'agent' | undefined,
  current: DrawerTab,
): DrawerTab {
  return kind !== 'room' && current === 'members' ? 'screen' : current;
}