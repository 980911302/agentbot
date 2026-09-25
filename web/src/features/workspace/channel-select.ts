/**
 * 频道选择的纯判定（OPT-04 从 App.tsx 抽出）：
 * 「当前该显示哪个频道」「记忆面板看谁的记忆」「成员面板用哪个房间」。
 */

import type { ChannelItem } from '../../components/Sidebar';
import type { BotSummary, RoomView } from '../../types';

/** 一个频道都没有时的兜底选中项：工作台为空时展示欢迎页，这里是永远读得下去的占位。只读。 */
export const EMPTY_CHANNEL: ChannelItem = {
  id: '',
  name: '暂无智能体',
  time: '',
  lastMessage: '点击左上方 + 创建智能体',
};

/** 当前频道：选中的那个 → 列表第一个 → 占位 */
export function selectActiveChannel(channels: ChannelItem[], activeChannelId: string): ChannelItem {
  return channels.find((item) => item.id === activeChannelId) ?? channels[0] ?? EMPTY_CHANNEL;
}

/** 群 → 用房间成员里的第一个；私聊 → 用智能体 id（记忆面板也用它） */
export function activeAgentIdFor(
  channel: ChannelItem,
  activeChannelId: string,
  agents: BotSummary[],
): string | null {
  if (channel.kind === 'room') return channel.members?.[0]?.id ?? null;
  if (agents.some((agent) => agent.id === activeChannelId)) return activeChannelId;
  return agents[0]?.id ?? null;
}

/** 成员面板用的房间视图：不是群就 null */
export function activeRoomFor(rooms: RoomView[], activeChannelId: string): RoomView | null {
  return rooms.find((room) => room.id === activeChannelId) ?? null;
}