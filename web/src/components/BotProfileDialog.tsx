import { useEffect, useRef, useState } from 'react';
import { BotAvatar } from './BotAvatar';
import { usePresence } from '../motion';
import { useModalKeys } from './ui/useModalKeys.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import type { BotSummary } from '../types';

const PALETTE = [
  '#b89b6a',
  '#93784a',
  '#4a90e2',
  '#34c759',
  '#af52de',
  '#5ac8fa',
  '#ff9500',
  '#f87171',
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const presence = usePresence(bot !== null);
  const shownRef = useRef(bot);
  if (bot) shownRef.current = bot;
  const shown = bot ?? shownRef.current;
  // 有未保存修改时 Esc 先确认，别一按键盘就丢内容
  const baselineRef = useRef({ name: '', instructions: '', color: PALETTE[0]! });
  const dirtyRef = useRef(false);
  dirtyRef.current =
    name.trim() !== baselineRef.current.name ||
    instructions.trim() !== baselineRef.current.instructions ||
    color !== baselineRef.current.color;
  const dialogRef = useModalKeys({
    open: bot !== null,
    onClose: () => (dirtyRef.current ? setConfirmDiscard(true) : onClose()),
    id: 'bot-profile-dialog',
  });

  useEffect(() => {
    if (!bot) return;
    setName(bot.name);
    setInstructions(bot.instructions ?? bot.role);
    setColor(bot.color || PALETTE[0]!);
    // 基线跟着打开的同务走：之后用它判断有没有未保存修改
    baselineRef.current = {
      name: bot.name.trim(),
      instructions: (bot.instructions ?? bot.role).trim(),
      color: bot.color || PALETTE[0]!,
    };
    setError(null);
    setConfirmDiscard(false);
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
      <div
        ref={dialogRef}
        className="dialog narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-profile-title"
      >
        <header className="dialog-head">
          <h2 id="bot-profile-title">智能体资料</h2>
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

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃这次修改？"
        message="资料还没有保存，关掉就没了。"
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
