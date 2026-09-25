/**
 * 全局快捷键（UI 设计规范 §12 / UI-10）：
 * ⌘K/Ctrl+K 聚焦搜索、⌘,/Ctrl+, 打开设置、⌘\/Ctrl+\ 开关右侧面板、
 * ⌘⇧I 开关资料页、Esc 关闭最上层浮层。
 *
 * 判定是纯函数，供 useShortcuts 与 node:test 共用。
 * 两条硬规则：
 *   1. 输入框/可编辑区域内的普通按键不拦（Enter 归输入框自己）；
 *   2. Alt 组合不认——避开系统与输入法。
 */

export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** 事件目标是不是输入框/文本域/可编辑区 */
  targetIsEditable: boolean;
}

export type ShortcutAction =
  | 'focus-search'
  | 'open-settings'
  | 'toggle-panel'
  | 'toggle-profile'
  | 'dismiss-top';

export function shortcutAction(event: ShortcutEvent): ShortcutAction | null {
  if (event.altKey) return null;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (event.key === 'Escape') return 'dismiss-top';
  if (!mod) return null;

  if (key === 'k' && !event.shiftKey) return 'focus-search';
  if (event.key === ',') return 'open-settings';
  if (event.key === '\\') return 'toggle-panel';
  if (key === 'i' && event.shiftKey) return 'toggle-profile';
  return null;
}

export function isGlobalShortcut(event: ShortcutEvent): boolean {
  return shortcutAction(event) !== null;
}
