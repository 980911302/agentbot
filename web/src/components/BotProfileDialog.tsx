import { useEffect, useRef, useState } from 'react';
import { BotAvatar } from './BotAvatar';
import { usePresence } from '../motion';
import type { BotSummary } from '../types';

const PALETTE = [
  '#a855f7',
  '#38bdf8',
  '#30d158',
  '#f97316',
  '#f472b6',
  '#facc15',
  '#5eead4',
  '#60a5fa',
];

interface BotProfileDialogProps {
  bot: BotSummary | null;
  onClose: () => void;
  /** App 负责调 API 与同步状态；成功返回 null，失败返回错误文案 */
  onSave: (input: { name: string; instructions: string; color: string }) => Promise<string | null>;
}

/** 智能体资料：名字 / 职责 / 配色，保存走 PATCH /api/bots/:id */
export function BotProfileDialog({ bot, onClose, onSave }: BotProfileDialogProps) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [color, setColor] = useState<string>(PALETTE[0]!);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presence = usePresence(bot !== null);
  const shownRef = useRef(bot);
  if (bot) shownRef.current = bot;
  const shown = bot ?? shownRef.current;

  useEffect(() => {
    if (!bot) return;
    setName(bot.name);
    setInstructions(bot.instructions ?? bot.role);
    setColor(bot.color || PALETTE[0]!);
    setError(null);
  }, [bot]);

  if (!presence.mounted || !shown) return null;

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    const failure = await onSave({
      name: trimmed,
      instructions: instructions.trim(),
      color,
    });
    setSaving(false);
    if (failure) setError(failure);
    else onClose();
  };

  return (
    <div
      className={`scrim ${presence.state}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="dialog narrow" role="dialog" aria-label="智能体资料">
        <header className="dialog-head">
          <h2>智能体资料</h2>
          <button type="button" className="dialog-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="dialog-body">
          <div className="profile-preview">
            <BotAvatar name={name.trim() || shown.name} color={color} size={46} />
            <span>{name.trim() || shown.name}</span>
          </div>

          <label className="field">
            <span>名字</span>
            <input
              autoFocus
              value={name}
              placeholder="它叫什么"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          </label>

          <label className="field">
            <span>职责</span>
            <textarea
              rows={4}
              value={instructions}
              placeholder="它负责什么、以什么风格行事——会写进它的系统提示词"
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>

          <div className="field">
            <span>配色</span>
            <div className="swatches">
              {PALETTE.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={`swatch${item === color ? ' selected' : ''}`}
                  style={{ background: item }}
                  aria-label={`配色 ${item}`}
                  onClick={() => setColor(item)}
                />
              ))}
            </div>
          </div>

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
