import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { resolveConfig } from '../config.js';
import { pickerOptionsFromProviders } from '../shared/contracts/model-catalog.js';
import { MemoryStore } from '../memory/store.js';
import { SettingsStore } from '../settings/store.js';
import { InteractionBroker } from '../interaction/broker.js';
import { SecretStore } from '../secret/store.js';
import { OpenAIProvider } from '../llm/openai-provider.js';
import type { LLMProvider } from '../llm/provider.js';
import { AgentRuntime } from './runtime.js';
import { DataDirLock } from '../storage/instance-lock.js';
import { runShutdownSequence, type ShutdownReport } from './lifecycle.js';
import { BackgroundProcesses } from '../tools/services/background-processes.js';
import { SEED_AGENTS, SEED_ROOMS } from './seed.js';
import { createAgentTools } from './tools.js';
import { isRequiredTool } from '../tools/capabilities.js';
import { json, readJson, serveStatic, checkRequest } from './transport/index.js';
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
import { ReplyFinalizer } from './runtime/reply-finalizer.js';
import { ModelConfigStore } from '../storage/model-config-store.js';
import { handleModelSettingsRoute, handlePreferencesRoute } from './routes/settings.js';

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
  /** 优雅停机（E8.4）：幂等，返回停机顺序台账；见 docs/架构设计.md §7.4 */
  close: () => Promise<ShutdownReport>;
}

