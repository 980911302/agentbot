/**
 * 频道/房间增删改的纯数据变换（OPT-04 从 App.tsx 抽出）。
 *
 * 这些函数只做「列表 → 新列表」的变换与频道条目构造，接口调用与 React 状态留在
 * use-channel-actions.ts。分开是为了让「删完选谁」「改名改到哪一项」这类
 * 容易出错但只靠手点很难覆盖的判定能被 node:test 直接盯住。
 */

import { formatRelativeTime } from '../../format';
import type { BotSummary, RoomView } from '../../types';
import type { ChannelItem } from '../../components/Sidebar';

/** 建同事失败时插进侧栏的占位条目（id / 时间由调用方给，保持函数纯粹） */
export function failedAgentChannel(input: { id: string; time: string }): ChannelItem {
  return {
    id: input.id,
    name: '创建失败',
    time: input.time,
    lastMessage: '后端未连接，智能体没有创建成功',
    color: '#e24b4b',
  };
}

/** 服务端确认建成的智能体 → 侧栏条目 */
export function channelFromBot(bot: { id: string; name: string; role?: string; title?: string; color?: string }): ChannelItem {
  return {
    id: bot.id,
    name: bot.name,
    time: '刚刚',
    lastMessage: bot.role || '准备就绪',
    color: bot.color,
    role: bot.title || bot.role,
    title: bot.title,
    kind: 'agent',
  };
}

/** 服务端确认建成的群 → 侧栏条目（进不去时成员空表，颜色与角色都给兜底） */
export function channelFromRoom(room: RoomView): ChannelItem {
  return {
    id: room.id,
    name: room.name,
    time: formatRelativeTime(room.updatedAt),
    lastMessage: '还没有人说话',
    color: room.members[0]?.color ?? '#b89b6a',
    role: `${room.members.length} 位成员`,
    isGroup: true,
    kind: 'room',
    members: room.members,
  };
}

/** 新建的频道插到最前；已在列表里就原样返回（建完 syncWorkspace 可能已经带回来了） */
export function prependChannel(list: ChannelItem[], channel: ChannelItem): ChannelItem[] {
  return list.some((item) => item.id === channel.id) ? list : [channel, ...list];
}

export function removeChannel(list: ChannelItem[], id: string): ChannelItem[] {
  return list.filter((item) => item.id !== id);
}

/** 删掉当前频道后选谁：剩下的第一个；一个不剩就空选中 */
export function nextActiveChannelId(activeId: string, removedId: string, remaining: ChannelItem[]): string {
  if (activeId !== removedId) return activeId;
  return remaining[0]?.id ?? '';
}

/** 建群：房间插到最前并去掉同 id 的旧项 */
export function upsertRoomFirst(rooms: RoomView[], room: RoomView): RoomView[] {
  return [room, ...rooms.filter((item) => item.id !== room.id)];
}

/** 拉人/踢人回来：用服务端返回的房间替换旧的 */
export function replaceRoom(rooms: RoomView[], room: RoomView): RoomView[] {
  return rooms.map((item) => (item.id === room.id ? room : item));
}

/** 成员表变化后同步侧栏条目的人数、成员与最后一句 */
export function mergeRoomIntoChannels(channels: ChannelItem[], room: RoomView): ChannelItem[] {
  return channels.map((item) =>
    item.id === room.id
      ? {
          ...item,
          role: `${room.members.length} 位成员`,
          members: room.members,
          lastMessage: room.lastMessage?.text ?? item.lastMessage,
        }
      : item,
  );
}

/** 资料保存回来：名字 / 配色 / 职责同步到侧栏（未给的字段保持原值） */
export function mergeBotIntoChannels(channels: ChannelItem[], updated: BotSummary): ChannelItem[] {
  return channels.map((item) =>
    item.id === updated.id
      ? {
          ...item,
          name: updated.name ?? item.name,
          color: updated.color ?? item.color,
          role: updated.title || updated.role || item.role,
          title: updated.title,
        }
      : item,
  );
}

/** 群改名：只动那一项的名字（智能体改名走资料编辑） */
export function renameChannelInList(channels: ChannelItem[], id: string, name: string): ChannelItem[] {
  return channels.map((item) => (item.id === id ? { ...item, name } : item));
}
