import { useState } from 'react';
import { RichText, stripThinkingBlocks } from '../markdown';
import { formatMessageTime } from '../format';
import { messageEnterKind, timelineLayoutKind } from '../features/chat/ui-chrome';
import type { BotSummary, DisplayMessage } from '../types';
import { BotAvatar, type AvatarMember } from './BotAvatar';
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
  onEdit,
  /** 时间线合并（规范 5.6）：同一个人 3 分钟内连说的几句，
   *  只有首条显示头像、名字与时间，后续只出气泡。 */
  compact = false,
}: {
  message: DisplayMessage;
  bot: BotSummary | null;
  memberNames?: string[];
  members?: AvatarMember[];
  isGroup?: boolean;
  notice?: boolean;
  onRetry?: (text: string) => void;
  onMention?: (name: string) => void;
  /** 用户消息：把原文填回输入框（不改发送逻辑） */
  onEdit?: (text: string) => void;
  compact?: boolean;
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
  const rowClass = `msg-row ${layout} enter-${enter}${compact ? ' compact' : ''}`;

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
      {isUser && onEdit && message.content.trim() ? (
        <button type="button" onClick={() => onEdit(message.content)} title="把原文填回输入框">
          重新编辑
        </button>
      ) : null}
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

  // 只有工具调用的消息没有正文：别画一个空气泡，工具卡自己会说话
  const text = message.content.trim() ? (
    <div className={`msg-bubble-box ${layout}${message.error ? ' error' : ''}`}>
      <BubbleContent message={message} memberNames={memberNames} />
    </div>
  ) : null;

  /** 工具过程：折叠卡片，默认收起，不跟正文抢（规范 5.7 / §3） */
  const toolCards =
    message.toolCalls.length > 0 ? (
      <div className="msg-tool-cards">
        {message.toolCalls.map((call) => (
          <ToolCallCard key={call.id} call={call} />
        ))}
      </div>
    ) : null;

  /** 合并组里的后续消息：只出气泡，不重复头像、名字与时间 */
  if (compact) {
    return (
      <div className={rowClass}>
        <div className={`msg-content-col ${layout === 'dm-user' ? 'user-content' : 'assistant-content'}`}>
          {text}
          {toolCards}
          {actions}
        </div>
      </div>
    );
  }

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
          {toolCards}
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
        {toolCards}
        {actions}
      </div>
    </div>
  );
}
