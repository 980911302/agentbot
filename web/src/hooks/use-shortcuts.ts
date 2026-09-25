import { useEffect } from 'react';
import { shortcutAction, type ShortcutAction } from '../features/chat/shortcuts.js';

export interface ShortcutHandlers {
  onFocusSearch?: () => void;
  onOpenSettings?: () => void;
  onTogglePanel?: () => void;
  onToggleProfile?: () => void;
  /** Esc：由调用方决定关哪一层（弹窗栈/抽屉/菜单） */
  onDismissTop?: () => void;
}

/** 事件目标是不是可编辑区：输入框、文本域、contenteditable */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const DISPATCH: Record<ShortcutAction, keyof ShortcutHandlers> = {
  'focus-search': 'onFocusSearch',
  'open-settings': 'onOpenSettings',
  'toggle-panel': 'onTogglePanel',
  'toggle-profile': 'onToggleProfile',
  'dismiss-top': 'onDismissTop',
};

/**
 * 全局快捷键（UI-10）：⌘K 搜索、⌘, 设置、⌘\ 右侧面板、⌘⇧I 资料页、Esc 关最上层。
 *
 * 判定逻辑在 features/chat/shortcuts.ts（可单测）；这里只负责接线：
 * 捕获阶段监听 document，输入框内的普通按键不拦（Enter 归输入框）。
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = shortcutAction({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        targetIsEditable: isEditableTarget(event.target),
      });
      if (!action) return;
      const handler = handlers[DISPATCH[action]];
      if (!handler) return;
      // Esc 用于关浮层时不一定想拦默认行为；其余组合键一律 preventDefault，
      // 否则浏览器会把 ⌘K/⌘, 当成自己的快捷键。
      if (action !== 'dismiss-top') event.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [handlers]);
}
