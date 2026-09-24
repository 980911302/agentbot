import { useEffect, useRef, useState } from 'react';
import type { ReactNode, WheelEvent as ReactWheelEvent } from 'react';
import type { ArtifactView, BotSummary, DisplayMessage, InteractionRequest, RoomFlowView } from '../types';
import { fetchRoomFlow, controlRoomFlow } from '../api';
import { RichText } from '../markdown';
import { BotAvatar } from './BotAvatar';
import { IconArrowDown, IconArrowUp, IconCheck, IconShare, IconSidebar } from '../icons';
import { MessageItem } from './MessageItem';
import { InteractionCard } from './InteractionCard';
import { CorrespondenceRow, CorrespondencePanel } from './CorrespondenceView';
import { chatRows } from '../features/chat/correspondence';
import { ChatWelcome } from './ChatWelcome';
import type { MessageActor } from '../../../src/shared/contracts/message-identity';

interface ChatViewProps {
  ownerName?: string;
  bot: BotSummary | null;
  messages: DisplayMessage[];
  artifacts: ArtifactView[];
  busy: boolean;
  /** 私聊流式：正在生成的增量文本（空 = 没有正在打字） */
  liveText?: string;
  composer: ReactNode;
  channelTitle?: string;
  onToggleInfo?: () => void;
  /** 私聊点标题打开智能体资料编辑 */
  onOpenProfile?: () => void;
  /** 错误消息的重试（重新发送原话） */
  onRetry?: (text: string, clientMessageId?: string) => void;
  /** 频道内的轻状态行（任务挂起等系统提示） */
  notices?: string[];
  /** 群回合：正在进入回合的成员（只改对应那张脸，不占「正在回复」气泡） */
  roundActive?: { id: string; name: string; color: string } | null;
  /** 回合/回复刚结束的短暂绿勾 */
  doneFlash?: boolean;
  isGroup?: boolean;
  members?: Array<{ id: string; name: string; color: string; status?: string }>;
  memberLimit?: number;
  /** 切换频道时用它触发内容淡入 */
  channelKey?: string;
  /** 正在等用户回答的卡片 */
  interactions?: InteractionRequest[];
  onAnswerInteraction?: (
    id: string,
    answer: { value?: string; secret?: string; cancelled?: boolean },
  ) => void;
}

