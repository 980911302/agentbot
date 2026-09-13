import { useCallback, useEffect, useRef, useState } from 'react';
import { LivingAvatar } from './LivingAvatar';
import { resolveAvatarColor } from './BotAvatar';
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
      description?: string;
      instructions?: string;
      color?: string;
    },
  ) => Promise<string | null>;
}

export function BotProfileDrawer({ bot, onClose, onSave }: BotProfileDrawerProps) {
  const [name, setName] = useState(bot.name || '');
  const [section, setSection] = useState(bot.section || '');
  const [description, setDescription] = useState(bot.description || bot.instructions || '');
  const [notify, setNotify] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem(`agentbot.notify.${bot.id}`);
    return saved !== null ? saved === 'true' : true;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 当外部选中的 bot 切换时同步更新
  useEffect(() => {
    setName(bot.name || '');
    setSection(bot.section || '');
    setDescription(bot.description || bot.instructions || '');
    const saved = localStorage.getItem(`agentbot.notify.${bot.id}`);
    setNotify(saved !== null ? saved === 'true' : true);
    setError(null);
  }, [bot.id, bot.name, bot.section, bot.description, bot.instructions]);

  const latestValues = useRef({ name, section, description });
  latestValues.current = { name, section, description };

  const saveChanges = useCallback(
    async (overrides?: Partial<{ name: string; section: string; description: string }>) => {
      const current = { ...latestValues.current, ...overrides };
      const trimmedName = current.name.trim();
      if (!trimmedName) return;

      setSaving(true);
      setError(null);
      try {
        const failure = await onSave(bot.id, {
          name: trimmedName,
          section: current.section.trim(),
          description: current.description.trim(),
          instructions: current.description.trim() || bot.instructions,
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
    [bot.id, bot.instructions, onSave],
  );

  // 输入防抖自动保存 (600ms)
  useEffect(() => {
    const isNameDiff = name.trim() !== '' && name !== bot.name;
    const isSectionDiff = section !== (bot.section || '');
    const isDescDiff = description !== (bot.description || bot.instructions || '');

    if (!isNameDiff && !isSectionDiff && !isDescDiff) return;

    const timer = setTimeout(() => {
      void saveChanges();
    }, 600);
    return () => clearTimeout(timer);
  }, [name, section, description, bot.name, bot.section, bot.description, bot.instructions, saveChanges]);

  const toggleNotify = async () => {
    const next = !notify;
    setNotify(next);
    localStorage.setItem(`agentbot.notify.${bot.id}`, String(next));
    if (next) {
      await ensureNotifyPermission();
    }
  };

  const avatarColor = resolveAvatarColor(bot.color);

  return (
    <div className="bot-profile-drawer" role="region" aria-label="智能体资料">
      <div className="profile-drawer-avatar-wrap">
        <LivingAvatar
          size={76}
          color={avatarColor}
          shape="squircle"
          state={bot.status === 'working' ? 'working' : 'idle'}
        />
      </div>

      <div className="profile-drawer-form">
        <div className="profile-drawer-field">
          <label className="profile-drawer-label" htmlFor="bot-profile-name">
            名称
          </label>
          <input
            id="bot-profile-name"
            type="text"
            className="profile-drawer-input"
            value={name}
            placeholder="New Bot"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveChanges()}
          />
        </div>

        <div className="profile-drawer-field">
          <label className="profile-drawer-label" htmlFor="bot-profile-section">
            标签（可选）
          </label>
          <input
            id="bot-profile-section"
            type="text"
            className="profile-drawer-input"
            value={section}
            placeholder="研究、市场、行政"
            onChange={(e) => setSection(e.target.value)}
            onBlur={() => void saveChanges()}
          />
        </div>

        <div className="profile-drawer-field">
          <label className="profile-drawer-label" htmlFor="bot-profile-description">
            描述
          </label>
          <textarea
            id="bot-profile-description"
            className="profile-drawer-textarea"
            rows={4}
            value={description}
            placeholder="详细说明用途和工作方式"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => void saveChanges()}
          />
        </div>

        {/* 通知卡片与开关 */}
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

        {saving ? <div className="profile-drawer-hint">正在自动同步…</div> : null}
        {error ? <div className="profile-drawer-error">{error}</div> : null}
      </div>
    </div>
  );
}
