import { randomUUID } from 'node:crypto';
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
import { createWorkbenchTools } from '../tools/examples/workbench.js';
import { Workbench } from '../workbench/service.js';
import { InteractionBroker } from '../interaction/broker.js';
import { SecretStore } from '../secret/store.js';
import { AgentInbox } from '../agent/inbox.js';
import { DEFAULT_OWNER_NAME, DEFAULT_STOP_WORDS, isStopSentence } from '../config.js';
import { ContextBuilder, type BuiltContext, type BuildOptions } from '../context/builder.js';
import type { ContextBudget } from '../context/budget.js';
import type { LLMProvider } from '../llm/provider.js';
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
import { resolveProjectOwner } from '../tools/examples/memory.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSendToAgentTool } from '../tools/examples/room.js';
import { createTaskTools } from '../tools/examples/task.js';
import type { Tool, TurnState } from '../tools/tool.js';

// 类型与错误定义已抽到 ./types（E2.2 第一步）；这里按原名 re-export 保持兼容
import {
  type AgentRuntimeOptions,
  type PendingStop,
  type RoomRoundSummary,
  type RuntimeTurn,
  type SendOptions,
  type SendResult,
  type TaskTree,
  type TurnResult,
  AgentBusyError,
} from './runtime/types.js';
import { AgentService } from './runtime/agent-service.js';
import { StopCoordinator } from './runtime/stop-coordinator.js';
import { InboxProcessor } from './runtime/inbox-processor.js';
import { RoomDispatcher } from './runtime/room-dispatcher.js';
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
  toolContext?: { room?: { roomId: string; roomName: string; posts: string[]; limit: number }; agentChainDepth?: number };
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

  readonly workbench: Workbench;
  readonly broker: InteractionBroker;
  readonly secrets: SecretStore;

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
  /** 群三波扇出（E2.2 拆出） */
  private readonly roomDispatcher: RoomDispatcher;
  private readonly locks = new Set<string>();

  /** 回合与任务树（见 docs/架构设计.md「插话、停止和等待」）：当前存于内存，消息本身已落盘 */
  private readonly turns = new Map<string, RuntimeTurn>();
  private readonly trees = new Map<string, TaskTree>();
  private readonly runningTurnByAgent = new Map<string, string>();
  /** 撞上正在跑的用户回合的停止令：回合结束立刻处理 */
  private readonly pendingStops = new Map<string, PendingStop[]>();

  constructor(private readonly options: AgentRuntimeOptions) {
    this.registry = new AgentRegistry(options.dataDir, []);
    this.messages = new MessageStore(options.dataDir);
    this.memory = options.memoryStore ?? new MemoryStore(options.dataDir);
    this.compaction = new CompactionStore(options.dataDir);
    this.rooms = new RoomStore(options.dataDir);
    this.inbox = new AgentInbox(options.dataDir);
    this.broker = options.broker ?? new InteractionBroker();
    this.secrets = options.secrets ?? new SecretStore(options.dataDir);
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
      ownerName: options.ownerName ?? DEFAULT_OWNER_NAME,
      postToRoom: async (roomId, text, excludeAgentIds) => {
        const summary = await this.postToRoom(roomId, text, { excludeAgentIds });
        const spoke = summary.outcomes.filter((item) => item.status === 'spoke').length;
        return {
          roomName: summary.roomName,
          called: summary.outcomes.length,
          spoke,
          silent: summary.outcomes.length - spoke,
          skipped: summary.skipped,
        };
      },
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

    this.stopCoordinator = new StopCoordinator({
      registry: this.registry,
      messages: this.messages,
      inbox: this.inbox,
      rooms: this.rooms,
      broker: this.broker,
      turns: this.turns,
      trees: this.trees,
      runningTurnByAgent: this.runningTurnByAgent,
      pendingStops: this.pendingStops,
      stopWords: options.stopWords ?? DEFAULT_STOP_WORDS,
      stopAckTimeoutMs: options.stopAckTimeoutMs ?? 30_000,
    });

    this.inboxProcessor = new InboxProcessor({
      inbox: this.inbox,
      registry: this.registry,
      maxAgentChainDepth: this.options.maxAgentChainDepth ?? DEFAULT_MAX_AGENT_DEPTH,
      stopCoordinator: this.stopCoordinator,
      runTurn: (agentId, task, turn, options) =>
        this.runTurn(agentId, task, { extraTools: [], ...turn }, options),
    });

    this.roomDispatcher = new RoomDispatcher({
      registry: this.registry,
      rooms: this.rooms,
      messages: this.messages,
      locks: this.locks,
      membersOf: (roomId) => this.membersOf(roomId),
      ownerNameFallback: options.ownerName ?? DEFAULT_OWNER_NAME,
      stopWords: options.stopWords ?? DEFAULT_STOP_WORDS,
      runTurn: (agentId, task, turn, options) =>
        this.runTurn(agentId, task, turn, options),
    });

    this.tools = [
      ...options.tools,
      ...createWorkbenchTools(this.workbench),
      this.createSendToAgentTool(),
      ...createTaskTools({
        provider: this.providerFor(this.options.defaultModel),
        messages: this.messages,
        workerTools: () => this.tools.filter((tool) => tool.name !== 'SendToUser'),
        maxIterations: this.options.maxIterations,
      }),
    ];
    // 新同事默认拿到全部工具——包括工作台那一组
    this.registry.setDefaultToolNames(this.tools.map((tool) => tool.name));
  }

  // ── 智能体 ──────────────────────────────────────────

  async ensureDefaultAgent(): Promise<AgentRecord> {
    const list = await this.registry.list();
    for (const seed of this.options.seed ?? []) {
      if (list.some((item) => item.name === seed.name)) continue;
      await this.registry.create(seed);
    }

    const allTools = this.tools.map((tool) => tool.name);
    const updated = await this.registry.list();
    for (const record of updated) {
      const missing = allTools.filter((name) => !record.toolNames.includes(name));
      if (missing.length > 0) {
        await this.registry.update(record.id, { toolNames: [...record.toolNames, ...missing] });
      }
    }

    const refreshed = await this.registry.list();
    const preferred = this.options.seed?.[this.options.seed.length - 1]?.name;
    return refreshed.find((item) => item.name === preferred) ?? refreshed[0] ?? (await this.registry.create({ name: '通用助手' }));
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

  async membersOf(roomId: string): Promise<{ room: Awaited<ReturnType<RoomStore['get']>>; members: AgentRecord[] }> {
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

  // ── 私聊回合 ────────────────────────────────────────

  async send(agentId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    // 见 docs/架构设计.md「插话、停止和等待」：认停止词是运行时的事，不让模型「想起来去通知别人」
    if (this.stopCoordinator.isStopSentence(text)) {
      return this.stopCoordinator.stopFromUser(agentId, text, options);
    }

    // 用户新句作废还没回答的选项卡——不当答案（§2）
    this.stopCoordinator.voidPendingInteractions(agentId, options.onEvent);

    const task: Message = {
      id: randomUUID(),
      agentId,
      role: 'user',
      content: { type: 'text', text },
      createdAt: Date.now(),
      source: 'user',
    };
    return this.runTurn(agentId, task, { brief: undefined, onDelta: options.onDelta }, options);
  }

  // ── 群回合：扇出叫醒（搬至 RoomDispatcher，此处保持兼容入口）──

  /**
   * 用户往房间发一条 → 扇出给全体成员（三波次见 RoomDispatcher）。
   * `@` 是强信号不是投递开关：没被点名的一样进这一轮，只是不强制开口。
   */
  async postToRoom(
    roomId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<RoomRoundSummary> {
    return this.roomDispatcher.postToRoom(roomId, text, options);
  }

  // ── 智能体 1:1 ──────────────────────────────────────

  /** SendToAgent：target 支持 id / 名字（同事），群 id / 群名（必须是自己所在的群） */
  private createSendToAgentTool() {
    return createSendToAgentTool({
      maxDepth: this.options.maxAgentChainDepth ?? DEFAULT_MAX_AGENT_DEPTH,
      resolveTarget: async (wanted) => {
        const agents = await this.registry.list();
        const agent =
          agents.find((item) => item.id === wanted) ??
          agents.find((item) => item.name === wanted.trim());
        if (agent) return { kind: 'agent' as const, id: agent.id, name: agent.name };

        const rooms = await this.workbench.listRooms();
        const room =
          rooms.find((item) => item.id === wanted) ??
          rooms.find((item) => item.name === wanted.trim());
        if (room) return { kind: 'room' as const, id: room.id, name: room.name };
        return undefined;
      },
      dispatch: async ({ targetId, kind, text, priority, callerId }) => {
        if (kind === 'agent') {
          const sender = await this.registry.get(callerId);
          const target = await this.registry.get(targetId);
          await this.inbox.enqueue({
            toAgentId: targetId,
            fromAgentId: callerId,
            fromName: sender?.name ?? '同事',
            text,
            priority,
            depth: 0,
            kind: 'message',
          });
          return `已投递给「${target?.name ?? targetId}」；发出去就结束，回复会作为之后的一个新回合回来。`;
        }
        const result = await this.workbench.postToRoom(callerId, targetId, text);
        const skipped =
          result.skipped.length > 0 ? `（${result.skipped.join('、')} 正忙，跳过）` : '';
        return `已发到「${result.roomName}」，${result.called} 人进入回合：${result.spoke} 开口 / ${result.silent} 沉默${skipped}`;
      },
    });
  }

  /** 把积压的同事来信合并成一个回合处理 */
  /** 把积压的同事来信合并成一个回合处理（搬至 InboxProcessor，此处保持兼容入口） */
  async drainInbox(agentId: string, options: SendOptions & { depth?: number } = {}): Promise<TurnResult | null> {
    return this.inboxProcessor.drain(agentId, options);
  }

  async pendingMail(agentId: string): Promise<number> {
    return this.inbox.count(agentId);
  }

  isBusy(agentId: string): boolean {
    return this.locks.has(agentId);
  }

  // ── 回合执行 ────────────────────────────────────────

  private async runTurn(
    agentId: string,
    task: Message,
    turn: {
      brief?: string;
      extraTools?: Tool<any>[];
      toolContext?: TurnInput['toolContext'];
      persistAssistantText?: boolean;
      skipPersist?: boolean;
      posts?: string[];
      model?: string;
      onEvent?: AgentEventHandler;
      /** 仅私聊传入：模型增量文本透传成 delta 事件 */
      onDelta?: (text: string) => void;
      /** 内部续跑回合（欠账补跑）：不算用户来源，忙时退避 */
      resume?: boolean;
      signal?: AbortSignal;
    },
    options: SendOptions = {},
  ): Promise<TurnResult> {
    const source: RuntimeTurn['source'] = turn.resume
      ? 'resume'
      : task.source === 'room'
        ? 'room'
        : task.source === 'agent'
          ? 'agent'
          : 'user';

    // 见 docs/架构设计.md「插话、停止和等待」：用户的新句永远能开新回合——旧的断流挂起、树记欠；
    // 同事信/群/续跑撞上忙智能体维持退避，不打扰正在进行的用户回合。
    const existingTurnId = this.runningTurnByAgent.get(agentId);
    if (existingTurnId) {
      if (source === 'user') {
        this.parkTurn(agentId, existingTurnId);
      } else {
        throw new AgentBusyError();
      }
    }

    const turnId = randomUUID();
    const treeId = randomUUID();
    const runtimeTurn: RuntimeTurn = {
      id: turnId,
      agentId,
      source,
      kind: 'normal',
      text: task.content.type === 'text' ? task.content.text : '',
      treeId,
      status: 'running',
      createdAt: Date.now(),
    };
    const tree: TaskTree = {
      id: treeId,
      rootTurnId: turnId,
      agentId,
      jobs: [],
      children: [],
      status: 'open',
      resumeCount: 0,
      createdAt: runtimeTurn.createdAt,
    };
    this.turns.set(turnId, runtimeTurn);
    this.trees.set(treeId, tree);
    this.runningTurnByAgent.set(agentId, turnId);
    this.locks.add(agentId);

    // 本回合自己的 abort 控制器：挂起（park）就掐这里；外部 close 信号并行生效
    const controller = new AbortController();
    tree.jobs.push({ abort: () => controller.abort(), label: 'turn' });
    const externalSignal = turn.signal ?? options.signal;
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    try {
      const record = await this.registry.get(agentId);
      if (!record) throw new Error(`Unknown agent: ${agentId}`);

      const model = this.resolveModel(turn.model ?? options.model);
      const provider = this.providerFor(model);

      if (!turn.skipPersist) {
        await this.messages.append(task);
        options.onEvent?.({ type: 'message', message: task });
      }

      let agent = await this.buildAgent(record);

      const compaction = await this.compactor.maybeCompact(agent, provider).catch(() => null);
      if (compaction) {
        options.onEvent?.({
          type: 'compacted',
          coversUpTo: compaction.state.coversUpTo,
          messageCount: compaction.state.messageCount,
        });
        agent = await this.buildAgent(record);
      }

      const buildOptions: BuildOptions = { turnBrief: turn.brief };
      const built = await this.builder.build(agent, task, buildOptions);
      options.onEvent?.({ type: 'context', stats: built.stats });
      await this.touchSurfaced(built.surfaced);

      const registry = turn.extraTools
        ? ToolRegistry.from([...agent.tools, ...turn.extraTools])
        : ToolRegistry.from(agent.tools);

      // 本轮配额：工作台工具建多少同事/群，回合结束即失效；树记账挂同一份状态
      const turnState: TurnState = {
        workbench: { agentsCreated: 0, roomsCreated: 0 },
        treeId,
        registerChild: (child) => {
          if (!tree.children.some((item) => item.agentId === child.agentId && item.via === child.via)) {
            tree.children.push(child);
          }
        },
        registerJob: (abort, label) => tree.jobs.push({ abort, label }),
        persistOutgoing: async (text) => {
          const message: Message = {
            id: randomUUID(),
            agentId,
            role: 'assistant',
            content: { type: 'text', text },
            createdAt: Date.now(),
            source: 'agent',
          };
          await this.messages.append(message);
          options.onEvent?.({ type: 'message', message });
        },
      };

      const loop = new AgentLoop({
        provider,
        messages: this.messages,
        maxIterations: this.options.maxIterations,
        onEvent: options.onEvent,
        onDelta: turn.onDelta,
        signal,
        toolsOverride: registry,
        toolContext: { ...(turn.toolContext ?? {}), turnState, emit: options.onEvent },
        persistAssistantText: turn.persistAssistantText,
        stamp: task.roomId
          ? { roomId: task.roomId, roomName: task.roomName, speaker: task.speaker, source: 'room' }
          : { source: task.source },
      });

      let result: RunResult;
      try {
        result = await loop.run(agent, built);
      } catch (error) {
        if (runtimeTurn.status === 'parked') {
          // 被新句插队：这不是故障，安静挂起，让位给新回合
          result = { content: '', iterations: 0, stopReason: 'parked' };
        } else if (controller.signal.aborted) {
          result = { content: '', iterations: 0, stopReason: 'cancelled' };
        } else {
          throw error;
        }
      }

      // 挂起/中止的回合不再抽记忆——半截对话不值得记
      if (result.stopReason === 'final_answer' || result.stopReason === 'max_iterations') {
        await this.registry.update(agentId, {});
        const exchange = await this.messages.recent(agentId, 12, task.id);
        const extracted = await this.extractor
          .extract(await this.buildAgent(record), provider, [...exchange, task])
          .catch(() => ({ refs: [] as MemoryRef[], merged: 0 }));
        if (extracted.refs.length > 0 || extracted.merged > 0) {
          options.onEvent?.({ type: 'memory', added: extracted.refs, merged: extracted.merged });
        }
      }

      return {
        ...result,
        agentId,
        agentName: record.name,
        context: built,
        posts: turn.posts ?? [],
        status: (turn.posts?.length ?? 0) > 0 ? 'spoke' : 'silent',
      };
    } finally {
      // 只有自己还占着坑才清；被插队时新回合已经接管了锁
      if (this.runningTurnByAgent.get(agentId) === turnId) {
        this.runningTurnByAgent.delete(agentId);
        this.locks.delete(agentId);
      }
      if (runtimeTurn.status === 'running') runtimeTurn.status = 'done';
      tree.jobs = tree.jobs.filter((job) => job.label !== 'turn');

      // 收尾顺序（见 docs/架构设计.md「插话、停止和等待」 优先级）：停止令 → 欠账续跑 → 同事来信
      await this.stopCoordinator.processPendingStops(agentId).catch(() => undefined);
      void this.resumeOwed(agentId).catch(() => undefined);
      const pending = await this.inbox.count(agentId).catch(() => 0);
      if (pending > 0) {
        this.drainInbox(agentId, { model: turn.model ?? options.model }).catch(() => undefined);
      }
    }
  }

  /** 把正在跑的回合断流挂起：旧树保持 open 记欠，等新回合结束再补跑 */
  private parkTurn(agentId: string, turnId: string): void {
    const rt = this.turns.get(turnId);
    if (!rt || rt.status !== 'running') return;
    rt.status = 'parked';
    const tree = this.trees.get(rt.treeId);
    if (tree) {
      for (const job of tree.jobs) job.abort();
    }
  }

  /** 欠账补跑：最早的、还没续过 3 次的 parked 树，接回去继续做 */
  private async resumeOwed(agentId: string): Promise<void> {
    if (this.runningTurnByAgent.has(agentId)) return;
    const tree = [...this.trees.values()]
      .filter(
        (item) =>
          item.agentId === agentId &&
          item.status === 'open' &&
          item.resumeCount < 3 &&
          this.turns.get(item.rootTurnId)?.status === 'parked',
      )
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!tree) return;
    tree.resumeCount += 1;
    const root = this.turns.get(tree.rootTurnId);
    // 先了结再跑：续跑回合自己的 finally 会再触发 resumeOwed，不改状态会立即再续一轮
    if (root && root.status === 'parked') root.status = 'done';

    const task: Message = {
      id: randomUUID(),
      agentId,
      role: 'user',
      content: {
        type: 'text',
        text: `（续）回到之前被打断的任务：${root?.text ?? ''}`,
      },
      createdAt: Date.now(),
      source: 'user',
    };
    try {
      const result = await this.runTurn(
        agentId,
        task,
        {
          resume: true,
          skipPersist: true,
          brief:
            '你之前有一件事被主人的新指令打断了，现在接着做。上面「续」的消息就是那件事的原文。先把旧事做完；如果情况已经变化做不下去了，用一句话说明原因即可。',
        },
        {},
      );
      // 续跑本身又被插队 → 这笔账重新记欠
      if (result.stopReason === 'parked' && root && root.status === 'done') {
        root.status = 'parked';
      }
    } catch {
      if (root && root.status === 'done') root.status = 'parked';
    }
  }


  private async touchSurfaced(refs: MemoryRef[]): Promise<void> {
    const byScope = new Map<string, { scope: MemoryScope; ownerId: string; ids: string[] }>();
    for (const ref of refs) {
      const key = `${ref.scope}:${ref.ownerId}`;
      const bucket = byScope.get(key) ?? { scope: ref.scope, ownerId: ref.ownerId, ids: [] };
      bucket.ids.push(ref.entry.id);
      byScope.set(key, bucket);
    }
    for (const bucket of byScope.values()) {
      await this.memory.touch(bucket.scope, bucket.ownerId, bucket.ids).catch(() => undefined);
    }
  }

  private resolveModel(model?: string): string {
    return this.agentService.resolveModel(model);
  }

  private providerFor(model: string): LLMProvider {
    return this.agentService.providerFor(model);
  }
}


export type { AgentEvent, RoomEvent, RoundOutcome };
