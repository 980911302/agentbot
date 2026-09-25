/**
 * 右侧面板的纯展示逻辑：有哪些页签、群里「记忆 / 工作」看的是哪位成员。
 * 不碰 React 与 DOM，供 WorkspaceDrawer 与 node:test 共用。
 */
import type { DrawerTab } from './dialog-view';

export interface DrawerTabItem {
  id: DrawerTab;
  label: string;
}

/** 页签顺序：私聊有「资料」，群有「成员」；不再有「屏幕」 */
export function drawerTabs(isGroup: boolean): DrawerTabItem[] {
  return [
    ...(isGroup ? [] : [{ id: 'profile' as const, label: '资料' }]),
    { id: 'work', label: '工作' },
    { id: 'memory', label: '记忆' },
    ...(isGroup ? [{ id: 'members' as const, label: '成员' }] : []),
  ];
}

export interface DrawerTarget {
  /** 记忆 / 工作面板要读的同事 id；没有可读对象时为 null */
  id: string | null;
  /** 面板标题里的名字：群里是成员名，不是群名 */
  name: string;
}

/**
 * 群里：优先用户在选择器里选的成员，否则落到 fallbackId（App 传的是第一个成员），
 * 标题写这位成员的名字——以前标题写群名、内容却是第一个成员的记忆。
 * 私聊：就是这位同事。
 */
export function drawerTarget(input: {
  isGroup: boolean;
  members: Array<{ id: string; name: string }>;
  focusId: string | null;
  fallbackId: string | null;
  channelName: string;
}): DrawerTarget {
  if (!input.isGroup) return { id: input.fallbackId, name: input.channelName };
  const picked =
    input.members.find((member) => member.id === input.focusId) ??
    input.members.find((member) => member.id === input.fallbackId) ??
    input.members[0];
  return picked ? { id: picked.id, name: picked.name } : { id: null, name: input.channelName };
}
