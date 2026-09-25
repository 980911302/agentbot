import type { AgentRecord } from '../agent/types.js';
import {
  isProfilePatchEmpty,
  type AgentProfilePatch,
  type AvatarUploadInput,
} from '../shared/contracts/agent-profile.js';
import { AgentProfileError, type AgentProfileService } from '../agent/profile-service.js';
import { ROOM_MEMBER_LIMIT, type Room } from '../room/types.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { RoomStore } from '../room/store.js';
import type { MessageStore } from '../store/messages.js';

/** 工作台操作被拒绝时的错误；工具层会把它转成 "Error: ..." 回给模型 */
export class WorkbenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchError';
  }
}

export interface PostToRoomResult {
  roomName: string;
  /** 仅表示发送成功，不包含收件人执行结果。 */
  roundId: string;
}

export interface WorkbenchDeps {
  registry: AgentRegistry;
  /** 资料唯一写入口（E5.1）：改资料不在这里另写一套合并逻辑 */
  profiles: AgentProfileService;
  rooms: RoomStore;
  messages: MessageStore;
  /** 由运行时注入：只写群消息并入队（排除调用者自己），不等待扇出执行。 */
  postToRoom: (
    roomId: string,
    text: string,
    excludeAgentIds: string[],
    depth?: number,
    signal?: AbortSignal,
    callerId?: string,
  ) => Promise<PostToRoomResult>;
  /** 主人在群里的显示名 */
  /** 由运行时注入：给新建智能体登记 enabled 控制条目，避免重启后被当成旧智能体暂停 */
  enrollAgent?: (agentId: string) => Promise<void>;
}

/**
 * 工作台写操作。
 *
 * 参见 docs/工具参考.md：智能体在对话里替用户改工作台，
 * 而不是「在对话里假装有个新角色」——建完必须真的进 agents.json / rooms，
 * 侧边栏立刻可见，新同事有自己的记忆和对话线。
 *
 * 权限边界（规格第 10 节「不要给智能体的工具」）：
 *   - 没有删除同事 / 解散群的入口
 *   - 改群成员要求调用者自己也在群里
 *   - 读不到别人的私聊与记忆
 */
export class Workbench {
  constructor(private readonly deps: WorkbenchDeps) {}

  // ── 同事 ────────────────────────────────────────────

  async createAgent(input: {
    name: string;
    title?: string;
    description?: string;
    instructions?: string;
    color?: string;
    avatar?: AvatarUploadInput;
    section?: string;
    resourceId?: string;
  }): Promise<AgentRecord> {
    const name = input.name?.trim();
    if (!name) throw new WorkbenchError('新建同事必须给一个名字');

    const existing = await this.deps.registry.findByName(name);
    if (existing && existing.id !== input.resourceId) {
      throw new WorkbenchError(
        `已经有一个叫「${name}」的同事了（id=${existing.id}）。要改资料请用 update_agent，不要重名再建一个。`,
      );
    }

    if (input.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(input.color.trim())) {
      throw new WorkbenchError('color 必须是 #rrggbb 形式的十六进制色值');
    }

    if (input.resourceId) {
      const absent = await this.deps.registry.createIfAbsent(input.resourceId, {
        name,
        title: input.title,
        description: input.description,
        instructions: input.instructions,
        color: input.color?.trim(),
        section: input.section,
      });
      await this.deps.enrollAgent?.(absent.id);
      return this.applyAvatar(absent, input.avatar);
    }

    const created = await this.deps.registry.create({
      name,
      title: input.title,
      description: input.description,
      instructions: input.instructions,
      color: input.color?.trim(),
      section: input.section,
    });
    await this.deps.enrollAgent?.(created.id);
    return this.applyAvatar(created, input.avatar);
  }

  /** 建同事时给的头像也走资料服务（落盘与引用规则只有一份） */
  private async applyAvatar(record: AgentRecord, avatar?: AvatarUploadInput): Promise<AgentRecord> {
    if (!avatar) return record;
    return this.deps.profiles.updateById(record.id, { avatar });
  }

  /**
   * 改同事资料：合并写入，没传的字段保持原值，空字符串不会把资料抹空，
   * null 是显式清空（E5.1）。允许改别人（规格第 1 节），但不允许读别人的私聊与记忆。
   *
   * 工具描述承诺「也可以给一个已存在的名字」，所以这里先按 id 找、找不到再按名字找
   * （CreateAgent 已保证名字唯一，按名字匹配不会歧义）。
   * 另外：一个字段都没给时直接返回，不落盘——registry.update 无论有没有改动都会刷新
   * updatedAt，而列表按 updatedAt 倒序，空调用会静默改动侧栏排序（E5.8）。
   */
  async updateAgent(targetIdOrName: string, patch: AgentProfilePatch): Promise<AgentRecord> {
    const byId = await this.deps.registry.get(targetIdOrName);
    const target = byId ?? (await this.deps.registry.findByName(targetIdOrName.trim()));
    if (!target) throw new WorkbenchError(`找不到 id 或名字为 ${targetIdOrName} 的同事`);

    // 不能枚举字段名判断「要不要改」：avatar/color/hidden/projectIds 等都要算数，
    // 只挑 name/instructions/title 会把合法的头像、配色更新静默吞掉。
    if (isProfilePatchEmpty(patch)) return target;

    try {
      return await this.deps.profiles.updateById(target.id, patch);
    } catch (error) {
      // 工具层只认 WorkbenchError（会转成 "Error: ..." 回给模型）
      if (error instanceof AgentProfileError) throw new WorkbenchError(error.message);
      throw error;
    }
  }

