import { useRef } from 'react';
import { usePresence } from '../motion';
import { useModalKeys } from './ui/useModalKeys.js';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const presence = usePresence(open);
  const dialogRef = useModalKeys({ open, onClose: onCancel, id: 'confirm-dialog' });
  const snap = useRef({ title, message, confirmLabel, danger });
  if (open) snap.current = { title, message, confirmLabel, danger };
  if (!presence.mounted) return null;

  const view = snap.current;

  return (
    <div
      className={`scrim ${presence.state}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        className="dialog narrow confirm"
        role="dialog"
        aria-modal="true"
        aria-label={view.title}
      >
        <div className="dialog-body">
          <h2 className="confirm-title">{view.title}</h2>
          <p className="confirm-text">{view.message}</p>
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={`btn ${view.danger ? 'danger' : 'primary'}`}
              autoFocus
              onClick={onConfirm}
            >
              {view.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
