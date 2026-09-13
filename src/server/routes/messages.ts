import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectArtifacts, toDisplayMessages } from '../presenters.js';
import { parseSendMessageInput } from '../../shared/contracts/index.js';
import { json, readJson } from '../transport/index.js';
import { readString, resolveAgent, type RouteContext } from './context.js';

/** /api/sessions：GET 列表（当前只有一个固定会话）/ POST 新建 */
export async function handleSessionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  method: string,
): Promise<void> {
  const { runtime } = context;

  if (method === 'GET') {
    const botId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('botId') ?? '';
    const list = await runtime.registry.list();
    const currentBot = list.find((item) => item.id === botId) || list[0];
    const sessions = [
      {
        id: currentBot ? currentBot.id : 'session-default',
        botId: currentBot ? currentBot.id : 'bot-default',
        title: currentBot ? currentBot.name : '白泽联调',
        model: context.model,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 6,
      },
    ];
    json(response, 200, { sessions });
    return;
  }

  if (method === 'POST') {
    const body = await readJson(request);
    const botId = readString(body.botId) ?? '';
    const list = await runtime.registry.list();
    const currentBot = list.find((item) => item.id === botId) || list[0];
    const session = {
      id: botId || 'session-' + Date.now(),
      botId,
      title: currentBot?.name ?? '新对话',
      model: readString(body.model) ?? context.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    };
    json(response, 201, { session });
  }
}

/** /api/sessions/:id：GET 该智能体的完整对话线（折叠工具卡片 + 产物） */
export async function handleSessionItem(
  response: ServerResponse,
  context: RouteContext,
  raw: string,
): Promise<void> {
  const record = await resolveAgent(context, raw);
  const id = record?.id ?? raw;
  const rawMsgs = await context.runtime.messages.list(id);
  const messages = await context.runtime.displayMessages(id, rawMsgs);
  json(response, 200, {
    session: {
      id,
      botId: id,
      title: record?.name ?? '对话',
      model: context.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
    },
    messages,
    artifacts: collectArtifacts(rawMsgs),
    taskProgress: context.runtime.taskProgress.list(id).slice(0, 20).map(task => ({ id: task.id, status: task.status, stopReason: task.stopReason, goal: task.goal.slice(0, 300), updatedAt: task.updatedAt })),
  });
}

/**
 * /api/chat：私聊发送。
 * E3.4 第二步起只做「接收」：202 立刻返回回执（messageId + 受理游标），
 * 回合在后台继续跑；进度与结果走 `GET /api/events` 订阅，断线只断订阅。
 */
export async function handleChatRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const parsed = parseSendMessageInput(await readJson(request));
  if (!parsed.ok) {
    json(response, 400, { error: parsed.error });
    return;
  }
  const { text, botId: requestedBotId, model, clientMessageId, resumeTaskId } = parsed.value;
  const list = await context.runtime.registry.list();
  const found = requestedBotId ? await resolveAgent(context, requestedBotId) : undefined;
  const botId = found?.id ?? list[0]?.id;

  if (!botId) {
    json(response, 400, { error: 'botId is required' });
    return;
  }
  if (!validateResume(context, response, botId, resumeTaskId)) return;

  const accepted = await context.runtime.acceptMessage(botId, text, { model, clientMessageId, resumeTaskId });
  json(response, 202, accepted.receipt);
  // 已受理的回执发出去后，执行在后台跑；失败会以 run error 事件到达订阅方
  void accepted.execute().catch(() => undefined);
}

/** /api/sessions/:id/messages：同一份发送契约的会话入口（202 回执 + 后台执行） */
export async function handleSend(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  agentId: string,
): Promise<void> {
  const parsed = parseSendMessageInput(await readJson(request));
  if (!parsed.ok) {
    json(response, 400, { error: parsed.error });
    return;
  }

  if (!validateResume(context, response, agentId, parsed.value.resumeTaskId)) return;

  const accepted = await context.runtime.acceptMessage(agentId, parsed.value.text, {
    model: parsed.value.model,
    clientMessageId: parsed.value.clientMessageId,
    resumeTaskId: parsed.value.resumeTaskId,
  });
  json(response, 202, accepted.receipt);
  void accepted.execute().catch(() => undefined);
}

function validateResume(context: RouteContext, response: ServerResponse, agentId: string, taskId?: string): boolean {
  if (!taskId) return true;
  const checkpoint = context.runtime.taskProgress.get(taskId, agentId);
  if (checkpoint?.scope === 'dm' && checkpoint.status !== 'running') return true;
  json(response, 400, { error: '找不到当前智能体已停止的任务进度' });
  return false;
}
