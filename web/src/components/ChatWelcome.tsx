import { BotAvatar, type AvatarMember } from './BotAvatar';
import type { BotSummary } from '../types';
import type { ChannelItem } from './Sidebar';

interface ChatWelcomeProps {
  ownerName: string;
  isWorkspaceEmpty?: boolean;
  isGroup?: boolean;
  bot?: BotSummary | ChannelItem | null;
  members?: AvatarMember[];
  onCreateAgent?: () => void;
}

export function ChatWelcome({
  ownerName,
  isWorkspaceEmpty = false,
  isGroup = false,
  bot,
  members = [],
  onCreateAgent,
}: ChatWelcomeProps) {
  if (isWorkspaceEmpty) {
    return (
      <div className="chat-welcome chat-welcome--empty-workspace">
        <h1 className="chat-welcome__title">你好，{ownerName}</h1>
        <p className="chat-welcome__desc">先创建一个智能体，再开始对话。</p>
        <button type="button" className="chat-welcome__cta-btn" onClick={onCreateAgent}>
          创建智能体
        </button>
      </div>
    );
  }

  if (isGroup) {
    return (
      <div className="chat-welcome chat-welcome--empty-group">
        <div className="chat-welcome__member-row">
          {members.map((member) => (
            <BotAvatar
              key={member.id}
              name={member.name}
              color={member.color}
              agentId={member.id}
              size={36}
            />
          ))}
        </div>
        <p className="chat-welcome__empty-copy">@ 谁，或说你们好</p>
      </div>
    );
  }

  // 欢迎页只放一句简介：优先 title（一行简介）、再 description，最后退到 role；CSS 限三行。
  // 不再铺开 instructions——那是整段职责提示词，写给模型看的，不是给人看的开场白。
  const title = bot && 'title' in bot ? (bot as BotSummary).title : undefined;
  const summary = bot && 'description' in bot ? (bot as BotSummary).description : undefined;
  const duty = (title || summary || bot?.role || '').trim();

  return (
    <div className="chat-welcome chat-welcome--empty-dm">
      <BotAvatar
        name={bot?.name || '智能体'}
        color={bot?.color || '#b89b6a'}
        agentId={'id' in (bot ?? {}) ? (bot as BotSummary).id : undefined}
        size={46}
      />
      {duty ? <p className="chat-welcome__duty">{duty}</p> : null}
      <p className="chat-welcome__empty-copy">直接打字</p>
    </div>
  );
}
