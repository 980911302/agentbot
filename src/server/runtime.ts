import { ActivationCoordinator } from './runtime/activation-coordinator.js';
import { DeliveryService } from './runtime/delivery-service.js';
import { EffectRunner } from './runtime/effect-runner.js';
import { OutboxProjector } from './runtime/outbox-projector.js';
import { ModelConfigStore } from '../storage/model-config-store.js';
import { RuntimeControlStore } from '../storage/runtime-control-store.js';
import type { DeliveryReceipt } from '../shared/contracts/execution-control.js';
import { randomUUID } from 'node:crypto';
import { RoomFlowStore } from '../storage/room-flow-store.js';
import { RoomFlowService } from './runtime/room-flow-service.js';
import { RoomFlowScheduler } from './runtime/room-flow-scheduler.js';
import { RoomFlowRouter } from './runtime/room-flow-router.js';
import { ProtocolRegistry, SequentialTurnProtocol } from './runtime/room-flow-protocols.js';
import { createManageRoomFlowTool } from '../tools/builtin/manage-room-flow.js';
import type { RoomFlow } from '../shared/contracts/room-flow.js';
import { toRoomFlowView } from './presenters.js';
import { InboxScheduler } from './runtime/inbox-scheduler.js';
import type {
  Agent,
  AgentEvent,
  AgentEventHandler,
  AgentRecord,
  MemoryRef,
  Message,
  RunResult,
} from '../agent/types.js';
import { AgentLoop } from '../agent/agent-loop.js';
import { AgentRegistry } from '../agent/registry.js';
import { createWorkbenchTools } from '../tools/builtin/workbench.js';
import { Workbench } from '../workbench/service.js';
import { InteractionBroker } from '../interaction/broker.js';
import { SecretStore } from '../secret/store.js';
import { AgentInbox, type InboxItem } from '../agent/inbox.js';
import { CorrespondenceStore } from '../storage/correspondence-store.js';
import { DEFAULT_OWNER_NAME, DEFAULT_STOP_WORDS, isStopSentence } from '../config.js';
import type { SettingsStore } from '../settings/store.js';
import { ContextBuilder, type BuiltContext, type BuildOptions } from '../context/builder.js';
import type { ContextBudget } from '../context/budget.js';
import type { LLMProvider } from '../llm/provider.js';
import { OpenAIProvider } from '../llm/openai-provider.js';
import { CompactionStore, Compactor } from '../memory/compact.js';
import { MemoryExtractor } from '../memory/extract.js';
import { USER_OWNER } from '../memory/policy.js';
import { MemoryStore } from '../memory/store.js';
import type { MemoryScope, MemorySnapshot, MemoryTier } from '../memory/types.js';
import { resolveMentions, stripMentions } from '../room/mentions.js';
import type { RoomMemberLike } from '../room/member.js';
import { RoomStore } from '../room/store.js';
import { SummonQueue } from '../room/summon.js';
import { buildAgentBrief, buildRoomBrief, decideRoomPosts } from '../room/turn.js';
import type { RoomMessage, RoomEvent, RoomEventHandler, RoundOutcome, RoundStatus } from '../room/types.js';
import { ROOM_MAX_RUNS_PER_MEMBER, ROOM_POST_LIMIT_PER_TURN } from '../room/types.js';
import { MessageStore } from '../store/messages.js';
import { resolveProjectOwner } from '../tools/builtin/memory.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSendToAgentTool } from '../tools/builtin/room.js';
import { createTaskTools } from '../tools/builtin/task.js';
import { createReadToolOutputTool } from '../tools/builtin/tool-output.js';
import { ToolOutputStore } from '../tools/services/tool-output-store.js';
import { TaskProgressStore } from '../storage/task-progress.js';
import type { Tool, TurnState } from '../tools/tool.js';

// 类型与错误定义已抽到 ./types（E2.2 第一步）；这里按原名 re-export 保持兼容
import {
  type AcceptedRun,
  type AgentRuntimeOptions,
  type PendingStop,
  type RoomRoundSummary,
  type SendOptions,
  type SendResult,
  type StartupReport,
  type TurnResult,
  AgentBusyError,
} from './runtime/types.js';
import { AgentService } from './runtime/agent-service.js';
import { StopCoordinator } from './runtime/stop-coordinator.js';
import { DELIVERY_DEFAULTS, InboxProcessor } from './runtime/inbox-processor.js';
import { planRecovery } from '../tools/policy.js';
import { RunExecutor } from './runtime/run-executor.js';
import { RoomDispatcher } from './runtime/room-dispatcher.js';
import { ReceivedStore } from '../storage/received-store.js';
import { JsonRunLedger } from '../storage/run-ledger.js';
import type { RunLedger } from '../storage/run-ledger.js';
import { JsonToolInvocationLedger } from '../storage/tool-ledger.js';
import { EventJournal } from './events/journal.js';
import { ChatRunCoordinator } from './runtime/chat-run-coordinator.js';
import { isActiveChatRun } from '../shared/contracts/chat-state.js';
import {
  toDisplayMessages,
  toCorrespondenceView,
  collectArtifacts,
  privateConversationMessages,
} from './presenters.js';
export * from './runtime/types.js';

const DEFAULT_MAX_AGENT_DEPTH = 3;
const OWNER_ID = 'owner';

interface TurnInput {
  text: string;
  source: 'user' | 'room' | 'agent';
  roomId?: string;
  roomName?: string;
  speaker?: string;
  brief?: string;
  /** 这一轮要显式区分「谁在跟它说话」时用 */
  toolContext?: {
    room?: { roomId: string; roomName: string; posts: string[]; limit: number };
    agentChainDepth?: number;
  };
  extraTools?: Tool<any>[];
  posts?: string[];
  stamp?: Partial<Pick<Message, 'roomId' | 'roomName' | 'speaker' | 'source'>>;
}

/**
 * 智能体运行时。
 *
 * 一次「回合」参见 docs/架构设计.md「群与同事协作」中的回合定义：
 *   看见 → 判断树 → 0~N 条纯文本出站
 * 群本身没有大脑：投递器把入站消息扇出给成员，各自决定说不说。
 */
export class AgentRuntime {
  readonly registry: AgentRegistry;
  readonly messages: MessageStore;
  readonly memory: MemoryStore;
  readonly compaction: CompactionStore;
  readonly rooms: RoomStore;
  readonly inbox: AgentInbox;
  readonly correspondence: CorrespondenceStore;

  readonly workbench: Workbench;
  readonly broker: InteractionBroker;
  readonly secrets: SecretStore;
  /** 模型配置（设置页热切换）；routes 经此访问，不直连 storage */
  readonly modelConfigStore: ModelConfigStore;
  readonly dataDir: string;

  /** 全量工具面（常驻 + 平台层），/api/health 与新同事默认表都从这里来 */
  readonly tools: Tool<any>[];
  private readonly builder: ContextBuilder;
  private readonly compactor: Compactor;
  private readonly extractor: MemoryExtractor;
  /** 身份装配与模型解析（E2.2 拆出） */
  private readonly agentService: AgentService;
  /** 停止令的认词、排队与执行（E2.2 拆出） */
  private readonly stopCoordinator: StopCoordinator;
  /** 同事来信的消费（E2.2 拆出） */
  private readonly inboxProcessor: InboxProcessor;
  private readonly inboxScheduler: InboxScheduler;
  /** 回合执行核心（E2.2 拆出）：调度/记账/模型循环/记忆收尾 */
  private readonly executor: RunExecutor;
  /** 接收幂等日志（E3.2） */
  private readonly receivedStore: ReceivedStore;
  /** 群三波扇出（E2.2 拆出） */
  private readonly roomDispatcher: RoomDispatcher;
  private readonly locks = new Set<string>();

