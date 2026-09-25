import { AgentService } from '../server/runtime/agent-service.js';
import { RunExecutor } from '../server/runtime/run-executor.js';
import { InboxScheduler } from '../server/runtime/inbox-scheduler.js';
import { effectiveToolNames } from '../tools/capabilities.js';
import { workerManagerOf } from '../tools/services/worker-manager.js';
import { createTaskTools } from '../tools/builtin/task.js';
import { createReadToolOutputTool } from '../tools/builtin/tool-output.js';
import { createManageRoomFlowTool } from '../tools/builtin/manage-room-flow.js';
import { createWorkbenchTools } from '../tools/builtin/workbench.js';
import { createSendToAgentDispatcher } from '../server/runtime/send-to-agent-service.js';
import type { Tool } from '../tools/tool.js';
import type { AgentRuntimeOptions } from '../server/runtime/types.js';
import type { createRuntimeStorage } from './storage-layer.js';
import { DEFAULT_MAX_AGENT_DEPTH, type createRuntimeServices } from './service-layer.js';
import type { RuntimeSharedState } from './host.js';
import type { RuntimeHost } from '../server/runtime/host.js';

/** 到点扫描间隔（E4.3）：不引入调度框架，用一个兜底定时器 + 启动扫描覆盖 */
const WAIT_SWEEP_INTERVAL_MS = 30_000;

/**
 * 回合执行与工具面装配（OPT-03）：AgentService / RunExecutor / 工具面 / 到期调度的唯一 new 处。
 *
 * 工具面要等 RunExecutor 建好（它引用同一份账本与工具依赖），inboxScheduler 又要等
 * inboxProcessor（上一层），所以这一层放在最后，由组合根把前面两层的结果传进来。
 */
