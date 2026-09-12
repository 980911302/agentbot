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
import { assembleAgent } from '../agent/assemble.js';
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
import { createAgentMessageTool, createSayTool, createSilentTool } from '../tools/examples/room.js';
import type { Tool, TurnState } from '../tools/tool.js';

export interface SeedAgent {
  name: string;
  color: string;
  instructions: string;
  projectIds?: string[];
}

export interface SeedRoom {
  name: string;
  memberNames: string[];
}

export interface AgentRuntimeOptions {
  tools: Tool<any>[];
  createProvider: (model: string) => LLMProvider;
  dataDir: string;
  defaultModel: string;
  knownModels: string[];
  budget: ContextBudget;
  memoryExtraction: boolean;
  memoryStore?: MemoryStore;
  maxIterations?: number;
  seed?: SeedAgent[];
  seedRooms?: SeedRoom[];
  /** 智能体互传的链深度上限，防止无限互发 */
  maxAgentChainDepth?: number;
  /** 主人在群里的显示名；不配则用「主人」 */
  ownerName?: string;
  /** 交互代理（工具问用户 → 界面作答）；不传则自建 */
  broker?: InteractionBroker;
  /** 密钥存储；不传则自建 */
  secrets?: SecretStore;
  /** 停止词表；不传用默认（《停止与插话.md》4.1） */
  stopWords?: string[];
  /** 停止令等下级回报的上限（默认 30s；测试可调短） */
  stopAckTimeoutMs?: number;
}

export interface SendOptions {
  model?: string;
  onEvent?: AgentEventHandler;
  onRoomEvent?: RoomEventHandler;
  /** 私聊流式：增量文本回调（群回合不透传，避免露出不进历史的收尾推理） */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  /** 覆盖主人显示名（一般不用传，从 runtime 配置读） */
  ownerName?: string;
  /** 这些成员跳过这一轮（工作台代发时排除调用者自己） */
  excludeAgentIds?: string[];
}

/** 一次回合的记账（《停止与插话.md》4.1） */
export interface RuntimeTurn {
  id: string;
  agentId: string;
  source: 'user' | 'agent' | 'room' | 'resume';
  kind: 'normal' | 'stop';
  text: string;
  treeId: string;
  status: 'running' | 'parked' | 'done' | 'cancelled';
  createdAt: number;
}

/** 一轮派生出去的任务树（4.2）：停止令按这张表往下走 */
export interface TaskTree {
  id: string;
  rootTurnId: string;
  agentId: string;
  jobs: Array<{ abort: AbortController; label: string }>;
  children: Array<{ agentId: string; via: 'dm' | 'room'; roomId?: string }>;
  status: 'open' | 'cancelling' | 'cancelled';
  /** 自动续跑次数上限 3，防止打断-续跑打乒乓 */
  resumeCount: number;
  createdAt: number;
}

/** 撞上用户回合被挂起的停止令 */
interface PendingStop {
  text: string;
  createdAt: number;
  options: SendOptions;
  /** true = 发起者是用户（要回「在停/停完了」）；false = 上级停止令（要回 stop-ack） */
  notifyUser: boolean;
  replyTo?: { agentId: string; name: string };
  resolve?: (result: SendResult) => void;
}

export interface TurnResult extends RunResult {
  agentId: string;
  agentName: string;
  context: BuiltContext;
  /** 群回合真正发到房间的正文；空数组 = 沉默 */
  posts: string[];
  status: RoundStatus;
}

export interface SendResult extends TurnResult {}

export interface RoomRoundSummary {
  roundId: string;
  roomId: string;
  roomName: string;
  outcomes: RoundOutcome[];
  /** 因为正在跑别的回合而跳过的成员名 */
  skipped: string[];
}

