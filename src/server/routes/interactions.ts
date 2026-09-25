import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../transport/index.js';
import { readString, type RouteContext } from './context.js';

/** /api/interactions：GET 正在等回答的卡片（含从持久等待重建的） */
export async function handleInteractionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const agentId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('agentId') ?? undefined;
  json(response, 200, {
    interactions: context.runtime.listInteractions(agentId),
  });
}

/**
 * /api/interactions/:id：POST 用户回答（或明确取消）。
 *
 * E4.3 起答案由运行时收口：带交互 id 的明确答案才能完成对应等待；
 * 过期卡/已作废卡的迟到回答返回 409 + 明确状态，不会被误解成别的等待的答案。
 */
export async function handleInteractionItem(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  id: string,
): Promise<void> {
  const body = await readJson(request);

  if (body.cancelled === true) {
    const result = await context.runtime.cancelInteraction(id);
    json(response, result.ok ? 200 : 404, result.ok ? { ok: true } : { error: '这个交互已经结束或不存在' });
    return;
  }

  const value = readString(body.value);
  const secret = readString(body.secret);
  if (value === undefined && secret === undefined) {
    json(response, 400, { error: '需要 value（选项）或 secret（密钥）' });
    return;
  }

  const result = await context.runtime.answerInteraction(id, { value, secret });
  if (result.ok) {
    json(response, 200, { ok: true, status: result.status, ...(result.runId ? { runId: result.runId } : {}) });
    return;
  }
  if (result.status === 'unknown') {
    json(response, 404, { error: result.message ?? '这个交互已经结束或不存在' });
    return;
  }
  if (result.status === 'pending') {
    json(response, 400, { error: result.message ?? '这次回答不完整' });
    return;
  }
  // resolved / cancelled / expired：迟到的回答，给明确状态
  json(response, 409, { error: result.message ?? '这个交互已经结束', status: result.status });
}