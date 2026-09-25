import { BotScreen } from './BotScreen';
import { BotProfileDrawer } from './BotProfileDrawer';
import { MemberPanel } from './MemberPanel';
import { MemoryPanel } from './MemoryPanel';
import { IconClose } from '../icons';
import type { PanelLayoutKind } from '../features/chat/panel-view';
import type { DrawerTab } from '../features/workspace/dialog-view';
import { WorkPanel } from './WorkPanel';
import type { ArtifactView, BotSummary, DisplayMessage, RoomView } from '../types';

interface WorkspaceDrawerProps {
  /** 抽屉是否挂在 DOM 上（含退出动画） */
  mounted: boolean;
  /** usePresence 的动画状态：enter / enter-active / exit / exit-active */
  presenceState: string;
  screenFull: boolean;
  drawerTab: DrawerTab;
  onSelectTab: (tab: DrawerTab) => void;
  panelLayout: PanelLayoutKind;
  panelWidth: number;
  onPanelResize: (width: number) => void;
  /** 面板拖拽中：关掉 .app 的网格列宽过渡（E4.7），否则聊天区慢半拍还留瞬时空隙 */
  onPanelResizingChange?: (active: boolean) => void;
  bot: BotSummary;
  messages: DisplayMessage[];
  artifacts: ArtifactView[];
  isGroup: boolean;
  room: RoomView | null;
  agents: BotSummary[];
  memberLimit: number;
  busy: boolean;
  agentId: string | null;
  channelName: string;
  memoryToken: number;
  onSaveMembers: (memberIds: string[]) => void;
  /** 保存资料：签名直接取 BotProfileDrawer 的 onSave（botId + 字段） */
  onSaveProfile: React.ComponentProps<typeof BotProfileDrawer>['onSave'];
  /** 关闭整个抽屉（含退出全屏）：全屏关闭与 tabs 的 × */
  onCloseDrawer: () => void;
  /** 只关抽屉、不动全屏：抽屉内各面板的关闭 */
  onClosePanel: () => void;
  onEnterFullscreen: () => void;
  onExitFullscreen: () => void;
}

/**
 * 右侧抽屉（OPT-04 从 App.tsx 抽出）：屏幕 / 记忆 / 成员 / 资料四个页签与拖拽调宽。
 * 结构、类名、点击语义与抽出前逐行一致——这是纯搬家，不是重做。
 */
export function WorkspaceDrawer({
  mounted,
  presenceState,
  screenFull,
  drawerTab,
  onSelectTab,
  panelLayout,
  panelWidth,
  onPanelResize,
  onPanelResizingChange,
  bot,
  messages,
  artifacts,
  isGroup,
  room,
  agents,
  memberLimit,
  busy,
  agentId,
  channelName,
  memoryToken,
  onSaveMembers,
  onSaveProfile,
  onCloseDrawer,
  onClosePanel,
  onEnterFullscreen,
  onExitFullscreen,
}: WorkspaceDrawerProps) {
  if (!mounted) return null;

  if (screenFull && drawerTab === 'screen') {
    return (
      <BotScreen
        bot={bot}
        messages={messages}
        artifacts={artifacts}
        fullscreen
        onToggleFullscreen={onExitFullscreen}
        onClose={onCloseDrawer}
      />
    );
  }

  /**
   * 工作面板标题里的同事名（E4.7）：群里 activeAgentId 取的是第一个成员，
   * 标题就必须写这位成员的名字——写群名会让人以为整群共用一件工作。
   */
  const agentName = room?.members.find((member) => member.id === agentId)?.name ?? channelName;

  return (
    <div
      className={`drawer ${presenceState}`}
      style={{ width: panelLayout === 'dock' ? panelWidth : undefined }}
    >
      {panelLayout === 'dock' ? (
        <div
          className="drawer-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整面板宽度"
          title="拖动调整面板宽度（320–480）"
          onMouseDown={(event) => {
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = panelWidth;
            const onMove = (move: MouseEvent) =>
              onPanelResize(startWidth + (startX - move.clientX));
            const onUp = () => {
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
              onPanelResizingChange?.(false);
            };
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            onPanelResizingChange?.(true);
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
        />
      ) : null}
      <div className="drawer-tabs">
        {!isGroup ? (
          <button
            type="button"
            className={`drawer-tab${drawerTab === 'profile' ? ' active' : ''}`}
            onClick={() => onSelectTab('profile')}
          >
            资料
          </button>
        ) : null}
        <button
          type="button"
          className={`drawer-tab${drawerTab === 'screen' ? ' active' : ''}`}
          onClick={() => onSelectTab('screen')}
        >
          屏幕
        </button>
        <button
          type="button"
          className={`drawer-tab${drawerTab === 'memory' ? ' active' : ''}`}
          onClick={() => onSelectTab('memory')}
        >
          记忆
        </button>
        {/* 工作（E4.7）：这位同事手头的工作，只读，状态来自 GET /api/agents/:id/work */}
        <button
          type="button"
          className={`drawer-tab${drawerTab === 'work' ? ' active' : ''}`}
          data-drawer-tab="work"
          onClick={() => onSelectTab('work')}
        >
          工作
        </button>
        {isGroup ? (
          <button
            type="button"
            className={`drawer-tab${drawerTab === 'members' ? ' active' : ''}`}
            onClick={() => onSelectTab('members')}
          >
            成员
          </button>
        ) : null}
        <button type="button" className="screen-btn" aria-label="关闭" onClick={onCloseDrawer}>
          <IconClose size={15} />
        </button>
      </div>

      <div className="swap" key={drawerTab}>
        {drawerTab === 'profile' ? (
          <BotProfileDrawer bot={bot} onClose={onCloseDrawer} onSave={onSaveProfile} />
        ) : drawerTab === 'screen' ? (
          <BotScreen
            bot={bot}
            messages={messages}
            artifacts={artifacts}
            fullscreen={false}
            onToggleFullscreen={onEnterFullscreen}
            onClose={onClosePanel}
          />
        ) : drawerTab === 'work' && agentId ? (
          <WorkPanel agentId={agentId} agentName={agentName} />
        ) : drawerTab === 'members' && room ? (
          <MemberPanel
            room={room}
            agents={agents}
            memberLimit={memberLimit}
            busy={busy}
            onSave={onSaveMembers}
            onClose={onClosePanel}
          />
        ) : agentId ? (
          <MemoryPanel
            agentId={agentId}
            agentName={channelName}
            refreshToken={memoryToken}
            onClose={onClosePanel}
          />
        ) : (
          <div className="drawer">
            <p className="memory-empty">后端未连接，暂时读不到记忆</p>
          </div>
        )}
      </div>
    </div>
  );
}