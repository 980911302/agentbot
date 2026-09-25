import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconChevronRight, IconCompose, IconPlus, IconSearch, IconTrash } from '../icons';
import { BotAvatar } from './BotAvatar';
import { Menu, MenuItem } from './ui/Menu.js';
import {
  channelStatusDot,
  nextSearchCursor,
  sidebarSections,
  type SidebarSectionState,
} from '../features/workspace/sidebar-view.js';

export interface ChannelItem {
  id: string;
  name: string;
  time: string;
  lastMessage: string;
  color?: string;
  role?: string;
  isGroup?: boolean;
  /** room = 群（扇出给成员）；agent = 1:1 私聊 */
  kind?: 'room' | 'agent';
  members?: Array<{ id: string; name: string; color: string; status?: string }>;
  /** 智能体频道的在场状态（来自后端轮询） */
  status?: 'idle' | 'thinking' | 'working' | 'error';
  /** 群未读数（非当前频道收到新消息） */
  unread?: number;
  /** 已暂停：不自动处理来信（UI-03 状态点，数据同 [UI-05]） */
  paused?: boolean;
  /** 待处理来信条数（1:1 队列，不含失败） */
  pendingMail?: number;
  /** 失败来信条数 */
  failedMail?: number;
}

interface SidebarProps {
  channels: ChannelItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenProfile: () => void;
  onDelete: (channel: ChannelItem) => void;
  /** 右键编辑智能体资料 / 右键重命名群 */
  onEdit: (channel: ChannelItem) => void;
  onRename: (channel: ChannelItem) => void;
  /** 主人显示名（设置里可改） */
  ownerName?: string;
  width?: number;
  onResize?: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
}

interface MenuState {
  x: number;
  y: number;
  channel: ChannelItem;
}

const MENU_WIDTH = 200;
const MENU_HEIGHT = 168;

const readSectionState = (): SidebarSectionState => {
  try {
    const raw = window.localStorage.getItem('agentbot.sidebarSections');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SidebarSectionState> | null;
      return { rooms: parsed?.rooms === true, agents: parsed?.agents === true };
    }
  } catch {
    // 本地存储不可用或内容损坏：按默认展开，不影响使用
  }
  return { rooms: false, agents: false };
};

