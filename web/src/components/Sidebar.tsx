import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconCompose, IconPlus, IconSearch, IconTrash, IconUsers } from '../icons';
import { BotAvatar } from './BotAvatar';
import { Menu, MenuItem } from './ui/Menu.js';
import {
  channelStatusDot,
  matchesKeyword,
  nextSearchCursor,
  sidebarWidthByKey,
  snapSidebarWidth,
  unreadBadgeText,
} from '../features/workspace/sidebar-view.js';

export interface ChannelItem {
  id: string;
  name: string;
  time: string;
  /** 最近活动时间，用于把群与智能体混排 */
  updatedAt?: number;
  lastMessage: string;
  color?: string;
  role?: string;
  /** 独立的短头衔；置顶卡只显示这个字段，不展示完整职责。 */
  title?: string;
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
const MENU_HEIGHT = 208;
const PINNED_STORAGE_KEY = 'agentbot.pinnedChannels';

const readPinnedChannels = (): string[] => {
  try {
    const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is string => typeof id === 'string'))]
      : [];
  } catch {
    return [];
  }
};

function insertPinned(current: string[], id: string, index: number): string[] {
  const previousIndex = current.indexOf(id);
  const without = current.filter((item) => item !== id);
  const nextIndex = Math.max(0, Math.min(without.length, index - (previousIndex >= 0 && previousIndex < index ? 1 : 0)));
  without.splice(nextIndex, 0, id);
  return without;
}

