import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AVATAR_COLORS,
  AVATAR_COLOR_HEX,
  AVATAR_SHAPES,
  LivingAvatar,
  loadAvatarShape,
  resolveAvatarColorFromHex,
  saveAvatarShape,
  type AvatarColor,
  type AvatarShape,
} from './LivingAvatar';
import { faceStateFromStatus } from '../features/chat/ui-chrome';
import { ensureNotifyPermission } from '../notify';
import type { BotSummary } from '../types';

interface BotProfileDrawerProps {
  bot: BotSummary;
  onClose: () => void;
  onSave: (
    botId: string,
    input: {
      name?: string;
      section?: string;
      title?: string;
      description?: string;
      instructions?: string;
      color?: string;
    },
  ) => Promise<string | null>;
}

export function BotProfileDrawer({ bot, onClose, onSave }: BotProfileDrawerProps) {
  const [name, setName] = useState(bot.name || '');
  const [title, setTitle] = useState(bot.title || '');
  const [instructions, setInstructions] = useState(bot.instructions || bot.role || '');
  const [color, setColor] = useState(bot.color || AVATAR_COLOR_HEX.violet);
  const [shape, setShape] = useState<AvatarShape>(() => loadAvatarShape(bot.id));
  const [notify, setNotify] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem(`agentbot.notify.${bot.id}`);
    return saved !== null ? saved === 'true' : true;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(bot.name || '');
    setTitle(bot.title || '');
    setInstructions(bot.instructions || bot.role || '');
    setColor(bot.color || AVATAR_COLOR_HEX.violet);
    setShape(loadAvatarShape(bot.id));
    const saved = localStorage.getItem(`agentbot.notify.${bot.id}`);
    setNotify(saved !== null ? saved === 'true' : true);
    setError(null);
  }, [bot.id, bot.name, bot.title, bot.instructions, bot.role, bot.color]);

  const latestValues = useRef({ name, title, instructions, color });
  latestValues.current = { name, title, instructions, color };

  /** 是否有未保存改动（名字留空视为没改好，不出保存条） */
  const isDirty =
    (name.trim() !== '' && name !== bot.name) ||
    title !== (bot.title || '') ||
    instructions !== (bot.instructions || bot.role || '') ||
    color !== (bot.color || AVATAR_COLOR_HEX.violet);

  const saveChanges = useCallback(
    async (overrides?: Partial<{ name: string; title: string; instructions: string; color: string }>) => {
      const current = { ...latestValues.current, ...overrides };
      const trimmedName = current.name.trim();
      if (!trimmedName) return;

      setSaving(true);
      setError(null);
      try {
        const failure = await onSave(bot.id, {
          name: trimmedName,
          title: current.title.trim(),
          instructions: current.instructions.trim(),
          color: current.color,
        });
        if (failure) {
          setError(failure);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [bot.id, onSave],
  );

  useEffect(() => {
    const isNameDiff = name.trim() !== '' && name !== bot.name;
    const isTitleDiff = title !== (bot.title || '');
    const isDutyDiff = instructions !== (bot.instructions || bot.role || '');
    const isColorDiff = color !== (bot.color || AVATAR_COLOR_HEX.violet);
    if (!isNameDiff && !isTitleDiff && !isDutyDiff && !isColorDiff) return;

    const timer = setTimeout(() => {
      void saveChanges();
    }, 600);
    return () => clearTimeout(timer);
  }, [name, title, instructions, color, bot.name, bot.title, bot.instructions, bot.role, bot.color, saveChanges]);

  const discardChanges = () => {
    setName(bot.name || '');
    setTitle(bot.title || '');
    setInstructions(bot.instructions || bot.role || '');
    setColor(bot.color || AVATAR_COLOR_HEX.violet);
    setError(null);
  };

  const toggleNotify = async () => {
    const next = !notify;
    setNotify(next);
    localStorage.setItem(`agentbot.notify.${bot.id}`, String(next));
    if (next) {
      await ensureNotifyPermission();
    }
  };

  const pickShape = (next: AvatarShape) => {
    setShape(next);
    saveAvatarShape(bot.id, next);
  };

  const pickColor = (next: AvatarColor) => {
    const hex = AVATAR_COLOR_HEX[next];
    setColor(hex);
    void saveChanges({ color: hex });
  };

  const avatarColor = resolveAvatarColorFromHex(color);

  return (
    <div className="bot-profile-drawer" role="region" aria-label="智能体资料">
      <div className="profile-drawer-avatar-wrap">
        <LivingAvatar
          size={76}
          color={avatarColor}
          shape={shape}
          state={faceStateFromStatus(bot.status)}
        />
      </div>

      <div className="profile-drawer-form">
        <div className="profile-drawer-field">
          <label className="profile-drawer-label" htmlFor="bot-profile-name">
            名字
          </label>
          <input
            id="bot-profile-name"
            type="text"
            className="profile-drawer-input"
            value={name}
            placeholder="同事名字"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveChanges()}
          />
        </div>

        <div className="profile-drawer-field">
          <label className="profile-drawer-label" htmlFor="bot-profile-title">
            头衔
          </label>
          <input
            id="bot-profile-title"
            type="text"
            className="profile-drawer-input"
            value={title}
            placeholder="一句话头衔"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveChanges()}
          />
        </div>

        <div className="profile-drawer-field">
          <label className="profile-drawer-label" htmlFor="bot-profile-instructions">
            职责
          </label>
          <textarea
            id="bot-profile-instructions"
            className="profile-drawer-textarea"
            rows={4}
            value={instructions}
            placeholder="它负责什么、怎么看待任务"
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => void saveChanges()}
          />
        </div>

        <div className="profile-drawer-field">
          <span className="profile-drawer-label">形状</span>
          <div className="profile-shape-grid">
            {AVATAR_SHAPES.map((item) => (
              <button
                type="button"
                key={item}
                className={`profile-shape-swatch${item === shape ? ' selected' : ''}`}
                title={item}
                onClick={() => pickShape(item)}
              >
                <LivingAvatar shape={item} color={avatarColor} size={28} frozen />
              </button>
            ))}
          </div>
        </div>

        <div className="profile-drawer-field">
          <span className="profile-drawer-label">颜色</span>
          <div className="profile-color-grid">
            {AVATAR_COLORS.map((item) => (
              <button
                type="button"
                key={item}
                className={`profile-color-swatch${item === avatarColor ? ' selected' : ''}`}
                style={{ background: AVATAR_COLOR_HEX[item] }}
                title={item}
                onClick={() => pickColor(item)}
              />
            ))}
          </div>
        </div>

        <div className="profile-drawer-notice-card">
          <div className="notice-card-text">
            <div className="notice-card-title">通知</div>
            <div className="notice-card-desc">Bot 完成任务或需要回应时通知你</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={notify}
            aria-label="通知开关"
            className={`profile-drawer-switch${notify ? ' active' : ''}`}
            onClick={() => void toggleNotify()}
          >
            <span className="switch-thumb" />
          </button>
        </div>

        {error ? <div className="profile-drawer-error">{error}</div> : null}
      </div>

      {/* 吸底保存条（UI-06 / 规范 5.10）：有改动才出现，保存走现有更新接口 */}
      {isDirty ? (
        <div className="profile-save-bar" role="group" aria-label="未保存的修改">
          <span className="profile-save-hint">{saving ? '正在保存…' : '有未保存的修改'}</span>
          <button type="button" className="btn ghost sm" onClick={discardChanges} disabled={saving}>
            撤销
          </button>
          <button type="button" className="btn primary sm" onClick={() => void saveChanges()} disabled={saving}>
            保存
          </button>
        </div>
      ) : null}
    </div>
  );
}
