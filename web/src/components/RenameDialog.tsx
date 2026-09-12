import { useState } from 'react';

interface RenameDialogProps {
  /** 对话框标题，如「重命名群」 */
  title: string;
  initial: string;
  onClose: () => void;
  /** App 负责调 API 与同步状态；成功返回 null，失败返回错误文案 */
  onSubmit: (name: string) => Promise<string | null>;
}

/** 单输入改名框（群重命名用；智能体走资料编辑） */
export function RenameDialog({ title, initial, onClose, onSubmit }: RenameDialogProps) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="dialog narrow" role="dialog" aria-label={title}>
        <header className="dialog-head">
          <h2>{title}</h2>
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
      </div>
    </div>
  );
}
