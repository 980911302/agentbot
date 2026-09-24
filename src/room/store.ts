import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Room, RoomMessage, RoomView } from './types.js';
import { ROOM_MEMBER_LIMIT } from './types.js';
import { isMissingFile, writeJsonAtomic } from '../storage/atomic-json.js';
import { JsonlLog } from '../storage/jsonl-log.js';

export class RoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomError';
  }
}

interface RoomDoc {
  rooms: Room[];
}

/**
 * 房间表 + 共享时间线。
 * 时间线是「这一轮谁说了什么」，不是记忆库。
 */
export class RoomStore {
  private doc: RoomDoc = { rooms: [] };
  private loaded = false;
  private loading?: Promise<void>;
  private readonly timeline: JsonlLog<RoomMessage>;
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = join(dataDir, 'rooms');
    this.timeline = new JsonlLog(this.baseDir);
  }

  private get indexFile(): string {
    return join(this.baseDir, 'index.json');
  }


  // ── 房间表 ──────────────────────────────────────────

  /**
   * 返回房间快照（深拷贝）。
   *
   * 不能把缓存里的对象直接交出去：调用方拿到后如果保存了引用，
   * 后续 setMembers 改的是同一个对象，它手里的「旧快照」会跟着变，
   * 于是「改之前有多少人」这类对比会得出错误结论。
   */
  async list(): Promise<Room[]> {
    await this.load();
    return [...this.doc.rooms]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(cloneRoom);
  }

  async get(id: string): Promise<Room | undefined> {
    await this.load();
    const room = this.doc.rooms.find((item) => item.id === id);
    return room ? cloneRoom(room) : undefined;
  }

  async create(input: { name: string; memberIds: string[] }): Promise<Room> {
    await this.load();
    const name = input.name.trim();
    if (!name) throw new RoomError('房间名不能为空');
    const memberIds = dedupe(input.memberIds).slice(0, ROOM_MEMBER_LIMIT);
    if (memberIds.length === 0) throw new RoomError('至少要有 1 个成员');

    const now = Date.now();
    const room: Room = {
      id: randomUUID(),
      name,
      memberIds,
      memberJoinedAt: Object.fromEntries(memberIds.map(id => [id, now])),
      createdAt: now,
      updatedAt: now,
    };
    this.doc.rooms.push(room);
    await this.save();
    return room;
  }

  /** 拉人 / 踢人：改成员表，从下一回合生效（文档第 1、7 节） */
  async setMembers(roomId: string, memberIds: string[]): Promise<Room> {
    await this.load();
    const room = this.doc.rooms.find((item) => item.id === roomId);
    if (!room) throw new RoomError('房间不存在');

    const next = dedupe(memberIds);
    if (next.length === 0) throw new RoomError('不能把成员删空，至少留 1 个');
    if (next.length > ROOM_MEMBER_LIMIT) {
      throw new RoomError(`成员最多 ${ROOM_MEMBER_LIMIT} 个，当前 ${next.length} 个`);
    }

    const old = new Set(room.memberIds);
    room.memberJoinedAt = Object.fromEntries(next.map(id => [id, old.has(id) ? room.memberJoinedAt?.[id] ?? room.createdAt : Date.now()]));
    room.memberIds = next;
    room.updatedAt = Date.now();
    await this.save();
    return room;
  }

  async rename(roomId: string, name: string): Promise<Room> {
    await this.load();
    const room = this.doc.rooms.find((item) => item.id === roomId);
    if (!room) throw new RoomError('房间不存在');
    const trimmed = name.trim();
    if (!trimmed) throw new RoomError('房间名不能为空');
    room.name = trimmed;
    room.updatedAt = Date.now();
    await this.save();
    return room;
  }

  async setMode(roomId: string, mode: import('../shared/contracts/room-flow.js').RoomMode, activeFlowId?: string): Promise<Room> {
    await this.load();
    const room = this.doc.rooms.find((item) => item.id === roomId);
    if (!room) throw new RoomError('房间不存在');
    room.mode = mode;
    room.activeFlowId = activeFlowId;
    room.updatedAt = Date.now();
    await this.save();
    return cloneRoom(room);
  }

  async remove(roomId: string): Promise<boolean> {
    await this.load();
    const before = this.doc.rooms.length;
    this.doc.rooms = this.doc.rooms.filter((room) => room.id !== roomId);
    if (this.doc.rooms.length === before) return false;
    await this.save();
    await this.timeline.clear(roomId);
    return true;
  }

  // ── 共享时间线 ──────────────────────────────────────

  async append(message: RoomMessage): Promise<RoomMessage> {
    await this.timeline.append(message.roomId, message);
    return message;
  }

  async appendIfAbsent(message: RoomMessage): Promise<RoomMessage> {
    const existing = (await this.timeline.list(message.roomId)).find((item) => item.id === message.id);
    if (existing) {
      if (existing.text !== message.text || existing.senderId !== message.senderId) {
        throw new Error('TIMELINE_ID_CONFLICT');
      }
      return existing;
    }
    return this.append(message);
  }

  async messages(roomId: string, limit?: number): Promise<RoomMessage[]> {
    const list = await this.timeline.list(roomId);
    if (!limit || limit >= list.length) return [...list];
    return list.slice(list.length - limit);
  }

  async count(roomId: string): Promise<number> {
    return (await this.timeline.list(roomId)).length;
  }

  async clearTimeline(roomId: string): Promise<void> {
    await this.timeline.clear(roomId);
  }

  /**
   * 带成员信息的视图。
   * members 由调用方注入（房间只存 id，名字从注册表取）。
   */
  async view(room: Room, memberInfo: Array<{ id: string; name: string; color: string }>): Promise<RoomView> {
    const list = await this.timeline.list(room.id);
    const last = list[list.length - 1];
    return {
      ...room,
      members: memberInfo,
      messageCount: list.length,
      lastMessage: last
        ? { text: last.text, senderName: last.senderName, createdAt: last.createdAt }
        : undefined,
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await readFile(this.indexFile, 'utf8');
          const parsed = JSON.parse(raw) as Partial<RoomDoc>;
          if (Array.isArray(parsed.rooms)) {
            this.doc = {
              rooms: parsed.rooms.map((room) => ({ ...room, memberIds: room.memberIds ?? [] })),
            };
          }
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          this.doc = { rooms: [] };
        }
        this.loaded = true;
      })();
    }
    try {
      await this.loading;
    } finally {
      if (this.loaded) this.loading = undefined;
    }
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.indexFile, this.doc);
  }

}

function cloneRoom(room: Room): Room {
  return { ...room, memberIds: [...room.memberIds], ...(room.memberJoinedAt ? { memberJoinedAt: { ...room.memberJoinedAt } } : {}) };
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
