import { useState } from 'react';
import { RichText, stripThinkingBlocks } from '../markdown';
import { formatMessageTime } from '../format';
import { messageEnterKind, timelineLayoutKind } from '../features/chat/ui-chrome';
import type { BotSummary, DisplayMessage } from '../types';
import { BotAvatar, type AvatarMember } from './BotAvatar';

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'ME';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0]! + parts[1][0]!).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function BubbleContent({
  message,
  memberNames,
}: {
  message: DisplayMessage;
  memberNames: string[];
}) {
  if (!message.content) return null;
  return <RichText text={message.content} mentionNames={memberNames} />;
}

export function MessageItem({
  message,
  bot,
  memberNames = [],
  members = [],
  isGroup = false,
  notice = false,
  onRetry,
  onMention,
}: {
  message: DisplayMessage;
  bot: BotSummary | null;
  memberNames?: string[];
  members?: AvatarMember[];
  isGroup?: boolean;
  notice?: boolean;
  onRetry?: (text: string) => void;
  onMention?: (name: string) => void;
}) {
  const isUser = message.role === 'user';
  const senderName = message.senderName || (isUser ? '我' : bot?.name || '助手');
  const senderColor = message.senderColor || message.sender?.color || bot?.color || '#b89b6a';
  const senderId = message.sender?.id;
  const member = members.find((item) => item.id === senderId || item.name === senderName);
  const initials = isUser ? getInitials(senderName) : '';
  const [copied, setCopied] = useState(false);
  const layout = timelineLayoutKind({ isGroup, role: message.role });
  const enter = messageEnterKind({ isGroup, role: message.role });
  const rowClass = `msg-row ${layout} enter-${enter}`;

  const copy = () => {
    void navigator.clipboard.writeText(stripThinkingBlocks(message.content)).then(() => {
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

  const origin = message.originLabel ? (
    <span className="msg-origin-tag">{message.originLabel}</span>
  ) : null;

  const text = (
    <div className={`msg-bubble-box ${layout}${message.error ? ' error' : ''}`}>
      <BubbleContent message={message} memberNames={memberNames} />
    </div>
  );

  if (layout === 'dm-user') {
    return (
      <div className={`${rowClass}`}>
        <div className="msg-content-col user-content">
          <div className="msg-sender-header user-header">
            <span>{senderName}</span>
            {origin}
            <span className="msg-time">{formatMessageTime(message.createdAt)}</span>
          </div>
          {text}
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

  const face = isUser ? (
    <div className="user-initial-avatar" title={senderName}>
      {initials}
    </div>
  ) : (
    <BotAvatar
      name={senderName}
      color={member?.color || senderColor}
      agentId={member?.id || senderId}
      size={34}
      status={member?.status}
      notice={notice}
    />
  );

  return (
    <div className={rowClass}>
      <div className="msg-avatar-col">{face}</div>
      <div className="msg-content-col assistant-content">
        <div
          className="msg-sender-header assistant-header"
          style={isUser ? undefined : { color: member?.color || senderColor }}
        >
          <button
            type="button"
            className="msg-sender-name"
            onClick={() => onMention?.(senderName)}
            title={onMention ? `插入 @${senderName}` : undefined}
          >
            {senderName}
          </button>
          {origin}
          <span className="msg-time">{formatMessageTime(message.createdAt)}</span>
        </div>
        {text}
        {actions}
      </div>
    </div>
  );
}
