import type { ReactNode } from 'react';
import { ChatView } from './ChatView';
import { ChatWelcome } from './ChatWelcome';
import type { ControlNoticeInput } from '../features/chat/control-view';
import type { ChannelItem } from './Sidebar';
import type { ArtifactView, BotSummary, DisplayMessage, InteractionRequest } from '../types';

interface WorkspaceMainProps {
  ownerName: string;
  /** 工作台一个频道都没有：展示欢迎与引导页 */
  empty: boolean;
  onCreateAgent: () => void;
  bot: BotSummary;
  messages: DisplayMessage[];
  artifacts: ArtifactView[];
  busy: boolean;
  liveText: string;
  notices: string[];
  composer: ReactNode;
  interactions: InteractionRequest[];
  onAnswerInteraction: (
    id: string,
    answer: { value?: string; secret?: string; cancelled?: boolean },
  ) => void;
  channelTitle: string;
  isGroup: boolean;
  members: NonNullable<ChannelItem['members']>;
  channelKey: string;
  loading: boolean;
  roundActive: { id: string; name: string; color: string } | null;
  doneFlash: boolean;
  memberLimit: number;
  controlInput: ControlNoticeInput | null;
  onControlChanged: () => void;
  onToggleInfo: () => void;
  onToggleSidebar: () => void;
  onOpenMembers: () => void;
  onOpenProfile?: () => void;
  onRetry: (text: string, clientMessageId?: string) => void;
  onEditMessage: (text: string) => void;
}

/**
 * 主消息区（OPT-04 从 App.tsx 抽出）：没有频道时是引导页，否则是聊天视图。
 * 只负责摆视图，状态与判定都在 App 组合好的 hooks 里。
 */
export function WorkspaceMain({
  ownerName,
  empty,
  onCreateAgent,
  bot,
  messages,
  artifacts,
  busy,
  liveText,
  notices,
  composer,
  interactions,
  onAnswerInteraction,
  channelTitle,
  isGroup,
  members,
  channelKey,
  loading,
  roundActive,
  doneFlash,
  memberLimit,
  controlInput,
  onControlChanged,
  onToggleInfo,
  onToggleSidebar,
  onOpenMembers,
  onOpenProfile,
  onRetry,
  onEditMessage,
}: WorkspaceMainProps) {
  if (empty) {
    return (
      <div className="empty-workbench-view">
        <ChatWelcome ownerName={ownerName} isWorkspaceEmpty={true} onCreateAgent={onCreateAgent} />
      </div>
    );
  }

  return (
    <ChatView
      ownerName={ownerName}
      bot={bot}
      interactions={interactions}
      onAnswerInteraction={onAnswerInteraction}
      channelTitle={channelTitle}
      messages={messages}
      artifacts={artifacts}
      busy={busy}
      liveText={liveText}
      notices={notices}
      composer={composer}
      onToggleInfo={onToggleInfo}
      onToggleSidebar={onToggleSidebar}
      onOpenMembers={onOpenMembers}
      isGroup={isGroup}
      members={members}
      channelKey={channelKey}
      loading={loading}
      roundActive={roundActive}
      doneFlash={doneFlash}
      memberLimit={memberLimit}
      controlInput={controlInput}
      onControlChanged={onControlChanged}
      onOpenProfile={onOpenProfile}
      onRetry={onRetry}
      onEditMessage={onEditMessage}
    />
  );
}