export function ChatView({
  ownerName = '主人',
  bot,
  messages,
  artifacts,
  busy,
  liveText,
  composer,
  channelTitle,
  onToggleInfo,
  onOpenProfile,
  onRetry,
  notices,
  roundActive,
  doneFlash,
  isGroup,
  members = [],
  memberLimit = 6,
  channelKey,
  interactions,
  onAnswerInteraction,
}: ChatViewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** 是否跟随新消息 */
  const stickToBottom = useRef(true);
  /** 脱离跟随期间新到了多少条，用于「回到底部」角标 */
  const [pendingCount, setPendingCount] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const lastSeenCount = useRef(messages.length);
  const title = channelTitle || bot?.name || '对话';
  const lastSpeakerId = [...messages].reverse().find((item) => item.role === 'assistant')?.id;
  const faces = members.map((member) => ({
    ...member,
    status: roundActive?.id === member.id ? 'working' : member.status,
  }));
  const [peer, setPeer] = useState<MessageActor | null>(null);
  useEffect(() => setPeer(null), [channelKey]);

  const [roomFlow, setRoomFlow] = useState<RoomFlowView | null>(null);
  useEffect(() => {
    if (!isGroup || !channelKey) {
      setRoomFlow(null);
      return;
    }
    let active = true;
    const loadFlow = () => {
      void fetchRoomFlow(channelKey)
        .then((flow) => {
          if (active) setRoomFlow(flow);
        })
        .catch(() => {});
    };
    loadFlow();

    const onFlowUpdated = (e: Event) => {
      const custom = e as CustomEvent<RoomFlowView>;
      if (custom.detail && custom.detail.roomId === channelKey) {
        setRoomFlow(custom.detail);
      } else {
        loadFlow();
      }
    };
    window.addEventListener('agentbot:flow_updated', onFlowUpdated);
    return () => {
      active = false;
      window.removeEventListener('agentbot:flow_updated', onFlowUpdated);
    };
  }, [isGroup, channelKey, messages.length]);

  const handleFlowAction = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!channelKey) return;
    try {
      const updated = await controlRoomFlow(channelKey, action);
      setRoomFlow(updated);
    } catch (err) {
      console.error('Failed to control room flow:', err);
    }
  };

  /** 最近一次还在跑的工具调用：悬停时告诉用户「它此刻在做什么」 */
  const runningCall = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const call = messages[index]?.toolCalls.find((item) => item.status === 'running');
      if (call) return call;
    }
    return null;
  })();
  const actionHint = runningCall
    ? `${runningCall.name}(${runningCall.arguments.replace(/\s+/g, ' ').slice(0, 80)})`
    : null;

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
  }, [messages, busy, artifacts, roundActive, liveText]);

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
    <div className={`main-chat-container${isGroup ? ' is-group' : ''}`}>
      <header className="chat-top-header">
        <div className="chat-header-left">
          {peer ? (
            <div className="correspondence-header-pair">
              <span className="correspondence-header-agent">
                <BotAvatar name={title} size={28} color={bot?.color || '#b89b6a'} agentId={bot?.id} />
                <strong>{title}</strong>
              </span>
              <span className="correspondence-swap" aria-hidden="true">↔</span>
              <span className="correspondence-header-agent">
                <BotAvatar name={peer.name} size={28} color={peer.color} />
                <strong>{peer.name}</strong>
              </span>
            </div>
          ) : <>
          <div
            className={`chat-header-avatar${doneFlash ? ' done-flash' : ''}${onOpenProfile ? ' clickable' : ''}`}
            title={busy ? (actionHint ?? '正在处理…') : (onOpenProfile ? '编辑智能体资料' : undefined)}
            onClick={onOpenProfile}
            role={onOpenProfile ? 'button' : undefined}
          >
            <BotAvatar
              name={title}
              size={28}
              color={bot?.color || '#b89b6a'}
              status={isGroup ? undefined : bot?.status}
              agentId={bot?.id}
              isGroup={isGroup}
              members={faces}
            />
            {doneFlash ? (
              <span className="done-check">
                <IconCheck size={11} />
              </span>
            ) : null}
          </div>
          <div
            className={`chat-header-title-box${onOpenProfile ? ' clickable' : ''}`}
            onClick={onOpenProfile}
            role={onOpenProfile ? 'button' : undefined}
            title={onOpenProfile ? '编辑智能体资料' : undefined}
          >
            <div className="chat-header-title-row">
              <h2 className="chat-header-title">{title}</h2>
              {isGroup ? <span className="chat-header-group-badge">{faces.length}/{memberLimit}</span> : null}
            </div>
            {isGroup && faces.length > 0 ? (
              <span className="chat-header-subtitle">群聊</span>
            ) : null}
          </div>

          {isGroup && faces.length > 0 ? (
            <div className="chat-header-member-stack" onClick={onToggleInfo} title="查看成员详情">
              {faces.slice(0, 4).map((m) => (
                <div key={m.id} className="header-member-avatar" title={m.name}>
                  <BotAvatar name={m.name} color={m.color} size={22} agentId={m.id} status={m.status} />
                </div>
              ))}
              {faces.length > 4 ? (
                <span className="header-member-more">+{faces.length - 4}</span>
              ) : null}
            </div>
          ) : null}
          </>}
          {/* header actions */}
        </div>

        <div className="chat-header-right">
          {peer ? (
            <button type="button" className="chat-header-icon-btn correspondence-back"
              aria-label={`返回${title}主对话`} title="返回主对话" onClick={() => setPeer(null)}>←</button>
          ) : null}
          <button
            type="button"
            className="chat-header-icon-btn"
            aria-label="分享"
            title="分享或导出会话"
            onClick={() => {
              void navigator.clipboard.writeText(window.location.href);
            }}
          >
            <IconShare size={17} />
          </button>
          <button
            type="button"
            className="chat-header-icon-btn"
            aria-label="侧边栏与屏幕"
            title="查看任务与环境详情"
            onClick={onToggleInfo}
          >
            <IconSidebar size={17} />
          </button>
        </div>
      </header>

      {isGroup && roomFlow && roomFlow.status !== 'completed' && roomFlow.status !== 'cancelled' ? (
        <div className="room-flow-bar">
          <div className="room-flow-info">
            <span className="room-flow-badge">{roomFlow.protocol}</span>
            <span className="room-flow-phase">阶段: {roomFlow.phase}</span>
            <span className={`room-flow-status status-${roomFlow.status}`}>
              {roomFlow.status === 'active'
                ? '● 进行中'
                : roomFlow.status === 'awaiting_user'
                  ? '👤 等待用户'
                  : roomFlow.status === 'paused'
                    ? '⏸ 已暂停'
                    : roomFlow.status}
            </span>
            {roomFlow.currentActors.length > 0 ? (
              <span className="room-flow-actors">
                行动方:{' '}
                {roomFlow.currentActors
                  .map((actor) => {
                    if (actor.kind === 'user') return '用户';
                    const member = members.find((m) => m.id === actor.id);
                    return member?.name ?? actor.id;
                  })
                  .join(', ')}
              </span>
            ) : null}
          </div>
          <div className="room-flow-actions">
            {roomFlow.status === 'active' ? (
              <button
                type="button"
                className="flow-btn pause"
                onClick={() => void handleFlowAction('pause')}
              >
                暂停
              </button>
            ) : roomFlow.status === 'paused' ? (
              <button
                type="button"
                className="flow-btn resume"
                onClick={() => void handleFlowAction('resume')}
              >
                继续
              </button>
            ) : null}
            <button
              type="button"
              className="flow-btn cancel"
              onClick={() => void handleFlowAction('cancel')}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {peer && bot?.id ? (
        <CorrespondencePanel key={`${channelKey}:${peer.id}`} agentId={bot.id} agentName={title} peer={peer}
          live={messages.flatMap(message => message.correspondence ? [message.correspondence] : [])} onClose={() => setPeer(null)} />
      ) : <>
      {/* 顶部悬浮未读药丸 (图二对应) */}
      {awayFromBottom ? (
        <div
          className="floating-unread-pill"
          role="button"
          tabIndex={0}
          onClick={jumpToBottom}
          title="点击直达最新消息"
        >
          <IconArrowUp size={14} />
          <span>{pendingCount > 0 ? `${pendingCount} 条新消息` : '回到最新消息'}</span>
          <span
            className="floating-unread-close"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              setAwayFromBottom(false);
            }}
            title="关闭提示"
          >
            ×
          </span>
        </div>
      ) : null}

      <div
        className="chat-scroll-viewport"
        ref={scrollerRef}
        onScroll={onScroll}
        onWheel={onWheel}
      >
        <div className="chat-message-list swap" key={channelKey}>
          {messages.length === 0 ? (
            <ChatWelcome
              ownerName={ownerName}
              bot={bot}
              isGroup={isGroup}
              members={faces}
              isWorkspaceEmpty={false}
            />
          ) : (
            chatRows(messages).map((row) =>
              row.kind === 'correspondence' ? (
                <CorrespondenceRow key={row.id} agentId={bot?.id ?? ''} transfers={row.transfers} onOpen={setPeer} />
              ) : (
                <MessageItem
                  key={row.message.id}
                  message={row.message}
                  bot={bot}
                  isGroup={Boolean(isGroup)}
                  members={faces}
                  memberNames={isGroup ? faces.map((member) => member.name) : []}
                  notice={row.message.role === 'assistant' && row.message.id === lastSpeakerId}
                  onRetry={onRetry}
                />
              ),
            )
          )}

          {artifacts.length > 0 ? <ArtifactRow artifacts={artifacts} /> : null}

          {(notices ?? []).map((notice, index) => (
            <div className="silent-line notice-line" key={`${notice}-${index}`}>
              <span>{notice}</span>
            </div>
          ))}

          {(interactions ?? []).length > 0
            ? (interactions ?? []).map((request) => (
                <InteractionCard
                  key={request.id}
                  request={request}
                  onAnswer={(answer) => onAnswerInteraction?.(request.id, answer)}
                />
              ))
            : null}

          {busy && !isGroup && liveText ? (
            <div className="msg-row dm-agent streaming-indicator">
              <div className="msg-avatar-col">
                <BotAvatar
                  name={bot?.name || '助手'}
                  color={bot?.color || '#b89b6a'}
                  size={34}
                  agentId={bot?.id}
                  status="thinking"
                />
              </div>
              <div className="msg-content-col assistant-content">
                <div className="msg-sender-header assistant-header" style={{ color: bot?.color || 'var(--fg-muted)' }}>
                  <span>{bot?.name || '助手'}</span>
                </div>
                <div className="msg-bubble-box dm-agent live-bubble" title={actionHint ?? '正在生成…'}>
                  <RichText text={liveText} />
                  <span className="type-caret" />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 底部悬浮直达最新消息按钮 (截图对应) */}
      {awayFromBottom ? (
        <button
          type="button"
          className="floating-scroll-bottom-btn"
          onClick={jumpToBottom}
          title="直达最新消息"
          aria-label="直达最新消息"
        >
          <IconArrowDown size={16} />
        </button>
      ) : null}

      {busy && !isGroup ? (
        <div className="chat-status-line" title={actionHint ?? undefined}>
          <span>{bot?.activity ? `正在 ${bot.activity}` : '正在…'}</span>
        </div>
      ) : null}

      {composer}
      </>}
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