  async listAgents(): Promise<AgentRecord[]> {
    return this.deps.registry.list();
  }

  async listSections(): Promise<string[]> {
    return this.deps.registry.listSections();
  }

  async listRooms(): Promise<Room[]> {
    return this.deps.rooms.list();
  }

  // ── 群 ──────────────────────────────────────────────

  async createRoom(
    callerId: string,
    input: { name: string; memberIds: string[] },
  ): Promise<{
    room: Room;
    callerIncluded: boolean;
  }> {
    const name = input.name?.trim();
    if (!name) throw new WorkbenchError('建群必须给一个群名');

    const memberIds = await this.resolveMemberIds(input.memberIds, { requireAtLeastOne: true });

    const duplicate = (await this.deps.rooms.list()).find(
      (room) => room.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      throw new WorkbenchError(
        `已经有一个叫「${name}」的群了（id=${duplicate.id}）。要改成员请用 UpdateChannel。`,
      );
    }

    const room = await this.deps.rooms.create({ name, memberIds });
    return { room, callerIncluded: memberIds.includes(callerId) };
  }

  /** 加人 / 减人 / 改名；调用者必须已是成员 */
  async updateRoom(
    callerId: string,
    roomId: string,
    patch: { name?: string; memberIds?: string[] },
  ): Promise<Room> {
    const room = await this.deps.rooms.get(roomId);
    if (!room) throw new WorkbenchError(`找不到 id 为 ${roomId} 的群`);

    if (!room.memberIds.includes(callerId)) {
      throw new WorkbenchError('只有自己也在群里才能改成员或改名；先让群里的人把你拉进去');
    }

    if (patch.name !== undefined) await this.deps.rooms.rename(roomId, patch.name);

    if (patch.memberIds !== undefined) {
      const next = await this.resolveMemberIds(patch.memberIds, { requireAtLeastOne: false });
      if (next.length === 0) {
        throw new WorkbenchError('不能把成员删空，至少留 1 个（解散群只有用户能做）');
      }
      await this.deps.rooms.setMembers(roomId, next);
    }

    const updated = await this.deps.rooms.get(roomId);
    if (!updated) throw new WorkbenchError('更新群失败');
    return updated;
  }

  /**
   * 以自己身份往群里发一条并扇出。
   * 与群回合内 SendToUser 的本轮发言不同：这会把全体成员叫醒开新的一轮。
   */
  async postToRoom(
    callerId: string,
    roomId: string,
    text: string,
    depth?: number,
    signal?: AbortSignal,
  ): Promise<PostToRoomResult> {
    const body = text?.trim();
    if (!body) throw new WorkbenchError('要发的内容不能为空');

    const room = await this.deps.rooms.get(roomId);
    if (!room) throw new WorkbenchError(`找不到 id 为 ${roomId} 的群`);
    if (!room.memberIds.includes(callerId)) {
      throw new WorkbenchError('你不在这个群里，不能代群发言；先让成员把你拉进去');
    }

    signal?.throwIfAborted();
    return this.deps.postToRoom(roomId, body, [callerId], depth, signal, callerId);
  }

  // ── 内部 ────────────────────────────────────────────

  private async resolveMemberIds(
    raw: string[] | undefined,
    options: { requireAtLeastOne: boolean },
  ): Promise<string[]> {
    const ids = [...new Set((raw ?? []).map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0 && options.requireAtLeastOne) {
      throw new WorkbenchError('建群时至少要有 1 个成员（把要参加的人 id 放进来）');
    }
    if (ids.length > ROOM_MEMBER_LIMIT) {
      throw new WorkbenchError(`群成员最多 ${ROOM_MEMBER_LIMIT} 个，当前给了 ${ids.length} 个`);
    }

    const all = await this.deps.registry.list();
    const known = new Map(all.map((agent) => [agent.id, agent.name]));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new WorkbenchError(`这些 id 找不到对应同事：${unknown.join(', ')}`);
    }
    return ids;
  }

  /** 给工具层用的成员名查询 */
  async memberNames(ids: string[]): Promise<string[]> {
    const all = await this.deps.registry.list();
    const known = new Map(all.map((agent) => [agent.id, agent.name]));
    return ids.map((id) => known.get(id) ?? id);
  }
}
