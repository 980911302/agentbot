import { useEffect, useRef, useState } from 'react';
import type { ReactNode, WheelEvent as ReactWheelEvent } from 'react';
import type { ArtifactView, BotSummary, DisplayMessage } from '../types';
import { BotAvatar } from './BotAvatar';
import { IconChevronDown, IconInfo } from '../icons';
import { MessageItem } from './MessageItem';

interface ChatViewProps {
  bot: BotSummary | null;
  messages: DisplayMessage[];
  artifacts: ArtifactView[];
  busy: boolean;
  composer: ReactNode;
  channelTitle?: string;
  onToggleInfo?: () => void;
  /** 群回合：正在进入回合的成员名 */
  roundActive?: string | null;
  /** 群回合：这一轮看过但没开口的成员 */
  silentNotes?: string[];
  isGroup?: boolean;
  members?: Array<{ id: string; name: string; color: string }>;
  /** 切换频道时用它触发内容淡入 */
  channelKey?: string;
}

export function ChatView({
  bot,
  messages,
  artifacts,
  busy,
  composer,
  channelTitle,
  onToggleInfo,
  roundActive,
  silentNotes,
  isGroup,
  members = [],
  channelKey,
}: ChatViewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** 是否跟随新消息 */
  const stickToBottom = useRef(true);
  /** 脱离跟随期间新到了多少条，用于「回到底部」角标 */
  const [pendingCount, setPendingCount] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const lastSeenCount = useRef(messages.length);
  const title = channelTitle || bot?.name || '白泽联调';

  const distanceFromBottom = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return 0;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  };

  /** 只有用户明确向上滚（滚轮向上 / 触摸下滑）才脱离跟随 */
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < -2) stickToBottom.current = false;
    else if (distanceFromBottom() < 24) stickToBottom.current = true;
  };

  /** 滚回底部就重新跟随 */
  const onScroll = () => {
    const nearBottom = distanceFromBottom() < 24;
    if (nearBottom) stickToBottom.current = true;
    setAwayFromBottom(!nearBottom);
    if (nearBottom) setPendingCount(0);
  };

  const jumpToBottom = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    stickToBottom.current = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    setPendingCount(0);
    setAwayFromBottom(false);
  };

  // 自动贴底
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !stickToBottom.current) return undefined;

    scroller.scrollTop = scroller.scrollHeight;
    const raf = requestAnimationFrame(() => {
      if (stickToBottom.current) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, busy, artifacts, roundActive]);

  // 脱离跟随期间累计新消息
  useEffect(() => {
    const added = messages.length - lastSeenCount.current;
    lastSeenCount.current = messages.length;
    if (added > 0 && !stickToBottom.current) {
      setPendingCount((count) => count + added);
    }
  }, [messages.length]);

  // 切换频道时重置跟随状态
  useEffect(() => {
    stickToBottom.current = true;
    setPendingCount(0);
    setAwayFromBottom(false);
    lastSeenCount.current = 0;
  }, [channelKey]);

  return (
    <div className="main-chat-container">
      <header className="chat-top-header">
        <div className="chat-header-left">
          <BotAvatar name={title} size={30} color={bot?.color || '#a855f7'} />
          <div className="chat-header-title-box">
            <h2 className="chat-header-title">{title}</h2>
            {isGroup && members.length > 0 ? (
              <span className="chat-header-subtitle">
                多智能体协同群 · {members.length} 位成员
              </span>
            ) : null}
          </div>

          {isGroup && members.length > 0 ? (
            <div className="chat-header-member-stack" onClick={onToggleInfo} title="查看成员详情">
              {members.slice(0, 4).map((m) => (
                <div key={m.id} className="header-member-avatar" title={m.name}>
                  <BotAvatar name={m.name} color={m.color} size={22} />
                </div>
              ))}
              {members.length > 4 ? (
                <span className="header-member-more">+{members.length - 4}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="chat-header-right">
          <button
            type="button"
            className="chat-header-icon-btn"
            aria-label="详情信息"
            title="查看任务与环境详情"
            onClick={onToggleInfo}
          >
            <IconInfo size={18} />
          </button>
        </div>
      </header>

      <div
        className="chat-scroll-viewport"
        ref={scrollerRef}
        onScroll={onScroll}
        onWheel={onWheel}
      >
        <div className="chat-message-list swap" key={channelKey}>
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} bot={bot} />
          ))}

          {artifacts.length > 0 ? <ArtifactRow artifacts={artifacts} /> : null}

          {/* 群回合进行中：谁在看 */}
          {isGroup && roundActive ? (
            <div className="round-line">
              <span className="dot-pulse" />
              <span>{roundActive} 正在看这一轮…</span>
            </div>
          ) : null}

          {/* 沉默是一等公民：只做轻提示，不进正文 */}
          {isGroup && !roundActive && (silentNotes?.length ?? 0) > 0 ? (
            <div className="silent-line">
              {silentNotes?.map((note) => <span key={note}>{note}</span>)}
            </div>
          ) : null}

          {busy && !isGroup ? (
            <div className="msg-group-item assistant thinking-indicator">
              <div className="msg-avatar-col">
                <BotAvatar name={bot?.name || '助手'} color={bot?.color || '#94a3b8'} size={34} />
              </div>
              <div className="msg-content-col">
                <div className="msg-sender-header" style={{ color: bot?.color || '#94a3b8' }}>
                  {bot?.name || '助手'}
                </div>
                <div className="msg-bubble-box working-bubble">
                  <span className="dot-pulse" />
                  <span className="dot-pulse" />
                  <span className="dot-pulse" />
                  <span className="working-label">{bot?.activity || '正在协同处理中…'}</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 翻历史时新消息还在来，给一个回到底部的出口 */}
      {awayFromBottom ? (
        <button
          type="button"
          className="scroll-bottom"
          aria-label={pendingCount > 0 ? `回到底部，${pendingCount} 条新消息` : '回到底部'}
          title="回到底部"
          onClick={jumpToBottom}
        >
          <IconChevronDown size={17} />
          {pendingCount > 0 ? (
            <span className="unread-dot">{pendingCount > 99 ? '99+' : pendingCount}</span>
          ) : null}
        </button>
      ) : null}

      {composer}
    </div>
  );
}

function ArtifactRow({ artifacts }: { artifacts: ArtifactView[] }) {
  return (
    <div className="artifact-row">
      {artifacts.map((artifact) => {
        const name = artifact.path.split('/').pop() ?? artifact.path;
        const ext = name.includes('.') ? (name.split('.').pop() ?? '').toUpperCase() : 'FILE';
        return (
          <span className="file-chip" key={`${artifact.tool}-${artifact.path}`}>
            <span className="file-ext">{ext}</span>
            <span className="file-name">{name}</span>
            <span className="file-tool">{artifact.tool}</span>
          </span>
        );
      })}
    </div>
  );
}
