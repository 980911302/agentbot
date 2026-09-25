import { useState } from 'react';
import { IconClose, IconPlus } from '../icons';
import { BotAvatar } from './BotAvatar';
import { Collapsible } from '../motion';
import type { BotSummary, RoomView } from '../types';

interface MemberPanelProps {
  room: RoomView;
  agents: BotSummary[];
  memberLimit: number;
  busy: boolean;
  onSave: (memberIds: string[]) => void;
}

/**
 * 群的成员表。
 * 文档：成员最多 6 个、至少留 1 个；改完从下一回合生效。
 */
export function MemberPanel({ room, agents, memberLimit, busy, onSave }: MemberPanelProps) {
  const [picked, setPicked] = useState<string[]>(room.memberIds);
  const [adding, setAdding] = useState(false);

  const memberSet = new Set(picked);
  const dirty =
    picked.length !== room.memberIds.length ||
    picked.some((id) => !room.memberIds.includes(id));
  const atLimit = picked.length >= memberLimit;
  const candidates = agents.filter((agent) => !memberSet.has(agent.id));

  const toggle = (id: string) => {
    setPicked((current) => {
      if (current.includes(id)) {
        if (current.length <= 1) return current;
        return current.filter((item) => item !== id);
      }
      if (current.length >= memberLimit) return current;
      return [...current, id];
    });
  };

  return (
    <section className="member-panel">
      <header className="screen-head">
        <span className="memory-title">成员</span>
        <span className="memory-sub">
          {picked.length}/{memberLimit}
        </span>
        <button
          type="button"
          className="screen-btn"
          aria-label="拉人"
          disabled={atLimit || candidates.length === 0}
          onClick={() => setAdding((value) => !value)}
        >
          <IconPlus size={15} />
        </button>
      </header>

      <div className="memory-body">
        <p className="field-hint">
          群只是成员表 + 广播。改完从下一回合生效，新成员不回溯进群前的记录。
        </p>

        <Collapsible open={adding && candidates.length > 0}>
          <div className="member-add">
            <div className="member-add-label">拉进群</div>
            {candidates.map((agent) => (
              <button
                type="button"
                key={agent.id}
                className="member-option"
                onClick={() => {
                  toggle(agent.id);
                  setAdding(false);
                }}
              >
                <BotAvatar name={agent.name} color={agent.color} size={24} agentId={agent.id} status={agent.status} />
                <span className="member-option-name">{agent.name}</span>
                <span className="member-option-role">{agent.role}</span>
                <span className="member-option-mark">＋</span>
              </button>
            ))}
          </div>
        </Collapsible>

        <ul className="memory-list">
          {picked.map((id) => {
            const agent = agents.find((item) => item.id === id);
            if (!agent) return null;
            const last = picked.length <= 1;
            return (
              <li className="member-row" key={id}>
                <BotAvatar name={agent.name} color={agent.color} size={30} agentId={agent.id} status={agent.status} />
                <div className="member-row-text">
                  <span className="member-row-name">{agent.name}</span>
                  <span className="member-row-role">{agent.role}</span>
                </div>
                <button
                  type="button"
                  className="memory-act danger"
                  disabled={last}
                  title={last ? '至少要留 1 个成员' : '踢出群'}
                  onClick={() => toggle(id)}
                >
                  <IconClose size={13} />
                </button>
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          className="btn primary"
          disabled={!dirty || busy || picked.length === 0}
          onClick={() => onSave(picked)}
        >
          {dirty ? '保存成员表' : '没有改动'}
        </button>

        {atLimit ? <p className="field-hint">已达成员上限 {memberLimit} 人，先踢一个再加。</p> : null}
        {picked.length === 1 ? <p className="field-hint">不能把成员删空，至少留 1 个。</p> : null}
      </div>
    </section>
  );
}
