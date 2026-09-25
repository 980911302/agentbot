import { useEffect, useRef, useState } from 'react';
import type { ReactNode, WheelEvent as ReactWheelEvent } from 'react';
import type { ArtifactView, BotSummary, DisplayMessage, InteractionRequest, RoomFlowView } from '../types';
import { fetchRoomFlow, controlRoomFlow } from '../api';
import { RichText } from '../markdown';
import { BotAvatar } from './BotAvatar';
import { IconArrowDown, IconCheck, IconShare, IconSidebar } from '../icons';
import { MessageItem } from './MessageItem';
import { ControlNotice } from './ControlNotice';
import { InteractionCard } from './InteractionCard';
import { CorrespondenceRow, CorrespondencePanel } from './CorrespondenceView';
import { chatRows } from '../features/chat/correspondence';
import { jumpToBottomVisible, timelineBlocks } from '../features/chat/timeline-view';
import { controlStatusText as controlStatusTextOf, type ControlNoticeInput } from '../features/chat/control-view';
import { headerMemberStack, memberPauseTag, roomFlowPhaseLabel } from '../features/chat/group-view';
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
  /** 群顶栏成员叠放点击：打开成员面板（规范 5.6） */
  onOpenMembers?: () => void;
  /** 顶栏菜单按钮：单栏档开合侧栏抽屉（UI-09） */
  onToggleSidebar?: () => void;
  /** 错误消息的重试（重新发送原话） */
  onRetry?: (text: string, clientMessageId?: string) => void;
  /** 用户消息「重新编辑」：只把原文填回输入框，不改发送逻辑 */
  onEditMessage?: (text: string) => void;  /** 频道内的轻状态行（任务挂起等系统提示） */
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
  /** 频道历史正在加载：显示骨架而不是空白（bug_d2xiqthtxdmm） */
  loading?: boolean;
  /** 正在等用户回答的卡片 */
  interactions?: InteractionRequest[];
  onAnswerInteraction?: (
    id: string,
    answer: { value?: string; secret?: string; cancelled?: boolean },
  ) => void;
  /** 控制状态（UI-05）：传入后自动渲染时间线底部状态条与顶栏状态文字；
   *  群没有单智能体许可态，App 传 null 即可。 */
  controlInput?: ControlNoticeInput | null;
  /** 控制操作（恢复/重试）成功后让父组件刷新数据 */
  onControlChanged?: () => void;
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
  onOpenMembers,
  onToggleSidebar,
  onRetry,
  onEditMessage,
  notices,
  roundActive,
  doneFlash,
  isGroup,
  members = [],
  memberLimit = 6,
  channelKey,
  loading = false,
  interactions,
  onAnswerInteraction,
  controlInput,
  onControlChanged,
}: ChatViewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** 是否跟随新消息 */
  const stickToBottom = useRef(true);
  /** 脱离跟随期间新到了多少条，用于「回到底部」角标 */
  const [pendingCount, setPendingCount] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const lastSeenCount = useRef(messages.length);
  const title = channelTitle || bot?.name || '对话';
  /** 顶栏控制状态文字（UI-05）：与底部状态条同一判定，不各说各话 */
  const controlStatusText = controlInput ? controlStatusTextOf(controlInput) : null;
  /** 顶栏头像状态：停止期间与暂停都要在脸上看出来，盖过运行态 */
  const avatarStatus = controlInput
    ? (controlInput.autoActivation === 'paused' || controlInput.stopInFlight ? 'paused' : bot?.status)
    : bot?.status;
  const lastSpeakerId = [...messages].reverse().find((item) => item.role === 'assistant')?.id;
  const faces = members.map((member) => ({
    ...member,
    status: roundActive?.id === member.id ? 'working' : member.status,
  }));
  /** 群顶栏成员叠放（规范 5.6：最多 4 个 + 数量） */
  const memberStack = headerMemberStack(faces);
  const [peer, setPeer] = useState<MessageActor | null>(null);
  useEffect(() => setPeer(null), [channelKey]);

  const [roomFlow, setRoomFlow] = useState<RoomFlowView | null>(null);
  /** 受控流程条文案与 warn 语义（规范 5.14） */
  const flowPhase = roomFlow
    ? roomFlowPhaseLabel({
        status: roomFlow.status,
        phase: roomFlow.phase,
        actors: roomFlow.currentActors.map((actor) => ({
          kind: actor.kind,
          id: actor.id,
          name: members.find((m) => m.id === actor.id)?.name ?? actor.id,
        })),
      })
    : null;
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

  /** 是否该显示「回到最新」：规范 4.3 —— 离底部 >200px 才算离开 */
  const shouldShowJump = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    return jumpToBottomVisible({
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
    });
  };

  /** 只有用户明确向上滚（滚轮向上 / 触摸下滑）才脱离跟随 */
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < -2) stickToBottom.current = false;
    else if (shouldShowJump() === false) stickToBottom.current = true;
  };

  /** 滚回底部附近就重新跟随 */
  const onScroll = () => {
    const away = shouldShowJump();
    if (!away) stickToBottom.current = true;
    setAwayFromBottom(away);
    if (!away) setPendingCount(0);
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
          <button
            type="button"
            className="chat-header-icon-btn sidebar-toggle"
            aria-label="打开侧边栏"
            title="打开侧边栏"
            onClick={onToggleSidebar}
          >
            <IconSidebar size={17} />
          </button>
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
              status={isGroup ? undefined : avatarStatus}
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
            tabIndex={onOpenProfile ? 0 : undefined}
            aria-label={onOpenProfile ? `打开${title}的资料` : undefined}
            onKeyDown={onOpenProfile ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpenProfile();
              }
            } : undefined}
            title={onOpenProfile ? '编辑智能体资料' : undefined}
          >
            <div className="chat-header-title-row">
              <h2 className="chat-header-title">{title}</h2>
              {isGroup ? <span className="chat-header-group-badge">{faces.length}/{memberLimit}</span> : null}
              {controlStatusText ? (
                <span className={`chat-header-control-status ${controlStatusText.kind}`}>{controlStatusText.text}</span>
              ) : null}
            </div>
            {isGroup && faces.length > 0 ? (
              <span className="chat-header-subtitle">群聊</span>
            ) : null}
          </div>

          {isGroup && faces.length > 0 ? (
            <button
              type="button"
              className="chat-header-member-stack"
              onClick={onOpenMembers}
              title="查看成员详情"
              aria-label={`群成员 ${faces.length} 人，查看成员面板`}
            >
              {memberStack.visible.map((m) => (
                <span key={m.id} className="header-member-avatar" title={memberPauseTag(m) ? `${m.name}（${memberPauseTag(m)}）` : m.name}>
                  <BotAvatar name={m.name} color={m.color} size={22} agentId={m.id} status={m.status} />
                </span>
              ))}
              {memberStack.more > 0 ? (
                <span className="header-member-more">+{memberStack.more}</span>
              ) : null}
            </button>
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

      {isGroup && roomFlow && flowPhase && roomFlow.status !== 'completed' && roomFlow.status !== 'cancelled' ? (
        <div className={`room-flow-bar${flowPhase.warn ? ' warn' : ''}`}>
          <div className="room-flow-info">
            <span className="room-flow-badge">{roomFlow.protocol}</span>
            <span className={`room-flow-status status-${roomFlow.status}`}>{flowPhase.text}</span>
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
      {/* 离开底部时显示一枚居中的回到底部提示；跳转与关闭使用独立按钮。 */}
      {awayFromBottom ? (
        <div className="floating-unread-pill">
          <button
            type="button"
            className="floating-unread-jump"
            onClick={jumpToBottom}
            title="点击回到最新消息"
          >
            <IconArrowDown size={14} />
            <span>{pendingCount > 0 ? `${pendingCount} 条新消息` : '回到最新消息'}</span>
          </button>
          <button
            type="button"
            className="floating-unread-close"
            onClick={() => setAwayFromBottom(false)}
            title="关闭提示"
            aria-label="关闭回到最新消息提示"
          >
            ×
          </button>
        </div>
      ) : null}

      <div
        className="chat-scroll-viewport"
        ref={scrollerRef}
        onScroll={onScroll}
        onWheel={onWheel}
      >
        {/* aria-live：新消息到达时朗读给屏幕阅读器（UI-10）。
            polite 不打断当前朗读；role=log 表明这是追加型内容。 */}
        <div className="chat-message-list swap" key={channelKey} role="log" aria-live="polite" aria-relevant="additions">
          {loading ? (
            <div className="chat-loading" aria-busy="true" aria-live="polite">
              {[0, 1, 2].map((row) => (
                <div className={`chat-loading-row${row % 2 === 1 ? ' mine' : ''}`} key={row}>
                  <div className="skeleton chat-loading-avatar" />
                  <div className="chat-loading-lines">
                    <div className="skeleton skeleton-line" style={{ width: '32%' }} />
                    <div className="skeleton skeleton-line" style={{ width: row === 1 ? '58%' : '76%' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : messages.length === 0 ? (
            <ChatWelcome
              ownerName={ownerName}
              bot={bot}
              isGroup={isGroup}
              members={faces}
              isWorkspaceEmpty={false}
            />
          ) : (
            timelineBlocks(chatRows(messages), { isGroup: Boolean(isGroup) }).map((block) => {
              if (block.kind === 'divider') {
                return (
                  <div className="date-divider" key={block.key}>
                    <span>{block.label}</span>
                  </div>
                );
              }
              if (block.kind === 'correspondence') {
                return (
                  <CorrespondenceRow
                    key={block.key}
                    agentId={bot?.id ?? ''}
                    transfers={block.transfers}
                    onOpen={setPeer}
                  />
                );
              }
              return block.messages.map((message, index) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  bot={bot}
                  isGroup={Boolean(isGroup)}
                  members={faces}
                  memberNames={isGroup ? faces.map((member) => member.name) : []}
                  notice={message.role === 'assistant' && message.id === lastSpeakerId}
                  onRetry={onRetry}
                  onEdit={onEditMessage}
                  compact={index > 0}
                />
              ));
            })
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
                <div className="msg-sender-header assistant-header" style={{ color: bot?.color || 'var(--text-secondary)' }}>
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

      {busy && !isGroup && !liveText ? (
        <div className="chat-status-line" role="status" aria-live="polite" title={actionHint ?? undefined}>
          <BotAvatar name={bot?.name || '助手'} color={bot?.color || '#b89b6a'} size={28} agentId={bot?.id} status="thinking" />
          <span className="chat-status-copy">
            <span className="chat-status-name">{bot?.name || '助手'}</span>
            <span className="chat-status-message">
              {bot?.activity ? `正在${bot.activity}` : '正在组织回复'}
              <span className="chat-status-dots" aria-hidden="true"><i /><i /><i /></span>
            </span>
          </span>
        </div>
      ) : null}

      {controlInput ? (
        <ControlNotice
          agentId={isGroup ? null : (bot?.id ?? null)}
          input={controlInput}
          onChanged={onControlChanged}
        />
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
