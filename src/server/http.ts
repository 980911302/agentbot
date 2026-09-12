import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { AVAILABLE_MODELS, resolveConfig, type AppConfig, type ModelOption } from '../config.js';
import type { AgentRecord } from '../agent/types.js';
import { OpenAIProvider } from '../llm/openai-provider.js';
import { MemoryStore } from '../memory/store.js';
import { InteractionBroker } from '../interaction/broker.js';
import { SecretStore } from '../secret/store.js';
import type { MemoryScope, MemoryTier } from '../memory/types.js';
import { AgentBusyError, AgentRuntime } from './runtime.js';
import { SEED_AGENTS, SEED_ROOMS } from './seed.js';
import { RoomError } from '../room/store.js';

import type { Room } from '../room/types.js';
import { ROOM_MEMBER_LIMIT } from '../room/types.js';
import type { Message } from '../agent/types.js';
import { createAgentTools } from './tools.js';

const MAX_BODY_BYTES = 1024 * 1024;
const PING_INTERVAL_MS = 15_000;

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface AgentServerOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  rootDir?: string;
  dataDir?: string;
}

export interface AgentServerHandle {
  server: Server;
  port: number;
  url: string;
  runtime: AgentRuntime;
  close(): Promise<void>;
}

interface RouteContext {
  runtime: AgentRuntime;
  staticDir?: string;
  model: string;
  models: ModelOption[];
  tools: Array<{ name: string; description: string }>;
  budget: AppConfig['budget'];
  ownerName: string;
}

/** 工具里要反查同事名；用软引用避免构造顺序上的循环依赖 */
let runtimeRef: AgentRuntime | undefined;

