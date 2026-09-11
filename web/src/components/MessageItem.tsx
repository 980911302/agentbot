import { RichText } from '../markdown';
import type { BotSummary, DisplayMessage } from '../types';
import { BotAvatar } from './BotAvatar';
import { ToolCallCard } from './ToolCallCard';

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'ME';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0]! + parts[1][0]!).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function resolveSenderColor(name: string, fallback: string): string {
  if (name.includes('测试') || name.includes('运维')) return '#30d158';
  if (name.includes('白泽团队') || (name.includes('白泽') && !name.includes('联调'))) return '#a855f7';
  if (name.includes('AI') || name.includes('智能')) return '#38bdf8';
  if (name.includes('知识库')) return '#5eead4';
  if (name === 'linlin zhang' || name === '我') return '#60a5fa';
  return fallback;
}

export function MessageItem({ message, bot }: { message: DisplayMessage; bot: BotSummary | null }) {
  const isUser = message.role === 'user';
  const senderName = message.senderName || (isUser ? '我' : bot?.name || '助手');
  const senderColor = message.senderColor || resolveSenderColor(senderName, bot?.color || '#a855f7');
  const initials = isUser ? getInitials(senderName) : '';

  if (isUser) {
    return (
      <div className="msg-group-item user">
        <div className="msg-content-col user-content">
          <div className="msg-sender-header user-header">
            <span>{senderName}</span>
          </div>

          <div className={`msg-bubble-box user-bubble${message.error ? ' error' : ''}`}>
            {message.content ? <RichText text={message.content} /> : null}
          </div>
        </div>

        <div className="msg-avatar-col">
          <div className="user-initial-avatar" title={senderName}>
            {initials}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="msg-group-item assistant">
      <div className="msg-avatar-col">
        <BotAvatar name={senderName} color={senderColor} size={34} />
      </div>

      <div className="msg-content-col assistant-content">
        <div className="msg-sender-header assistant-header" style={{ color: senderColor }}>
          <span>{senderName}</span>
        </div>

        <div className={`msg-bubble-box assistant-bubble${message.error ? ' error' : ''}`}>
          {message.content ? <RichText text={message.content} /> : null}

          {message.toolCalls && message.toolCalls.length > 0 ? (
            <div className="tools-container">
              {message.toolCalls.map((call) => (
                <ToolCallCard key={call.id} call={call} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}


