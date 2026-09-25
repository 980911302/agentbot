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
import type { WorkRepositoryPort, WorkWaitRepositoryPort } from '../storage/ports.js';
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
import { WorkService, type AcceptResult, type ClarifyResult } from '../work/service.js';
import { JsonWorkRepository } from '../work/store.js';
import { isTerminalWork, titleFrom } from '../work/item.js';
import { WaitService, WAIT_TERMINAL_MESSAGES } from '../work/wait-service.js';
import { JsonWorkWaitRepository } from '../work/wait-store.js';
import { agentWaitKey, answerSummary, isAgentWaitForPeer, type WorkWait } from '../work/wait.js';
import { DelegationService } from '../work/delegation-service.js';
import { JsonDelegationRepository } from '../work/delegation-store.js';
import { isOpenDelegation } from '../work/delegation.js';
import type { InteractionRequest } from '../shared/contracts/sse.js';
import type { MessageActor } from '../shared/contracts/message-identity.js';
import { resolveProjectOwner } from '../tools/builtin/memory.js';
import { ToolRegistry } from '../tools/registry.js';
import { effectiveToolNames } from '../tools/capabilities.js';
import { createSendToAgentTool } from '../tools/builtin/room.js';
import { createTaskTools } from '../tools/builtin/task.js';
import { workerResultLetter, type Worker, type WorkerManager } from '../tools/services/worker-manager.js';
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
/** 到点扫描间隔（E4.3）：不引入调度框架，用一个兜底定时器 + 启动扫描覆盖 */
const WAIT_SWEEP_INTERVAL_MS = 30_000;
/** 用户问题卡的默认答复期限：持久等待不该被 5 分钟掐掉；到点只判过期，不当已回答 */
const DEFAULT_USER_WAIT_TTL_MS = 24 * 60 * 60 * 1000;

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
  /** 工作服务（E4.1）：WorkItem 的唯一状态转换入口 */
  readonly works: WorkService;
  /** 等待服务（E4.3）：WorkWait 的唯一状态转换入口；重启读回、到点扫描 */
  readonly waits: WaitService;
  /** 委派服务（E4.4）：parentWorkId/childWorkId/correlationId；精确停止与精确唤醒共用 */
  readonly delegations: DelegationService;
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
  /** 后台工人的持久账本与收尾投递（E4.5）：启动扫描要能补送上次进程没送出的结果 */
  private readonly workerManager: WorkerManager;
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
  /** 到点扫描兜底定时器（E4.3）；unref 不拉着进程 */
  private waitTimer?: NodeJS.Timeout;
  /** 是否已经进入停机（E8.4）：beginShutdown 幂等 */
  private shutdownStarted = false;

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
    // 工作账本（E4.1）：同事手头负责的 WorkItem/WorkStep 持久化
    const workRepository = options.workRepository ?? new JsonWorkRepository(options.dataDir);
    this.works = new WorkService({ repository: workRepository });
    // 等待账本（E4.3）：等谁/到点/等回答落成 WorkWait，重启后还能接上
    const waitRepository = options.waitRepository ?? new JsonWorkWaitRepository(options.dataDir);
    this.waits = new WaitService({ repository: waitRepository });
    // 委派账本（E4.4）：谁把哪件事派给谁 + 线程键，精确停止/唤醒都读它
    this.delegations = new DelegationService({ repository: new JsonDelegationRepository(options.dataDir) });
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
      // E4.4：精确停止读委派账本；子工作随委派停、等待随委派作废
      delegations: this.delegations,
      cancelWork: async (workId, reason) => {
        await this.works.close(workId, 'cancelled', reason).catch((error) => {
          // 已经收尾的工作不重复关（幂等）；其它错误记一笔即可，不拦停止
          if (!String(messageOf(error)).includes('已经结束')) {
            console.warn(`停止时关工作失败（${workId}）：${messageOf(error)}`);
          }
        });
      },
      onDelegationCancelled: async (delegation) => {
        await this.waits.cancelByThread(delegation.id, '这条委派已被停止');
      },
      // 迟到的 stop-ack 把 needs_attention 更新掉（设计 §7.1）
      onStopAcksSettled: async (stopId, remaining) => {
        if (!stopId) return;
        await this.activation
          .settleStop(stopId, remaining.length > 0 ? 'needs_attention' : 'settled', remaining)
          .catch(() => undefined);
      },
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
      onStopAck: (agentId, item) =>
        this.stopCoordinator.noteStopAck(agentId, item.fromAgentId, item.treeId, {
          ...(item.cancelId ? { cancelId: item.cancelId } : {}),
          ...(item.childWorkId ? { childWorkId: item.childWorkId } : {}),
          ...(item.correlationId ? { correlationId: item.correlationId } : {}),
        }),
      // 同事回信已确认处理：按线程键精确解决「等这位同事回信」的等待（E4.3/E4.4）
      onLettersHandled: async (agentId, letters) => {
        for (const letter of letters) {
          await this.resolveAgentWaitsForReply(agentId, letter.fromAgentId, `letter:${letter.id}`, letter.correlationId);
        }
      },
      // 这封信是不是某个等待的唤醒事件：是就把那份工作写进本轮 brief
      workBriefForLetter: (agentId, fromAgentId, correlationId) =>
        this.workBriefForPeerReply(agentId, fromAgentId, correlationId),
      // 这封信是一条委派：收件方为它开一件工作并回填 childWorkId（E4.4）
      acceptDelegation: (agentId, letter) => this.acceptDelegationLetter(agentId, letter),
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
      // E4.3：SendToUser 的提问类出口落成持久 WorkWait（工具不认识存储）
      requestUserWait: (agentId, input) => this.requestUserWaitCard(agentId, input),
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
          // 按派工者实际可用的工具面取（含恒定叠加的必需能力），工人再自行取交集
          return owner ? this.tools.filter((tool) => effectiveToolNames(owner.toolNames).includes(tool.name)) : [];
        },
        providerFor: (model) => this.agentService.providerFor(this.agentService.resolveModel(model)),
        ownerAuthority: async (ownerId) => {
          const owner = await this.registry.get(ownerId);
          return owner ? { toolNames: effectiveToolNames(owner.toolNames), projectIds: owner.projectIds } : undefined;
        },
        maxIterations: this.options.maxIterations,
        // TodoWrite → WorkStep（E4.1）：有正在进行的工作才记步骤
        onTodoWrite: async (agentId, todos) => {
          const work = await this.works.openWorkOf(agentId);
          if (!work) return;
          for (const todo of todos) {
            await this.works.appendStep({
              workId: work.id,
              id: todo.id,
              title: todo.content,
              status: todo.status,
            });
          }
        },
        invocations: this.toolLedger,
        dataDir: this.options.dataDir,
        progress: this.taskProgress,
        outputs: this.toolOutputs,
        // E8.4：后台工人登记进停机清单
        background: this.options.background,
        // ── E4.5 新增（都追加在参数表末尾，避免与并行分支撞在同一段插入）──
        // 工人是为派工者手头那件工作执行的（E4.1）；没有正在进行的工作就不关联
        workOf: async (ownerId) => (await this.works.openWorkOf(ownerId))?.id,
        // 工人收尾投递（E4.5）：结果作为一封信送回派工者，走既有 inbox/Delivery 链路
        onWorkerSettled: (worker) => this.deliverWorkerResult(worker),
      }),
    ];
    // 工人账本（E4.5）：启动扫描要能补送上次进程没送出的收尾结果
    this.workerManager = workerManagerOf(this.tools);
    // 新同事默认拿到全部工具——包括工作台那一组
    this.registry.setDefaultToolNames(this.tools.map((tool) => tool.name));
    this.inboxScheduler = new InboxScheduler({
      inbox: this.inbox,
      busy: (agentId) => this.isBusy(agentId) || this.inboxProcessor.isProcessing(agentId),
      exists: async (agentId) => Boolean(await this.registry.get(agentId)),
      process: (agentId) => this.drainInbox(agentId),
    });
    // 到点等待的兜底扫描（E4.3）：启动扫描在 recover() 里做一次，这之后靠定时器补
    this.waitTimer = setInterval(() => {
      void this.sweepDueWaits().catch((error) => {
        console.warn(`等待到点扫描失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, WAIT_SWEEP_INTERVAL_MS);
    this.waitTimer.unref?.();
  }

  async close(): Promise<void> {
    this.beginShutdown();
    await Promise.all([this.executor.close(), this.inboxProcessor.close()]);
  }

  /**
   * 停机第一步（E8.4）：停止接新工作。
   * 只停调度与兜底定时器，不动存储、不碰后台进程——那两步各由停机顺序里的
   * terminate_background / close_storage 负责（见 src/server/lifecycle.ts）。
   * 幂等：close() 也会调用它，重复调用不产生副作用。
   */
  beginShutdown(): void {
    if (this.waitTimer) {
      clearInterval(this.waitTimer);
      this.waitTimer = undefined;
    }
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    this.inboxScheduler.close();
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
    // 持久等待（E4.3）：撤下卡片、作废记录，同事没了等待也没有归属
    await this.voidPendingUserWaits(agentId);
    await this.waits.clear(agentId);
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
   * 工人收尾投递（E4.5）：结果作为一封信回到派工者，而不是只能靠 CheckSubagent 轮询。
   *
   * 不为工人另造一套投递：走 SendToAgent 用的同一条可靠链路——
   * DeliveryService.submit 落 outbox → OutboxProjector.project 写进收件箱 → 调度器唤醒派工者新回合。
   * 投递按 (actorId, inputId, …) 指纹幂等，所以重启补送不会重复送到。
   */
  private async deliverWorkerResult(worker: Worker): Promise<void> {
    const owner = worker.ownerId ? await this.registry.get(worker.ownerId) : undefined;
    if (!owner) throw new Error(`派工者 ${worker.ownerId ?? '(未知)'} 已不存在，工人结果无处投递`);
    const text = workerResultLetter(worker);
    const from: MessageActor = { kind: 'agent', id: worker.id, name: `工人：${worker.description}` };
    const to: MessageActor = {
      kind: 'agent',
      id: owner.id,
      name: owner.name,
      color: owner.color,
      avatar: owner.avatar,
    };
    // 工人自己的经历线留一条收尾：审计「它交了什么」不依赖收件箱是否已被消费
    await this.messages.appendIfAbsent({
      id: `worker-result:${worker.id}`,
      agentId: worker.id,
      role: 'assistant',
      content: { type: 'text', text },
      createdAt: worker.endedAt ?? Date.now(),
      source: 'agent',
    });
    const submitted = await this.deliveries.submit({
      actorId: worker.id,
      inputId: `worker:${worker.id}`,
      // 结果信记在派工者那一轮的同一条协作链上：链预算仍然算得住，不另开一条绕过上限
      chainId: worker.chainId ?? `worker:${worker.id}`,
      target: { kind: 'agent', id: owner.id, nameAtSend: owner.name },
      payload: text,
      depth: (worker.chainDepth ?? 0) + 1,
    });
    if (submitted.kind !== 'accepted') {
      // 链预算用尽时不假装送到：结果留在工人记录里，重启扫描会再试，界面上仍能查证
      throw new Error(`工人结果投递被拒（${submitted.code}），未送达派工者`);
    }
    await this.projector.project(submitted.receipt.actionId, { from, to });
    this.inboxScheduler.watch(owner.id);
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

    /** 这条消息与工作的关联（E4.1/E4.2）：进 brief，并作为收尾写回进度的依据 */
    let workLink: WorkLinkOutcome | null = null;
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
        // E4.1/E4.2：把这条消息关联到工作（新建 / 接着 / 修订；闲聊返回 null；
        // 含糊返回候选，交给回合短问）。旁路记录，不改发送/执行/停止语义；
        // 失败也不能让这条消息发不出去。
        // 带 workId 的唤醒（E4.3）走显式关联：不用再判定这句话接哪件工作。
        //
        // E4.6：判定必须在 append 之前——消息是不可变内容，来源标注要随它一起落盘，
        // 这样它以后作为历史出现在上下文里时，模型才知道这句话属于哪件工作。
        if (!stop && options.workId) {
          const linked = await this.works.get(options.workId);
          workLink =
            linked && !isTerminalWork(linked.status)
              ? { work: linked, kind: 'continued', relation: 'continue' }
              : null;
        } else if (!stop) {
          try {
            workLink = await this.works.acceptUserMessage({
              agentId,
              channel: { kind: 'dm', id: agentId },
              messageId: task.id,
              text,
            });
          } catch (error) {
            console.warn(
              `工作记录失败（不影响本次回合）：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (workLink && workLink.kind !== 'clarify') task.workId = workLink.work.id;

        await this.messages.append(task);
        opts.onEvent?.({ type: 'message', message: task });
        this.stopCoordinator.voidPendingInteractions(agentId, opts.onEvent);
        // E4.3 §7.2：用户新句作废未回答的持久问题卡（不当答案），工作本身继续存在。
        // 等待被满足后的唤醒回合不是「新句」，不能顺手作废别的卡。
        if (!options.waitAnswer) await this.voidPendingUserWaits(agentId, opts.onEvent);
      } catch (error) {
        await this.chatRuns.fail(run.runId, error);
        throw error;
      }
    }

    // 工作关联进 brief：让模型知道「这句是接着哪件工作」，含糊时明确要求先短问
    const workBrief = this.workLinkBrief(workLink);
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
          { skipPersist: true, resumeTaskId, ...(workBrief ? { brief: workBrief } : {}) },
          { ...opts, authorization: decision.ticket },
        ).then(async (result) => {
          await this.recordWorkProgress(workLink, result);
          return result;
        });
      }
      return this.runTurn(
        agentId,
        task,
        { skipPersist: true, resumeTaskId, ...(workBrief ? { brief: workBrief } : {}) },
        opts,
      ).then(async (result) => {
        await this.recordWorkProgress(workLink, result);
        return result;
      });
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
    // 工人收尾投递补送（E4.5）：上次进程收尾了却没送回去的结果信在这里补上。
    // 投递层按指纹幂等，所以重复补送不会让派工者收到两封一样的信。
    const workerResults = await this.workerManager.deliverPendingResults().catch(() => 0);
    if (workerResults > 0) console.log(`启动扫描：补送 ${workerResults} 条工人收尾结果`);
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

    // E4.3 等待恢复：先处理到点的（time 补上 / user 判过期），再把还在等的待答卡
    // 重建到界面上——卡片是数据，不是 Promise，所以另一个进程也能读回来。
    await this.sweepDueWaits().catch((error) =>
      console.warn(`启动扫描：等待到点处理失败（${messageOf(error)}）`),
    );
    const restored = await this.refreshWaitCards().catch(() => 0);
    if (restored > 0) console.log(`启动扫描：恢复 ${restored} 张待回答的问题卡`);

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
          // E4.4：这次投递是「回某次委派」还是「新派一件事」？
          // 回信复用原委派线程键，让发起方能只唤醒「那一次请求」；
          // 新派则由这封信自己的投递 id 当线程键（投影时落定）。
          const replyThread = await this.delegations.resolveReplyThread({
            callerId,
            targetId,
            ...(correlationId ? { threadId: correlationId } : {}),
          });
          const submitted = await this.deliveries.submit({
            actorId: callerId,
            inputId: correlationId ?? `${callerId}:${targetId}`,
            chainId: chainId ?? correlationId ?? callerId,
            target: { kind: 'agent', id: targetId, nameAtSend: target.name },
            payload: text,
            ...(images?.length ? { images } : {}),
            priority,
            depth: depth ?? 1,
            ...(replyThread ? { correlationId: replyThread.id } : {}),
          });
          if (submitted.kind !== 'accepted') throw new Error(submitted.code);
          // E4.4：先记委派、再让信可见——收件方认领这封信时要能查到「这是哪条委派」，
          // 否则它就成了没主的一次投递，childWorkId 也就永远回填不上。
          // 线程键 = 请求信投递 id；重试/重复提交时幂等复用原记录。
          const threadId = submitted.receipt.deliveryId;
          const waitingWork = await this.works.openWorkOf(callerId);
          if (threadId) {
            await this.delegations
              .recordOutbound({
                id: threadId,
                fromAgentId: callerId,
                toAgentId: targetId,
                ...(waitingWork && !isTerminalWork(waitingWork.status)
                  ? { parentWorkId: waitingWork.id }
                  : {}),
                requestMessageId: threadId,
              })
              .catch((error) => console.warn(`委派未记账：${messageOf(error)}`));
          }
          if (replyThread) {
            await this.delegations
              .markReplied(replyThread.id)
              .catch((error) => console.warn(`委派回信状态未写回：${messageOf(error)}`));
          }
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
          // E4.3：记一条「在等这位同事回信」的持久等待——重启后仍然知道在等谁；
          // 对方回信被确认处理时按线程键精确 resolve 并唤醒工作（见 resolveAgentWaitsForReply）。
          // 没有关联的工作时不记（没有可唤醒的对象，投递本身照常）。
          if (waitingWork && !isTerminalWork(waitingWork.status)) {
            await this.beginWait({
              agentId: callerId,
              workId: waitingWork.id,
              kind: 'agent',
              correlationId: agentWaitKey(targetId),
              ...(threadId ? { threadId } : {}),
              condition: `等「${target.name}」回复「${titleFrom(text)}」`,
            }).catch((error) => console.warn(`同事等待未记录：${messageOf(error)}`));
          }
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
   * 回合结束后把进展写回工作（E4.2）。
   *
   * 关键约束（设计 §5「修订」段）：**旧 Run 的状态提交必须检查 revision**——
   * 这里用受理时记下的 revision 做条件更新；如果回合跑的过程中用户又改了范围
   * （revision 已推进），这次写回会被拒绝，直接让出、绝不覆盖新目标。
   * 写回失败只记日志：账目问题不能让回合结果失败。
   */
  private async recordWorkProgress(link: WorkLinkOutcome | null, result: TurnResult): Promise<void> {
    if (!link || link.kind === 'clarify' || !link.work) return;
    const summary = (result.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!summary) return;
    try {
      const current = await this.works.get(link.work.id);
      // 等待中（E4.3）：状态由等待驱动，本回合的进展快照会让位——不然会把 waiting 覆盖掉
      if (!current || current.status === 'waiting' || current.status === 'paused') return;
      await this.works.update(
        link.work.id,
        { progressSummary: summary },
        { expectedRevision: link.work.revision },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 版本冲突是预期内的（用户中途改了范围，本次执行让出）
      console.warn(`工作进度未写回（${link.work.id}）：${message}`);
    }
  }

  /**
   * 工作关联写进回合 brief（E4.1/E4.2）：告诉模型这句在接着哪件工作；
   * 含糊时明确要求先用 SendToUser widget 短问，不瞎猜（设计 §5 第 5 条）。
   * 没有关联（闲聊）时不加任何文字，上下文与以前完全一样。
   */
  private workLinkBrief(link: WorkLinkOutcome | null): string {
    if (!link) return '';
    if (link.kind === 'clarify') {
      return `【工作关联】${link.question}`;
    }
    if (!link.work) return '';
    const relation =
      link.relation === 'revise'
        ? `这是对当前工作的**修订**：目标已改写为「${link.work.objective}」，按新目标做，旧目标的执行不再有效`
        : link.relation === 'new_work'
          ? '这是**新开的一件工作**'
          : '这是**接着当前工作**的补充';
    return [
      `【当前工作】${link.work.title}（id=${link.work.id}，revision=${link.work.revision}，状态=${link.work.status}）`,
      `目标：${link.work.objective}`,
      link.work.progressSummary ? `最近进展：${link.work.progressSummary}` : '',
      relation,
      // E4.6：工作事实只认 WorkItem。更早的摘要/日志/记忆可能停在旧状态上，不能反过来改工作。
      '这件工作的状态以本行为准；更早的摘要、日志和长期记忆只是历史背景，不能据此说它已完成或取消。',
      '收尾时如实说明交付了什么；不要只凭一句话就把工作说成完成。',
    ].filter(Boolean).join('\n');
  }

  /**
   * 生效的主人名（E5.7）：有 SettingsStore 就以它为准，否则回落到构造时的配置。
   * 群消息、工作台代发、幂等指纹都走这里，保证 CLI / 界面 / 后台是同一个名字。
   */
  ownerName(): string {
    return this.options.settings?.ownerName ?? this.options.ownerName ?? DEFAULT_OWNER_NAME;
  }

  // ── 持久等待：WorkWait（E4.3，设计 §4.3 / §7.2）────────────
  //
  // 等待是一条记录，不是一段悬挂的 Promise：
  //   建        —— 落盘 WorkWait + 工作置 waiting + 用户卡登记到界面；
  //   结束当前执行 —— 提问类工具让位（stopReason=waiting），执行位立刻释放；
  //   唤醒      —— 用户答题 / 同事回信 / 到点，各开一次新的 Run 接着做；
  //   重启      —— 读回 pending、重建待答卡、补上错过的到点，绝不序列化 Promise。

  /** 界面/快照用的卡片列表（含重启后重建的持久卡） */
  listInteractions(agentId?: string): InteractionRequest[] {
    return this.broker.list(agentId ? { agentId } : undefined);
  }

  /**
   * 落一条等待并把工作置为 waiting。
   * dueAt 缺省时：用户卡给一个明确的答复期限（到点只判过期）；其余等待不设期限。
   */
  private async beginWait(input: {
    agentId: string;
    workId?: string;
    kind: WorkWait['kind'];
    correlationId: string;
    /** 「哪一次请求」的线程键（E4.4）：kind=agent 时是委派 id */
    threadId?: string;
    card?: WorkWait['card'];
    condition?: string;
    dueAt?: number;
  }): Promise<WorkWait> {
    if (input.kind === 'user') {
      const existing = await this.waits.listPending({ agentId: input.agentId, kind: 'user' });
      if (existing.length > 0) throw new Error('这个同事已经有一张等回答的卡了，先回答或作废它再问');
    }
    const ttl = this.options.waitUserTimeoutMs ?? DEFAULT_USER_WAIT_TTL_MS;
    const wait = await this.waits.create({
      ...input,
      ...(input.kind === 'user' && input.dueAt === undefined ? { dueAt: Date.now() + ttl } : {}),
    });
    await this.markWorkWaiting(wait.workId, wait.condition);
    if (wait.kind === 'user' && wait.card) {
      const agent = await this.registry.get(wait.agentId);
      const card = this.toInteractionCard(wait, agent?.name ?? wait.agentId);
      if (card) {
        this.broker.expose(card);
        this.events.publish({
          kind: 'agent',
          agentId: wait.agentId,
          payload: { type: 'interaction', request: card },
        });
      }
    }
    return wait;
  }

  /** 提问类工具（widget / secret-request）的持久等待通道：进 ToolContext，工具不认识存储 */
  private async requestUserWaitCard(
    agentId: string,
    input: {
      kind: 'choice' | 'secret';
      question: string;
      detail?: string;
      options?: Array<{ id: string; label: string }>;
      name?: string;
    },
  ): Promise<{ id: string }> {
    const work = await this.works.openWorkOf(agentId);
    // 交互 id 与存储 id 分开：答案必须带这个 id 才能完成对应等待
    const correlationId = randomUUID();
    await this.beginWait({
      agentId,
      ...(work ? { workId: work.id } : {}),
      kind: 'user',
      correlationId,
      card: {
        question: input.question,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.options ? { options: input.options } : {}),
        ...(input.name ? { name: input.name } : {}),
      },
      condition: `等用户回答「${input.question}」`,
    });
    return { id: correlationId };
  }

  /** 持久等待 → 线上卡片形状（重启恢复与实时推送共用同一份映射） */
  private toInteractionCard(wait: WorkWait, agentName: string): InteractionRequest | undefined {
    if (!wait.card) return undefined;
    const card = wait.card;
    return {
      id: wait.correlationId,
      kind: card.name ? 'secret' : 'choice',
      question: card.question,
      ...(card.detail ? { detail: card.detail } : {}),
      ...(card.options ? { options: card.options.map((option) => ({ ...option })) } : {}),
      ...(card.name ? { name: card.name } : {}),
      agentId: wait.agentId,
      agentName,
      createdAt: wait.createdAt,
      // 卡片不设隐性 5 分钟超时：有业务期限就用 dueAt，否则给一个明确的远界
      expiresAt: wait.dueAt ?? wait.createdAt + (this.options.waitUserTimeoutMs ?? DEFAULT_USER_WAIT_TTL_MS),
    };
  }

  /** 重启恢复：从持久等待重建待答卡（不序列化 Promise），返回重建张数 */
  async refreshWaitCards(): Promise<number> {
    const pending = await this.waits.listPending({ kind: 'user' });
    const cards: InteractionRequest[] = [];
    for (const wait of pending) {
      const agent = await this.registry.get(wait.agentId);
      const card = this.toInteractionCard(wait, agent?.name ?? wait.agentId);
      if (card) cards.push(card);
    }
    this.broker.hydrate(cards);
    return cards.length;
  }

  /**
   * 到点扫描（启动扫描 + 兜底定时器共用，不引入调度框架）：
   *   time 到点 → 满足条件并唤醒（进程不在时错过，重启补上）；
   *   user 到点 → 明确过期（超时被当作没答，不是回答）。
   */
  async sweepDueWaits(now?: number): Promise<{ satisfied: number; expired: number }> {
    const { satisfied, expired } = await this.waits.sweepDue(now);
    for (const wait of expired) {
      this.broker.retire(wait.correlationId);
      this.events.publish({
        kind: 'agent',
        agentId: wait.agentId,
        payload: { type: 'interaction_closed', id: wait.correlationId, answered: false },
      });
      await this.releaseWorkIfSettled(wait.workId);
    }
    for (const wait of satisfied) {
      await this.releaseWorkIfSettled(wait.workId);
      await this.wakeWait(wait, `定时等待到点：${wait.condition ?? wait.correlationId}。接着做。`).catch(
        (error) => console.warn(`定时等待唤醒失败：${messageOf(error)}`),
      );
    }
    return { satisfied: satisfied.length, expired: expired.length };
  }

  /** 用户答题：带交互 id 的明确答案才能完成对应等待；迟到回答返回明确状态 */
  async answerInteraction(
    id: string,
    answer: { value?: string; secret?: string },
  ): Promise<{ ok: boolean; status: string; message?: string; runId?: string }> {
    const found = await this.waits.findByCorrelation(id);
    const wait = found.find((item) => item.status === 'pending' && item.kind === 'user');
    if (!wait) {
      // 同回合内的同步等待（工具未接持久通道时的兼容路径）
      if (id && this.broker.resolve(id, answer)) return { ok: true, status: 'resolved' };
      const last = found[0];
      if (!last || last.status === 'pending') return { ok: false, status: 'unknown', message: '这个交互已经结束或不存在' };
      return { ok: false, status: last.status, message: WAIT_TERMINAL_MESSAGES[last.status] };
    }
    let resultRef: string;
    if (wait.card?.name) {
      const secret = answer.secret?.trim();
      if (!secret) return { ok: false, status: 'pending', message: `需要 secret（${wait.card.name}）` };
      // 明文只进 SecretStore；等待里只留引用
      await this.secrets.put(wait.card.name, secret);
      resultRef = `secret:${wait.card.name}`;
    } else {
      if (answer.value === undefined) return { ok: false, status: 'pending', message: '需要 value（选项）或 secret（密钥）' };
      resultRef = `choice:${answer.value}`;
    }
    const outcome = await this.waits.resolve(wait.id, resultRef);
    if (!outcome.ok) return { ok: false, status: outcome.status, message: outcome.message };
    this.broker.retire(id);
    this.events.publish({
      kind: 'agent',
      agentId: wait.agentId,
      payload: { type: 'interaction_closed', id, answered: true },
    });
    await this.releaseWorkIfSettled(wait.workId);
    const runId = await this.wakeWait(wait, answerSummary(wait, answer));
    return { ok: true, status: 'resolved', ...(runId ? { runId } : {}) };
  }

  /** 用户明确「跳过/放弃」这张卡：等待作废，不当作答案 */
  async cancelInteraction(id: string): Promise<{ ok: boolean; status: string }> {
    const found = await this.waits.findByCorrelation(id);
    const wait = found.find((item) => item.status === 'pending' && item.kind === 'user');
    if (!wait) {
      const ok = this.broker.cancel(id);
      return { ok, status: ok ? 'cancelled' : 'unknown' };
    }
    const outcome = await this.waits.cancel(wait.id, '用户放弃了这张卡');
    this.broker.retire(id);
    this.events.publish({
      kind: 'agent',
      agentId: wait.agentId,
      payload: { type: 'interaction_closed', id, answered: false },
    });
    await this.releaseWorkIfSettled(wait.workId);
    return { ok: outcome.ok, status: 'cancelled' };
  }

  /**
   * 「用户新句作废未回答选项卡」（§7.2）：作废该卡并写入状态，再分析新句；
   * 工作本身继续存在，是否还需要等待由新一轮判断。刷新/断线不走这里，所以不作废。
   */
  private async voidPendingUserWaits(agentId: string, emit?: AgentEventHandler): Promise<void> {
    const pending = await this.waits.listPending({ agentId, kind: 'user' });
    for (const wait of pending) {
      await this.waits.cancel(wait.id, '用户发了新消息，这张卡作废');
      this.broker.retire(wait.correlationId);
      emit?.({ type: 'interaction_closed', id: wait.correlationId, answered: false });
      await this.releaseWorkIfSettled(wait.workId);
    }
  }

  /**
   * 同事回信唤醒（E4.4）：先按**线程键**精确命中「哪一次请求」，一封回信只满足
   * 对应的那一次等待；信里没有线程键（旧数据/直接 enqueue）时才退回旧行为——
   * 等这位同事的等待**只有一条**才算数，多条就不猜。信被确认处理后 resolve 并唤醒工作。
   */
  private async resolveAgentWaitsForReply(
    agentId: string,
    peerAgentId: string,
    resultRef: string,
    threadId?: string,
  ): Promise<void> {
    for (const wait of await this.selectReplyWaits(agentId, peerAgentId, threadId)) {
      const outcome = await this.waits.resolve(wait.id, resultRef);
      if (outcome.ok) await this.releaseWorkIfSettled(wait.workId);
    }
    // 委派闭环：只有**反方向**（我派出去、对方回给我）的那条线程才算回信；
// 对方收下请求信的 ack 会带着同一个线程键回来，那不是回信，不能把委派提前闭环。
    // 这封信的发送方是 peer、收件方是我——问的是「peer 在回我派出去的活吗」。
    if (threadId) {
      const replyThread = await this.delegations.resolveReplyThread({
        callerId: peerAgentId,
        targetId: agentId,
        threadId,
      });
      if (replyThread) await this.delegations.markReplied(replyThread.id).catch(() => undefined);
    }
  }

  /** 一封同事回信该满足哪些等待：有线程键按线程精确匹配，没有时只在唯一等待上认 */
  private async selectReplyWaits(
    agentId: string,
    peerAgentId: string,
    threadId?: string,
  ): Promise<WorkWait[]> {
    const forPeer = (await this.waits.listPending({ agentId, kind: 'agent' })).filter((wait) =>
      isAgentWaitForPeer(wait.correlationId, peerAgentId),
    );
    if (threadId) return forPeer.filter((wait) => wait.threadId === threadId);
    return forPeer.length === 1 ? forPeer : [];
  }

  /**
   * 这封信是不是「等这位同事」这件事的唤醒事件（E4.3/E4.4）。
   * 是就把等待归属的工作写进本轮 brief：来信那一轮本身就是唤醒后的新 Run，
   * 只是它由收件箱驱动而没有 workLink——这里补上工作身份，模型才知道在接着做什么。
   */
  private async workBriefForPeerReply(
    agentId: string,
    peerAgentId: string,
    threadId?: string,
  ): Promise<string | undefined> {
    const pending = (await this.selectReplyWaits(agentId, peerAgentId, threadId)).filter(
      (wait) => wait.workId,
    );
    const workId = pending[0]?.workId;
    if (!workId) return undefined;
    const work = await this.works.get(workId);
    if (!work || isTerminalWork(work.status)) return undefined;
    const peerName = (await this.registry.get(peerAgentId))?.name ?? peerAgentId;
    return [
      `【当前工作】${work.title}（id=${work.id}，revision=${work.revision}）`,
      `目标：${work.objective}`,
      `你在等「${peerName}」的回信，这封信就是那个等待被满足的事件：这是**接着当前工作**的继续，不是一件新事。`,
      '收尾时如实说明交付了什么；不要只凭一句话就把工作说成完成。',
    ].join('\n');
  }

  /**
   * 收件方接下一条委派（E4.4）：为它开一件**专属工作**并把 childWorkId 回填到委派。
   * 专属：不走「接到已有工作」的判定，否则停止这条委派会连坐同事的独立工作。
   * 判为闲聊则不建工作（childWorkId 留空），委派照常收下。
   * 幂等：信被退回重投时复用已开的子工作，不为同一件委派开第二件；
   * 已取消/已回信的委派也不再开工作（停止令先到就到此为止）。
   */
  private async acceptDelegationLetter(
    agentId: string,
    letter: { id: string; fromAgentId: string; text: string; correlationId?: string },
  ): Promise<string | undefined> {
    if (!letter.correlationId) return undefined;
    const delegation = await this.delegations.get(letter.correlationId);
    if (!delegation || delegation.toAgentId !== agentId) return undefined;
    if (delegation.childWorkId) {
      const existing = await this.works.get(delegation.childWorkId);
      return existing ? this.delegationWorkBrief(existing) : undefined;
    }
    if (!isOpenDelegation(delegation)) return undefined;
    await this.delegations.markAccepted(delegation.id).catch(() => undefined);
    const work = await this.works.acceptDelegation({
      agentId,
      fromAgentId: delegation.fromAgentId,
      messageId: letter.id,
      text: letter.text,
    });
    if (!work) return undefined;
    await this.delegations.attachChildWork(delegation.id, work.id).catch((error) => {
      console.warn(`委派子工作未回填：${messageOf(error)}`);
    });
    return this.delegationWorkBrief(work);
  }

  /** 委派专属工作的身份，进本轮 brief：让模型知道只做这一件 */
  private delegationWorkBrief(work: { id: string; title: string; objective: string; revision: number }): string {
    return [
      `【当前工作】${work.title}（id=${work.id}，revision=${work.revision}）`,
      `目标：${work.objective}`,
      '这是同事派来的活，已记为一件独立工作；只做这一件，别把别的活也算进来。',
    ].join('\n');
  }

  /** 事件到达后新开一次执行（不占着旧执行位；执行在后台跑） */
  private async wakeWait(wait: WorkWait, text: string): Promise<string | undefined> {
    if (!(await this.registry.get(wait.agentId))) return undefined;
    const work = wait.workId ? await this.works.get(wait.workId) : undefined;
    if (work && isTerminalWork(work.status)) return undefined;
    const accepted = await this.acceptMessage(wait.agentId, text, {
      ...(wait.workId ? { workId: wait.workId } : {}),
      waitAnswer: true,
    });
    void accepted.execute().catch((error) => {
      console.warn(`等待唤醒的回合失败（${wait.workId ?? wait.agentId}）：${messageOf(error)}`);
    });
    return accepted.receipt.runId;
  }

  /** 进入 waiting：工作状态是事实，不是只写在等待记录里 */
  private async markWorkWaiting(workId: string | undefined, condition?: string): Promise<void> {
    if (!workId) return;
    try {
      const work = await this.works.get(workId);
      if (!work || isTerminalWork(work.status) || work.status === 'waiting') return;
      await this.works.update(workId, {
        status: 'waiting',
        ...(condition ? { nextAction: condition } : {}),
      });
    } catch (error) {
      console.warn(`工作等待状态未写回（${workId}）：${messageOf(error)}`);
    }
  }

  /** 等待都结束了就把工作放回 active——否则工作会永远卡在 waiting，无法收尾 */
  private async releaseWorkIfSettled(workId: string | undefined): Promise<void> {
    if (!workId) return;
    try {
      if ((await this.waits.pendingCountForWork(workId)) > 0) return;
      const work = await this.works.get(workId);
      if (!work || work.status !== 'waiting') return;
      // nextAction 已被 markWorkWaiting 改写成「等谁/等什么」；条件满足了它就过期了，
      // 留着会让模型以为还要继续等。清空后由接下来那一轮重新写下一步。
      await this.works.update(workId, { status: 'active', nextAction: undefined });
    } catch (error) {
      console.warn(`工作等待结束状态未写回（${workId}）：${messageOf(error)}`);
    }
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

/** 受理一条消息后拿到的工作关联结果（E4.1/E4.2）；闲聊为 null */
type WorkLinkOutcome = AcceptResult | ClarifyResult;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 从工具面里取回工人账本（E4.5：Task 工具带着它的 WorkerManager，启动扫描要用） */
function workerManagerOf(tools: Tool<any>[]): WorkerManager {
  const task = tools.find((tool) => tool.name === 'Task') as
    | (Tool<unknown> & { workerManager?: WorkerManager })
    | undefined;
  if (!task?.workerManager) throw new Error('工具面里没有装配 Task 工人族，工人恢复无法进行');
  return task.workerManager;
}

export type { AgentEvent, RoomEvent, RoundOutcome };
