import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../transport/index.js';
import { readString, type RouteContext } from './context.js';

/** /api/interactions：GET 正在等回答的卡片 */
export async function handleInteractionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const agentId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('agentId') ?? undefined;
  json(response, 200, {
    interactions: context.runtime.broker.list(agentId ? { agentId } : undefined),
  });
}

/** /api/interactions/:id：POST 用户回答（或明确取消） */
export async function handleInteractionItem(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  id: string,
): Promise<void> {
  const body = await readJson(request);

  if (body.cancelled === true) {
    json(response, 200, { ok: context.runtime.broker.cancel(id) });
    return;
  }

  const value = readString(body.value);
  const secret = readString(body.secret);
  if (value === undefined && secret === undefined) {
    json(response, 400, { error: '需要 value（选项）或 secret（密钥）' });
    return;
  }

  const ok = context.runtime.broker.resolve(id, { value, secret });
  json(response, ok ? 200 : 404, ok ? { ok: true } : { error: '这个交互已经结束或不存在' });
}