export async function createAgentServer(options: AgentServerOptions = {}): Promise<AgentServerHandle> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const config = resolveConfig({ env: process.env, rootDir });
  const models = AVAILABLE_MODELS.some((item) => item.id === config.model)
    ? AVAILABLE_MODELS
    : [{ id: config.model, label: config.model, hint: '来自环境变量配置' }, ...AVAILABLE_MODELS];

  const dataDir = options.dataDir ?? config.dataDir;
  const memoryStore = new MemoryStore(dataDir);
  const broker = new InteractionBroker();
  const secrets = new SecretStore(dataDir);
  const tools = createAgentTools({
    rootDir,
    memory: memoryStore,
    secrets,
    broker,
    agentName: async (agentId) => (await runtimeRef?.registry.get(agentId))?.name ?? agentId,
    updateAgent: async (agentId, patch) => {
      if (!runtimeRef) throw new Error('runtime is not ready yet');
      return runtimeRef.registry.update(agentId, patch);
    },
    web: config.web,
  });

  const runtime = new AgentRuntime({
    tools,
    createProvider: (model) =>
      new OpenAIProvider({ apiKey: config.apiKey, model, baseURL: config.baseURL }),
    dataDir,
    defaultModel: config.model,
    knownModels: models.map((item) => item.id),
    budget: config.budget,
    memoryExtraction: config.memoryExtraction,
    memoryStore,
    seed: SEED_AGENTS,
    seedRooms: SEED_ROOMS,
    ownerName: config.ownerName,
    stopWords: config.stopWords,
    broker,
    secrets,
  });

  runtimeRef = runtime;

  // 健康检查报全量工具面（常驻 + 平台层），而不是装配前的常驻子集
  const toolDefs = runtime.tools.map((tool) => ({ name: tool.name, description: tool.description }));
  await runtime.ensureDefaultAgent();
  await runtime.ensureSeedRooms();

  const context: RouteContext = {
    runtime,
    staticDir: options.staticDir ? resolve(options.staticDir) : undefined,
    model: config.model,
    models,
    tools: toolDefs,
    budget: config.budget,
    ownerName: config.ownerName,
  };

  const server = createServer((request, response) => {
    handleRequest(request, response, context).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (response.headersSent) {
        response.end();
        return;
      }
      json(response, 500, { error: message });
    });
  });

  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 0;

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(requestedPort, host, () => {
      server.off('error', fail);
      done();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;

  return {
    server,
    port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`,
    runtime,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method ?? 'GET';
  const { runtime } = context;

  if (path === '/api/health') {
    json(response, 200, {
      ok: true,
      service: 'agentbot',
      model: context.model,
      models: context.models,
      tools: context.tools,
      budget: context.budget,
      ownerName: context.ownerName,
    });
    return;
  }

  if ((path === '/api/bots' || path === '/api/agents') && method === 'GET') {
    const list = await runtime.registry.list();
    const bots = await Promise.all(list.map((record) => toBotView(runtime, record)));
    json(response, 200, { bots, agents: list });
    return;
  }

  if ((path === '/api/bots' || path === '/api/agents') && method === 'POST') {
    const body = await readJson(request);
    const record = await runtime.registry.create({
      name: readString(body.name),
      instructions: readString(body.instructions) ?? readString(body.role),
      color: readString(body.color),
    });
    json(response, 201, { agent: record, bot: await toBotView(runtime, record) });
    return;
  }

  const botMatch = /^\/api\/bots\/([^/]+)$/.exec(path);
  if (botMatch) {
    const raw = decodeURIComponent(botMatch[1] ?? '');
    const record = await resolveAgent(context, raw);
    if (!record) {
      json(response, 404, { error: `unknown bot: ${raw}` });
      return;
    }

    if (method === 'GET') {
      json(response, 200, { bot: await toBotView(context.runtime, record) });
      return;
    }

    if (method === 'PATCH') {
      const body = await readJson(request);
      const updated = await context.runtime.registry.update(record.id, {
        name: readString(body.name),
        instructions: readString(body.instructions) ?? readString(body.role),
        color: readString(body.color),
      });
      json(response, 200, {
        bot: updated ? await toBotView(context.runtime, updated) : null,
      });
      return;
    }

    if (method === 'DELETE') {
      if (context.runtime.isBusy(record.id)) {
        json(response, 409, { error: '这个智能体正在跑任务，等它结束后再删' });
        return;
      }
      await context.runtime.messages.clear(record.id);
      await context.runtime.memory.clear('self', record.id);
      await context.runtime.compaction.clear(record.id);
      const ok = await context.runtime.registry.remove(record.id);
      json(response, 200, { ok, removed: record.name });
      return;
    }
  }

  if (path === '/api/sessions' && method === 'GET') {
    const botId = url.searchParams.get('botId') ?? '';
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

  if (path === '/api/sessions' && method === 'POST') {
    const body = await readJson(request);
    const botId = readString(body.botId) ?? '';
    const list = await runtime.registry.list();
    const currentBot = list.find((item) => item.id === botId) || list[0];
    const session = {
      id: botId || 'session-' + Date.now(),
      botId: botId,
      title: currentBot?.name ?? '新对话',
      model: readString(body.model) ?? context.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    };
    json(response, 201, { session });
    return;
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch) {
    const raw = decodeURIComponent(sessionMatch[1] ?? '');
    const record = await resolveAgent(context, raw);
    const id = record?.id ?? raw;
    if (method === 'GET') {
      const rawMsgs = await runtime.messages.list(id);
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
      return;
    }
  }

  if (path === '/api/chat' && method === 'POST') {
    await handleChatRoute(request, response, context);
    return;
  }

  const agentMatch = /^\/api\/agents\/([^/]+)(\/.*)?$/.exec(path);
  if (agentMatch) {
    const id = decodeURIComponent(agentMatch[1] ?? '');
    const rest = agentMatch[2] ?? '';
    await handleAgentRoute(request, response, context, id, rest === '' ? '/' : rest);
    return;
  }


  // ── 交互：等用户回答的卡片 ────────────────────────
  if (path === '/api/interactions' && method === 'GET') {
    const agentId = url.searchParams.get('agentId') ?? undefined;
    json(response, 200, { interactions: runtime.broker.list(agentId ? { agentId } : undefined) });
    return;
  }

  const interactionMatch = /^\/api\/interactions\/([^/]+)$/.exec(path);
  if (interactionMatch && method === 'POST') {
    const id = decodeURIComponent(interactionMatch[1] ?? '');
    const body = await readJson(request);

    if (body.cancelled === true) {
      json(response, 200, { ok: runtime.broker.cancel(id) });
      return;
    }

    const value = readString(body.value);
    const secret = readString(body.secret);
    if (value === undefined && secret === undefined) {
      json(response, 400, { error: '需要 value（选项）或 secret（密钥）' });
      return;
    }

    const ok = runtime.broker.resolve(id, { value, secret });
    json(response, ok ? 200 : 404, ok ? { ok: true } : { error: '这个交互已经结束或不存在' });
    return;
  }

  // ── 密钥：只暴露名字，永远不回传值 ────────────────
  if (path === '/api/secrets' && method === 'GET') {
    json(response, 200, { names: await runtime.secrets.names() });
    return;
  }

  const secretMatch = /^\/api\/secrets\/([^/]+)$/.exec(path);
  if (secretMatch && method === 'DELETE') {
    const name = decodeURIComponent(secretMatch[1] ?? '');
    json(response, 200, { ok: await runtime.secrets.remove(name) });
    return;
  }

  // ── 房间：名字 + 成员表 + 共享时间线 ──────────────
  if (path === '/api/rooms' && method === 'GET') {
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

  if (path === '/api/rooms' && method === 'POST') {
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
    return;
  }

  const roomMatch = /^\/api\/rooms\/([^/]+)(\/.*)?$/.exec(path);
  if (roomMatch) {
    const roomId = decodeURIComponent(roomMatch[1] ?? '');
    const rest = roomMatch[2] ?? '';
    await handleRoomRoute(request, response, context, roomId, rest === '' ? '/' : rest);
    return;
  }

  if (path.startsWith('/api/')) {
    json(response, 404, { error: `no route for ${method} ${path}` });
    return;
  }

  if (method === 'GET' || method === 'HEAD') {
    serveStatic(response, path, method === 'HEAD', context.staticDir);
    return;
  }

  json(response, 405, { error: 'method not allowed' });
}

async function roomView(runtime: AgentRuntime, room: Room) {
  const { members } = await runtime.membersOf(room.id);
  return runtime.rooms.view(
    room,
    members.map((record) => ({ id: record.id, name: record.name, color: record.color })),
  );
}

async function handleRoomRoute(
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
  if (rest === '/messages' && method === 'POST') {
    const body = await readJson(request);
    const text = (readString(body.text) ?? readString(body.message) ?? '').trim();
    const model = readString(body.model);
    if (!text) {
      json(response, 400, { error: 'text is required' });
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const ping = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) response.write(': ping\n\n');
    }, PING_INTERVAL_MS);

    const controller = new AbortController();
    response.on('close', () => controller.abort());

    try {
      const summary = await runtime.postToRoom(roomId, text, {
        model,
        ownerName: readString(body.ownerName) ?? context.ownerName,
        signal: controller.signal,
        onEvent: (event) => sse(response, 'event', event),
        onRoomEvent: (event) => sse(response, 'room', event),
      });
      sse(response, 'done', summary);
    } catch (error) {
      sse(response, 'error', { message: messageOf(error) });
    } finally {
      clearInterval(ping);
      if (!response.writableEnded && !response.destroyed) response.end();
    }
    return;
  }

  json(response, 404, { error: `no route for ${method} /api/rooms/:id${rest}` });
}

async function handleAgentRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  agentId: string,
  rest: string,
): Promise<void> {
  const method = request.method ?? 'GET';
  const { runtime } = context;
  const record = await runtime.registry.get(agentId);
  if (!record) {
    json(response, 404, { error: 'unknown agent' });
    return;
  }

  if (rest === '/' && method === 'GET') {
    const memory = await runtime.snapshotMemory(agentId);
    json(response, 200, {
      agent: record,
      memory,
      messageCount: await runtime.messages.count(agentId),
      busy: runtime.isBusy(agentId),
    });
    return;
  }

  if (rest === '/' && method === 'PATCH') {
    const body = await readJson(request);
    const updated = await runtime.registry.update(agentId, {
      name: readString(body.name),
      instructions: readString(body.instructions),
      toolNames: Array.isArray(body.toolNames)
        ? body.toolNames.filter((item): item is string => typeof item === 'string')
        : undefined,
      projectIds: Array.isArray(body.projectIds)
        ? body.projectIds.filter((item): item is string => typeof item === 'string')
        : undefined,
    });
    json(response, 200, { agent: updated });
    return;
  }

  if (rest === '/' && method === 'DELETE') {
    await runtime.messages.clear(agentId);
    await runtime.memory.clear('self', agentId);
    await runtime.compaction.clear(agentId);
    json(response, 200, { ok: await runtime.registry.remove(agentId) });
    return;
  }

  if (rest === '/messages' && method === 'GET') {
    const limit = Number.parseInt(new URL(request.url ?? '/', 'http://x').searchParams.get('limit') ?? '', 10);
    json(response, 200, {
      messages: await runtime.messages.list(agentId, Number.isFinite(limit) ? limit : undefined),
    });
    return;
  }

  // 同事私发进来的积压消息（1:1 队列）
  if (rest === '/inbox' && method === 'GET') {
    json(response, 200, { items: await runtime.inbox.peek(agentId) });
    return;
  }

  if (rest === '/inbox' && method === 'POST') {
    await runtime.drainInbox(agentId);
    json(response, 200, { ok: true });
    return;
  }

  if (rest === '/messages' && method === 'POST') {
    await handleSend(request, response, context, agentId);
    return;
  }

  // 记忆快照：三层 × 三作用域，直接喂给 UI
  if (rest === '/memory' && method === 'GET') {
    const snapshot = await runtime.snapshotMemory(agentId);
    if (!snapshot) {
      json(response, 404, { error: 'unknown agent' });
      return;
    }
    json(response, 200, snapshot);
    return;
  }

  if (rest === '/memory' && method === 'POST') {
    const body = await readJson(request);
    const text = readString(body.text)?.trim();
    if (!text) {
      json(response, 400, { error: 'text is required' });
      return;
    }
    try {
      const ref = await runtime.remember(agentId, {
        text,
        scope: parseScope(body.scope),
        tier: parseTier(body.tier),
        projectId: readString(body.projectId),
        tags: Array.isArray(body.tags)
          ? body.tags.filter((item): item is string => typeof item === 'string')
          : [],
      });
      json(response, 201, { ref });
    } catch (error) {
      json(response, 400, { error: messageOf(error) });
    }
    return;
  }

  const memoryMatch = /^\/memory\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(rest);
  if (memoryMatch) {
    const scope = parseScope(decodeURIComponent(memoryMatch[1] ?? ''));
    const ownerId = decodeURIComponent(memoryMatch[2] ?? '');
    const entryId = decodeURIComponent(memoryMatch[3] ?? '');
    if (method === 'DELETE') {
      json(response, 200, { ok: await runtime.memory.remove(scope, ownerId, entryId) });
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson(request);
      const updated = await runtime.memory.update(scope, ownerId, entryId, {
        tier: parseTier(body.tier),
        text: readString(body.text),
        tags: Array.isArray(body.tags)
          ? body.tags.filter((item): item is string => typeof item === 'string')
          : undefined,
      });
      json(response, updated ? 200 : 404, updated ? { entry: updated } : { error: 'not found' });
      return;
    }
  }

  if (rest === '/context' && method === 'GET') {
    const built = await runtime.previewContext(agentId);
    if (!built) {
      json(response, 404, { error: 'unknown agent' });
      return;
    }
    json(response, 200, {
      stats: built.stats,
      system: built.system,
      droppedRecent: built.droppedRecent,
      droppedGroups: built.droppedGroups,
      surfaced: built.surfaced.map((ref) => ({
        id: ref.entry.id,
        scope: ref.scope,
        tier: ref.entry.tier,
        text: ref.entry.text,
      })),
    });
    return;
  }

  json(response, 404, { error: `no route for ${method} /api/agents/:id${rest}` });
}

async function handleChatRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const body = await readJson(request);
  const text = (readString(body.message) || readString(body.text) || '').trim();
  const list = await context.runtime.registry.list();
  const requested = readString(body.botId) || readString(body.agentId) || '';
  const found = requested ? await resolveAgent(context, requested) : undefined;
  const botId = found?.id ?? list[0]?.id;
  const model = readString(body.model);

  if (!text) {
    json(response, 400, { error: 'message is required' });
    return;
  }
  if (!botId) {
    json(response, 400, { error: 'botId is required' });
    return;
  }
  // 忙不拒：《停止与插话.md》——新句插队开新回合，旧的挂起欠账

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const ping = setInterval(() => {
    if (!response.writableEnded && !response.destroyed) response.write(': ping\n\n');
  }, PING_INTERVAL_MS);

  const controller = new AbortController();
  response.on('close', () => controller.abort());

  try {
    const result = await context.runtime.send(botId, text, {
      model,
      signal: controller.signal,
      onEvent: (event) => sse(response, 'event', event),
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

async function handleSend(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  agentId: string,
): Promise<void> {

  const body = await readJson(request);
  const text = readString(body.text)?.trim() ?? '';
  const model = readString(body.model);
  if (!text) {
    json(response, 400, { error: 'text is required' });
    return;
  }
  // 忙不拒：新句插队（同 handleChatRoute）

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const ping = setInterval(() => {
    if (!response.writableEnded && !response.destroyed) response.write(': ping\n\n');
  }, PING_INTERVAL_MS);

  const controller = new AbortController();
  response.on('close', () => controller.abort());

  try {
    const result = await context.runtime.send(agentId, text, {
      model,
      signal: controller.signal,
      onEvent: (event) => sse(response, 'event', event),
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * 按 id 找智能体，找不到再按名字找。
 *
 * 兼容层要足够宽容：前端历史上用过 channel-xxx 这类本地 id，
 * 也有直接拿显示名当标识的地方，按名字兜底能省掉一整类「Unknown agent」。
 */
async function resolveAgent(context: RouteContext, idOrName: string) {
  const byId = await context.runtime.registry.get(idOrName);
  if (byId) return byId;
  const list = await context.runtime.registry.list();
  const wanted = idOrName.trim();
  return list.find((item) => item.name === wanted);
}

/** 智能体的界面视图：状态与计数一律来自真实数据源，不放假数 */
async function toBotView(runtime: AgentRuntime, record: AgentRecord) {
  return {
    id: record.id,
    name: record.name,
    title: record.title,
    role: record.title || record.instructions.slice(0, 30),
    /** 完整职责文本，资料编辑要用；role 只是展示截断 */
    instructions: record.instructions,
    color: record.color,
    status: runtime.isBusy(record.id) ? 'working' : 'idle',
    activity: '',
    conversationCount: await runtime.messages.count(record.id),
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

interface DisplayMessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  senderName?: string;
  senderColor?: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
    result?: string;
    durationMs?: number;
    status: 'running' | 'ok' | 'error';
  }>;
  createdAt: string;
  error?: boolean;
}

/**
 * 把存下来的消息折成界面用的形状。
 * 一次工具调用 + 它的结果是两条消息，这里合并回一张卡片。
 */
function toDisplayMessages(raw: Message[]): DisplayMessageView[] {
  const out: DisplayMessageView[] = [];

  for (const message of raw) {
    const content = message.content;

    if (content.type === 'text') {
      const text = content.text.trim();
      if (!text) continue;
      out.push({
        id: message.id,
        role: message.role === 'user' ? 'user' : 'assistant',
        content: text,
        senderName: message.speaker,
        toolCalls: [],
        createdAt: new Date(message.createdAt).toISOString(),
      });
      continue;
    }

    if (content.type === 'tool_calls') {
      out.push({
        id: message.id,
        role: 'assistant',
        content: '',
        toolCalls: content.calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'running' as const,
        })),
        createdAt: new Date(message.createdAt).toISOString(),
      });
      continue;
    }

    // tool_result → 回填到对应卡片
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const target = out[index];
      const call = target?.toolCalls.find((item) => item.id === content.callId);
      if (!call) continue;
      call.result = content.result;
      call.durationMs = content.durationMs;
      call.status = content.ok ? 'ok' : 'error';
      break;
    }
  }

  return out;
}

function collectArtifacts(raw: Message[]): Array<{ path: string; tool: string; createdAt: string }> {
  const seen = new Map<string, { path: string; tool: string; createdAt: string }>();
  for (const message of raw) {
    if (message.content.type !== 'tool_calls') continue;
    for (const call of message.content.calls) {
      let path: unknown;
      try {
        path = (JSON.parse(call.arguments || '{}') as { path?: unknown }).path;
      } catch {
        continue;
      }
      if (typeof path !== 'string' || !path || seen.has(path)) continue;
      seen.set(path, {
        path,
        tool: call.name,
        createdAt: new Date(message.createdAt).toISOString(),
      });
    }
  }
  return [...seen.values()];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function messageOf(error: unknown): string {
  if (error instanceof RoomError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function parseScope(value: unknown): MemoryScope {
  if (value === 'user' || value === 'project') return value;
  return 'self';
}

function parseTier(value: unknown): MemoryTier {
  if (value === 'portrait' || value === 'scratch') return value;
  return 'log';
}

function sse(response: ServerResponse, event: string, data: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function serveStatic(
  response: ServerResponse,
  pathname: string,
  headOnly: boolean,
  staticDir?: string,
): void {
  if (!staticDir) {
    json(response, 404, {
      error: 'UI bundle not found. Run `npm run web:build`, or use the Vite dev server on :5173.',
    });
    return;
  }

  const indexFile = join(staticDir, 'index.html');
  if (!existsSync(indexFile)) {
    json(response, 404, { error: 'web/dist/index.html is missing. Run `npm run web:build`.' });
    return;
  }

  const target = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(staticDir, target);
  const rel = relative(staticDir, candidate);
  const insideRoot = !rel.startsWith('..') && !isAbsolute(rel);
  const file =
    insideRoot && existsSync(candidate) && statSync(candidate).isFile() ? candidate : indexFile;
  const type = STATIC_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';

  response.writeHead(200, {
    'content-type': type,
    'cache-control': file === indexFile ? 'no-cache' : 'public, max-age=3600',
  });
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}
