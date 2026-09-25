import type { ChannelItem } from '../../components/Sidebar.js';

/**
 * 侧栏纯展示选择器（UI-03）：分组折叠、状态点、搜索键盘游标。
 * 不碰 React 与 DOM，供 Sidebar 渲染与 node:test 单测共用。
 */

/** 群 / 同事两段的折叠状态（true = 收起） */
export interface SidebarSectionState {
  rooms: boolean;
  agents: boolean;
}

export type SidebarDotKind = 'paused' | 'failed' | 'pending';

export interface SidebarDot {
  kind: SidebarDotKind | null;
  title: string;
}

export interface SidebarSection {
  /** 段 id：与折叠状态、aria-controls 同键 */
  id: 'rooms' | 'agents';
  title: string;
  /** 该段全部可见频道。折叠与否都返回完整列表——段头常驻、计数才准确 */
  channels: ChannelItem[];
  /** 是否折叠。折叠只藏内容，不藏段头；搜索时恒为 false */
  collapsed: boolean;
}

/**
 * 状态点优先级：暂停 > 有消息没处理成功 > 有消息等处理。
 * 「在干活」不画点：只看头像的脸（docs/UI交互与视觉.md「头像即状态」），不再叠脉冲圈和蓝点。
 */
export function channelStatusDot(channel: ChannelItem): SidebarDot {
  if (channel.kind !== 'agent') return { kind: null, title: '' };
  const notes: string[] = [];
  if (channel.paused) notes.push('已暂停，不自动处理新消息');
  if (channel.failedMail) notes.push(`有 ${channel.failedMail} 条消息没处理成功`);
  if (channel.pendingMail) notes.push(`有 ${channel.pendingMail} 条消息等它处理`);
  if (notes.length === 0) return { kind: null, title: '' };
  if (channel.paused) return { kind: 'paused', title: notes.join('；') };
  if (channel.failedMail) return { kind: 'failed', title: notes.join('；') };
  return { kind: 'pending', title: notes.join('；') };
}

/** 按名字过滤（不搜正文），大小写不敏感 */
export function matchesKeyword(channel: ChannelItem, keyword: string): boolean {
  return !keyword || channel.name.toLowerCase().includes(keyword);
}

/**
 * 分「群」「同事」两段。
 *
 * 段头必须常驻：折叠只藏内容，段头是唯一的展开入口，跟着一起藏掉用户就
 * 再也展不开了。所以折叠段也返回段结构，由组件只渲染段头不渲染内容。
 *
 * 搜索时忽略折叠——搜到了就该看见；段一个都不匹配时整段不渲染。
 */
export function sidebarSections(
  channels: ChannelItem[],
  collapsed: SidebarSectionState,
  query: string,
): SidebarSection[] {
  const keyword = query.trim().toLowerCase();
  const searching = keyword.length > 0;
  const rooms = channels.filter(channel => channel.kind === 'room' && matchesKeyword(channel, keyword));
  const agents = channels.filter(channel => channel.kind !== 'room' && matchesKeyword(channel, keyword));
  const sections: SidebarSection[] = [];
  if (rooms.length > 0) {
    sections.push({ id: 'rooms', title: '群', channels: rooms, collapsed: searching ? false : collapsed.rooms });
  }
  if (agents.length > 0) {
    sections.push({ id: 'agents', title: '同事', channels: agents, collapsed: searching ? false : collapsed.agents });
  }
  return sections;
}

/** 搜索结果里的键盘游标：无选中时 -1，上下键越界回绕 */
export function nextSearchCursor(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}

/** 未读数徽标文字：超过 99 显示 99+；0 或无效值不显示 */
export function unreadBadgeText(count: number | undefined): string {
  if (!count || !Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** 侧栏宽度的键盘步进：方向键每次 16px，Shift 加速到 48px；与拖拽同一套吸附规则 */
export function sidebarWidthByKey(width: number, key: string, shift = false): number | null {
  const step = shift ? 48 : 16;
  if (key === 'ArrowLeft') return snapSidebarWidth(width - step);
  if (key === 'ArrowRight') return snapSidebarWidth(width <= 90 ? 200 : width + step);
  if (key === 'Home') return 72;
  if (key === 'End') return 450;
  return null;
}

/** 拖拽 / 键盘共用的吸附：小于 160 收成迷你 72，其余夹在 200–450 */
export function snapSidebarWidth(width: number): number {
  if (width < 160) return 72;
  return Math.min(450, Math.max(200, width));
}