  /** 回合与任务树账本（E3.3 接线；见 docs/架构设计.md「插话、停止和等待」） */
  private readonly ledger: RunLedger;
  /** 事件日志（E3.4）：发送与订阅分离的基础；断线只断订阅，不牵动执行 */
  readonly events = new EventJournal();
  readonly chatRuns: ChatRunCoordinator;
  /** 工具执行账本（E3.5）：先记意图再执行再记结果；中断的调用留在这里等核对 */
  readonly toolLedger: JsonToolInvocationLedger;
  readonly taskProgress: TaskProgressStore;
  readonly toolOutputs: ToolOutputStore;
  /** 撞上正在跑的用户回合的停止令：回合结束立刻处理 */
  private readonly pendingStops = new Map<string, PendingStop[]>();
  private readonly control: RuntimeControlStore;
  readonly activation: ActivationCoordinator;
  private readonly deliveries: DeliveryService;
  private readonly projector: OutboxProjector;
  readonly effects: EffectRunner;
  readonly roomFlowStore: RoomFlowStore;
  readonly protocolRegistry: ProtocolRegistry;
  readonly roomFlowService: RoomFlowService;
  readonly roomFlowScheduler: RoomFlowScheduler;
  readonly roomFlowRouter: RoomFlowRouter;
  private readonly runExecutions = new Map<string, Promise<SendResult>>();

