import { useEffect, useRef, useState } from 'react';
import { usePresence } from '../motion';
import { useModalKeys } from './ui/useModalKeys.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface RenameDialogProps {
  /** 对话框标题，如「重命名群」 */
  title: string;
  initial: string;
  open: boolean;
  onClose: () => void;
  /** App 负责调 API 与同步状态；成功返回 null，失败返回错误文案 */
  onSubmit: (name: string) => Promise<string | null>;
}

/** 单输入改名框（群重命名用；智能体走资料编辑） */
export function RenameDialog({ title, initial, open, onClose, onSubmit }: RenameDialogProps) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const presence = usePresence(open);
  const dialogRef = useModalKeys({
    open,
    onClose: () => (dirtyRef.current ? setConfirmDiscard(true) : onClose()),
    id: 'rename-dialog',
  });
  // 有未保存修改时 Esc 先确认，避免一按键盘就丢掉刚输入的内容
  const dirtyRef = useRef(false);
  dirtyRef.current = name.trim() !== initial.trim();

  useEffect(() => {
    if (!open) return;
    setName(initial);
    setSaving(false);
    setError(null);
    setConfirmDiscard(false);
  }, [open, initial]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    const failure = await onSubmit(trimmed);
    setSaving(false);
    if (failure) setError(failure);
    else onClose();
  };

  if (!presence.mounted) return null;

  return (
    <div
      className={`scrim ${presence.state}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className="dialog narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-dialog-title"
      >
        <header className="dialog-head">
          <h2 id="rename-dialog-title">{title}</h2>
          <button type="button" className="dialog-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span>名字</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          </label>

          {error ? <p className="profile-error">{error}</p> : null}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!name.trim() || saving}
            onClick={() => void submit()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃这次修改？"
        message="刚才输入的新名字还没有保存，关掉就没了。"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        danger
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}
