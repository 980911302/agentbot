import { createRuntimeAssembly } from '../app/bootstrap.js';
import type { createDelegationWaitBridge } from './runtime/delegation-wait-bridge.js';
import type { createWaitCoordinator } from './runtime/wait-coordinator.js';
import type { createRoomGateway } from './runtime/room-gateway-service.js';
import type { createMessageAcceptance } from './runtime/message-acceptance-service.js';
import type { createWorkerResultDelivery } from './runtime/worker-result-service.js';
import type { WorkerManager } from '../tools/services/worker-manager.js';
import type { createControlViews } from './runtime/control-view-service.js';
import type { WaitRequest } from './runtime/send-to-agent-service.js';
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
import { ProtocolRegistry } from './runtime/room-flow-protocols.js';
import type { RoomFlow } from '../shared/contracts/room-flow.js';
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
import { AgentProfileService } from '../agent/profile-service.js';
import { Workbench } from '../workbench/service.js';
import { InteractionBroker } from '../interaction/broker.js';
import { SecretStore } from '../secret/store.js';
import { AgentInbox, type InboxItem } from '../agent/inbox.js';
import { CorrespondenceStore } from '../storage/correspondence-store.js';
import { DEFAULT_OWNER_NAME } from '../config.js';
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
import { stripMentions } from '../room/mentions.js';
import type { RoomMemberLike } from '../room/member.js';
import { RoomStore } from '../room/store.js';
import { SummonQueue } from '../room/summon.js';
import { buildAgentBrief, buildRoomBrief, decideRoomPosts } from '../room/turn.js';
import type { RoomMessage, RoomEvent, RoomEventHandler, RoundOutcome, RoundStatus } from '../room/types.js';
import { ROOM_MAX_RUNS_PER_MEMBER, ROOM_POST_LIMIT_PER_TURN } from '../room/types.js';
import { MessageStore } from '../store/messages.js';
import { WorkService, type AcceptResult, type ClarifyResult } from '../work/service.js';
import { isTerminalWork } from '../work/item.js';
import { WaitService, WAIT_TERMINAL_MESSAGES } from '../work/wait-service.js';
import { answerSummary, isAgentWaitForPeer, type WorkWait } from '../work/wait.js';
import { DelegationService } from '../work/delegation-service.js';
import { isOpenDelegation } from '../work/delegation.js';
import type { InteractionRequest } from '../shared/contracts/sse.js';
import { resolveProjectOwner } from '../tools/builtin/memory.js';
import { ToolRegistry } from '../tools/registry.js';
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

