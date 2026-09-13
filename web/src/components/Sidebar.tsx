import { useCallback, useEffect, useRef, useState } from 'react';
import { IconCompose, IconGrid, IconPlus, IconSearch, IconTrash } from '../icons';
import { BotAvatar } from './BotAvatar';

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
  members?: Array<{ id: string; name: string; color: string }>;
  /** 智能体频道的在场状态（来自后端轮询） */
  status?: 'idle' | 'thinking' | 'working' | 'error';
  /** 群未读数（非当前频道收到新消息） */
  unread?: number;
}

interface SidebarProps {
  channels: ChannelItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenMarket: () => void;
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

const MENU_WIDTH = 196;
const MENU_HEIGHT = 190;

export function Sidebar({
  channels,
  activeId,
  onSelect,
  onNew,
  onOpenMarket,
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
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menu, closeMenu]);

  const onMouseDownResizer = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      onResizingChange?.(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        let newWidth = startWidth + delta;

        // 拉到小于 160px，自动吸附锁定为 70px (Mini 折叠模式)
        if (newWidth < 160) {
          newWidth = 70;
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
    onResize?.(isMini ? 260 : 70);
  }, [isMini, onResize]);

  const keyword = query.trim().toLowerCase();
  const visibleChannels = keyword
    ? channels.filter((item) => item.name.toLowerCase().includes(keyword) || item.lastMessage.toLowerCase().includes(keyword))
    : channels;

  return (
    <aside className={`app-sidebar${isMini ? ' mini' : ''}`} style={{ width }}>
      {/* 1. macOS 系统原生红绿灯占位区域 + Plus Action */}
      <div className="sidebar-window-header">
        <div className="traffic-lights-spacer" />

        <button
          type="button"
          className="sidebar-add-btn"
          aria-label="新建会话或群"
          title="新建会话或群聊"
          onClick={onNew}
        >
          <IconPlus size={18} />
        </button>
      </div>

      {/* 2. Search Bar */}
      <div className="sidebar-search-box">
        <label className="sidebar-search-label">
          <IconSearch size={14} className="search-icon" />
          <input
            type="text"
            className="sidebar-search-input"
            value={query}
            placeholder="搜索"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setQuery('')}
              title="清空搜索"
            >
              ×
            </button>
          ) : null}
        </label>
      </div>

      {/* 3. Channels / Bots / Sessions List */}
      <div className="sidebar-channel-list">
        {visibleChannels.length === 0 ? (
          <div className="sidebar-empty">
            <span className="sidebar-empty-icon">🔍</span>
            <span className="sidebar-empty-title">无匹配会话</span>
            <span className="sidebar-empty-hint">换个关键词试试</span>
          </div>
        ) : (
          visibleChannels.map((channel) => {
            const isActive = channel.id === activeId;
            return (
              <div
                key={channel.id}
                role="button"
                tabIndex={0}
                className={`channel-item${isActive ? ' active' : ''}`}
                onClick={() => onSelect(channel.id)}
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
                    color={channel.color || '#8b5cf6'}
                    size={36}
                  />
                </div>

                <div className="channel-info-wrapper">
                  <div className="channel-title-row">
                    <div className="channel-name-box">
                      <span className="channel-title">{channel.name}</span>
                      {channel.isGroup ? (
                        <span className="channel-tag group">群</span>
                      ) : null}
                    </div>
                    {isActive || channel.unread ? (
                      <span className="channel-blue-dot" />
                    ) : (
                      <span className="channel-time">{channel.time}</span>
                    )}
                  </div>
                  <div className="channel-snippet-row">
                    <span className="channel-snippet">{channel.lastMessage}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 4. Bottom Footer: Marketplace + User Profile */}
      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-footer-btn"
          onClick={onOpenMarket}
          title="模型服务与环境配置"
        >
          <IconGrid size={17} />
          <span>市场</span>
        </button>

        {/* Mini 模式下的居中新建按钮 */}
        <button
          type="button"
          className="sidebar-mini-plus-btn"
          onClick={onNew}
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
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <div className="context-menu-head">
            <BotAvatar name={menu.channel.name} color={menu.channel.color || '#8b5cf6'} size={22} />
            <span className="context-menu-name">{menu.channel.name}</span>
            <span className="context-menu-kind">{menu.channel.isGroup ? '群' : '智能体'}</span>
          </div>
          <div className="menu-divider" />
          {menu.channel.isGroup ? (
            <button
              type="button"
              className="context-menu-row"
              role="menuitem"
              onClick={() => {
                const target = menu.channel;
                closeMenu();
                onRename(target);
              }}
            >
              <IconCompose size={15} />
              <span>重命名</span>
            </button>
          ) : (
            <button
              type="button"
              className="context-menu-row"
              role="menuitem"
              onClick={() => {
                const target = menu.channel;
                closeMenu();
                onEdit(target);
              }}
            >
              <IconCompose size={15} />
              <span>编辑智能体</span>
            </button>
          )}
          <button
            type="button"
            className="context-menu-row danger"
            role="menuitem"
            onClick={() => {
              const target = menu.channel;
              closeMenu();
              onDelete(target);
            }}
          >
            <IconTrash size={15} />
            <span>{menu.channel.isGroup ? '解散群' : '删除智能体'}</span>
          </button>
        </div>
      ) : null}
    </aside>
  );
}

