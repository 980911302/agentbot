import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Room } from '../../room/types.js';
import { ROOM_MEMBER_LIMIT } from '../../room/types.js';
import { json, readJson } from '../transport/index.js';
import { messageOf, readString, readStringArray, type RouteContext } from './context.js';

async function roomView(runtime: RouteContext['runtime'], room: Room) {
  const { members } = await runtime.membersOf(room.id);
  return runtime.rooms.view(
    room,
    members.map((record) => ({ id: record.id, name: record.name, color: record.color })),
  );
}

/** /api/rooms 集合：GET 列表 / POST 建群 */
export async function handleRoomsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  method: string,
): Promise<void> {
  const { runtime } = context;

  if (method === 'GET') {
    const list = await runtime.rooms.list();
    const views = await Promise.all(
      list.map(async (room) => {
        const { members } = await runtime.membersOf(room.id);
        return runtime.rooms.view(
          room,
          members.map((record) => ({ id: record.id, name: record.name, color: record.color })),
        );
      }),
    );
    json(response, 200, { rooms: views, memberLimit: ROOM_MEMBER_LIMIT });
    return;
  }

  if (method === 'POST') {
    const body = await readJson(request);
    try {
      const room = await runtime.rooms.create({
        name: readString(body.name) ?? '',
        memberIds: readStringArray(body.memberIds),
      });
      json(response, 201, { room: await roomView(runtime, room) });
    } catch (error) {
      json(response, 400, { error: messageOf(error) });
    }
  }
}

/** /api/rooms/:id 及其 /messages 子路径 */
export async function handleRoomRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  roomId: string,
  rest: string,
): Promise<void> {
  const method = request.method ?? 'GET';
  const { runtime } = context;
  const { room, members } = await runtime.membersOf(roomId);
  if (!room) {
    json(response, 404, { error: 'unknown room' });
    return;
  }
  const memberInfo = members.map((record) => ({
    id: record.id,
    name: record.name,
    color: record.color,
  }));

  if (rest === '/' && method === 'GET') {
    json(response, 200, { room: await runtime.rooms.view(room, memberInfo) });
    return;
  }

  if (rest === '/' && method === 'PATCH') {
    const body = await readJson(request);
    try {
      if (typeof body.name === 'string') await runtime.rooms.rename(roomId, body.name);
      if (Array.isArray(body.memberIds)) {
        await runtime.rooms.setMembers(roomId, readStringArray(body.memberIds));
      }
      const updated = await runtime.rooms.get(roomId);
      json(response, 200, { room: updated ? await roomView(runtime, updated) : null });
    } catch (error) {
      json(response, 400, { error: messageOf(error) });
    }
    return;
  }

  if (rest === '/' && method === 'DELETE') {
    await runtime.rooms.remove(roomId);
    json(response, 200, { ok: true });
    return;
  }

  if (rest === '/messages' && method === 'GET') {
    const limit = Number.parseInt(
      new URL(request.url ?? '/', 'http://x').searchParams.get('limit') ?? '',
      10,
    );
    json(response, 200, {
      messages: await runtime.rooms.messages(roomId, Number.isFinite(limit) ? limit : undefined),
    });
    return;
  }

  // 往群里说一句 → 扇出给全体成员；每个成员各自决定开口还是沉默
  // E3.4 第二步：202 立刻回执，扇出在后台跑，进度走 `GET /api/events` 订阅
  if (rest === '/messages' && method === 'POST') {
    const body = await readJson(request);
    const text = (readString(body.text) ?? readString(body.message) ?? '').trim();
    const model = readString(body.model);
    const clientMessageId = readString(body.clientMessageId);
    if (!text) {
      json(response, 400, { error: 'text is required' });
      return;
    }

    const accepted = await runtime.acceptRoomMessage(roomId, text, {
      model,
      clientMessageId,
      ownerName: readString(body.ownerName) ?? context.ownerName,
    });
    json(response, 202, accepted.receipt);
    void accepted.execute().catch(() => undefined);
    return;
  }

  json(response, 404, { error: `no route for ${method} /api/rooms/:id${rest}` });
}