  constructor(readonly options: AgentRuntimeOptions) {
    this.dataDir = options.dataDir;
    this.chatRuns = new ChatRunCoordinator(options.dataDir, this.events);
    this.ledger = new JsonRunLedger(options.dataDir);
    this.registry = new AgentRegistry(options.dataDir, []);
    this.control = RuntimeControlStore.openSync(options.dataDir, {
      // 接近软上限时告警：真撞上去 transact 会直接拒绝，同事之间的投递就失败了
      onNearLimit: (bytes, limit) => {
        console.warn(
          `控制存储已达 ${(bytes / 1024).toFixed(0)}KiB／上限 ${(limit / 1024).toFixed(0)}KiB：` +
            '已终结票据超量时会拒绝新写入，请减小 ticketRetention 或清理历史数据',
        );
      },
    });
    this.activation = new ActivationCoordinator(this.control, {
      processEpoch: this.control.currentProcessEpoch,
      exists: async (agentId) => Boolean(await this.registry.get(agentId)),
    });
    this.effects = new EffectRunner(this.activation);
    this.deliveries = new DeliveryService(this.control);
    this.messages = new MessageStore(options.dataDir);
    this.memory = options.memoryStore ?? new MemoryStore(options.dataDir);
    this.compaction = new CompactionStore(options.dataDir);
    this.rooms = new RoomStore(options.dataDir);
    this.inbox = new AgentInbox(options.dataDir);
    this.correspondence = new CorrespondenceStore(options.dataDir);
    this.projector = new OutboxProjector({
      store: this.control,
      inbox: this.inbox,
      correspondence: this.correspondence,
      rooms: this.rooms,
      messages: this.messages,
    });
    this.roomFlowStore = new RoomFlowStore(options.dataDir);
    this.protocolRegistry = new ProtocolRegistry();
    const defaultSeqProtocol = new SequentialTurnProtocol();
    this.protocolRegistry.register('sequential-turn', defaultSeqProtocol);
    this.protocolRegistry.register('sequential_turn', defaultSeqProtocol);
    this.roomFlowService = new RoomFlowService({
      store: this.roomFlowStore,
      rooms: this.rooms,
      protocols: this.protocolRegistry,
      resolveAgentName: async (agentId) => (await this.registry.get(agentId))?.name,
      publishTimelineMessage: async (msg) => {
        await this.rooms.appendIfAbsent(msg);
        this.events.publish({
          kind: 'room',
          roomId: msg.roomId,
          payload: { type: 'room_message', message: msg },
        });
      },
      onGrantReady: async (flow, grant) => {
        await this.roomFlowScheduler.scheduleGrant(flow, grant);
      },
      onFlowUpdated: (flow) => {
        this.events.publish({
          kind: 'room',
          roomId: flow.roomId,
          payload: { type: 'flow_updated', flow: toRoomFlowView(flow) },
        });
      },
    });
    this.roomFlowScheduler = new RoomFlowScheduler({
      inbox: this.inbox,
      flowService: this.roomFlowService,
      drainInbox: (agentId) => this.inboxScheduler?.watch(agentId),
    });
    this.broker = options.broker ?? new InteractionBroker();
    this.secrets = options.secrets ?? new SecretStore(options.dataDir);
    this.modelConfigStore = options.modelConfigStore ?? new ModelConfigStore(options.dataDir);
    this.stopCoordinator = new StopCoordinator({
      registry: this.registry,
      messages: this.messages,
      inbox: this.inbox,
      rooms: this.rooms,
      broker: this.broker,
      ledger: this.ledger,
      pendingStops: this.pendingStops,
      stopWords: options.stopWords ?? DEFAULT_STOP_WORDS,
      stopAckTimeoutMs: options.stopAckTimeoutMs ?? 30_000,
      activation: this.activation,
      effects: this.effects,
    });

    this.roomFlowRouter = new RoomFlowRouter({
      rooms: this.rooms,
      flowService: this.roomFlowService,
      stopCoordinator: this.stopCoordinator,
      isStopSentence: (text) => isStopSentence(text, options.stopWords ?? DEFAULT_STOP_WORDS),
    });
    this.builder = new ContextBuilder(this.messages, options.budget);
    this.compactor = new Compactor(
      this.messages,
      this.compaction,
      options.budget.compactionTrigger,
      options.budget.reserveRecent,
    );
    this.extractor = new MemoryExtractor(this.memory, options.memoryExtraction);

    // 工作台：智能体在对话里替用户改工作台（建同事、建群、拉人、代群发言）
    this.workbench = new Workbench({
      registry: this.registry,
      rooms: this.rooms,
      messages: this.messages,
      // 新建同事务必登记 enabled，否则重启后会被迁移逻辑当成旧智能体暂停
      enrollAgent: (agentId) => this.enrollAgent(agentId),
      postToRoom: async (roomId, text, excludeAgentIds, agentChainDepth, signal, callerId) => {
        if (!callerId) throw new Error('代群发言缺少真实发送者');
        const summary = await this.roomDispatcher.enqueueMessage(roomId, text, {
          excludeAgentIds,
          agentChainDepth,
          signal,
          roomSenderId: callerId,
          onRoomEvent: (payload) => this.events.publish({ kind: 'room', roomId, payload }),
        });
        for (const member of (await this.rooms.get(roomId))?.memberIds ?? [])
          if (member !== callerId) this.inboxScheduler.watch(member);
        return { roomName: summary.roomName, roundId: summary.roundId };
      },
    });

    this.roomDispatcher = new RoomDispatcher({
      registry: this.registry,
      rooms: this.rooms,
      messages: this.messages,
      inbox: this.inbox,
      locks: this.locks,
      membersOf: (roomId) => this.membersOf(roomId),
      ownerNameFallback: () => this.ownerName(),
      stopWords: options.stopWords ?? DEFAULT_STOP_WORDS,
      runTurn: (agentId, task, turn, options) => this.runTurn(agentId, task, turn, options),
      // 只通知调度器，绝不沿发送方的栈递归执行收件人。
      drainInbox: (agentId) => this.inboxScheduler.watch(agentId),
      router: this.roomFlowRouter,
    });

    this.inboxProcessor = new InboxProcessor({
      inbox: this.inbox,
      registry: this.registry,
      maxAgentChainDepth: this.options.maxAgentChainDepth ?? DEFAULT_MAX_AGENT_DEPTH,
      stopCoordinator: this.stopCoordinator,
      // stop-ack 由这里确认并登记给等待中的停止令，不再靠 take 去信箱里抢
      onStopAck: (agentId, item) => this.stopCoordinator.noteStopAck(agentId, item.fromAgentId, item.treeId),
      runTurn: (agentId, task, turn, options) =>
        this.runTurn(agentId, task, { extraTools: [], ...turn }, options),
      // 排队的群回合：事件按 roomId 归属（前端据此路由到群频道）
      deliverRoom: async (item, options) => {
        const roomId = item.room?.roomId ?? '';
        const { run } = await this.chatRuns.prepare({
          channelId: roomId,
          roomId,
          kind: 'room',
          source: 'room',
          input: item.text,
          messageId: item.checkpoint?.messageId,
        });
        const scoped = this.chatRuns.bind(run, options);
        return this.chatRuns.execute(
          run.runId,
          () => this.roomDispatcher.deliverQueued(item, scoped),
          (result) => {
            if (result.status === 'error') throw new Error(result.note ?? '延迟群回合执行失败');
            return {};
          },
        );
      },
      archiveLetter: (item) => this.archiveLetter(item),
      admit: async (item) => {
        const decision = await this.activation.tryActivate({
          agentId: item.toAgentId,
          runId: item.id,
          taskId: item.id,
          inputId: item.id,
          chainId: item.chainId ?? item.correlationId ?? item.id,
          source: item.kind === 'room' ? 'room' : 'inbox',
          disposition: item.disposition,
          lease:
            item.leaseOwner && item.leaseEpoch !== undefined
              ? { deliveryId: item.id, ownerId: item.leaseOwner, epoch: item.leaseEpoch }
              : undefined,
          flowId: item.flowId,
          flowGrantId: item.grantId,
          replyRoute: item.replyRoute,
        });
        if (decision.kind === 'admitted') {
          await this.activation.markRunning(decision.ticket);
        }
        return decision;
      },
      settleTicket: (ticketId) => this.activation.settleTicket(ticketId),
      canRetry: async (agentId, messageId) => {
        const all = this.chatRuns.list();
        const ids = new Set(
          all
            .filter((run) => run.messageId === messageId && (!run.agentId || run.agentId === agentId))
            .map((run) => run.runId),
        );
        for (let size = -1; size !== ids.size;) {
          size = ids.size;
          for (const run of all) if (run.parentRunId && ids.has(run.parentRunId)) ids.add(run.runId);
        }
        const runs = all.filter((run) => ids.has(run.runId) && run.agentId === agentId);
        // 只有"查得到运行、而且其中真有人动过手"才判不可重试。
        // 查不到记录（运行账本按 1000 条上限裁掉、任务进度按 500 条裁掉、或换了进程）
        // 时无法证明有副作用，不能据此把信判死——那会让长期实例在清理后永久丢信。
        if (runs.length === 0) return true;
        return runs.every((run) => {
          const progress = this.taskProgress.get(run.runId, agentId);
          return progress === undefined || progress.mayHaveSideEffects === false;
        });
      },
      leaseMs: options.deliveryLeaseMs,
      maxAttempts: options.deliveryMaxAttempts,
      baseDelayMs: options.deliveryBaseDelayMs,
    });

    this.agentService = new AgentService({
      registry: this.registry,
      memory: this.memory,
      compaction: this.compaction,
      createProvider: options.createProvider,
      defaultModel: options.defaultModel,
      knownModels: options.knownModels,
      budget: options.budget,
      tools: () => this.tools,
    });

    this.receivedStore = new ReceivedStore(options.dataDir);
    this.toolLedger = new JsonToolInvocationLedger(options.dataDir);
    this.taskProgress = new TaskProgressStore(options.dataDir);
    this.toolOutputs = new ToolOutputStore(options.dataDir);

    this.executor = new RunExecutor({
      registry: this.registry,
      messages: this.messages,
      memory: this.memory,
      inbox: this.inbox,
      builder: this.builder,
      compactor: this.compactor,
      compaction: this.compaction,
      extractor: this.extractor,
      agentService: this.agentService,
      stopCoordinator: this.stopCoordinator,
      activation: this.activation,
      effectRunner: this.effects,
      flowService: this.roomFlowService,
      drainInbox: (agentId, options) => this.drainInbox(agentId, options),
      canAutoActivate: (agentId) => {
        if (!this.control.allowsAutomaticExecution()) return false;
        return this.control.snapshot().agents[agentId]?.autoActivation !== 'paused';
      },
      locks: this.locks,
      ledger: this.ledger,
      toolLedger: this.toolLedger,
      progress: this.taskProgress,
      outputs: this.toolOutputs,
      maxIterations: options.maxIterations,
      chatRuns: this.chatRuns,
      canResumeRoom: async (agentId, roomId) =>
        (await this.rooms.get(roomId))?.memberIds.includes(agentId) ?? false,
      publishResumedPosts: (agentId, continuation, posts, opts) =>
        this.roomDispatcher.publishResumedPosts(agentId, continuation, posts, opts),
      onMemory: (agentId, runId, added, merged) =>
        this.events.publish({ kind: 'agent', agentId, runId, payload: { type: 'memory', added, merged } }),
    });

    this.tools = [
      ...options.tools,
      ...(options.tools.some((tool) => tool.name === 'ReadToolOutput') ? [] : [createReadToolOutputTool()]),
      createManageRoomFlowTool(this.roomFlowService),
      ...createWorkbenchTools(this.workbench),
      this.createSendToAgentTool(),
      ...createTaskTools({
        provider: this.agentService.providerFor(this.options.defaultModel),
        messages: this.messages,
        workerTools: async (ownerId) => {
          const owner = ownerId ? await this.registry.get(ownerId) : undefined;
          return owner ? this.tools.filter((tool) => owner.toolNames.includes(tool.name)) : [];
        },
        providerFor: (model) => this.agentService.providerFor(this.agentService.resolveModel(model)),
        ownerAuthority: async (ownerId) => {
          const owner = await this.registry.get(ownerId);
          return owner ? { toolNames: owner.toolNames, projectIds: owner.projectIds } : undefined;
        },
        maxIterations: this.options.maxIterations,
        invocations: this.toolLedger,
        dataDir: this.options.dataDir,
        progress: this.taskProgress,
        outputs: this.toolOutputs,
      }),
    ];
    // 新同事默认拿到全部工具——包括工作台那一组
    this.registry.setDefaultToolNames(this.tools.map((tool) => tool.name));
    this.inboxScheduler = new InboxScheduler({
      inbox: this.inbox,
      busy: (agentId) => this.isBusy(agentId) || this.inboxProcessor.isProcessing(agentId),
      exists: async (agentId) => Boolean(await this.registry.get(agentId)),
      process: (agentId) => this.drainInbox(agentId),
    });
  }

