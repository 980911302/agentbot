import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Room, RoomMessage, RoomView } from './types.js';
import { ROOM_MEMBER_LIMIT } from './types.js';

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
  private readonly timeline = new Map<string, RoomMessage[]>();
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = join(dataDir, 'rooms');
  }

  private get indexFile(): string {
    return join(this.baseDir, 'index.json');
  }

  private timelineFile(roomId: string): string {
    return join(this.baseDir, `${roomId}.jsonl`);
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

  async remove(roomId: string): Promise<boolean> {
    await this.load();
    const before = this.doc.rooms.length;
    this.doc.rooms = this.doc.rooms.filter((room) => room.id !== roomId);
    if (this.doc.rooms.length === before) return false;
    this.timeline.delete(roomId);
    await this.save();
    await rm(this.timelineFile(roomId), { force: true });
    return true;
  }

  // ── 共享时间线 ──────────────────────────────────────

  async append(message: RoomMessage): Promise<RoomMessage> {
    const list = await this.loadTimeline(message.roomId);
    list.push(message);
    await mkdir(dirname(this.timelineFile(message.roomId)), { recursive: true });
    await writeFile(this.timelineFile(message.roomId), `${JSON.stringify(message)}\n`, {
      flag: 'a',
    });
    return message;
  }

  async messages(roomId: string, limit?: number): Promise<RoomMessage[]> {
    const list = await this.loadTimeline(roomId);
    if (!limit || limit >= list.length) return [...list];
    return list.slice(list.length - limit);
  }

  async count(roomId: string): Promise<number> {
    return (await this.loadTimeline(roomId)).length;
  }

  async clearTimeline(roomId: string): Promise<void> {
    this.timeline.set(roomId, []);
    await rm(this.timelineFile(roomId), { force: true });
  }

  /**
   * 带成员信息的视图。
   * members 由调用方注入（房间只存 id，名字从注册表取）。
   */
  async view(room: Room, memberInfo: Array<{ id: string; name: string; color: string }>): Promise<RoomView> {
    const list = await this.loadTimeline(room.id);
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
    this.loaded = true;
    try {
      const raw = await readFile(this.indexFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RoomDoc>;
      if (Array.isArray(parsed.rooms)) {
        this.doc = {
          rooms: parsed.rooms.map((room) => ({ ...room, memberIds: room.memberIds ?? [] })),
        };
      }
    } catch {
      this.doc = { rooms: [] };
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.indexFile), { recursive: true });
    await writeFile(this.indexFile, JSON.stringify(this.doc, null, 2), 'utf8');
  }

  private async loadTimeline(roomId: string): Promise<RoomMessage[]> {
    const cached = this.timeline.get(roomId);
    if (cached) return cached;

    let raw = '';
    try {
      raw = await readFile(this.timelineFile(roomId), 'utf8');
    } catch {
      this.timeline.set(roomId, []);
      return this.timeline.get(roomId) as RoomMessage[];
    }

    const list: RoomMessage[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        list.push(JSON.parse(trimmed) as RoomMessage);
      } catch {
        // 跳过坏行
      }
    }
    this.timeline.set(roomId, list);
    return list;
  }
}

function cloneRoom(room: Room): Room {
  return { ...room, memberIds: [...room.memberIds] };
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
