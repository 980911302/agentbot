import { useState, type ReactNode } from 'react';
import { usePresence } from '../../motion';
import { useModalKeys } from './useModalKeys.js';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** S 400 / M 440 / L 800 */
  size?: 's' | 'm' | 'l';
  children: ReactNode;
  /** 底部操作条；不传则主体占满 */
  actions?: ReactNode;
}

/**
 * 统一弹窗（UI 设计规范 5.11）：Esc 关闭（多弹窗只关最上层）、
 * Tab 焦点陷阱、打开聚焦首个控件、关闭还原焦点。
 * 最大高度 min(720px, 100vh - 64px)，主体滚动，操作条吸底任何窗口高度可见；
 * <768px 全屏（贴边满窗、去圆角）的规则在 09-ui.css 的
 * `@media (max-width: 768px)` 段，与旧 `.scrim`/`.dialog` 路径同一套。
 */
export function Modal({ open, onClose, title, size = 'm', children, actions }: ModalProps) {
  const presence = usePresence(open);
  const dialogRef = useModalKeys({ open, onClose, id: `ui-modal-${title}` });
  if (!presence.mounted) return null;
  const titleId = `ui-modal-title-${title}`;
  return (
    <div
      className={`ui-modal-scrim ${presence.state}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className={`ui-modal ${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="ui-modal-head">
          <h2 className="ui-modal-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="btn ghost sm" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ui-modal-body">{children}</div>
        {actions ? <div className="ui-modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