  async close(): Promise<void> {
    this.inboxScheduler.close();
    await Promise.all([this.executor.close(), this.inboxProcessor.close()]);
  }

  // ── 智能体 ──────────────────────────────────────────

  /**
   * 新建智能体时登记 enabled 控制条目（bug_trhd1ffe8580）。
   *
   * 没有条目的话，重启时迁移逻辑会把它当成「升级前的旧智能体」打上 paused，
   * 于是新建的同事一重启就在群里静默。创建时写 entry，就不必依赖迁移兜底。
   */
  async enrollAgent(agentId: string): Promise<void> {
    await this.control
      .transact((draft) => {
        if (draft.agents[agentId]) return 'skip';
        draft.agents[agentId] = {
          agentId,
          generation: 0,
          autoActivation: 'enabled',
          revision: 0,
        };
      })
      .catch(() => undefined);
  }

  /** 建同事：登记 + 立刻给 enabled 控制条目 */
  async createAgent(input: Parameters<AgentRegistry['create']>[0]): Promise<AgentRecord> {
    const record = await this.registry.create(input);
    await this.enrollAgent(record.id);
    return record;
  }

  /**
   * 删同事的统一生命周期入口（bug_x3wyowcuabut）。
   *
   * 两个删除接口此前各做一半：/api/agents/:id 只清消息与注册表、不查忙碌，
   * /api/bots/:id 查忙碌并清消息/记忆/摘要，但都不清收件箱与排队投递、不移出
   * 群成员表、不清控制条目与待答卡。删完 id 还留在群 memberIds 里，点名解析
   * 与投递都会继续指向一个不存在的同事。这里收敛成一条路径。
   *
   * 保留的审计信息：往来档案、任务进度、运行与工具账本（都是历史事实）。
   */
  async removeAgent(agentId: string): Promise<{ removed: boolean }> {
    if (this.isBusy(agentId)) {
      throw Object.assign(new Error('这个智能体正在跑任务，等它结束后再删'), { code: 'AGENT_BUSY' });
    }
    const removed = await this.registry.remove(agentId);
    if (!removed) return { removed: false };

    // 对话线与自己的记忆、压缩摘要：没有同事就没有主人
    await this.messages.clear(agentId);
    await this.memory.clear('self', agentId);
    await this.compaction.clear(agentId);
    // 收件箱与还没处理的来信：同事没了，信没有归属
    await this.inbox.clear(agentId);
    // 等用户回答的卡片：留着会永远挂着（停止协调器已封装「取消该智能体全部待答卡」）
    this.stopCoordinator.voidPendingInteractions(agentId);
    // 从所有群的成员表移出，避免点名与扇出指向已删同事
    for (const room of await this.rooms.list()) {
      if (!room.memberIds.includes(agentId)) continue;
      await this.rooms.setMembers(
        room.id,
        room.memberIds.filter((id) => id !== agentId),
      );
    }
    // 控制条目、票据与许可
    await this.activation.forgetAgent(agentId);
    return { removed: true };
  }

  async ensureDefaultAgent(): Promise<AgentRecord> {
    const list = await this.registry.list();
    for (const seed of this.options.seed ?? []) {
      if (list.some((item) => item.name === seed.name)) continue;
      await this.createAgent(seed);
    }

    await this.registry.syncDefaultTools();
    await this.migrateExistingAgents();

    const refreshed = await this.registry.list();
    const preferred = this.options.seed?.[this.options.seed.length - 1]?.name;
    return (
      refreshed.find((item) => item.name === preferred) ??
      refreshed[0] ??
      (await this.createAgent({ name: '通用助手' }))
    );
  }

  /** 预置房间；成员名解析不到就跳过 */
  async ensureSeedRooms(): Promise<void> {
    const seeds = this.options.seedRooms ?? [];
    if (seeds.length === 0) return;
    const agents = await this.registry.list();
    const existing = await this.rooms.list();

    for (const seed of seeds) {
      if (existing.some((room) => room.name === seed.name)) continue;
      const memberIds = seed.memberNames
        .map((name) => agents.find((agent) => agent.name === name)?.id)
        .filter((id): id is string => Boolean(id));
      if (memberIds.length === 0) continue;
      await this.rooms.create({ name: seed.name, memberIds });
    }
  }

  async buildAgent(record: AgentRecord): Promise<Agent> {
    return this.agentService.buildAgent(record);
  }

  async membersOf(
    roomId: string,
  ): Promise<{ room: Awaited<ReturnType<RoomStore['get']>>; members: AgentRecord[] }> {
    const room = await this.rooms.get(roomId);
    if (!room) return { room: undefined, members: [] };
    const all = await this.registry.list();
    const members = room.memberIds
      .map((id) => all.find((agent) => agent.id === id))
      .filter((record): record is AgentRecord => Boolean(record));
    return { room, members };
  }

  // ── 记忆 ────────────────────────────────────────────

  /**
   * 手动写入一条记忆。
   * 项目作用域必须归属明确——多项目时要求显式 projectId，不猜。
   */
  async remember(
    agentId: string,
    input: {
      text: string;
      scope?: MemoryScope;
      tier?: MemoryTier;
      tags?: string[];
      projectId?: string;
    },
  ): Promise<MemoryRef> {
    const record = await this.registry.get(agentId);
    const scope = input.scope ?? 'self';
    let ownerId = agentId;

    if (scope === 'user') {
      ownerId = USER_OWNER;
    } else if (scope === 'project') {
      const available = record?.projectIds ?? [];
      const resolved = resolveProjectOwner(input.projectId, available);
      if ('error' in resolved) throw new Error(resolved.error);
      ownerId = resolved.ownerId;
    }

    const result = await this.memory.write({
      scope,
      tier: input.tier ?? 'log',
      ownerId,
      text: input.text,
      tags: input.tags ?? [],
      source: 'user',
    });
    return { entry: result.entry, scope, ownerId };
  }

  async snapshotMemory(agentId: string): Promise<MemorySnapshot | undefined> {
    const record = await this.registry.get(agentId);
    if (!record) return undefined;
    return this.memory.snapshot(agentId, { projectIds: record.projectIds });
  }

  async previewContext(agentId: string): Promise<BuiltContext | undefined> {
    const record = await this.registry.get(agentId);
    if (!record) return undefined;
    const agent = await this.buildAgent(record);
    const recent = await this.messages.recent(agentId, 1);
    const task: Message = recent[0] ?? {
      id: 'preview',
      agentId,
      role: 'user',
      content: { type: 'text', text: '' },
      createdAt: Date.now(),
    };
    return this.builder.build(agent, task);
  }

  // ── 事件日志（E3.4：发送与订阅分离）───────────────

