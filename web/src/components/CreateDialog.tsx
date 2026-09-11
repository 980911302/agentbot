import { useState } from 'react';
import { IconClose } from '../icons';
import { BotAvatar } from './BotAvatar';
import { BotFace } from './BotFace';
import { Collapsible, usePresence } from '../motion';
import type { BotSummary } from '../types';

export interface CreateAgentInput {
  name: string;
  role: string;
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
  const [picked, setPicked] = useState<string[]>([]);
  const presence = usePresence(open);
  if (!presence.mounted) return null;

  const reset = () => {
    setName('');
    setRole('通用任务');
    setPicked([]);
    setMode('agent');
  };

  const close = () => {
    reset();
    onClose();
  };

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
    if (mode === 'agent') onCreateAgent({ name: name.trim(), role });
    else onCreateRoom({ name: name.trim(), memberIds: picked });
    reset();
  };

  return (
    <div
      className={`scrim ${presence.state}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div className="dialog narrow" role="dialog" aria-label="新建">
        <header className="dialog-head">
          <h2>{mode === 'agent' ? '新建智能体' : '新建群'}</h2>
          <button type="button" className="dialog-close" aria-label="关闭" onClick={close}>
            <IconClose size={16} />
          </button>
        </header>

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

        <div className="dialog-body">
          {mode === 'agent' ? (
            <>
              <div className="preview-face">
                <BotFace color="#8b5cf6" status="idle" size={54} />
                <span>颜色由系统分配</span>
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

              <p className="field-hint">职责会写进它的系统提示词，影响它看待任务的方式。</p>
            </>
          ) : (
            <>
              <div className="preview-face">
                <BotFace color="#a855f7" status="idle" size={54} />
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
                  {agents.length === 0 ? (
                    <p className="field-hint">还没有智能体，先建一个</p>
                  ) : null}
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
    </div>
  );
}