function pinnedTitle(value?: string): string | null {
  const title = value?.trim();
  if (!title || [...title].length > 10 || /[\n，。！？；：,.!?;:]/u.test(title)) return null;
  return title;
}

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
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinnedChannels);
  const [draggingChannelId, setDraggingChannelId] = useState<string | null>(null);
  const [draggingSource, setDraggingSource] = useState<'list' | 'pinned' | null>(null);
  const [pinDropActive, setPinDropActive] = useState(false);
  const [pinInsertIndex, setPinInsertIndex] = useState<number | null>(null);
  const [unpinDropActive, setUnpinDropActive] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinDropRef = useRef<HTMLDivElement | null>(null);
  const pinnedSectionRef = useRef<HTMLElement | null>(null);
  const previousPinRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const draggingSourceRef = useRef<'list' | 'pinned' | null>(null);
  /** ⌘K 在迷你模式下先展开，展开完成后再聚焦（见下方 effect） */
  const expandPendingRef = useRef(false);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => () => dragPreviewRef.current?.remove(), []);

  useLayoutEffect(() => {
    const previous = previousPinRectsRef.current;
    previousPinRectsRef.current = new Map();
    if (previous.size === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const section = pinnedSectionRef.current;
    if (!section) return;
    const styles = getComputedStyle(section);
    const duration = Number.parseFloat(styles.getPropertyValue('--dur-base')) || 220;
    const easing = styles.getPropertyValue('--ease').trim() || 'ease';
    for (const card of section.querySelectorAll<HTMLElement>('.pinned-channel-item')) {
      const before = previous.get(card.dataset.channelId ?? '');
      if (!before) continue;
      const after = card.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      card.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration, easing },
      );
    }
  }, [pinnedIds]);

  const capturePinnedPositions = useCallback(() => {
    previousPinRectsRef.current = new Map(
      [...(pinnedSectionRef.current?.querySelectorAll<HTMLElement>('.pinned-channel-item') ?? [])]
        .map((card) => [card.dataset.channelId ?? '', card.getBoundingClientRect()]),
    );
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinnedIds));
    } catch {
      // 置顶偏好只保存在本机；存储不可用时仍可在当前会话里置顶。
    }
  }, [pinnedIds]);

  useEffect(() => {
    if (channels.length === 0) return;
    const availableAgents = new Set(channels.filter((channel) => channel.kind !== 'room').map((channel) => channel.id));
    setPinnedIds((current) => current.filter((id) => availableAgents.has(id)));
  }, [channels]);

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
  const pinnedChannels = useMemo(() => {
    if (keyword || isMini) return [];
    return pinnedIds
      .map((id) => channels.find((channel) => channel.id === id))
      .filter((channel): channel is ChannelItem => Boolean(channel && channel.kind !== 'room'));
  }, [channels, isMini, keyword, pinnedIds]);
  const flat = useMemo(() => channels.filter((channel) =>
    (keyword || isMini || !pinnedIds.includes(channel.id)) && matchesKeyword(channel, keyword.toLowerCase()),
  ), [channels, isMini, keyword, pinnedIds]);
  const visibleCount = flat.length;
  const hasVisibleChannels = visibleCount > 0 || pinnedChannels.length > 0;
  const showInitialPinDrop = !isMini && !keyword && pinnedIds.length === 0;
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
        const newWidth = startWidth + delta;

        // 拉到小于 160px，自动吸附锁定为 72px (Mini 折叠模式)；键盘调宽共用同一套吸附
        onResize?.(snapSidebarWidth(newWidth));
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

  /** 手柄的键盘操作：左右方向键调宽（Shift 加速），Home/End 到两端，Enter 切换迷你 */
  const onKeyDownResizer = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onResize?.(isMini ? 260 : 72);
        return;
      }
      const next = sidebarWidthByKey(width, event.key, event.shiftKey);
      if (next === null) return;
      event.preventDefault();
      onResize?.(next);
    },
    [isMini, onResize, width],
  );

  const togglePinned = useCallback((id: string) => {
    capturePinnedPositions();
    setPinnedIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  }, [capturePinnedPositions]);

  const finishDrag = () => {
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
    draggingIdRef.current = null;
    draggingSourceRef.current = null;
    setDraggingChannelId(null);
    setDraggingSource(null);
    setPinDropActive(false);
    setPinInsertIndex(null);
    setUnpinDropActive(false);
  };

  const pinChannelAt = (id: string | null, index: number) => {
    if (id && channels.some((channel) => channel.id === id && channel.kind !== 'room')) {
      capturePinnedPositions();
      setPinnedIds((current) => insertPinned(current, id, index));
    }
    finishDrag();
  };

  const pinIndexAt = (section: HTMLElement, x: number, y: number): number => {
    const cards = [...section.querySelectorAll<HTMLElement>('.pinned-channel-item')];
    if (cards.length === 0) return 0;
    const inRow = cards.filter((card) => {
      const rect = card.getBoundingClientRect();
      return y >= rect.top - 5 && y <= rect.bottom + 5;
    });
    if (inRow.length === 0) return y < cards[0]!.getBoundingClientRect().top ? 0 : cards.length;
    for (const card of inRow) {
      if (x < card.getBoundingClientRect().left + card.offsetWidth / 2) {
        return cards.indexOf(card);
      }
    }
    return cards.indexOf(inRow[inRow.length - 1]!) + 1;
  };

  const setAvatarDragPreview = (event: React.DragEvent<HTMLDivElement>, name: string) => {
    dragPreviewRef.current?.remove();
    const preview = document.createElement('div');
    preview.className = 'sidebar-drag-preview';
    preview.setAttribute('aria-hidden', 'true');
    const avatar = event.currentTarget.querySelector<HTMLElement>('.bot-avatar')?.cloneNode(true) as HTMLElement | undefined;
    if (avatar) {
      avatar.style.width = '64px';
      avatar.style.height = '64px';
      const svg = avatar.querySelector('svg');
      svg?.setAttribute('width', '64');
      svg?.setAttribute('height', '64');
      svg?.setAttribute('data-frozen', 'true');
      preview.appendChild(avatar);
    }
    const label = document.createElement('span');
    label.textContent = name;
    preview.appendChild(label);
    document.body.appendChild(preview);
    dragPreviewRef.current = preview;
    event.dataTransfer.setDragImage(preview, 40, 32);
  };

  // 高度在动画中从 0 展开；快速拖动时用完整目标高度接住放置。
  const isOverPinDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!draggingIdRef.current || draggingSourceRef.current !== 'list') return false;
    const target = pinDropRef.current;
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const openHeight = Number.parseFloat(getComputedStyle(target).getPropertyValue('--pin-drop-height'));
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.top + openHeight;
  };

  const renderChannel = (channel: ChannelItem, pinned = false, pinIndex = -1) => {
    const index = flat.indexOf(channel);
    const isActive = channel.id === activeId;
    const dot = channelStatusDot(channel);
    const isGroup = channel.isGroup || channel.kind === 'room';
    const unread = unreadBadgeText(channel.unread);
    const shortTitle = pinned ? pinnedTitle(channel.title) : null;
    return (
      <div
        key={channel.id}
        data-channel-id={channel.id}
        role="button"
        tabIndex={0}
        aria-current={isActive ? 'page' : undefined}
        draggable={!isGroup && !isMini}
        className={`channel-item${isActive ? ' active' : ''}${index === effectiveCursor ? ' cursor' : ''}${pinned ? ' pinned-channel-item' : ''}${draggingChannelId === channel.id ? ' dragging' : ''}${pinned && pinInsertIndex === pinIndex ? ' pin-insert-before' : ''}${pinned && pinIndex === pinnedChannels.length - 1 && pinInsertIndex === pinnedChannels.length ? ' pin-insert-after' : ''}`}
        onDragStart={(event) => {
          if (isGroup) return;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', channel.id);
          setAvatarDragPreview(event, channel.name);
          draggingIdRef.current = channel.id;
          draggingSourceRef.current = pinned ? 'pinned' : 'list';
          setDraggingChannelId(channel.id);
          setDraggingSource(pinned ? 'pinned' : 'list');
          setPinDropActive(false);
          setPinInsertIndex(null);
          setUnpinDropActive(false);
        }}
        onDragEnd={finishDrag}
        onMouseMove={() => {
          if (keyword && index >= 0 && index !== effectiveCursor) setCursor(index);
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
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(channel.id);
          } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({ x: bounds.left + 8, y: bounds.bottom, channel });
          }
        }}
      >
        {/* 在干活只看脸（BotAvatar 的表情），不再叠脉冲圈和状态点 */}
        <div className="channel-avatar-wrapper">
          <BotAvatar
            name={channel.name}
            color={channel.color || '#b89b6a'}
            size={pinned ? 64 : isMini ? 44 : isGroup ? 52 : 48}
            className={isGroup ? 'sidebar-group-avatar' : ''}
            status={channel.status}
            agentId={channel.id}
            isGroup={isGroup}
            members={channel.members}
          />
          {dot.kind ? (
            <span className={`channel-status-dot ${dot.kind}`} title={dot.title} aria-label={dot.title} role="img" />
          ) : null}
          {/* 迷你模式下信息列隐藏：未读数挪到头像右上角，和右下角的状态点分开 */}
          {unread && isMini ? (
            <span className="channel-unread corner" aria-label={`${channel.unread} 条未读`} role="img">
              {unread}
            </span>
          ) : null}
        </div>

        <div className="channel-info-wrapper">
          <div className="channel-title-row">
            <div className="channel-name-box">
              <span className="channel-title">{channel.name}</span>
            </div>
            {unread ? (
              <span className="channel-unread" title={`${channel.unread} 条未读`} aria-label={`${channel.unread} 条未读`} role="img">
                {unread}
              </span>
            ) : null}
          </div>
          {shortTitle ? <span className="channel-tag pinned-title">{shortTitle}</span> : null}
          {!pinned ? (
            <div className="channel-snippet-row">
              <span className="channel-snippet">{channel.lastMessage}</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

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
            placeholder="搜索名字…"
            aria-label="按名字搜索智能体或群"
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

      {/* 3. 会话列表：群与智能体按最近活动混排 */}
      <div
        className="sidebar-channel-list"
        ref={listRef}
        onDragOver={(event) => {
          if (!draggingIdRef.current) return;
          const overTarget = isOverPinDrop(event);
          setPinDropActive(overTarget);
          if (overTarget) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={(event) => {
          if (isOverPinDrop(event)) {
            event.preventDefault();
            pinChannelAt(draggingIdRef.current, pinnedIds.length);
          }
        }}
      >
        {showInitialPinDrop ? (
          <div
            ref={pinDropRef}
            className={`sidebar-pin-drop${draggingSource === 'list' ? ' dragging-target' : ''}${pinDropActive ? ' active' : ''}`}
            aria-hidden={draggingSource !== 'list'}
            onDragOver={(event) => {
              if (draggingSourceRef.current !== 'list') return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setPinDropActive(true);
            }}
            onDragLeave={(event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                setPinDropActive(false);
              }
            }}
            onDrop={(event) => {
              event.stopPropagation();
              if (draggingSourceRef.current !== 'list') return;
              event.preventDefault();
              pinChannelAt(draggingIdRef.current, pinnedIds.length);
            }}
          >
            <span className="sidebar-pin-drop-icon">＋</span>
            <span>拖到此处置顶</span>
          </div>
        ) : null}
        {!hasVisibleChannels ? (
          <div className="sidebar-empty">
            <span className="sidebar-empty-icon" aria-hidden="true">
              {keyword ? <IconSearch size={22} /> : <IconUsers size={22} />}
            </span>
            <span className="sidebar-empty-title">{keyword ? '没有叫这个名字的智能体或群' : '暂无智能体'}</span>
            <span className="sidebar-empty-hint">{keyword ? '换个名字试试' : '点击上方 + 开始创建'}</span>
          </div>
        ) : (
          <>
            {pinnedChannels.length > 0 ? (
              <section
                ref={pinnedSectionRef}
                className="sidebar-pinned-section"
                aria-label="置顶智能体"
                onDragOver={(event) => {
                  if (!draggingIdRef.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                  setPinInsertIndex(pinIndexAt(event.currentTarget, event.clientX, event.clientY));
                  setPinDropActive(false);
                  setUnpinDropActive(false);
                }}
                onDragLeave={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (event.clientX < rect.left || event.clientX > rect.right
                    || event.clientY < rect.top || event.clientY > rect.bottom) {
                    setPinInsertIndex(null);
                  }
                }}
                onDrop={(event) => {
                  if (!draggingIdRef.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                  pinChannelAt(draggingIdRef.current, pinIndexAt(event.currentTarget, event.clientX, event.clientY));
                }}
              >
                {pinnedChannels.map((channel, index) => renderChannel(channel, true, index))}
              </section>
            ) : null}
            <div
              className={`sidebar-conversation-list${draggingSource === 'pinned' ? ' can-unpin' : ''}${unpinDropActive ? ' unpin-active' : ''}`}
              onDragOver={(event) => {
                if (draggingSourceRef.current !== 'pinned') return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                setUnpinDropActive(true);
                setPinInsertIndex(null);
              }}
              onDragLeave={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                if (event.clientX < rect.left || event.clientX > rect.right
                  || event.clientY < rect.top || event.clientY > rect.bottom) {
                  setUnpinDropActive(false);
                }
              }}
              onDrop={(event) => {
                if (draggingSourceRef.current !== 'pinned' || !draggingIdRef.current) return;
                event.preventDefault();
                event.stopPropagation();
                const id = draggingIdRef.current;
                capturePinnedPositions();
                setPinnedIds((current) => current.filter((item) => item !== id));
                finishDrag();
              }}
            >
              <div className="sidebar-unpin-hint" aria-hidden={draggingSource !== 'pinned'}>拖到会话列表取消置顶</div>
              {flat.map((channel) => renderChannel(channel))}
            </div>
          </>
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
              : (ownerName.trim().slice(0, 2).toUpperCase() || '我')}
          </div>
          <span className="user-name">{ownerName}</span>
        </button>
      </div>

      {/* 侧边栏拖拽手柄 */}
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        aria-valuemin={72}
        aria-valuemax={300}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        title="拖动或用左右方向键调整侧边栏宽度；向左到底折叠为图标模式，双击或 Enter 快速切换"
        onMouseDown={onMouseDownResizer}
        onDoubleClick={onDoubleClickResizer}
        onKeyDown={onKeyDownResizer}
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
          {menu.channel.kind !== 'room' ? (
            <MenuItem
              onSelect={() => {
                togglePinned(menu.channel.id);
                closeMenu();
              }}
            >
              <span>{pinnedIds.includes(menu.channel.id) ? '取消置顶' : '置顶到常用'}</span>
            </MenuItem>
          ) : null}
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