  /** 恢复读模型。游标与运行快照一起返回，读取失败不推进游标。 */
  async chatSnapshot(channelIds: string[]) {
    if (channelIds.length > 100 || channelIds.some((id) => !/^[\w-]{1,128}$/.test(id)))
      throw new Error('无效的频道列表');
    return this.events.snapshot(async () => {
      const channels: Record<
        string,
        { messages: ReturnType<typeof toDisplayMessages>; artifacts: ReturnType<typeof collectArtifacts> }
      > = {};
      for (const id of new Set(channelIds)) {
        const room = await this.rooms.get(id);
        if (room) {
          channels[id] = {
            messages: (await this.rooms.messages(id)).map((message) => ({
              id: message.id,
              role: message.senderKind === 'user' ? ('user' as const) : ('assistant' as const),
              content: message.text,
              senderName: message.senderName,
              senderColor: message.senderColor,
              clientMessageId: message.clientMessageId,
              toolCalls: [],
              createdAt: new Date(message.createdAt).toISOString(),
            })),
            artifacts: [],
          };
        } else {
          const messages = await this.messages.list(id);
          const privateMessages = privateConversationMessages(messages);
          channels[id] = {
            messages: await this.displayMessages(id, privateMessages),
            artifacts: collectArtifacts(privateMessages),
          };
        }
      }
      const agentControls: Record<
        string,
        { autoActivation: 'enabled' | 'paused'; generation: number; lastStopId?: string }
      > = {};
      for (const id of new Set(channelIds)) {
        const view = this.controlView(id);
        agentControls[id] = {
          autoActivation: view.autoActivation,
          generation: view.generation,
          lastStopId: view.lastStopId,
        };
      }
      return { channels, runs: this.chatRuns.list(), interactions: this.broker.list(), agentControls };
    });
  }

  // ── 收信与执行分离（E3.4 第二步）────────────────────

  async displayMessages(agentId: string, raw?: Message[]) {
    const transfers = (await this.correspondence.list(agentId)).map(toCorrespondenceView);
    const privateMessages = privateConversationMessages(raw ?? (await this.messages.list(agentId)));
    return [...toDisplayMessages(privateMessages), ...transfers].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }

  private async archiveLetter(item: InboxItem): Promise<void> {
    if (item.kind && item.kind !== 'message') return;
    const from = item.fromActor ?? { kind: 'agent' as const, id: item.fromAgentId, name: item.fromName };
    const target = item.toActor ? undefined : await this.registry.get(item.toAgentId);
    const to = item.toActor ?? {
      kind: 'agent' as const,
      id: item.toAgentId,
      name: target?.name ?? '已删除的智能体',
      color: target?.color,
      avatar: target?.avatar,
    };
    const transfer = {
      id: item.id,
      from,
      to,
      text: item.text,
      ...(item.images?.length ? { images: item.images } : {}),
      createdAt: item.createdAt,
    };
    await this.correspondence.record(transfer);
    // 可以重复发布；快照和实时事件均按同一个投递 id 去重。
    for (const agentId of new Set([from.id, to.id]))
      this.events.publish({ kind: 'agent', agentId, payload: { type: 'correspondence', transfer } });
  }