const OWNER_ID = 'owner';
/** 控制面视图服务的返回形状（OPT-03 从门面搬出，转发用） */
type ControlViews = ReturnType<typeof createControlViews>;
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
  /** 资料唯一写入口（E5.1）：路由与工具都经它改 name/title/description/instructions/头像 */
  readonly profiles: AgentProfileService;
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
  /** 后台工人的持久账本与收尾投递（E4.5）：启动扫描要能补送上次进程没送出的结果 */
  private readonly workerManager: WorkerManager;
  /** 工人收尾投递（E4.5，OPT-03 从门面搬出） */
  private readonly workerResults: ReturnType<typeof createWorkerResultDelivery>;
  /** 消息受理与回合派发（OPT-03 从门面搬出） */
  private readonly acceptance: ReturnType<typeof createMessageAcceptance>;
  /** 群收发与群流程门面（OPT-03 从门面搬出） */
  private readonly roomGateway: ReturnType<typeof createRoomGateway>;
  /** 控制面视图与停止/恢复命令（OPT-03 从门面搬出） */
  private readonly controlViews: ReturnType<typeof createControlViews>;
  /** 持久等待生命周期（E4.3，OPT-03 从门面搬出） */
  private readonly waitLifecycle: ReturnType<typeof createWaitCoordinator>;
  /** 委派与同事回信的等待闭环（E4.4，OPT-03 从门面搬出） */
  private readonly delegationWaits: ReturnType<typeof createDelegationWaitBridge>;
  private readonly runExecutions = new Map<string, Promise<SendResult>>();
  /** 到点扫描兜底定时器（E4.3）；unref 不拉着进程 */
  private waitTimer?: NodeJS.Timeout;
  /** 是否已经进入停机（E8.4）：beginShutdown 幂等 */
  private shutdownStarted = false;

  /**
   * 门面构造：装配已全部搬到 src/app/bootstrap.ts（OPT-03），这里只做两件事——
   * 把门面自己的延迟回调交给装配根，再把装配结果落到字段上。
   * 公开构造签名（AgentRuntimeOptions）保持不变，测试与组合根无需改动。
   */
  constructor(readonly options: AgentRuntimeOptions) {
    const deps = createRuntimeAssembly(
      options,
      {
        isBusy: (agentId) => this.isBusy(agentId),
        watchInbox: (agentId) => this.inboxScheduler.watch(agentId),
        acceptMessage: (agentId, text, messageOptions) => this.acceptMessage(agentId, text, messageOptions),
        deliverWorkerResult: (worker) => this.workerResults.deliverWorkerResult(worker),
        drainInbox: (agentId, drainOptions) => this.drainInbox(agentId, drainOptions),
        runTurn: (agentId, task, turn, turnOptions) => this.runTurn(agentId, task, turn, turnOptions),
        membersOf: (roomId) => this.membersOf(roomId),
        ownerName: () => this.ownerName(),
        enrollAgent: (agentId) => this.enrollAgent(agentId),
        archiveLetter: (item) => this.archiveLetter(item),
        beginWait: (input) => this.beginWait(input),
        requestUserWaitCard: (agentId, input) => this.requestUserWaitCard(agentId, input),
        resolveAgentWaitsForReply: (agentId, peerAgentId, resultRef, threadId) =>
          this.resolveAgentWaitsForReply(agentId, peerAgentId, resultRef, threadId),
        workBriefForPeerReply: (agentId, peerAgentId, threadId) =>
          this.workBriefForPeerReply(agentId, peerAgentId, threadId),
        acceptDelegationLetter: (agentId, letter) => this.acceptDelegationLetter(agentId, letter),
        sweepDueWaits: (now) => this.sweepDueWaits(now),
      },
      // events / locks / pendingStops 是门面自有的可变状态，装配只借用
      {
        events: this.events,
        locks: this.locks,
        pendingStops: this.pendingStops,
        runExecutions: this.runExecutions,
      },
    );

    this.dataDir = deps.dataDir;
    this.chatRuns = deps.chatRuns;
    this.ledger = deps.ledger;
    this.registry = deps.registry;
    this.profiles = deps.profiles;
    this.control = deps.control;
    this.activation = deps.activation;
    this.effects = deps.effects;
    this.deliveries = deps.deliveries;
    this.messages = deps.messages;
    this.works = deps.works;
    this.waits = deps.waits;
    this.delegations = deps.delegations;
    this.memory = deps.memory;
    this.compaction = deps.compaction;
    this.rooms = deps.rooms;
    this.inbox = deps.inbox;
    this.correspondence = deps.correspondence;
    this.projector = deps.projector;
    this.roomFlowStore = deps.roomFlowStore;
    this.protocolRegistry = deps.protocolRegistry;
    this.roomFlowService = deps.roomFlowService;
    this.roomFlowScheduler = deps.roomFlowScheduler;
    this.broker = deps.broker;
    this.secrets = deps.secrets;
    this.modelConfigStore = deps.modelConfigStore;
    this.stopCoordinator = deps.stopCoordinator;
    this.roomFlowRouter = deps.roomFlowRouter;
    this.builder = deps.builder;
    this.compactor = deps.compactor;
    this.extractor = deps.extractor;
    this.workbench = deps.workbench;
    this.roomDispatcher = deps.roomDispatcher;
    this.inboxProcessor = deps.inboxProcessor;
    this.agentService = deps.agentService;
    this.receivedStore = deps.receivedStore;
    this.toolLedger = deps.toolLedger;
    this.taskProgress = deps.taskProgress;
    this.toolOutputs = deps.toolOutputs;
    this.executor = deps.executor;
    this.tools = deps.tools;
    this.inboxScheduler = deps.inboxScheduler;
    this.waitTimer = deps.waitTimer;
    this.workerManager = deps.workerManager;
    this.workerResults = deps.workerResults;
    this.acceptance = deps.acceptance;
    this.roomGateway = deps.roomGateway;
    this.controlViews = deps.controlViews;
    this.waitLifecycle = deps.waitLifecycle;
    this.delegationWaits = deps.delegationWaits;
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

  // ── 消息受理与回合派发：实现搬至 runtime/message-acceptance-service.ts（OPT-03）──

  /**
   * 先持久接收：去重 → 落消息、写事件日志 → 回执。
   * 返回的 execute 由调用方决定何时执行：HTTP 立刻回 202，回合在后台继续跑，
   * 事件全部走 EventJournal（断线只断订阅）。
   */
  acceptMessage(agentId: string, text: string, options: SendOptions = {}): Promise<AcceptedRun<SendResult>> {
    return this.acceptance.acceptMessage(agentId, text, options);
  }

  /** 兼容入口：接了就执行（CLI、测试与内部调用都用它） */
  async send(agentId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    return this.acceptance.send(agentId, text, options);
  }

  private recordWorkProgress(link: WorkLinkOutcome | null, result: TurnResult): Promise<void> {
    return this.acceptance.recordWorkProgress(link, result);
  }

  private workLinkBrief(link: WorkLinkOutcome | null): string { return this.acceptance.workLinkBrief(link); }


  // ── 群收发与群流程（受理编排搬至 runtime/room-gateway-service.ts，门面在此）──

  /**
   * 用户往房间发一条 → 扇出给全体成员（三波次见 RoomDispatcher）。
   * `@` 是强信号不是投递开关：没被点名的一样进这一轮，只是不强制开口。
   */
  async postToRoom(roomId: string, text: string, options: SendOptions = {}): Promise<RoomRoundSummary> {
    return this.roomGateway.postToRoom(roomId, text, options);
  }

  /**
   * HTTP 收信：先持久写时间线和收件箱，再回 202；execute 仅通知调度器。
   * 群消息的 messageId 由 room_message 事件带回来（客户端按内容/幂等键校正占位）。
   */
  acceptRoomMessage(
    roomId: string,
    text: string,
    options: SendOptions = {},
    waitForRounds = false,
  ): Promise<AcceptedRun<RoomRoundSummary>> {
    return this.roomGateway.acceptRoomMessage(roomId, text, options, waitForRounds);
  }

  getActiveRoomFlow(roomId: string): Promise<RoomFlow | undefined> { return this.roomGateway.getActiveRoomFlow(roomId); }

  getRoomFlow(flowId: string): Promise<RoomFlow | undefined> { return this.roomGateway.getRoomFlow(flowId); }

  pauseRoomFlow(flowId: string, reason?: string): Promise<RoomFlow> { return this.roomGateway.pauseRoomFlow(flowId, reason); }

  resumeRoomFlow(flowId: string): Promise<RoomFlow> { return this.roomGateway.resumeRoomFlow(flowId); }

  cancelRoomFlow(flowId: string, reason?: string): Promise<RoomFlow> { return this.roomGateway.cancelRoomFlow(flowId, reason); }

  listRoomFlows(roomId?: string): Promise<RoomFlow[]> { return this.roomGateway.listRoomFlows(roomId); }


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

  // ── 持久等待与委派闭环（E4.3/E4.4，实现在 runtime/wait-coordinator.ts 与
  //    runtime/delegation-wait-bridge.ts；这里只留门面）────────────

  /** 界面/快照用的卡片列表（含重启后重建的持久卡） */
  listInteractions(agentId?: string): InteractionRequest[] { return this.waitLifecycle.listInteractions(agentId); }

  refreshWaitCards(): Promise<number> { return this.waitLifecycle.refreshWaitCards(); }

  sweepDueWaits(now?: number): Promise<{ satisfied: number; expired: number }> { return this.waitLifecycle.sweepDueWaits(now); }

  /** 用户答题：带交互 id 的明确答案才能完成对应等待；迟到回答返回明确状态 */
  answerInteraction(id: string, answer: { value?: string; secret?: string }): Promise<{ ok: boolean; status: string; message?: string; runId?: string }> {
    return this.waitLifecycle.answerInteraction(id, answer);
  }

  /** 用户明确「跳过/放弃」这张卡：等待作废，不当作答案 */
  cancelInteraction(id: string): Promise<{ ok: boolean; status: string }> { return this.waitLifecycle.cancelInteraction(id); }

  /** 装配与内部接线用的等待入口（实现在 wait-coordinator） */
  private beginWait(input: WaitRequest): Promise<WorkWait> { return this.waitLifecycle.beginWait(input); }

  private requestUserWaitCard(agentId: string, input: { kind: 'choice' | 'secret'; question: string; detail?: string; options?: Array<{ id: string; label: string }>; name?: string }): Promise<{ id: string }> {
    return this.waitLifecycle.requestUserWaitCard(agentId, input);
  }

  private voidPendingUserWaits(agentId: string, emit?: AgentEventHandler): Promise<void> { return this.waitLifecycle.voidPendingUserWaits(agentId, emit); }

  private resolveAgentWaitsForReply(agentId: string, peerAgentId: string, resultRef: string, threadId?: string): Promise<void> {
    return this.delegationWaits.resolveAgentWaitsForReply(agentId, peerAgentId, resultRef, threadId);
  }

  private workBriefForPeerReply(agentId: string, peerAgentId: string, threadId?: string): Promise<string | undefined> {
    return this.delegationWaits.workBriefForPeerReply(agentId, peerAgentId, threadId);
  }

  private acceptDelegationLetter(agentId: string, letter: { id: string; fromAgentId: string; text: string; correlationId?: string }): Promise<string | undefined> {
    return this.delegationWaits.acceptDelegationLetter(agentId, letter);
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

  // ── 控制面视图（控制存储快照、停止/恢复命令）搬至 runtime/control-view-service.ts

  repairControlStore(): ReturnType<ControlViews['repairControlStore']> { return this.controlViews.repairControlStore(); }

  controlView(agentId: string): ReturnType<ControlViews['controlView']> { return this.controlViews.controlView(agentId); }

  stopOperation(stopId: string): ReturnType<ControlViews['stopOperation']> { return this.controlViews.stopOperation(stopId); }

  activationSnapshot(): ReturnType<ControlViews['activationSnapshot']> { return this.controlViews.activationSnapshot(); }

  requestAgentStop(agentId: string, commandId: string): ReturnType<ControlViews['requestAgentStop']> {
    return this.controlViews.requestAgentStop(agentId, commandId);
  }

  resumeAgent(command: Parameters<ActivationCoordinator['resumeSelected']>[0]): ReturnType<ControlViews['resumeAgent']> {
    return this.controlViews.resumeAgent(command);
  }

  deliveryReceipt(receiptId: string): DeliveryReceipt | undefined { return this.controlViews.deliveryReceipt(receiptId); }


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

export type { AgentEvent, RoomEvent, RoundOutcome };