export async function createAgentServer(options: AgentServerOptions = {}): Promise<AgentServerHandle> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const config = resolveConfig({ env: process.env, rootDir, allowMissingKey: options.allowMissingKey });
  const dataDir = options.dataDir ?? config.dataDir;
  // E3.6：同一份数据只允许一个调度器；崩溃留下的锁会被接管
  const lock = new DataDirLock(dataDir);
  await lock.acquire();

  // 读取已保存的自定义模型配置（优先于环境变量）
  const modelConfigStore = new ModelConfigStore(dataDir);
  const storedModel = await modelConfigStore.load({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    thinkingEnabled: true,
    thinkingLevel: 'medium',
  });

  const activeApiKey = storedModel.apiKey || config.apiKey;
  const activeBaseURL = storedModel.baseURL || config.baseURL;
  const activeModel = storedModel.model || config.model;

  const models = pickerOptionsFromProviders(storedModel.providers);
  const knownModels = models.length > 0 ? models.map((item) => item.id) : [activeModel];

  const memoryStore = new MemoryStore(dataDir);
  // 主人级设置（E5.7）：主人名/时区/语言/通知偏好落数据目录，与 CLI 读同一份
  const settings = new SettingsStore(dataDir, { ownerName: config.ownerName });
  await settings.load();
  const broker = new InteractionBroker();
  const secrets = new SecretStore(dataDir);
  // E8.4：后台进程（常驻 Shell / 后台工人）共用一张停机登记表
  const background = new BackgroundProcesses();
  const { tools, bind } = createAgentTools({
    rootDir,
    dataDir,
    memory: memoryStore,
    secrets,
    broker,
    web: config.web,
    background,
  });

  const runtime = new AgentRuntime({
    tools,
    createProvider:
      options.createProvider ??
      ((model) =>
        new OpenAIProvider({
          apiKey: activeApiKey,
          model,
          baseURL: activeBaseURL,
          thinkingEnabled: storedModel.thinkingEnabled !== false,
          thinkingLevel: storedModel.thinkingLevel || 'medium',
          temperature: storedModel.temperature,
        })),
    dataDir,
    defaultModel: activeModel,
    knownModels,
    budget: config.budget,
    memoryExtraction: config.memoryExtraction,
    memoryStore,
    seed: SEED_AGENTS,
    seedRooms: SEED_ROOMS,
    ownerName: config.ownerName,
    settings,
    stopWords: config.stopWords,
    broker,
    secrets,
    modelConfigStore,
    background,
  });

  // DI：工具需要的运行时回调在 runtime 建好后立即绑定（无模块级全局可变状态）
  bind({
    agentName: async (agentId) => (await runtime.registry.get(agentId))?.name ?? agentId,
    updateProfile: (agentId, patch) => runtime.profiles.updateById(agentId, patch),
    finalizeReply: async (input) => {
      const finalizer = new ReplyFinalizer({
        lookup: async (id) => runtime.deliveryReceipt(id),
        canView: (actorId, receipt) => receipt.actorId === actorId,
      });
      return finalizer.finalize({
        actorId: input.actorId,
        inputId: input.inputId ?? input.actorId,
        content: input.content,
        deliveryRefs: input.deliveryRefs,
        allowedReceiptIds: input.allowedReceiptIds,
        source: input.source,
      });
    },
  });

  // 健康检查报全量工具面（常驻 + 平台层），而不是装配前的常驻子集；
  // required 标记必需能力（E5.3），设置页据此把勾选框锁成只读
  const toolDefs = runtime.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    required: isRequiredTool(tool.name),
  }));
  await runtime.registry.syncDefaultTools();
  await runtime.migrateExistingAgents();
  const fileExisted = await runtime.registry.existed();
  if (!fileExisted || (runtime.options.seed?.length ?? 0) > 0) {
    await runtime.ensureDefaultAgent();
  }
  await runtime.ensureSeedRooms();

  // E3.6 启动扫描：核对上次进程留下的中断调用、把没确认的来信重投并接着办
  const report = await runtime.recover();
  if (report.unresolvedInvocations.length > 0) {
    console.warn(`启动扫描：${report.unresolvedInvocations.length} 个中断的工具调用待核对（不会自动重放）`);
    for (const item of report.unresolvedInvocations.slice(0, 5)) {
      console.warn(`  - ${item.record.tool}（${item.plan.action}）：${item.plan.reason}`);
    }
  }
  for (const item of report.pendingDeliveries) {
    console.log(
      `启动扫描：${item.agentName} 有待处理来信（可领取 ${item.claimable} / 在飞 ${item.claimed} / 失败 ${item.failed}）`,
    );
  }

  const context: RouteContext = {
    runtime,
    staticDir: options.staticDir ? resolve(options.staticDir) : undefined,
    model: activeModel,
    models,
    tools: toolDefs,
    budget: config.budget,
    ownerName: () => runtime.ownerName(),
    // 环境变量里的模型默认值（bug_epxdph16hjut）：设置页只在没建供应商时拿它兜底
    envDefaults: {
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    },
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

  // E8.4 停机顺序的唯一实现（幂等）：停新工作 → 写检查点 → 终止后台进程 → 关存储 → 放锁。
  // 顺序与分母都在 src/server/lifecycle.ts，这里只提供各步的真实动作。
  let closing: Promise<ShutdownReport> | undefined;
  const close = (): Promise<ShutdownReport> =>
    (closing ??= runShutdownSequence({
      reason: 'close',
      dataDir,
      background,
      // 检查点要记的是真实状态，不是常量
      acceptingNewWork: () => server.listening,
      stopAcceptingNewWork: async () => {
        runtime.beginShutdown();
        await new Promise<void>((done) => {
          // 先断开已有连接（含 /api/events 订阅），再停止接受新连接
          server.closeAllConnections();
          server.close(() => done());
        });
      },
      closeStorage: async () => {
        await runtime.close();
        await runtime.messages.close();
      },
      releaseLock: () => lock.release(),
      lockSnapshot: () => lock.peek(),
    }));

  return {
    server,
    port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`,
    runtime,
    close,
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

  // 本机请求守卫（bug_yc9t7bf99uf1）：Host 必须回环、写操作来源必须是本应用、浏览器请求必须是 JSON。
  // 放在路由之前，未命中的路径也一并不被外站驱动
  const rejection = checkRequest(request);
  if (rejection) {
    json(response, rejection.status, { error: rejection.error, code: rejection.code });
    return;
  }

  if (path === '/api/health') {
    await handleHealthRoute(response, context);
    return;
  }

  if (path.startsWith('/api/settings/model')) {
    await handleModelSettingsRoute(request, response, context);
    return;
  }

  if (path === '/api/settings/preferences') {
    await handlePreferencesRoute(request, response, context);
    return;
  }

  // 界面事件的独立订阅（E3.4）：发送与订阅分离，断线只断订阅
  if (path === '/api/events' && method === 'GET') {
    handleEventsRoute(request, response, context);
    return;
  }

  if (path === '/api/chat/state' && method === 'GET') {
    const channels = (url.searchParams.get('channels') ?? '').split(',').filter(Boolean);
    json(response, 200, await context.runtime.chatSnapshot(channels));
    return;
  }

  if (path === '/api/bots' || path === '/api/agents') {
    await handleBotsCollection(request, response, context, method);
    return;
  }

  const botMatch = /^\/api\/bots\/([^/]+)$/.exec(path);
  if (
    botMatch &&
    (await handleBotItem(request, response, context, decodeURIComponent(botMatch[1] ?? ''), method))
  ) {
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

  const stopMatch = /^\/api\/control\/stops\/([^/]+)$/.exec(path);
  if (stopMatch && method === 'GET') {
    const stop = context.runtime.stopOperation(decodeURIComponent(stopMatch[1] ?? ''));
    if (!stop) {
      json(response, 404, { error: 'unknown stop' });
      return;
    }
    json(response, 200, stop);
    return;
  }

  const deliveryMatch = /^\/api\/deliveries\/([^/]+)$/.exec(path);
  if (deliveryMatch && method === 'GET') {
    const receipt = context.runtime.deliveryReceipt(decodeURIComponent(deliveryMatch[1] ?? ''));
    if (!receipt) {
      json(response, 404, { error: 'unknown receipt' });
      return;
    }
    json(response, 200, receipt);
    return;
  }

  if (path === '/api/control/stop-all' && method === 'POST') {
    json(response, 400, { error: 'UNSUPPORTED_STOP_SCOPE', code: 'UNSUPPORTED_STOP_SCOPE' });
    return;
  }

  // 控制存储修复（OPT-06）：损坏文件先备份，再以空状态重建并把已知同事置 paused。
  // 必须带确认字段，避免误触；修复后要用户逐个核对再恢复自动处理。
  if (path === '/api/control/repair' && method === 'POST') {
    const body = (await readJson(request).catch(() => ({}))) as { confirm?: unknown };
    if (body?.confirm !== 'repair') {
      json(response, 400, { error: '需要确认字段 confirm="repair"', code: 'CONFIRM_REQUIRED' });
      return;
    }
    const result = await context.runtime.repairControlStore();
    json(response, 200, result);
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
    json(response, 200, {
      ok: await context.runtime.secrets.remove(decodeURIComponent(secretMatch[1] ?? '')),
    });
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
