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
import { createWorkbenchTools } from '../tools/builtin/workbench.js';
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
import { resolveProjectOwner } from '../tools/builtin/memory.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSendToAgentTool } from '../tools/builtin/room.js';
import { createTaskTools } from '../tools/builtin/task.js';
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
import { RunExecutor } from './runtime/run-executor.js';
import { RoomDispatcher } from './runtime/room-dispatcher.js';
import { ReceivedStore } from '../storage/received-store.js';
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
  /** 回合执行核心（E2.2 拆出）：调度/记账/模型循环/记忆收尾 */
  private readonly executor: RunExecutor;
  /** 接收幂等日志（E3.2） */
  private readonly receivedStore: ReceivedStore;
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
      drainInbox: (agentId, options) => this.drainInbox(agentId, options),
      locks: this.locks,
      turnsMap: this.turns,
      treesMap: this.trees,
      runningTurnByAgentMap: this.runningTurnByAgent,
      maxIterations: options.maxIterations,
    });

    this.tools = [
      ...options.tools,
      ...createWorkbenchTools(this.workbench),
      this.createSendToAgentTool(),
      ...createTaskTools({
        provider: this.agentService.providerFor(this.options.defaultModel),
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
    const clientMessageId = options.clientMessageId;
    if (clientMessageId) {
      const existing = this.receivedStore.find(clientMessageId);
      if (existing) {
        // E3.2：重复提交返回原消息，不开新回合
        const original = (await this.messages.list(agentId)).find((m) => m.id === existing.messageId);
        if (original) {
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
      }
    }

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
      ...(clientMessageId ? { clientMessageId } : {}),
    };
    if (clientMessageId) {
      this.receivedStore.record(clientMessageId, { messageId: task.id, agentId });
    }
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
    const clientMessageId = options.clientMessageId;
    if (clientMessageId) {
      const existing = this.receivedStore.find(clientMessageId);
      if (existing) {
        // E3.2：重复提交不再扇出，直接按已处理返回
        return { roundId: '', roomId, roomName: roomId, outcomes: [], skipped: [] };
      }
    }
    const summary = await this.roomDispatcher.postToRoom(roomId, text, options);
    if (clientMessageId) {
      this.receivedStore.record(clientMessageId, { messageId: summary.roundId, agentId: roomId });
    }
    return summary;
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