export function Sidebar({
  channels,
  activeId,
  onSelect,
  onNew,
  onOpenProfile,
  onDelete,
  onEdit,
  onRename,
  ownerName = '主人',
  width = 260,
  onResize,
  onResizingChange,
}: SidebarProps) {
  const isMini = width <= 90;
  const [query, setQuery] = useState('');
  /** 搜索结果的键盘游标（-1 = 无选中）；⌘K 聚焦后上下键移动、Enter 打开 */
  const [cursor, setCursor] = useState(-1);
  const [collapsed, setCollapsed] = useState<SidebarSectionState>(readSectionState);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** ⌘K 在迷你模式下先展开，展开完成后再聚焦（见下方 effect） */
  const expandPendingRef = useRef(false);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    try {
      window.localStorage.setItem('agentbot.sidebarSections', JSON.stringify(collapsed));
    } catch {
      // 存不下就不存，折叠状态只在本次会话有效
    }
  }, [collapsed]);

  // ⌘K / Ctrl+K 聚焦搜索。迷你模式下输入框是隐藏的，先展开，等宽度变化
  // 提交后（下一个 effect）再聚焦——不用 requestAnimationFrame：窗口被遮挡时
  // rAF 会停摆，快捷键就哑了。
  useEffect(() => {
    const onFocusSearch = () => {
      if (isMini) {
        expandPendingRef.current = true;
        onResize?.(260);
        return;
      }
      searchRef.current?.focus();
    };
    window.addEventListener('agentbot:focus-search', onFocusSearch);
    return () => window.removeEventListener('agentbot:focus-search', onFocusSearch);
  }, [isMini, onResize]);

  useEffect(() => {
    if (isMini || !expandPendingRef.current) return;
    expandPendingRef.current = false;
    searchRef.current?.focus();
  }, [isMini]);

  const keyword = query.trim();
  const sections = useMemo(() => sidebarSections(channels, collapsed, keyword), [channels, collapsed, keyword]);
  const flat = useMemo(() => sections.flatMap(section => section.channels), [sections]);
  const visibleCount = flat.length;
  const effectiveCursor = cursor >= 0 && cursor < visibleCount ? cursor : -1;

  // 换一批结果就回到无选中，避免游标指向看不见的行
  useEffect(() => {
    setCursor(-1);
  }, [keyword]);

  const openChannel = useCallback(
    (channel: ChannelItem) => {
      onSelect(channel.id);
      setQuery('');
      setCursor(-1);
    },
    [onSelect],
  );

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (visibleCount === 0) return;
        event.preventDefault();
        setCursor(current => nextSearchCursor(current < 0 || current >= visibleCount ? -1 : current, visibleCount, event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Enter') {
        const target = effectiveCursor >= 0 ? flat[effectiveCursor] : visibleCount === 1 ? flat[0] : undefined;
        if (target) {
          event.preventDefault();
          openChannel(target);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (query) {
          setQuery('');
          setCursor(-1);
        } else {
          event.currentTarget.blur();
        }
      }
    },
    [effectiveCursor, flat, openChannel, query, visibleCount],
  );

  // 游标行走出可视区时把它带回来
  useEffect(() => {
    if (effectiveCursor < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-cursor="true"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [effectiveCursor]);

  const onMouseDownResizer = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      onResizingChange?.(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        let newWidth = startWidth + delta;

        // 拉到小于 160px，自动吸附锁定为 72px (Mini 折叠模式)
        if (newWidth < 160) {
          newWidth = 72;
        } else {
          newWidth = Math.min(450, Math.max(200, newWidth));
        }

        onResize?.(newWidth);
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        onResizingChange?.(false);
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width, onResize, onResizingChange],
  );

  const onDoubleClickResizer = useCallback(() => {
    onResize?.(isMini ? 260 : 72);
  }, [isMini, onResize]);

  // 搜索时段是强制展开的，此时点段头不写持久态：否则用户以为是展开/收起，
  // 实际写进去的折叠态要等清空搜索才显现（验收打回点：折叠态不可见地写入）
  const toggleSection = useCallback((id: 'rooms' | 'agents') => {
    if (keyword.trim().length > 0) return;
    setCollapsed(current => ({ ...current, [id]: !current[id] }));
  }, [keyword]);

  return (
    <aside className={`app-sidebar${isMini ? ' mini' : ''}`} style={{ width }}>
      {/* 1. 顶栏区域：macOS 原生红绿灯占位（保持左上角干净不显示标题） + Plus Action */}
      <div className="sidebar-window-header">
        <div className="traffic-lights-spacer" />

        <button
          type="button"
          className="sidebar-add-btn"
          aria-label="新建智能体或群"
          title="新建智能体或群聊"
          onClick={onNew}
        >
          <IconPlus size={16} />
        </button>
      </div>

      {/* 2. Search Bar */}
      <div className="sidebar-search-box">
        <label className="sidebar-search-label">
          <IconSearch size={14} className="search-icon" />
          <input
            ref={searchRef}
            type="text"
            className="sidebar-search-input"
            value={query}
            placeholder="搜索会话..."
            aria-label="搜索智能体或群"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {query ? (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => {
                setQuery('');
                setCursor(-1);
                searchRef.current?.focus();
              }}
              title="清空搜索"
            >
              ×
            </button>
          ) : (
            <span className="search-shortcut-hint">⌘K</span>
          )}
        </label>
      </div>

      {/* 3. Channels / Bots / Sessions List：同事与群分两段，各段可折叠 */}
      <div className="sidebar-channel-list" ref={listRef}>
        {visibleCount === 0 ? (
          <div className="sidebar-empty">
            <span className="sidebar-empty-icon">{keyword ? '🔍' : '🤖'}</span>
            <span className="sidebar-empty-title">{keyword ? '没有叫这个名字的智能体或群' : '暂无智能体'}</span>
            <span className="sidebar-empty-hint">{keyword ? '换个名字试试' : '点击上方 + 开始创建'}</span>
          </div>
        ) : (
          sections.map((section) => (
            <section key={section.id} className="sidebar-section">
              <button
                type="button"
                className="sidebar-section-head"
                aria-expanded={!section.collapsed}
                aria-controls={`sidebar-section-${section.id}`}
                onClick={() => toggleSection(section.id)}
              >
                <IconChevronRight
                  size={12}
                  className={`sidebar-section-chevron${section.collapsed ? '' : ' open'}`}
                />
                <span className="sidebar-section-title">{section.title}</span>
                <span className="sidebar-section-count">{section.channels.length}</span>
              </button>
              {/* 折叠只藏内容不藏段头：段头是唯一的展开入口（验收打回点） */}
              {section.collapsed ? null : (
                <div className="sidebar-section-body" id={`sidebar-section-${section.id}`}>
                  {section.channels.map((channel) => {
                  const index = flat.indexOf(channel);
                  const isActive = channel.id === activeId;
                  const dot = channelStatusDot(channel);
                  return (
                    <div
                      key={channel.id}
                      role="button"
                      tabIndex={0}
                      className={`channel-item${isActive ? ' active' : ''}${index === effectiveCursor ? ' cursor' : ''}`}
                      onMouseMove={() => {
                        if (index >= 0 && index !== effectiveCursor) setCursor(index);
                      }}
                      onClick={() => openChannel(channel)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        const maxX = window.innerWidth - MENU_WIDTH - 8;
                        const maxY = window.innerHeight - MENU_HEIGHT - 8;
                        setMenu({
                          x: Math.min(event.clientX, Math.max(8, maxX)),
                          y: Math.min(event.clientY, Math.max(8, maxY)),
                          channel,
                        });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect(channel.id);
                        }
                      }}
                    >
                      <div
                        className={`channel-avatar-wrapper${channel.status === 'working' ? ' working' : ''}`}
                        title={channel.status === 'working' ? '正在干活' : undefined}
                      >
                        <BotAvatar
                          name={channel.name}
                          color={channel.color || '#b89b6a'}
                          size={36}
                          status={channel.status}
                          agentId={channel.id}
                          isGroup={channel.isGroup || channel.kind === 'room'}
                          members={channel.members}
                        />
                        {dot.kind ? (
                          <span className={`channel-status-dot ${dot.kind}`} title={dot.title} aria-label={dot.title} role="img" />
                        ) : null}
                      </div>

                      <div className="channel-info-wrapper">
                        <div className="channel-title-row">
                          <div className="channel-name-box">
                            <span className="channel-title">{channel.name}</span>
                            {channel.isGroup ? (
                              <span className="channel-tag group">群</span>
                            ) : null}
                          </div>
                          <span className="channel-time">{channel.time}</span>
                          {channel.unread ? <span className="channel-unread-dot" title={`${channel.unread} 条未读`} /> : null}
                        </div>
                        <div className="channel-snippet-row">
                          <span className="channel-snippet">{channel.lastMessage}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                </div>
              )}
            </section>
          ))
        )}
      </div>

      {/* 4. Bottom Footer: User Profile & Settings */}
      <div className="sidebar-footer">

        {/* Mini 模式下的居中新建按钮 */}
        <button
          type="button"
          className="sidebar-mini-plus-btn"
          onClick={onNew}
          aria-label="新建智能体或群"
          title="新建会话或智能体"
        >
          <IconPlus size={18} />
        </button>

        <button
          type="button"
          className="sidebar-user-row"
          onClick={onOpenProfile}
          title="用户与模型偏好设置"
        >
          <div className="user-avatar-badge">
            {ownerName.trim().split(/\s+/).length >= 2
              ? (ownerName.trim().split(/\s+/)[0]![0]! + ownerName.trim().split(/\s+/)[1]![0]!).toUpperCase()
              : (ownerName.trim().slice(0, 2).toUpperCase() || 'LZ')}
          </div>
          <span className="user-name">{ownerName}</span>
        </button>
      </div>

      {/* 侧边栏拖拽手柄 */}
      <div
        className="sidebar-resizer"
        title="拖动调整侧边栏宽度，向左拖拽可折叠为图标模式，双击快速切换"
        onMouseDown={onMouseDownResizer}
        onDoubleClick={onDoubleClickResizer}
      />

      {menu ? (
        // 承载层用 fixed 定位到点击处：Menu 的弹层相对自己的 root 定位，
        // 而 root 只是侧栏 flex 列里的一个 0×0 项，不套这一层菜单会跑到侧栏末尾。
        <div className="ui-context-layer" style={{ left: menu.x, top: menu.y }}>
          <Menu
            open
            onOpenChange={(open) => {
              if (!open) closeMenu();
            }}
            trigger={<span />}
          >
          <div className="ui-menu-head">
            <BotAvatar
              name={menu.channel.name}
              color={menu.channel.color || '#b89b6a'}
              size={22}
              agentId={menu.channel.id}
              isGroup={menu.channel.isGroup || menu.channel.kind === 'room'}
              members={menu.channel.members}
            />
            <span className="ui-menu-head-name">{menu.channel.name}</span>
            <span className="ui-menu-head-kind">{menu.channel.isGroup ? '群' : '智能体'}</span>
          </div>
          <div className="ui-menu-sep" />
          {menu.channel.isGroup ? (
            <MenuItem
              onSelect={() => {
                const target = menu.channel;
                closeMenu();
                onRename(target);
              }}
            >
              <IconCompose size={15} />
              <span>重命名</span>
            </MenuItem>
          ) : (
            <MenuItem
              onSelect={() => {
                const target = menu.channel;
                closeMenu();
                onEdit(target);
              }}
            >
              <IconCompose size={15} />
              <span>编辑智能体</span>
            </MenuItem>
          )}
          <MenuItem
            danger
            onSelect={() => {
              const target = menu.channel;
              closeMenu();
              onDelete(target);
            }}
          >
            <IconTrash size={15} />
            <span>{menu.channel.isGroup ? '解散群' : '删除智能体'}</span>
          </MenuItem>
          </Menu>
        </div>
      ) : null}
    </aside>
  );
}

