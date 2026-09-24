import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuProps {
  /** 触发元素（如按钮）；children 为菜单内容 */
  trigger: ReactNode;
  children: ReactNode;
  /** 受控开合由外部给；不传则内部维护（点击外部 / Esc 关闭） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * 下拉菜单（UI 设计规范 5.12）：键盘上下选择、Home/End 跳转、Enter 确认、Esc 关闭。
 * 菜单内容用 MenuItem 组装；危险项放最后。
 * 打开即聚焦首项，因此右键菜单也能全键盘操作。
 */
export function Menu({ trigger, children, open: controlledOpen, onOpenChange }: MenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const menuItems = useCallback(
    () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.ui-menu-item:not(:disabled)') ?? [])],
    [],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setInternalOpen(false);
        onOpenChange?.(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInternalOpen(false);
        onOpenChange?.(false);
        return;
      }
      const items = menuItems();
      if (items.length === 0) return;
      const index = items.findIndex((item: HTMLButtonElement) => item === document.activeElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(index + 1) % items.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index <= 0 ? items.length : index) - 1]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onOpenChange, menuItems]);

  // 打开时聚焦首项：键盘用户可以立刻用上下键选择
  useEffect(() => {
    if (!open) return undefined;
    const first = listRef.current?.querySelector<HTMLButtonElement>('.ui-menu-item:not(:disabled)');
    first?.focus();
    return undefined;
  }, [open, children]);

  return (
    <div className="ui-menu-root" ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        onClick={() => {
          setInternalOpen((v) => !v);
          onOpenChange?.(!open);
        }}
      >
        {trigger}
      </span>
      {open ? (
        <div className="ui-menu" ref={listRef} role="menu">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface MenuItemProps {
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}

export function MenuItem({ onSelect, danger = false, disabled = false, children }: MenuItemProps) {
  return (
    <button
      type="button"
      className={`ui-menu-item${danger ? ' danger' : ''}`}
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