export class AgentBusyError extends Error {
  constructor() {
    super('This agent is already running a request');
    this.name = 'AgentBusyError';
  }
}

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
 * 一次「回合」对应《群聊与智能体交互.md》里的单元：
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

  private readonly tools: Tool<any>[];
  private readonly builder: ContextBuilder;
  private readonly compactor: Compactor;
  private readonly extractor: MemoryExtractor;
  private readonly providers = new Map<string, LLMProvider>();
  private readonly locks = new Set<string>();

  /** 回合与任务树（《停止与插话.md》§4）：内存即可，消息本身已落盘 */
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

    this.tools = [...options.tools, ...createWorkbenchTools(this.workbench)];
    this.registry.setDefaultToolNames(this.tools.map((tool) => tool.name));
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
    const refs = await this.memory.visibleTo(record.id, { projectIds: record.projectIds });
    const compaction = await this.compaction.get(record.id);
    return assembleAgent({
      record,
      memory: { refs, compaction, projectIds: record.projectIds },
      tools: this.tools,
    });
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
    // 《停止与插话.md》§5：认停止词是运行时的事，不让模型「想起来去通知别人」
    if (isStopSentence(text, this.options.stopWords ?? DEFAULT_STOP_WORDS)) {
      return this.stopOrQueue(agentId, text, options);
    }

    // 用户新句作废还没回答的选项卡——不当答案（§2）
    await this.voidPendingInteractions(agentId, options.onEvent);

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

  /** 停止令入口：撞上正在跑的用户回合就排队（那条 SSE 保持打开），否则立刻执行 */
  private stopOrQueue(
    agentId: string,
    text: string,
    options: SendOptions,
  ): Promise<SendResult> {
    const runningId = this.runningTurnByAgent.get(agentId);
    const running = runningId ? this.turns.get(runningId) : undefined;
    if (running && running.source === 'user' && running.status === 'running') {
      let resolve!: (result: SendResult) => void;
      const done = new Promise<SendResult>((settle) => {
        resolve = settle;
      });
      const queue = this.pendingStops.get(agentId) ?? [];
      queue.push({ text, createdAt: Date.now(), options, notifyUser: true, resolve });
      this.pendingStops.set(agentId, queue);
      return done;
    }
    return this.executeStop(agentId, { text, createdAt: Date.now() }, {
      notifyUser: true,
      options,
    });
  }

  /**
   * 执行停止令（机械步骤，不经模型，§5）：
   * 在停 → 砍早于本令的树 → dm 下发紧急件 / room 普通文本 → 等 stop-ack 或超时 → 停完了。
   * 上级的令（notifyUser=false）走同一套，只是不写自己的对话线、最后回 stop-ack。
   */
  private async executeStop(
    agentId: string,
    stop: { text: string; createdAt: number },
    opts: { notifyUser: boolean; options: SendOptions; replyTo?: { agentId: string; name: string } },
  ): Promise<SendResult> {
    const record = await this.registry.get(agentId);
    const name = record?.name ?? '智能体';
    const emit = opts.options.onEvent;

    const persist = async (line: string): Promise<void> => {
      if (!opts.notifyUser) return;
      const message: Message = {
        id: randomUUID(),
        agentId,
        role: 'assistant',
        content: { type: 'text', text: line },
        createdAt: Date.now(),
        source: 'user',
      };
      await this.messages.append(message);
      emit?.({ type: 'message', message });
    };

    await persist('好的，在停。');

    // 只砍「早于本令」的 open 树：停止令之后用户新开的事不受牵连
    const targets = [...this.trees.values()].filter(
      (tree) => tree.agentId === agentId && tree.status === 'open' && tree.createdAt < stop.createdAt,
    );
    const dmChildren: Array<{ agentId: string; treeId: string }> = [];
    const roomChildren: Array<{ roomId?: string }> = [];
    for (const tree of targets) {
      tree.status = 'cancelling';
      for (const job of tree.jobs) job.abort.abort();
      for (const child of tree.children) {
        if (child.via === 'dm') dmChildren.push({ agentId: child.agentId, treeId: tree.id });
        else roomChildren.push({ roomId: child.roomId });
      }
    }

    for (const child of dmChildren) {
      await this.inbox.enqueue({
        toAgentId: child.agentId,
        fromAgentId: agentId,
        fromName: name,
        text: '停止令：把手上正在做的活停掉。',
        priority: true,
        depth: 0,
        kind: 'stop',
        treeId: child.treeId,
      });
    }
    for (const child of roomChildren) {
      if (!child.roomId) continue;
      const message: RoomMessage = {
        id: randomUUID(),
        roomId: child.roomId,
        roundId: randomUUID(),
        senderKind: 'agent',
        senderId: agentId,
        senderName: name,
        text: '先停，别继续了。',
        mentions: [],
        everyone: false,
        createdAt: Date.now(),
      };
      await this.rooms.append(message);
      opts.options.onRoomEvent?.({ type: 'room_message', message });
    }

    if (dmChildren.length > 0) {
      await this.awaitStopAcks(agentId, dmChildren.length, this.options.stopAckTimeoutMs ?? 30_000);
    }

    for (const tree of targets) tree.status = 'cancelled';
    await persist('停完了。');

    if (opts.replyTo) {
      await this.inbox.enqueue({
        toAgentId: opts.replyTo.agentId,
        fromAgentId: agentId,
        fromName: name,
        text: '已停。',
        priority: true,
        depth: 0,
        kind: 'stop-ack',
      });
    }

    return {
      content: '停完了。',
      iterations: 0,
      stopReason: 'stopped',
      agentId,
      agentName: name,
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
      status: 'spoke',
    };
  }

  /** 等下级的 stop-ack；信箱里的 ack 由这里消费，不会进模型 */
  private async awaitStopAcks(agentId: string, expected: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let acked = 0;
    while (acked < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const taken = await this.inbox
        .take(agentId, (item) => item.kind === 'stop-ack')
        .catch(() => []);
      acked += taken.length;
    }
  }

  /** 用户新句作废未答选项卡：不当答案，也不留悬挂卡片 */
  private async voidPendingInteractions(
    agentId: string,
    emit?: AgentEventHandler,
  ): Promise<void> {
    const pending = this.broker.list({ agentId });
    for (const request of pending) {
      this.broker.cancel(request.id);
      emit?.({ type: 'interaction_closed', id: request.id, answered: false });
    }
  }

  // ── 群回合：扇出叫醒 ────────────────────────────────

  /**
   * 用户往房间发一条 → 扇出给全体成员。
   *
   * 分三波（对应《群聊与智能体交互.md》第 3、4.1 节）：
   *   波次 1  被点名的人              串行 —— 后者要能看到前者发言
   *   波次 2  在场但未被点名的人       并行 —— 互相看不见（见 docs/链路文档.md）
   *   波次 3  被同事发言再次 @ 的人    串行，受 ROOM_MAX_RUNS_PER_MEMBER 约束
   *
   * `@` 是强信号不是投递开关：没被点名的一样进这一轮，只是不强制开口。
   */
  async postToRoom(
    roomId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<RoomRoundSummary> {
    const { room, members } = await this.membersOf(roomId);
    if (!room) throw new Error(`Unknown room: ${roomId}`);
    if (members.length === 0) throw new Error('房间没有成员');

    // 正在进行别的回合的成员不能被打断；工作台代发时还要排除调用者自己
    const exclude = new Set(options.excludeAgentIds ?? []);
    const skipped: string[] = [];
    const active = members.filter((record) => {
      if (exclude.has(record.id)) return false;
      if (this.locks.has(record.id)) {
        skipped.push(record.name);
        return false;
      }
      return true;
    });
    if (active.length === 0) throw new Error('房间里没有可叫醒的成员（其他人正忙）');

    const memberLike: RoomMemberLike[] = active.map((record) => ({
      id: record.id,
      name: record.name,
      color: record.color,
    }));
    const byId = new Map(active.map((record) => [record.id, record]));

    const mentions = resolveMentions(text, memberLike);
    const roundId = randomUUID();
    const ownerName = options.ownerName ?? this.options.ownerName ?? DEFAULT_OWNER_NAME;
    // 群里的停止令（《停止与插话.md》§3）：不能紧急下发，被点名者下一轮从简报里知道
    const stopRequested = isStopSentence(text, this.options.stopWords ?? DEFAULT_STOP_WORDS);

    const inbound: RoomMessage = {
      id: randomUUID(),
      roomId,
      roundId,
      senderKind: 'user',
      senderId: OWNER_ID,
      senderName: ownerName,
      text,
      mentions: mentions.ids,
      everyone: mentions.everyone,
      createdAt: Date.now(),
    };
    await this.rooms.append(inbound);
    options.onRoomEvent?.({ type: 'room_message', message: inbound });

    // 入站消息写进每个成员自己的对话线（私聊与群聊是同一条线）
    const stripped = stripMentions(text, memberLike);
    await Promise.all(
      active.map((member) =>
        this.messages.append({
          id: randomUUID(),
          agentId: member.id,
          role: 'user',
          content: { type: 'text', text: stripped },
          createdAt: inbound.createdAt,
          roomId,
          roomName: room.name,
          speaker: ownerName,
          source: 'room',
        }),
      ),
    );

    const queue = new SummonQueue(
      memberLike.map((item) => item.id),
      mentions,
      ROOM_MAX_RUNS_PER_MEMBER,
    );
    const outcomes: RoundOutcome[] = [];
    /** 本轮已公开的发言，喂给后开口的人，避免重复 */
    const roundPosts: Array<{ speaker: string; text: string }> = [];

    const fanOut = async (agentId: string): Promise<void> => {
      const member = byId.get(agentId);
      if (!member) return;

      // 同步占名额：并行派发时同波次的人必须先登记，否则互相 @ 会漏掉
      const runIndex = queue.reserve(agentId);
      if (runIndex > ROOM_MAX_RUNS_PER_MEMBER) return;

      options.onRoomEvent?.({ type: 'round_start', roundId, agentId, agentName: member.name });

      const outcome = await this.runRoomTurn({
        roomId,
        roomName: room.name,
        roundId,
        member,
        members: memberLike,
        inbound,
        summoned: queue.isSummoned(agentId),
        everyone: queue.mentionsFor(agentId).everyone,
        recallCount: runIndex,
        roundPosts: [...roundPosts],
        stopRequested: stopRequested && queue.isSummoned(agentId),
        options,
      });
      outcomes.push(outcome);
      options.onRoomEvent?.({ type: 'round_end', outcome });

      for (const post of outcome.posts) {
        // 每条发言都重新解析点名：成员之间的 @ 也要能叫醒人
        const postMentions = resolveMentions(post, memberLike);
        const posted: RoomMessage = {
          id: randomUUID(),
          roomId,
          roundId,
          senderKind: 'agent',
          senderId: member.id,
          senderName: member.name,
          senderColor: member.color,
          text: post,
          mentions: postMentions.ids,
          everyone: postMentions.everyone,
          createdAt: Date.now(),
        };
        await this.rooms.append(posted);
        options.onRoomEvent?.({ type: 'room_message', message: posted });
        roundPosts.push({ speaker: member.name, text: post });

        await Promise.all(
          active
            .filter((other) => other.id !== member.id)
            .map((other) =>
              this.messages.append({
                id: randomUUID(),
                agentId: other.id,
                role: 'user',
                content: { type: 'text', text: post },
                createdAt: posted.createdAt,
                roomId,
                roomName: room.name,
                speaker: member.name,
                source: 'room',
              }),
            ),
        );

        // 被同事点名的人排进队列，稍后单独跑一轮
        queue.summonFrom(postMentions, member.id);
      }
    };

    // 波次 1：被点名者，串行
    for (const agentId of queue.initiallySummoned()) await fanOut(agentId);

    // 波次 2：在场未点名者，并行（同波次互相看不见，但能看到波次 1 的发言）
    const bystanders = queue.bystanders();
    if (bystanders.length > 0) {
      await Promise.all(bystanders.map((agentId) => fanOut(agentId)));
    }

    // 波次 3：同事发言引发的新召唤，串行直到队列空或达每人上限
    while (queue.hasWaiting) {
      const agentId = queue.next();
      if (!agentId) break;
      await fanOut(agentId);
    }

    const spoke = outcomes.filter((item) => item.status === 'spoke').length;
    options.onRoomEvent?.({
      type: 'fanout_done',
      roundId,
      spoke,
      silent: outcomes.length - spoke,
    });

    return { roundId, roomId, roomName: room.name, outcomes, skipped };
  }

  private async runRoomTurn(input: {
    roomId: string;
    roomName: string;
    roundId: string;
    member: AgentRecord;
    members: RoomMemberLike[];
    inbound: RoomMessage;
    summoned: boolean;
    everyone: boolean;
    recallCount: number;
    roundPosts: Array<{ speaker: string; text: string }>;
    stopRequested?: boolean;
    options: SendOptions;
  }): Promise<RoundOutcome> {
    const startedAt = Date.now();
    const { member, members, inbound, summoned, options } = input;
    const posts: string[] = [];

    const brief = buildRoomBrief({
      roomName: input.roomName,
      members,
      selfId: member.id,
      speaker: inbound.senderName,
      summoned,
      everyone: input.everyone,
      postLimit: ROOM_POST_LIMIT_PER_TURN,
      roundPosts: input.roundPosts,
      recallCount: input.recallCount,
      stopRequested: input.stopRequested,
    });

    const task: Message = {
      id: randomUUID(),
      agentId: member.id,
      role: 'user',
      content: { type: 'text', text: stripMentions(inbound.text, members) },
      createdAt: inbound.createdAt,
      roomId: input.roomId,
      roomName: input.roomName,
      speaker: inbound.senderName,
      source: 'room',
    };

    try {
      const result = await this.runTurn(member.id, task, {
        brief,
        skipPersist: true,
        persistAssistantText: false,
        // 被点名时必须开口：连沉默工具都不给，把「必须说」做成硬约束
        extraTools: summoned
          ? [createSayTool(), this.agentMessageTool(member.id, 0)]
          : [createSayTool(), createSilentTool(), this.agentMessageTool(member.id, 0)],
        toolContext: {
          room: {
            roomId: input.roomId,
            roomName: input.roomName,
            posts,
            limit: ROOM_POST_LIMIT_PER_TURN,
          },
          agentChainDepth: 0,
        },
        posts,
        model: options.model,
        onEvent: options.onEvent,
        signal: options.signal,
      });

      // 被点名的人「必须开口」：模型直接输出正文也算开口，不要求它一定走 say。
      // 没被点名的人默认闭嘴，只有显式调用 say 才算真的往房间发了字。
      for (const post of decideRoomPosts({
        said: posts,
        summoned,
        finalText: result.content,
      })) {
        if (!posts.includes(post)) posts.push(post);
      }

      if (posts.length > 0) {
        // 自己的发言也要留在自己的对话里
        for (const post of posts) {
          await this.messages.append({
            id: randomUUID(),
            agentId: member.id,
            role: 'assistant',
            content: { type: 'text', text: post },
            createdAt: Date.now(),
            roomId: input.roomId,
            roomName: input.roomName,
            source: 'room',
          });
        }
      }

      return {
        roundId: input.roundId,
        roomId: input.roomId,
        agentId: member.id,
        agentName: member.name,
        agentColor: member.color,
        status: posts.length > 0 ? 'spoke' : 'silent',
        posts,
        note: posts.length > 0 ? undefined : silenceReason(result.usedTools ?? []),
        durationMs: Date.now() - startedAt,
        runIndex: input.recallCount,
      };
    } catch (error) {
      return {
        roundId: input.roundId,
        roomId: input.roomId,
        agentId: member.id,
        agentName: member.name,
        agentColor: member.color,
        status: 'error',
        posts: [],
        note: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        runIndex: input.recallCount,
      };
    }
  }

  // ── 智能体 1:1 ──────────────────────────────────────

  private agentMessageTool(selfId: string, depth: number) {
    return createAgentMessageTool({
      depth,
      maxDepth: this.options.maxAgentChainDepth ?? DEFAULT_MAX_AGENT_DEPTH,
      onSend: async ({ toAgentId, text, priority }) => {
        const target = await this.registry.get(toAgentId);
        if (!target) return `没有找到 id 为 ${toAgentId} 的智能体，请改用 @名字 在群里点名`;
        const sender = await this.registry.get(selfId);
        await this.inbox.enqueue({
          toAgentId,
          fromAgentId: selfId,
          fromName: sender?.name ?? '同事',
          text,
          priority,
          depth: depth + 1,
        });
        return `已投递给「${target.name}」，它会作为之后的一个新回合处理`;
      },
    });
  }

  /** 把积压的同事来信合并成一个回合处理 */
  async drainInbox(agentId: string, options: SendOptions & { depth?: number } = {}): Promise<TurnResult | null> {
    const items = await this.inbox.drain(agentId);
    if (items.length === 0) return null;

    const record = await this.registry.get(agentId);
    if (!record) return null;

    // 停止令优先处理（§4.3）：先砍自己这棵再回报；普通信照旧
    const stops = items.filter((item) => item.kind === 'stop');
    for (const stop of stops) {
      const runningId = this.runningTurnByAgent.get(agentId);
      const running = runningId ? this.turns.get(runningId) : undefined;
      const childStop = {
        text: stop.text,
        createdAt: stop.createdAt,
      };
      const replyTo = { agentId: stop.fromAgentId, name: stop.fromName };
      if (running && running.source === 'user' && running.status === 'running') {
        // 下级也保护正在进行的用户回合：排到回合结束再停
        const queue = this.pendingStops.get(agentId) ?? [];
        queue.push({
          text: childStop.text,
          createdAt: childStop.createdAt,
          options: {},
          notifyUser: false,
          replyTo,
        });
        this.pendingStops.set(agentId, queue);
      } else {
        await this.executeStop(agentId, childStop, { notifyUser: false, options: {}, replyTo }).catch(
          () => undefined,
        );
      }
    }

    const letters = items.filter((item) => item.kind !== 'stop' && item.kind !== 'stop-ack');
    if (letters.length === 0) return null;

    const depth = Math.max(...letters.map((item) => item.depth));
    const fromName = letters[0]?.fromName ?? '同事';
    const text = letters.map((item) => item.text).join('\n\n');

    const task: Message = {
      id: randomUUID(),
      agentId,
      role: 'user',
      content: { type: 'text', text },
      createdAt: Date.now(),
      speaker: fromName,
      source: 'agent',
    };

    const result = await this.runTurn(agentId, task, {
      brief: buildAgentBrief({
        fromName,
        depth,
        maxDepth: this.options.maxAgentChainDepth ?? DEFAULT_MAX_AGENT_DEPTH,
      }),
      extraTools: [this.agentMessageTool(agentId, depth)],
      toolContext: { agentChainDepth: depth },
    }, options);

    // 处理完这批，继续往下走（受深度上限约束）
    const deeper = await this.drainInbox(agentId, { ...options, depth: depth + 1 });
    void deeper;

    return result;
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

    // 《停止与插话.md》§7：用户的新句永远能开新回合——旧的断流挂起、树记欠；
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
    tree.jobs.push({ abort: controller, label: 'turn' });
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

      // 收尾顺序（《停止与插话.md》§3 优先级）：停止令 → 欠账续跑 → 同事来信
      await this.processPendingStops(agentId).catch(() => undefined);
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
      for (const job of tree.jobs) job.abort.abort();
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

  private async processPendingStops(agentId: string): Promise<void> {
    const queue = this.pendingStops.get(agentId);
    if (!queue || queue.length === 0) return;
    this.pendingStops.set(agentId, []);
    for (const stop of queue) {
      const result = await this.executeStop(
        agentId,
        { text: stop.text, createdAt: stop.createdAt },
        { notifyUser: stop.notifyUser, options: stop.options, replyTo: stop.replyTo },
      ).catch(() => undefined);
      stop.resolve?.(
        result ?? {
          content: '停完了。',
          iterations: 0,
          stopReason: 'stopped',
          agentId,
          agentName: agentId,
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
          status: 'spoke',
        },
      );
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
    if (model && this.options.knownModels.includes(model)) return model;
    return this.options.defaultModel;
  }

  private providerFor(model: string): LLMProvider {
    let provider = this.providers.get(model);
    if (!provider) {
      provider = this.options.createProvider(model);
      this.providers.set(model, provider);
    }
    return provider;
  }
}

function silenceReason(usedTools: string[]): string {
  if (usedTools.includes('stay_silent')) return '这一轮没有要补充的';
  return '这一轮没有开口';
}

export type { AgentEvent, RoomEvent, RoundOutcome };
