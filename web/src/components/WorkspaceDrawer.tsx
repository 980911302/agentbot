import { useEffect, useRef, useState } from 'react';
import { BotProfileDrawer } from './BotProfileDrawer';
import { MemberPanel } from './MemberPanel';
import { MemoryPanel } from './MemoryPanel';
import { IconClose } from '../icons';
import type { PanelLayoutKind } from '../features/chat/panel-view';
import type { DrawerTab } from '../features/workspace/dialog-view';
import { drawerTabs, drawerTarget } from '../features/workspace/drawer-view';
import { nextMenuIndex } from '../features/chat/composer-view';
import { WorkPanel } from './WorkPanel';
import type { BotSummary, RoomView } from '../types';

interface WorkspaceDrawerProps {
  /** 抽屉是否挂在 DOM 上（含退出动画） */
  mounted: boolean;
  /** usePresence 的动画状态：enter / enter-active / exit / exit-active */
  presenceState: string;
  drawerTab: DrawerTab;
  onSelectTab: (tab: DrawerTab) => void;
  panelLayout: PanelLayoutKind;
  panelWidth: number;
  onPanelResize: (width: number) => void;
  /** 面板拖拽中：关掉 .app 的网格列宽过渡（E4.7），否则聊天区慢半拍还留瞬时空隙 */
  onPanelResizingChange?: (active: boolean) => void;
  bot: BotSummary;
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
  /** 关闭整个抽屉：页签栏右端唯一的 × */
  onCloseDrawer: () => void;
}

/**
 * 右侧抽屉（OPT-04 从 App.tsx 抽出）：资料 / 记忆 / 工作 / 成员页签与拖拽调宽。
 *
 * - 「屏幕」页已移除（docs/UI交互与视觉.md「不要做：云电脑预览」、§5「不要画空壳电脑窗」）；默认页是「工作」。
 * - 页签是 WAI-ARIA tablist：role=tab + aria-selected，左右方向键切换。
 * - 关闭按钮只有页签栏这一个，各面板自己不再放 ×。
 * - 群里「记忆」「工作」属于某一位成员：页签下方给成员选择器，标题写这位成员的名字。
 */
export function WorkspaceDrawer({
  mounted,
  presenceState,
  drawerTab,
  onSelectTab,
  panelLayout,
  panelWidth,
  onPanelResize,
  onPanelResizingChange,
  bot,
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
}: WorkspaceDrawerProps) {
  /** 群里正在看哪位成员的记忆 / 工作；换群时清掉 */
  const [focusMemberId, setFocusMemberId] = useState<string | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => setFocusMemberId(null), [room?.id]);

  if (!mounted) return null;

  const tabs = drawerTabs(isGroup);
  const members = isGroup ? (room?.members ?? []) : [];
  const target = drawerTarget({ isGroup, members, focusId: focusMemberId, fallbackId: agentId, channelName });
  const showMemberPicker = isGroup && members.length > 1 && (drawerTab === 'memory' || drawerTab === 'work');

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keyMap: Record<string, string> = { ArrowRight: 'ArrowDown', ArrowLeft: 'ArrowUp', Home: 'Home', End: 'End' };
    const mapped = keyMap[event.key];
    if (!mapped) return;
    event.preventDefault();
    const current = tabs.findIndex((tab) => tab.id === drawerTab);
    const next = tabs[nextMenuIndex(current, tabs.length, mapped)];
    if (!next) return;
    onSelectTab(next.id);
    tabListRef.current?.querySelector<HTMLElement>(`#drawer-tab-${next.id}`)?.focus();
  };

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
        <div
          ref={tabListRef}
          className="drawer-tablist"
          role="tablist"
          aria-label="右侧面板"
          onKeyDown={onTabKeyDown}
        >
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              id={`drawer-tab-${tab.id}`}
              role="tab"
              aria-selected={drawerTab === tab.id}
              aria-controls="drawer-tabpanel"
              tabIndex={drawerTab === tab.id ? 0 : -1}
              className={`drawer-tab${drawerTab === tab.id ? ' active' : ''}`}
              data-drawer-tab={tab.id}
              onClick={() => onSelectTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button type="button" className="screen-btn" aria-label="关闭右侧面板" title="关闭右侧面板" onClick={onCloseDrawer}>
          <IconClose size={15} />
        </button>
      </div>

      {showMemberPicker ? (
        <label className="drawer-member-picker">
          <span>查看成员</span>
          <select value={target.id ?? ''} onChange={(event) => setFocusMemberId(event.target.value)}>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div
        className="swap"
        key={drawerTab}
        id="drawer-tabpanel"
        role="tabpanel"
        aria-labelledby={`drawer-tab-${drawerTab}`}
      >
        {drawerTab === 'profile' ? (
          <BotProfileDrawer bot={bot} onClose={onCloseDrawer} onSave={onSaveProfile} />
        ) : drawerTab === 'work' && target.id ? (
          <WorkPanel agentId={target.id} agentName={target.name} />
        ) : drawerTab === 'members' && room ? (
          <MemberPanel room={room} agents={agents} memberLimit={memberLimit} busy={busy} onSave={onSaveMembers} />
        ) : drawerTab === 'memory' && target.id ? (
          <MemoryPanel agentId={target.id} agentName={target.name} refreshToken={memoryToken} />
        ) : (
          <div className="drawer">
            <p className="memory-empty">后端未连接，暂时读不到内容</p>
          </div>
        )}
      </div>
    </div>
  );
}
