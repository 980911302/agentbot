import { useState } from 'react';
import { RichText, stripThinkingBlocks } from '../markdown';
import { formatMessageTime } from '../format';
import { messageEnterKind, timelineLayoutKind } from '../features/chat/ui-chrome';
import { memberPauseTag } from '../features/chat/group-view';
import type { BotSummary, DisplayMessage } from '../types';
import { BotAvatar, type AvatarMember } from './BotAvatar';
import { ToolCallCard } from './ToolCallCard';
import { IconAlert, IconChevronRight, IconTool } from '../icons';

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
  /** 暂停成员的「暂停」标记：只在群里、且该成员确实暂停时出现 */
  const pauseTag = isGroup && !isUser && member ? memberPauseTag(member) : null;
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

  // 只有工具调用的消息没有正文：别画一个空气泡，工具卡自己会说话。
  // 错误消息统一在这里画一个警示图标（正文不再拼 ⚠️），图标带 aria-label 让读屏先读「出错」。
  const text = message.content.trim() ? (
    message.error ? (
      <div className={`msg-bubble-box ${layout} error`}>
        <IconAlert size={16} className="msg-error-icon" role="img" aria-label="出错" />
        <div className="msg-error-body">
          <BubbleContent message={message} memberNames={memberNames} />
        </div>
      </div>
    ) : (
      <div className={`msg-bubble-box ${layout}`}>
        <BubbleContent message={message} memberNames={memberNames} />
      </div>
    )
  ) : null;

  /** 工具过程聚合成一条摘要，默认收起；失败时展开，便于看见需要处理的问题。 */
  const toolState = message.toolCalls.some((call) => call.status === 'error')
    ? 'error'
    : message.toolCalls.some((call) => call.status === 'running')
      ? 'running'
      : 'ok';
  const toolStateLabel =
    toolState === 'error' ? '有调用失败' : toolState === 'running' ? '执行中' : '已完成';
  const toolCards =
    message.toolCalls.length > 0 ? (
      <details className={`tool-call-group ${toolState}`} open={toolState === 'error'}>
        <summary className="tool-call-group-summary">
          <span className={`tool-status-dot ${toolState}`} />
          <IconTool size={13} />
          <span className="tool-call-group-title">执行过程</span>
          <span className="tool-call-group-meta">
            {message.toolCalls.length} 次调用 · {toolStateLabel}
          </span>
          <IconChevronRight size={14} className="tool-call-group-chevron" />
        </summary>
        <div className="msg-tool-cards">
          {message.toolCalls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </div>
      </details>
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
          {/* 暂停中的成员标出来，不当成沉默（规范 4 / UI-11） */}
          {pauseTag ? <span className="msg-sender-paused">{pauseTag}</span> : null}
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