export function createExecutionLayer(
  options: AgentRuntimeOptions,
  host: RuntimeHost,
  shared: RuntimeSharedState,
  store: ReturnType<typeof createRuntimeStorage>,
  services: ReturnType<typeof createRuntimeServices>,
) {
  const { events, locks } = shared;
  const {
    registry,
    control,
    activation,
    effects,
    messages,
    memory,
    compaction,
    rooms,
    inbox,
    ledger,
    chatRuns,
    works,
    waits,
    delegations,
    builder,
    compactor,
    extractor,
    roomFlowService,
    roomDispatcher,
    inboxProcessor,
    stopCoordinator,
    toolLedger,
    taskProgress,
    toolOutputs,
    projector,
    deliveries,
    workbench,
  } = { ...store, ...services };

  const agentService = new AgentService({
    registry,
    memory,
    compaction,
    createProvider: options.createProvider,
    defaultModel: options.defaultModel,
    knownModels: options.knownModels,
    budget: options.budget,
    tools: () => tools,
  });
  const executor = new RunExecutor({
    registry,
    messages,
    memory,
    inbox,
    builder,
    compactor,
    compaction,
    extractor,
    agentService,
    stopCoordinator,
    activation,
    effectRunner: effects,
    flowService: roomFlowService,
    drainInbox: (agentId, drainOptions) => host.drainInbox(agentId, drainOptions),
    canAutoActivate: (agentId) => {
      if (!control.allowsAutomaticExecution()) return false;
      return control.snapshot().agents[agentId]?.autoActivation !== 'paused';
    },
    locks,
    ledger,
    toolLedger,
    progress: taskProgress,
    outputs: toolOutputs,
    maxIterations: options.maxIterations,
    chatRuns,
    canResumeRoom: async (agentId, roomId) =>
      (await rooms.get(roomId))?.memberIds.includes(agentId) ?? false,
    publishResumedPosts: (agentId, continuation, posts, postOptions) =>
      roomDispatcher.publishResumedPosts(agentId, continuation, posts, postOptions),
    // E4.3：SendToUser 的提问类出口落成持久 WorkWait（工具不认识存储）
    requestUserWait: (agentId, input) => host.requestUserWaitCard(agentId, input),
    onMemory: (agentId, runId, added, merged) =>
      events.publish({ kind: 'agent', agentId, runId, payload: { type: 'memory', added, merged } }),
  });

  const tools: Tool<any>[] = [
    ...options.tools,
    ...(options.tools.some((tool) => tool.name === 'ReadToolOutput') ? [] : [createReadToolOutputTool()]),
    createManageRoomFlowTool(roomFlowService),
    ...createWorkbenchTools(workbench),
    createSendToAgentDispatcher({
      maxAgentChainDepth: options.maxAgentChainDepth ?? DEFAULT_MAX_AGENT_DEPTH,
      registry,
      workbench,
      delegations,
      deliveries,
      works,
      projector,
      inbox,
      watchInbox: (agentId) => inboxScheduler.watch(agentId),
      beginWait: (input) => host.beginWait(input),
      archiveLetter: (item) => host.archiveLetter(item),
    }),
    ...createTaskTools({
      provider: agentService.providerFor(options.defaultModel),
      messages,
      workerTools: async (ownerId) => {
        const owner = ownerId ? await registry.get(ownerId) : undefined;
        // 按派工者实际可用的工具面取（含恒定叠加的必需能力），工人再自行取交集
        return owner ? tools.filter((tool) => effectiveToolNames(owner.toolNames).includes(tool.name)) : [];
      },
      providerFor: (model) => agentService.providerFor(agentService.resolveModel(model)),
      ownerAuthority: async (ownerId) => {
        const owner = await registry.get(ownerId);
        return owner ? { toolNames: effectiveToolNames(owner.toolNames), projectIds: owner.projectIds } : undefined;
      },
      maxIterations: options.maxIterations,
      // TodoWrite → WorkStep（E4.1）：有正在进行的工作才记步骤
      onTodoWrite: async (agentId, todos) => {
        const work = await works.openWorkOf(agentId);
        if (!work) return;
        for (const todo of todos) {
          await works.appendStep({
            workId: work.id,
            id: todo.id,
            title: todo.content,
            status: todo.status,
          });
        }
      },
      invocations: toolLedger,
      dataDir: options.dataDir,
      progress: taskProgress,
      outputs: toolOutputs,
      // E8.4：后台工人登记进停机清单
      background: options.background,
      // ── E4.5 新增（都追加在参数表末尾，避免与并行分支撞在同一段插入）──
      // 工人是为派工者手头那件工作执行的（E4.1）；没有正在进行的工作就不关联
      workOf: async (ownerId) => (await works.openWorkOf(ownerId))?.id,
      // 工人收尾投递（E4.5）：结果作为一封信送回派工者，走既有 inbox/Delivery 链路
      onWorkerSettled: (worker) => host.deliverWorkerResult(worker),
    }),
  ];
  // 工人账本（E4.5）：启动扫描要能补送上次进程没送出的收尾结果
  const workerManager = workerManagerOf(tools);
  // 新同事默认拿到全部工具——包括工作台那一组
  registry.setDefaultToolNames(tools.map((tool) => tool.name));
  const inboxScheduler = new InboxScheduler({
    inbox,
    busy: (agentId) => host.isBusy(agentId) || inboxProcessor.isProcessing(agentId),
    exists: async (agentId) => Boolean(await registry.get(agentId)),
    process: (agentId) => host.drainInbox(agentId),
  });
  // 到点等待的兜底扫描（E4.3）：启动扫描在 recover() 里做一次，这之后靠定时器补
  const waitTimer = setInterval(() => {
    void host.sweepDueWaits().catch((error) => {
      console.warn(`等待到点扫描失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, WAIT_SWEEP_INTERVAL_MS);
  waitTimer.unref?.();


  return {
    agentService,
    executor,
    tools,
    workerManager,
    inboxScheduler,
    waitTimer,
  };
}