  /**
   * 先持久接收：去重 → 落消息、写事件日志 → 回执。
   * 返回的 execute 由调用方决定何时执行：HTTP 立刻回 202，回合在后台继续跑，
   * 事件全部走 EventJournal（断线只断订阅）。
   */
  async acceptMessage(
    agentId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<AcceptedRun<SendResult>> {
    return this.chatRuns.accept(`dm:${agentId}:${options.clientMessageId ?? randomUUID()}`, () =>
      this.acceptMessageInner(agentId, text, options),
    );
  }

  private async acceptMessageInner(
    agentId: string,
    text: string,
    options: SendOptions,
  ): Promise<AcceptedRun<SendResult>> {
    const clientMessageId = options.clientMessageId;

    if (clientMessageId) {
      const existing = this.receivedStore.find(clientMessageId);
      if (existing && existing.agentId === agentId) {
        const original = (await this.messages.list(agentId)).find(
          (message) => message.id === existing.messageId,
        );
        if (original) {
          // E3.2：重复提交返回原消息，不开新回合
          return {
            receipt: {
              messageId: original.id,
              agentId,
              receiptSeq: this.events.latestSeq,
              duplicate: true,
            },
            execute: () => this.duplicateRun(agentId, original, options),
          };
        }
      }
    }

    if (!(await this.registry.get(agentId))) throw new Error(`Unknown agent: ${agentId}`);

    // 用户新句作废还没回答的选项卡——不当答案（§2）
    let resumeTaskId = options.resumeTaskId;
    if (
      !resumeTaskId &&
      /^(继续|继续上个任务|继续刚才的任务|接着做|恢复上个任务)[。！!]?$/u.test(text.trim())
    ) {
      const latest = this.taskProgress.list(agentId)[0];
      if (latest && ['incomplete', 'failed', 'interrupted', 'cancelled', 'parked'].includes(latest.status))
        resumeTaskId = latest.id;
    }
    const previous = clientMessageId
      ? this.chatRuns
          .list()
          .find((run) => run.channelId === agentId && run.clientMessageId === clientMessageId)
      : undefined;
    if (resumeTaskId && !previous) {
      const checkpoint = this.taskProgress.get(resumeTaskId, agentId);
      if (!checkpoint || checkpoint.scope !== 'dm' || checkpoint.status === 'running')
        throw new Error('找不到当前智能体已停止的任务进度');
    }
    const stop = this.stopCoordinator.isStopSentence(text);
    if (this.control.faulted && !stop) {
      throw Object.assign(new Error('控制数据损坏，已进入保护模式：去设置 → 高级 → 修复控制数据'), {
        code: 'CONTROL_FAULTED',
      });
    }
    const commandId = clientMessageId ?? randomUUID();
    let authorization: Awaited<ReturnType<ActivationCoordinator['acceptUserInput']>> | undefined;
    if (!stop) {
      authorization = await this.activation.acceptUserInput({
        commandId,
        agentId,
        inputId: commandId,
        text,
      });
    }
    const { run, duplicate } = await this.chatRuns.prepare(
      {
        channelId: agentId,
        agentId,
        kind: stop ? 'stop' : 'agent',
        source: 'user',
        input: text,
        clientMessageId,
        messageId: randomUUID(),
        parentRunId: resumeTaskId,
      },
      [options.model ?? '', options.resumeTaskId ?? ''],
    );
    const opts = this.chatRuns.bind(run, options);

    const task: Message = {
      id: run.messageId!,
      runId: run.runId,
      agentId,
      role: 'user',
      content: { type: 'text', text },
      createdAt: Date.now(),
      source: 'user',
      sender: { kind: 'user', id: OWNER_ID, name: this.ownerName() },
      ...(clientMessageId ? { clientMessageId } : {}),
    };
    // 先落盘再回执：客户端拿到 messageId 时消息已经在库里（E3.2/E3.4）
    if (!duplicate) {
      try {
        await this.messages.append(task);
        opts.onEvent?.({ type: 'message', message: task });
        this.stopCoordinator.voidPendingInteractions(agentId, opts.onEvent);
      } catch (error) {
        await this.chatRuns.fail(run.runId, error);
        throw error;
      }
    }

    const executeOnce = async (): Promise<SendResult> => {
      if (!isActiveChatRun(this.chatRuns.get(run.runId)!)) return this.duplicateRun(agentId, task, options);
      this.executor.cancelMaintenance(agentId);
      if (stop) {
        return this.chatRuns.execute(
          run.runId,
          () => this.stopCoordinator.stopFromUser(agentId, text, opts),
          (result) => result,
        );
      }
      if (authorization) {
        const decision = await this.activation.tryActivate({
          agentId,
          runId: run.runId,
          taskId: run.taskId,
          inputId: authorization.inputId,
          chainId: authorization.chainId,
          source: 'user',
          grantId: authorization.grantId,
        });
        if (decision.kind !== 'admitted') {
          throw Object.assign(new Error(decision.kind === 'held' ? decision.reason : decision.kind), {
            code: 'STALE_ACTIVATION',
          });
        }
        await this.activation.markRunning(decision.ticket);
        return this.runTurn(
          agentId,
          task,
          { skipPersist: true, resumeTaskId },
          { ...opts, authorization: decision.ticket },
        );
      }
      return this.runTurn(agentId, task, { skipPersist: true, resumeTaskId }, opts);
    };
    let inflight = this.runExecutions.get(run.runId);
    if (!inflight) {
      inflight = executeOnce().finally(() => {
        if (this.runExecutions.get(run.runId) === inflight) this.runExecutions.delete(run.runId);
      });
      this.runExecutions.set(run.runId, inflight);
    }
    return {
      receipt: {
        runId: run.runId,
        taskId: run.taskId,
        run: this.chatRuns.get(run.runId),
        messageId: task.id,
        agentId,
        receiptSeq: this.events.latestSeq,
        duplicate,
      },
      execute: () => inflight,
    };
  }

  /** 兼容入口：接了就执行（CLI、测试与内部调用都用它） */
  async send(agentId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    const accepted = await this.acceptMessage(agentId, text, options);
    return accepted.execute();
  }

  /** 重复提交的重放：原消息再报一次（客户端按 id 去重），不再开回合 */
  private async duplicateRun(agentId: string, original: Message, options: SendOptions): Promise<SendResult> {
    options.onEvent?.({ type: 'message', message: original });
    const record = await this.registry.get(agentId);
    return {
      content: original.content.type === 'text' ? original.content.text : '',
      iterations: 0,
      stopReason: 'duplicate',
      agentId,
      agentName: record?.name ?? agentId,
      context: {
        agentId,
        system: '',
        messages: [],
        stats: { sections: [], totalTokens: 0, budgetTokens: 0, generatedAt: Date.now() },
        surfaced: [],
        droppedRecent: 0,
        droppedGroups: 0,
      },
      posts: [],
      status: 'silent',
    };
  }

  // ── 群回合：扇出叫醒（搬至 RoomDispatcher，此处保持兼容入口）──

  /**
   * 用户往房间发一条 → 扇出给全体成员（三波次见 RoomDispatcher）。
   * `@` 是强信号不是投递开关：没被点名的一样进这一轮，只是不强制开口。
   */
  async postToRoom(roomId: string, text: string, options: SendOptions = {}): Promise<RoomRoundSummary> {
    // 进程内兼容接口仍可等待三波结果；HTTP 与模型工具不使用这条等待路径。
    const accepted = await this.acceptRoomMessage(roomId, text, options, true);
    return accepted.execute();
  }

  /**
   * HTTP 收信：先持久写时间线和收件箱，再回 202；execute 仅通知调度器。
   * 群消息的 messageId 由 room_message 事件带回来（客户端按内容/幂等键校正占位）。
   */
  async acceptRoomMessage(
    roomId: string,
    text: string,
    options: SendOptions = {},
    waitForRounds = false,
  ): Promise<AcceptedRun<RoomRoundSummary>> {
    return this.chatRuns.accept(`room:${roomId}:${options.clientMessageId ?? randomUUID()}`, async () => {
      const { room, members } = await this.membersOf(roomId);
      if (!room || members.length === 0) throw new Error('房间不存在或没有成员');
      if (this.stopCoordinator.isStopSentence(text)) {
        const activeFlow = await this.roomFlowService.getActiveFlowForRoom(roomId);
        if (activeFlow) {
          await this.stopCoordinator.stopRoomFlow(roomId, activeFlow.id, text);
          await this.roomFlowService.pauseFlow(activeFlow.id, 'USER_STOP_COMMAND');
        }
      }
      const { run, duplicate } = await this.chatRuns.prepare(
        {
          channelId: roomId,
          roomId,
          kind: 'room',
          source: options.roomSenderId ? 'agent' : 'user',
          input: text,
          clientMessageId: options.clientMessageId,
          messageId: randomUUID(),
        },
        [
          options.model ?? '',
          options.ownerName ?? this.ownerName(),
          options.excludeAgentIds ?? [],
          options.roomSenderId ?? '',
        ],
      );

      // §6.2：用户新的群发言为受众签发新链许可。没有它，停止后的成员在这一轮
      // 全部判定 held，于是「私聊说一次停 → 群里再也不响应」。
      // 工作台代发（roomSenderId）不是用户命令，不签发；停止词更不签发。
      let chainId: string | undefined;
      if (!options.roomSenderId && !duplicate && !this.stopCoordinator.isStopSentence(text)) {
        const excluded = new Set(options.excludeAgentIds ?? []);
        const audience = members.map((member) => member.id).filter((id) => !excluded.has(id));
        if (audience.length > 0) {
          chainId = (
            await this.activation.acceptRoomInput({
              commandId: options.clientMessageId ?? run.runId,
              agentIds: audience,
            })
          ).chainId;
        }
      }

      const opts = this.chatRuns.bind(run, {
        ...options,
        messageId: run.messageId,
        ...(chainId ? { chainId } : {}),
      });
      const queued =
        !waitForRounds && !duplicate
          ? await this.chatRuns.execute(
              run.runId,
              () => this.roomDispatcher.enqueueMessage(roomId, text, opts),
              () => ({}),
            )
          : { roundId: run.runId, roomId, roomName: room.name, outcomes: [], queued: [] };
      return {
        receipt: {
          roomId,
          runId: run.runId,
          taskId: run.taskId,
          run: this.chatRuns.get(run.runId)!,
          messageId: run.messageId,
          receiptSeq: this.events.latestSeq,
          duplicate,
        },
        execute: () => {
          if (!waitForRounds) {
            for (const member of members) this.inboxScheduler.watch(member.id);
            return Promise.resolve(queued);
          }
          return !isActiveChatRun(this.chatRuns.get(run.runId)!)
            ? Promise.resolve({ roundId: run.runId, roomId, roomName: room.name, outcomes: [], queued: [] })
            : this.chatRuns.execute(
                run.runId,
                () => this.roomDispatcher.postToRoom(roomId, text, opts),
                () => ({}),
              );
        },
      };
    });
  }

  getActiveRoomFlow(roomId: string): Promise<RoomFlow | undefined> {
    return this.roomFlowService.getActiveFlowForRoom(roomId);
  }

  getRoomFlow(flowId: string): Promise<RoomFlow | undefined> {
    return this.roomFlowService.getFlow(flowId);
  }

  async pauseRoomFlow(flowId: string, reason?: string): Promise<RoomFlow> {
    const flow = await this.roomFlowService.pauseFlow(flowId, reason);
    await this.stopCoordinator.stopRoomFlow(flow.roomId, flowId, reason ?? 'pause');
    return flow;
  }

  resumeRoomFlow(flowId: string): Promise<RoomFlow> {
    return this.roomFlowService.resumeFlow(flowId);
  }

  async cancelRoomFlow(flowId: string, reason?: string): Promise<RoomFlow> {
    const flow = await this.roomFlowService.cancelFlow(flowId, reason);
    await this.stopCoordinator.stopRoomFlow(flow.roomId, flowId, reason ?? 'cancel');
    return flow;
  }

  listRoomFlows(roomId?: string): Promise<RoomFlow[]> {
    return this.roomFlowStore.listFlows(roomId);
  }

  /** 热更新模型配置与提供者 */
  updateModelConfig(options: {
    model: string;
    baseURL: string;
    apiKey: string;
    thinkingEnabled?: boolean;
    thinkingLevel?: 'low' | 'medium' | 'high';
    temperature?: number;
    knownModels?: string[];
  }): void {
    this.agentService.updateModelConfig({
      model: options.model,
      knownModels: options.knownModels,
      createProvider: (m) =>
        new OpenAIProvider({
          apiKey: options.apiKey,
          baseURL: options.baseURL,
          model: m,
          thinkingEnabled: options.thinkingEnabled,
          thinkingLevel: options.thinkingLevel,
          temperature: options.temperature,
        }),
    });
  }

  // ── 启动恢复（E3.6）─────────────────────────────────

  /**
   * 启动扫描：只在「已独享数据目录」时调用（服务端取得单实例锁之后）。
   *   1) 上次进程留下、没有结果的工具调用 → 标 unknown 并给出核对计划（不自动重放）；
   *   2) 上次进程领走却没确认的来信 → 一律作废重投（重启不重置尝试预算）；
   *   3) 有待处理来信的同事 → 立刻排一次消费，重启后接着办。
   */
  /**
   * 升级前的旧智能体补 paused 控制条目（bug_trhd1ffe8580）。
   *
   * 判据是「注册表里有、控制存储里没有条目」——这只可能是控制存储建立之前的
   * 旧智能体，按设计进待确认。新建的同事务必走 createAgent / workbench.createAgent
   * 登记 enabled，所以不会落进这条路径。
   */
  async migrateExistingAgents(): Promise<void> {
    const agents = await this.registry.list();
    await this.control
      .transact((draft) => {
        if (draft.controlSeq === 0 && Object.keys(draft.agents).length === 0) return 'skip';
        let changed = false;
        for (const agent of agents) {
          if (draft.agents[agent.id]) continue;
          draft.agents[agent.id] = {
            agentId: agent.id,
            generation: 0,
            autoActivation: 'paused',
            revision: 0,
            blockedAutoRootsThroughSeq: draft.controlSeq + 1,
          };
          changed = true;
        }
        if (!changed) return 'skip';
      })
      .catch(() => undefined);
  }

  async recover(): Promise<StartupReport> {
    await this.migrateExistingAgents();
    await this.projector.recover().catch(() => 0);
    await this.roomFlowService.recoverOutbox().catch(() => 0);
    const unresolvedInvocations: StartupReport['unresolvedInvocations'] = [];
    for (const record of await this.toolLedger.unfinished()) {
      if (record.status !== 'started') {
        unresolvedInvocations.push({ record, plan: planRecovery(record) });
        continue;
      }
      const marked = await this.toolLedger
        .finish(record.id, { status: 'unknown', error: '进程退出时未回填结果（启动扫描）' })
        .catch(() => undefined);
      if (marked) unresolvedInvocations.push({ record: marked, plan: planRecovery(marked) });
    }

    const pendingDeliveries: StartupReport['pendingDeliveries'] = [];
    for (const agent of await this.registry.list()) {
      await this.inbox
        .reclaimAll(agent.id, {
          maxAttempts: this.options.deliveryMaxAttempts ?? DELIVERY_DEFAULTS.maxAttempts,
        })
        .catch(() => 0);
      const items = await this.inbox.peek(agent.id).catch(() => []);
      for (const item of items) await this.archiveLetter(item);
      const claimable = await this.inbox.claimableCount(agent.id).catch(() => 0);
      const claimed = items.filter((item) => item.status === 'claimed').length;
      const failed = await this.inbox.failedCount(agent.id).catch(() => 0);
      if (claimable === 0 && items.length === 0 && failed === 0) continue;
      pendingDeliveries.push({ agentId: agent.id, agentName: agent.name, claimable, claimed, failed });
      const paused = this.control.snapshot().agents[agent.id]?.autoActivation === 'paused';
      if (claimable > 0 && this.control.allowsAutomaticExecution() && !paused) {
        void this.drainInbox(agent.id).catch(() => undefined);
      }
    }

    this.executor.resumeRecovered((await this.registry.list()).map((agent) => agent.id));
    this.inboxScheduler.start((await this.registry.list()).map((agent) => agent.id));

    return { unresolvedInvocations, pendingDeliveries };
  }

  // ── 智能体 1:1 ──────────────────────────────────────

  /** SendToAgent：target 支持 id / 名字（同事），群 id / 群名（必须是自己所在的群） */
  private createSendToAgentTool() {
    return createSendToAgentTool({
      maxDepth: this.options.maxAgentChainDepth ?? DEFAULT_MAX_AGENT_DEPTH,
      resolveTarget: async (wanted, callerId) => {
        const agents = await this.registry.list();
        const agent = agents.find((item) => item.id === wanted);
        if (agent) return { kind: 'agent' as const, id: agent.id, name: agent.name };
        const rooms = await this.workbench.listRooms();
        const room = rooms.find((item) => item.id === wanted);
        if (room) {
          if (!room.memberIds.includes(callerId)) throw new Error('你不在这个群');
          return { kind: 'room' as const, id: room.id, name: room.name };
        }
        const matches = [
          ...agents
            .filter((item) => item.name === wanted)
            .map((item) => ({ kind: 'agent' as const, id: item.id, name: item.name })),
          ...rooms
            .filter((item) => item.memberIds.includes(callerId) && item.name === wanted)
            .map((item) => ({ kind: 'room' as const, id: item.id, name: item.name })),
        ];
        if (matches.length > 1)
          throw new Error(
            `收件方名称有歧义，请使用 id：${matches.map((item) => `${item.kind === 'agent' ? '同事' : '群'}「${item.name}」id=${item.id}`).join('；')}`,
          );
        return matches[0];
      },
      dispatch: async ({
        targetId,
        kind,
        text,
        images,
        priority,
        callerId,
        correlationId,
        chainId,
        depth,
        signal,
        roundId,
      }) => {
        if (kind === 'agent') {
          const sender = await this.registry.get(callerId);
          const target = await this.registry.get(targetId);
          signal?.throwIfAborted();
          if (!sender || !target) throw new Error('发信方或收件方不存在');
          const submitted = await this.deliveries.submit({
            actorId: callerId,
            inputId: correlationId ?? `${callerId}:${targetId}`,
            chainId: chainId ?? correlationId ?? callerId,
            target: { kind: 'agent', id: targetId, nameAtSend: target.name },
            payload: text,
            ...(images?.length ? { images } : {}),
            priority,
            depth: depth ?? 1,
          });
          if (submitted.kind !== 'accepted') throw new Error(submitted.code);
          await this.projector.project(submitted.receipt.actionId, {
            from: {
              kind: 'agent',
              id: sender.id,
              name: sender.name,
              color: sender.color,
              avatar: sender.avatar,
            },
            to: {
              kind: 'agent',
              id: target.id,
              name: target.name,
              color: target.color,
              avatar: target.avatar,
            },
          });
          const projected = await this.inbox.peek(targetId);
          const letter = projected.find((item) => item.id === submitted.receipt.deliveryId);
          if (letter) await this.archiveLetter(letter);
          this.inboxScheduler.watch(targetId);
          return {
            status: 'ok' as const,
            content: `已投递给「${target.name}」；发出去就结束，回复是之后的新回合。`,
            output: {
              truncated: false,
              handle: submitted.receipt.receiptId,
            },
          };
        }
        const sender = await this.registry.get(callerId);
        const rooms = await this.workbench.listRooms();
        const room = rooms.find((item) => item.id === targetId);
        if (!sender || !room) throw new Error('发信方或不在该群');
        const members = (await Promise.all(room.memberIds.map((id) => this.registry.get(id)))).filter(
          (member): member is AgentRecord => Boolean(member),
        );
        const mentioned = resolveMentions(
          text,
          members.map((member) => ({ id: member.id, name: member.name, color: member.color })),
        );
        const recipientMembers = members.filter((member) => member.id !== callerId);
        const submitted = await this.deliveries.submit({
          actorId: callerId,
          inputId: correlationId ?? `${callerId}:${targetId}`,
          chainId: chainId ?? correlationId ?? callerId,
          target: { kind: 'room', id: targetId, nameAtSend: room.name },
          payload: text,
          depth: depth ?? 0,
          sender: {
            kind: 'agent',
            id: sender.id,
            name: sender.name,
            color: sender.color,
            avatar: sender.avatar,
          },
          roomRecipients: recipientMembers.map((member) => ({
            id: member.id,
            name: member.name,
            color: member.color,
            avatar: member.avatar,
            summoned: mentioned.everyone || mentioned.ids.includes(member.id),
            everyone: mentioned.everyone,
          })),
          recipientAgentIds: recipientMembers.map((member) => member.id),
          recipientCount: recipientMembers.length,
          ...(roundId ? { roundId } : {}),
        });
        if (submitted.kind !== 'accepted') throw new Error(submitted.code);
        await this.projector.projectRoom(submitted.receipt.actionId);
        for (const member of recipientMembers) this.inboxScheduler.watch(member.id);
        return {
          status: 'ok' as const,
          content: `已发到「${room.name}」。`,
          output: { truncated: false, handle: submitted.receipt.receiptId },
        };
      },
    });
  }

  /** 消费积压的同事来信（领取 → 处理 → 确认；搬至 InboxProcessor，此处保持兼容入口） */
  async drainInbox(agentId: string, options: SendOptions = {}): Promise<TurnResult | null> {
    if (!this.control.allowsAutomaticExecution()) {
      this.inboxScheduler.watch(agentId);
      return null;
    }
    try {
      return await this.inboxProcessor.process(agentId, options);
    } finally {
      this.inboxScheduler.watch(agentId);
    }
  }

  /** 未处理的来信数（含领取中，不含 failed） */
  async pendingMail(agentId: string): Promise<number> {
    return this.inbox.count(agentId);
  }

  /** 处理失败、不再自动重试的来信数 */
  async failedMail(agentId: string): Promise<number> {
    return this.inbox.failedCount(agentId);
  }

  /** 人工重试失败的来信（重置尝试预算） */
  async retryFailedMail(agentId: string): Promise<number> {
    return this.inbox.retryFailed(agentId);
  }

  /**
   * 生效的主人名（E5.7）：有 SettingsStore 就以它为准，否则回落到构造时的配置。
   * 群消息、工作台代发、幂等指纹都走这里，保证 CLI / 界面 / 后台是同一个名字。
   */
  ownerName(): string {
    return this.options.settings?.ownerName ?? this.options.ownerName ?? DEFAULT_OWNER_NAME;
  }

  /** 当前主人级设置；没配 SettingsStore 时给一份只读的默认视图 */
  preferences() {
    return (
      this.options.settings?.current() ?? {
        ownerName: this.ownerName(),
        timezone: '',
        language: '',
        notifications: { done: true, blocked: true, needsAction: true },
      }
    );
  }

  /** 更新主人级设置（E5.7）：落盘后才生效，三个入口读同一份 */
  async updatePreferences(patch: Parameters<SettingsStore['update']>[0]) {
    if (!this.options.settings) throw new Error('本次运行没有配置主人设置存储（settings 未注入）');
    return this.options.settings.update(patch);
  }

  isBusy(agentId: string): boolean {
    return this.locks.has(agentId);
  }

  /**
   * 修复控制存储（OPT-06）：损坏文件改名备份后以空状态重建，已知同事全部置 paused
   * ——需要用户逐个核对恢复，而不是默认放行。
   */
  async repairControlStore(): Promise<{
    ok: boolean;
    corruptBackup?: string;
    pausedAgents: number;
    faulted: boolean;
  }> {
    const known = await this.registry.list();
    const result = await this.control.repair(known.map((agent) => agent.id));
    return { ok: true, ...result, faulted: this.control.faulted };
  }

  controlView(agentId: string) {
    const snap = this.control.snapshot();
    const agent = snap.agents[agentId];
    return {
      agentId,
      autoActivation: agent?.autoActivation ?? 'enabled',
      generation: agent?.generation ?? 0,
      lastStopId: agent?.lastStopId,
      held: Object.values(snap.tickets).filter(
        (ticket) => ticket.agentId === agentId && ticket.state === 'revoked',
      ).length,
      faulted: this.control.faulted,
    };
  }

  stopOperation(stopId: string) {
    return this.control.snapshot().stops[stopId];
  }

  activationSnapshot() {
    return this.control.snapshot();
  }

  async requestAgentStop(agentId: string, commandId: string) {
    const operation = await this.activation.requestStop({
      commandId,
      requestedBy: { kind: 'user', id: 'owner' },
      scope: { kind: 'agent', agentId },
    });
    await this.inbox.hold(agentId, 'agent_paused').catch(() => 0);
    const runningId = this.ledger.runningTurnOf(agentId);
    if (runningId) {
      const treeId = this.ledger.getTurn(runningId)?.treeId;
      if (treeId) for (const job of this.ledger.jobsOf(treeId)) job.abort();
    }
    const pending = await this.effects.waitFor(operation.targetEffectIds, 5_000);
    await this.activation.settleStop(operation.stopId, pending.length > 0 ? 'needs_attention' : 'settled');
    return (
      this.activationSnapshot().stops[operation.stopId] ?? {
        ...operation,
        state: pending.length > 0 ? ('needs_attention' as const) : ('settled' as const),
      }
    );
  }

  resumeAgent(command: Parameters<ActivationCoordinator['resumeSelected']>[0]) {
    return this.activation.resumeSelected(command);
  }

  deliveryReceipt(receiptId: string): DeliveryReceipt | undefined {
    const value = this.control.snapshot().receipts[receiptId];
    if (!value || typeof value !== 'object' || !('receiptId' in value)) return undefined;
    return value as DeliveryReceipt;
  }

  // ── 回合执行（搬至 RunExecutor，此处保持兼容入口）──

  private runTurn(
    agentId: string,
    task: Message,
    turn: Parameters<RunExecutor['runTurn']>[2],
    options: SendOptions = {},
  ): Promise<TurnResult> {
    return this.executor.runTurn(agentId, task, turn, options);
  }
}

export type { AgentEvent, RoomEvent, RoundOutcome };
