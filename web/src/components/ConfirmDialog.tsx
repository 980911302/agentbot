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
  if (!open) return null;

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div className="dialog narrow confirm" role="dialog" aria-label={title}>
        <div className="dialog-body">
          <h2 className="confirm-title">{title}</h2>
          <p className="confirm-text">{message}</p>
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={`btn ${danger ? 'danger' : 'primary'}`}
              autoFocus
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
