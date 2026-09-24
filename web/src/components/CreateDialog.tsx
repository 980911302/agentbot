import { useState } from 'react';
import { IconClose } from '../icons';
import { BotAvatar } from './BotAvatar';
import {
  AVATAR_COLORS,
  AVATAR_COLOR_HEX,
  AVATAR_SHAPES,
  LivingAvatar,
  type AvatarColor,
  type AvatarShape,
} from './LivingAvatar';
import { usePresence } from '../motion';
import { useModalKeys } from './ui/useModalKeys.js';
import type { BotSummary } from '../types';

export interface CreateAgentInput {
  name: string;
  role: string;
  color?: string;
  shape?: AvatarShape;
}

export interface CreateRoomInput {
  name: string;
  memberIds: string[];
}

interface CreateDialogProps {
  open: boolean;
  agents: BotSummary[];
  memberLimit: number;
  onCreateAgent: (input: CreateAgentInput) => void;
  onCreateRoom: (input: CreateRoomInput) => void;
  onClose: () => void;
}

const ROLES = ['代码审查', '资料检索', '写作助手', '数据分析', '运维值守', '通用任务'];

export function CreateDialog({
  open,
  agents,
  memberLimit,
  onCreateAgent,
  onCreateRoom,
  onClose,
}: CreateDialogProps) {
  const [mode, setMode] = useState<'agent' | 'room'>('agent');
  const [name, setName] = useState('');
  const [role, setRole] = useState('通用任务');
  const [color, setColor] = useState<AvatarColor>('brown');
  const [shape, setShape] = useState<AvatarShape>('squircle');
  const [picked, setPicked] = useState<string[]>([]);
  const presence = usePresence(open);

  const reset = () => {
    setName('');
    setRole('通用任务');
    setColor('violet');
    setShape('squircle');
    setPicked([]);
    setMode('agent');
  };

  const close = () => {
    reset();
    onClose();
  };

  // Esc 与点遮罩、点关闭按钮同一个语义：直接关掉并清空表单（本来就是新建，没有可丢的旧值）
  const dialogRef = useModalKeys({ open, onClose: close, id: 'create-dialog' });
  if (!presence.mounted) return null;

  const toggle = (id: string) => {
    setPicked((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length >= memberLimit
          ? current
          : [...current, id],
    );
  };

  const canSubmit = mode === 'agent' ? name.trim().length > 0 : name.trim() && picked.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    if (mode === 'agent') onCreateAgent({ name: name.trim(), role, color: AVATAR_COLOR_HEX[color], shape });
    else onCreateRoom({ name: name.trim(), memberIds: picked });
    reset();
  };

  return (
    <div
      className={`scrim ${presence.state}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        className="dialog narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-dialog-title"
      >
        <header className="dialog-head">
          <h2 id="create-dialog-title">{mode === 'agent' ? '新建智能体' : '新建群'}</h2>
          <button type="button" className="dialog-close" aria-label="关闭" onClick={close}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="dialog-body">
          <div className="create-tabs">
            <button
              type="button"
              className={`create-tab${mode === 'agent' ? ' active' : ''}`}
              onClick={() => setMode('agent')}
            >
              智能体
            </button>
            <button
              type="button"
              className={`create-tab${mode === 'room' ? ' active' : ''}`}
              onClick={() => setMode('room')}
            >
              群
            </button>
          </div>

          {mode === 'agent' ? (
            <>
              <div className="preview-face">
                <LivingAvatar shape={shape} color={color} size={54} />
                <span>默认脸：形状 + 颜色</span>
              </div>

              <label className="field">
                <span>名字</span>
                <input
                  autoFocus
                  value={name}
                  placeholder="例如：小审"
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submit();
                  }}
                />
              </label>

              <div className="field">
                <span>职责</span>
                <div className="chips">
                  {ROLES.map((item) => (
                    <button
                      type="button"
                      key={item}
                      className={`chip${item === role ? ' selected' : ''}`}
                      onClick={() => setRole(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <span>形状（可选）</span>
                <div className="profile-shape-grid compact">
                  {AVATAR_SHAPES.map((item) => (
                    <button
                      type="button"
                      key={item}
                      className={`profile-shape-swatch${item === shape ? ' selected' : ''}`}
                      onClick={() => setShape(item)}
                      title={item}
                    >
                      <LivingAvatar shape={item} color={color} size={22} frozen />
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <span>颜色（可选）</span>
                <div className="profile-color-grid">
                  {AVATAR_COLORS.map((item) => (
                    <button
                      type="button"
                      key={item}
                      className={`profile-color-swatch${item === color ? ' selected' : ''}`}
                      style={{ background: AVATAR_COLOR_HEX[item] }}
                      title={item}
                      onClick={() => setColor(item)}
                    />
                  ))}
                </div>
              </div>

              <p className="field-hint">职责会写进它的系统提示词，影响它看待任务的方式。</p>
            </>
          ) : (
            <>
              <div className="preview-face">
                <BotAvatar
                  name={name || '群'}
                  isGroup
                  members={picked
                    .map((id) => agents.find((agent) => agent.id === id))
                    .filter((agent): agent is BotSummary => Boolean(agent))
                    .map((agent) => ({ id: agent.id, name: agent.name, color: agent.color }))}
                  size={54}
                />
                <span>群只是成员表 + 广播，本身不思考、不存档</span>
              </div>

              <label className="field">
                <span>群名</span>
                <input
                  autoFocus
                  value={name}
                  placeholder="例如：支付联调"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>

              <div className="field">
                <span>
                  成员（{picked.length}/{memberLimit}）
                </span>
                <div className="member-picker">
                  {agents.length === 0 ? <p className="field-hint">还没有智能体，先建一个</p> : null}
                  {agents.map((agent) => {
                    const on = picked.includes(agent.id);
                    return (
                      <button
                        type="button"
                        key={agent.id}
                        className={`member-option${on ? ' selected' : ''}`}
                        onClick={() => toggle(agent.id)}
                      >
                        <BotAvatar name={agent.name} color={agent.color} size={26} />
                        <span className="member-option-name">{agent.name}</span>
                        <span className="member-option-role">{agent.role}</span>
                        <span className="member-option-mark">{on ? '✓' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <p className="field-hint">
                新成员从进群之后开始收消息，不回溯进群前的记录；之后可以在群里拉人 / 踢人。
              </p>
            </>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={close}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
            {mode === 'agent' ? '创建智能体' : '创建群'}
          </button>
        </div>
      </div>
    </div>
  );
}
