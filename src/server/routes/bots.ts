import type { IncomingMessage, ServerResponse } from 'node:http';
import { toBotView } from '../presenters.js';
import { json, readJson } from '../transport/json.js';
import { readString, resolveAgent, type RouteContext } from './context.js';

/** /api/bots、/api/agents 集合：GET 列表 / POST 创建。响应了才返回 true */
export async function handleBotsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  method: string,
): Promise<boolean> {
  const { runtime } = context;

  if (method === 'GET') {
    const list = await runtime.registry.list();
    const bots = await Promise.all(
      list.map(async (record) =>
        toBotView(record, {
          busy: runtime.isBusy(record.id),
          conversationCount: await runtime.messages.count(record.id),
        }),
      ),
    );
    json(response, 200, { bots, agents: list });
    return true;
  }

  if (method === 'POST') {
    const body = await readJson(request);
    const record = await runtime.registry.create({
      name: readString(body.name),
      instructions: readString(body.instructions) ?? readString(body.role),
      color: readString(body.color),
    });
    json(response, 201, {
      agent: record,
      bot: toBotView(record, { busy: false, conversationCount: 0 }),
    });
    return true;
  }

  return false;
}

/** /api/bots/:id：GET / PATCH / DELETE。未覆盖的方法返回 false（沿用"继续分发到 API 404"的历史行为） */
export async function handleBotItem(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  raw: string,
  method: string,
): Promise<boolean> {
  const record = await resolveAgent(context, raw);
  if (!record) {
    json(response, 404, { error: `unknown bot: ${raw}` });
    return true;
  }

  if (method === 'GET') {
    json(response, 200, {
      bot: toBotView(record, {
        busy: context.runtime.isBusy(record.id),
        conversationCount: await context.runtime.messages.count(record.id),
      }),
    });
    return true;
  }

  if (method === 'PATCH') {
    const body = await readJson(request);
    const updated = await context.runtime.registry.update(record.id, {
      name: readString(body.name),
      instructions: readString(body.instructions) ?? readString(body.role),
      color: readString(body.color),
    });
    json(response, 200, {
      bot: updated
        ? toBotView(updated, {
            busy: context.runtime.isBusy(updated.id),
            conversationCount: await context.runtime.messages.count(updated.id),
          })
        : null,
    });
    return true;
  }

  if (method === 'DELETE') {
    if (context.runtime.isBusy(record.id)) {
      json(response, 409, { error: '这个智能体正在跑任务，等它结束后再删' });
      return true;
    }
    await context.runtime.messages.clear(record.id);
    await context.runtime.memory.clear('self', record.id);
    await context.runtime.compaction.clear(record.id);
    const ok = await context.runtime.registry.remove(record.id);
    json(response, 200, { ok, removed: record.name });
    return true;
  }

  return false;
}
