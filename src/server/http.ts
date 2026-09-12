import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { AVAILABLE_MODELS, resolveConfig } from '../config.js';
import { MemoryStore } from '../memory/store.js';
import { InteractionBroker } from '../interaction/broker.js';
import { SecretStore } from '../secret/store.js';
import { OpenAIProvider } from '../llm/openai-provider.js';
import type { LLMProvider } from '../llm/provider.js';
import { AgentRuntime } from './runtime.js';
import { SEED_AGENTS, SEED_ROOMS } from './seed.js';
import { createAgentTools } from './tools.js';
import { json, serveStatic } from './transport/index.js';
import type { RouteContext } from './routes/context.js';
import { handleBotsCollection, handleBotItem } from './routes/bots.js';
import {
  handleChatRoute,
  handleSend,
  handleSessionItem,
  handleSessionsCollection,
} from './routes/messages.js';
import { handleAgentRoute } from './routes/agents.js';
import { handleRoomRoute, handleRoomsCollection } from './routes/rooms.js';
import { handleInteractionItem, handleInteractionsCollection } from './routes/interactions.js';
import { handleSecretsCollection } from './routes/secrets.js';
import { handleHealthRoute } from './routes/health.js';
import { handleEventsRoute } from './routes/events.js';

export interface AgentServerOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  rootDir?: string;
  dataDir?: string;
  /** 测试注入：不传则按配置建 OpenAIProvider */
  createProvider?: (model: string) => LLMProvider;
  /** 配合 createProvider 的无 Key 启动（测试用） */
  allowMissingKey?: boolean;
}

export interface AgentServerHandle {
  server: import('node:http').Server;
  port: number;
  url: string;
  runtime: AgentRuntime;
  close: () => Promise<void>;
}

export async function createAgentServer(options: AgentServerOptions = {}): Promise<AgentServerHandle> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const config = resolveConfig({ env: process.env, rootDir, allowMissingKey: options.allowMissingKey });
  const models = AVAILABLE_MODELS.some((item) => item.id === config.model)
    ? AVAILABLE_MODELS
    : [{ id: config.model, label: config.model, hint: '来自环境变量配置' }, ...AVAILABLE_MODELS];

  const dataDir = options.dataDir ?? config.dataDir;
  const memoryStore = new MemoryStore(dataDir);
  const broker = new InteractionBroker();
  const secrets = new SecretStore(dataDir);
  const { tools, bind } = createAgentTools({
    rootDir,
    memory: memoryStore,
    secrets,
    broker,
    web: config.web,
  });

  const runtime = new AgentRuntime({
    tools,
    createProvider:
      options.createProvider ??
      ((model) => new OpenAIProvider({ apiKey: config.apiKey, model, baseURL: config.baseURL })),
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

  // DI：工具需要的运行时回调在 runtime 建好后立即绑定（无模块级全局可变状态）
  bind({
    agentName: async (agentId) => (await runtime.registry.get(agentId))?.name ?? agentId,
    updateAgent: (agentId, patch) => runtime.registry.update(agentId, patch),
  });

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

/** 分发：只做路径匹配与解码，业务在各 routes/ 模块里（顺序与拆分前完全一致） */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (path === '/api/health') {
    handleHealthRoute(response, context);
    return;
  }

  // 界面事件的独立订阅（E3.4）：发送与订阅分离，断线只断订阅
  if (path === '/api/events' && method === 'GET') {
    handleEventsRoute(request, response, context);
    return;
  }

  if (path === '/api/bots' || path === '/api/agents') {
    await handleBotsCollection(request, response, context, method);
    return;
  }

  const botMatch = /^\/api\/bots\/([^/]+)$/.exec(path);
  if (botMatch && (await handleBotItem(request, response, context, decodeURIComponent(botMatch[1] ?? ''), method))) {
    return;
  }

  if (path === '/api/sessions') {
    await handleSessionsCollection(request, response, context, method);
    return;
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch && method === 'GET') {
    await handleSessionItem(response, context, decodeURIComponent(sessionMatch[1] ?? ''));
    return;
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
    await handleInteractionsCollection(request, response, context);
    return;
  }

  const interactionMatch = /^\/api\/interactions\/([^/]+)$/.exec(path);
  if (interactionMatch && method === 'POST') {
    await handleInteractionItem(request, response, context, decodeURIComponent(interactionMatch[1] ?? ''));
    return;
  }

  // ── 密钥：只暴露名字，永远不回传值 ────────────────
  if (path === '/api/secrets' && method === 'GET') {
    handleSecretsCollection(response, context);
    return;
  }

  const secretMatch = /^\/api\/secrets\/([^/]+)$/.exec(path);
  if (secretMatch && method === 'DELETE') {
    json(response, 200, { ok: await context.runtime.secrets.remove(decodeURIComponent(secretMatch[1] ?? '')) });
    return;
  }

  // ── 房间：名字 + 成员表 + 共享时间线 ──────────────
  if (path === '/api/rooms' && method === 'GET') {
    await handleRoomsCollection(request, response, context, method);
    return;
  }

  if (path === '/api/rooms' && method === 'POST') {
    await handleRoomsCollection(request, response, context, method);
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
