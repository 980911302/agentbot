import { useState } from 'react';
import { RichText } from '../markdown';
import { formatMessageTime } from '../format';
import type { BotSummary, DisplayMessage } from '../types';
import { BotAvatar } from './BotAvatar';

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

/** 把文本按 @名字 / @everyone 切段，命中成员的提及高亮 */
function splitMentions(
  text: string,
  names: string[],
): Array<{ text: string; mention?: boolean }> {
  if (names.length === 0) return [{ text }];
  const escaped = [...names, 'everyone']
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const pattern = new RegExp(`@(${escaped})`, 'g');
  const parts: Array<{ text: string; mention?: boolean }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ text: text.slice(lastIndex, index) });
    parts.push({ text: match[0], mention: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ text }];
}

function BubbleContent({
  message,
  memberNames,
}: {
  message: DisplayMessage;
  memberNames: string[];
}) {
  if (!message.content) return null;
  if (memberNames.length === 0) return <RichText text={message.content} />;
  return (
    <>
      {splitMentions(message.content, memberNames).map((part, index) =>
        part.mention ? (
          <span className="mention" key={index}>
            {part.text}
          </span>
        ) : (
          <RichText key={index} text={part.text} />
        ),
      )}
    </>
  );
}

export function MessageItem({
  message,
  bot,
  memberNames = [],
  onRetry,
}: {
  message: DisplayMessage;
  bot: BotSummary | null;
  /** 群成员名：用于 @ 提及高亮，空 = 不启用 */
  memberNames?: string[];
  /** 错误消息的重试回调 */
  onRetry?: (text: string) => void;
}) {
  const isUser = message.role === 'user';
  const senderName = message.senderName || (isUser ? '我' : bot?.name || '助手');
  const senderColor = message.senderColor || resolveSenderColor(senderName, bot?.color || '#a855f7');
  const initials = isUser ? getInitials(senderName) : '';
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const actions = (
    <div className="msg-actions">
      <button type="button" onClick={copy}>
        {copied ? '已复制' : '复制'}
      </button>
      {!isUser && message.error && message.retryText && onRetry ? (
        <button type="button" onClick={() => onRetry(message.retryText!)}>
          重试
        </button>
      ) : null}
    </div>
  );

  if (isUser) {
    return (
      <div className="msg-group-item user">
        <div className="msg-content-col user-content">
          <div className="msg-sender-header user-header">
            <span>{senderName}</span>
            <span className="msg-time">{formatMessageTime(message.createdAt)}</span>
          </div>

          <div className={`msg-bubble-box user-bubble${message.error ? ' error' : ''}`}>
            <BubbleContent message={message} memberNames={memberNames} />
          </div>
          {actions}
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
          <span className="msg-time">{formatMessageTime(message.createdAt)}</span>
        </div>

        <div className={`msg-bubble-box assistant-bubble${message.error ? ' error' : ''}`}>
          <BubbleContent message={message} memberNames={memberNames} />
        </div>
        {actions}
      </div>
    </div>
  );
}
