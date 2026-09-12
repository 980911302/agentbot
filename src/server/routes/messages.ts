import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectArtifacts, toDisplayMessages } from '../presenters.js';
import { isKnownAgentEvent, parseSendMessageInput } from '../../shared/contracts/index.js';
import { json, PING_INTERVAL_MS, readJson, sse } from '../transport/index.js';
import { AgentBusyError } from '../runtime.js';
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
  const messages = toDisplayMessages(rawMsgs);
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
  });
}

/** /api/chat：私聊发送（SSE）。忙不拒——新句插队开新回合，旧的挂起欠账 */
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
  const { text, botId: requestedBotId, model, clientMessageId } = parsed.value;
  const list = await context.runtime.registry.list();
  const found = requestedBotId ? await resolveAgent(context, requestedBotId) : undefined;
  const botId = found?.id ?? list[0]?.id;

  if (!botId) {
    json(response, 400, { error: 'botId is required' });
    return;
  }

  openSse(response);

  const ping = ssePing(response);
  const controller = new AbortController();
  response.on('close', () => controller.abort());

  try {
    const result = await context.runtime.send(botId, text, {
      model,
      clientMessageId,
      signal: controller.signal,
      onEvent: (event) => {
        if (isKnownAgentEvent(event)) sse(response, 'event', event);
      },
      onDelta: (text) => sse(response, 'event', { type: 'delta', text }),
    });
    sse(response, 'done', result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sse(response, 'error', { message });
  } finally {
    clearInterval(ping);
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

/** /api/sessions/:id/messages：同一份发送契约的会话入口（SSE） */
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
  const text = parsed.value.text;
  const model = parsed.value.model;
  const clientMessageId = parsed.value.clientMessageId;

  openSse(response);

  const ping = ssePing(response);
  const controller = new AbortController();
  response.on('close', () => controller.abort());

  try {
    const result = await context.runtime.send(agentId, text, {
      model,
      clientMessageId,
      signal: controller.signal,
      onEvent: (event) => {
        if (isKnownAgentEvent(event)) sse(response, 'event', event);
      },
      onDelta: (text) => sse(response, 'event', { type: 'delta', text }),
    });
    sse(response, 'done', result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sse(response, 'error', {
      message,
      status: error instanceof AgentBusyError ? 409 : 500,
    });
  } finally {
    clearInterval(ping);
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

function openSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

function ssePing(response: ServerResponse): NodeJS.Timeout {
  return setInterval(() => {
    if (!response.writableEnded && !response.destroyed) response.write(': ping\n\n');
  }, PING_INTERVAL_MS);
}
