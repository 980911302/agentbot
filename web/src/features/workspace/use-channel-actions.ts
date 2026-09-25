import { useCallback, useRef } from 'react';
import * as api from '../../api';
import { formatClock } from '../../format';
import { saveAvatarShape, type AvatarShape } from '../../components/LivingAvatar';
import { errorMessage, uid } from '../chat/message-reducer';
import type { ChannelItem } from '../../components/Sidebar';
import type { BotSummary, DisplayMessage, RoomView } from '../../types';
import {
  channelFromBot,
  channelFromRoom,
  failedAgentChannel,
  mergeBotIntoChannels,
  mergeRoomIntoChannels,
  nextActiveChannelId,
  prependChannel,
  removeChannel,
  renameChannelInList,
  replaceRoom,
  upsertRoomFirst,
} from './channel-actions-view';

export interface ChannelActionDeps {
  /** 右键菜单选中的待删对象（use-dialogs 持有） */
  pendingDelete: ChannelItem | null;
  deleting: boolean;
  setDeleting: (value: boolean) => void;
  closeDelete: () => void;
  /** 正在改名的群（use-dialogs 持有） */
  renamingChannel: ChannelItem | null;
  closeRename: () => void;
  setChannels: React.Dispatch<React.SetStateAction<ChannelItem[]>>;
  setRooms: React.Dispatch<React.SetStateAction<RoomView[]>>;
  setBackendAgents: React.Dispatch<React.SetStateAction<BotSummary[]>>;
  setActiveChannelId: React.Dispatch<React.SetStateAction<string>>;
  setChannelHistories: (
    updater: (prev: Record<string, DisplayMessage[]>) => Record<string, DisplayMessage[]>,
  ) => void;
  syncWorkspace: () => Promise<ChannelItem[]>;
}

/**
 * 频道 CRUD（OPT-04 从 App.tsx 抽出）：建同事、建群、拉人踢人、删除、改名、保存资料。
 *
 * 列表变换都在 channel-actions-view.ts（纯、可单测）；这里只负责调 API 与更新状态。
 * 「先请求后端，成功了才动界面」这条不变：失败时频道还在，错误写进它的时间线。
 */
export function useChannelActions(deps: ChannelActionDeps) {
  const ref = useRef(deps);
  ref.current = deps;

  /** 新建智能体：只有服务端确认建成才进侧栏，避免出现发不出消息的死频道 */
  const createAgent = useCallback(
    async (input: { name: string; role: string; color?: string; shape?: AvatarShape }) => {
      const current = ref.current;
      const created = await api
        .createBot({ name: input.name, role: input.role, color: input.color })
        .catch(() => null);
      if (!created) {
        current.setChannels((list) => [
          failedAgentChannel({ id: `failed-${uid()}`, time: formatClock(Date.now()) }),
          ...list,
        ]);
        return;
      }
      if (input.shape) saveAvatarShape(created.id, input.shape);
      await current.syncWorkspace();
      const channel = channelFromBot(created);
      current.setChannels((list) => prependChannel(list, channel));
      current.setActiveChannelId(created.id);
      current.setChannelHistories((prev) => ({ ...prev, [created.id]: [] }));
    },
    [],
  );

  /** 新建群：建完立刻可进，成员表由服务端校验 */
  const createRoom = useCallback(async (input: { name: string; memberIds: string[] }) => {
    const current = ref.current;
    const room = await api.createRoom(input).catch(() => null);
    if (!room) return;
    current.setRooms((list) => upsertRoomFirst(list, room));
    const channel = channelFromRoom(room);
    current.setChannels((list) => prependChannel(list, channel));
    current.setActiveChannelId(room.id);
    current.setChannelHistories((prev) => ({ ...prev, [room.id]: [] }));
  }, []);

  /** 拉人 / 踢人：改成员表，从下一回合生效 */
  const saveMembers = useCallback(async (roomId: string, memberIds: string[]) => {
    const current = ref.current;
    const room = await api.updateRoomMembers(roomId, memberIds).catch(() => null);
    if (!room) return;
    current.setRooms((list) => replaceRoom(list, room));
    current.setChannels((list) => mergeRoomIntoChannels(list, room));
  }, []);

  /**
   * 右键删除。
   *
   * 群是解散，智能体是删除（连带它的消息与记忆）。
   * 先请求后端，成功了才从界面上摘掉——失败时频道还在，错误直接写进它的时间线。
   */
  const confirmDelete = useCallback(async () => {
    const current = ref.current;
    const target = current.pendingDelete;
    if (!target || current.deleting) return;
    current.setDeleting(true);

    try {
      if (target.kind === 'room') await api.deleteRoom(target.id);
      else await api.deleteBot(target.id);

      current.setChannels((list) => {
        const next = removeChannel(list, target.id);
        current.setActiveChannelId((active) => nextActiveChannelId(active, target.id, next));
        return next;
      });
      current.setChannelHistories((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
      current.closeDelete();
      await current.syncWorkspace();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      current.setChannelHistories((prev) => ({
        ...prev,
        [target.id]: [...(prev[target.id] ?? []), errorMessage(target, `删除失败：${reason}`)],
      }));
      current.closeDelete();
    } finally {
      current.setDeleting(false);
    }
  }, []);

  /**
   * 保存智能体资料（名字 / 标签 / 描述 / 职责 / 配色）。
   * 成功就同步侧边栏与抽屉用的智能体表；失败把原因还给调用方展示。
   */
  const saveBotProfile = useCallback(
    async (
      botId: string,
      input: {
        name?: string;
        section?: string;
        title?: string;
        description?: string;
        instructions?: string;
        color?: string;
        hidden?: boolean;
      },
    ) => {
      const current = ref.current;
      try {
        const updated = await api.updateBot(botId, input);
        current.setBackendAgents((list) =>
          list.map((bot) => (bot.id === updated.id ? { ...bot, ...updated } : bot)),
        );
        current.setChannels((list) => mergeBotIntoChannels(list, updated));
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [],
  );

  /** 群改名：群有独立的 PATCH；智能体改名走资料编辑 */
  const submitRoomRename = useCallback(async (name: string) => {
    const current = ref.current;
    const target = current.renamingChannel;
    if (!target) return '没有正在改名的群';
    try {
      await api.renameRoom(target.id, name);
      current.setChannels((list) => renameChannelInList(list, target.id, name));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, []);

  return { createAgent, createRoom, saveMembers, confirmDelete, saveBotProfile, submitRoomRename };
}