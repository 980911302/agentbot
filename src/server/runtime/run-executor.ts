import { randomUUID } from 'node:crypto';
import { AgentLoop } from '../../agent/agent-loop.js';
import type { AgentEventHandler, MemoryRef } from '../../agent/types.js';
import type { Message, RunResult } from '../../shared/contracts/sse.js';
import type { ContextBuilder } from '../../context/builder.js';
import type { Compactor, CompactionStore } from '../../memory/compact.js';
import type { MemoryExtractor } from '../../memory/extract.js';
import type { MemoryScope } from '../../memory/types.js';
import { ToolRegistry } from '../../tools/registry.js';
import type { Tool, TurnState } from '../../tools/tool.js';
import type { AgentRegistry } from '../../agent/registry.js';
import type { MessageStore } from '../../store/messages.js';
import type { MemoryStore } from '../../memory/store.js';
import type { AgentInbox } from '../../agent/inbox.js';
import type { RunLedger } from '../../storage/run-ledger.js';
import type { ToolInvocationPort } from '../../storage/ports.js';
import type { AgentService } from './agent-service.js';
import type { StopCoordinator } from './stop-coordinator.js';
import { AgentBusyError } from './types.js';
import type { RuntimeTurn, SendOptions, SendResult, TaskTree, TurnResult } from './types.js';

/**
 * RunExecutor（E2.2 拆出，E3.3 记账改经 RunLedger）：一次回合的执行核心。
 *
 * 实现《工程化执行计划.md》E2.2 的调度语义：
 *   - 用户的新句永远能开新回合——旧的断流挂起（park）、树记欠，结束后自动补跑（resume）
 *   - 同事信/群/续跑撞上忙智能体维持退避，不打扰正在进行的用户回合
 *   - 回合收尾顺序：停止令 → 欠账续跑 → 同事来信
 *
 * 回合/任务树的状态与「谁占着执行位」写入 RunLedger（E3.1 边界）；
 * AbortController 这类执行句柄只留在账本的内存支路，不随状态落盘。
 */
export class RunExecutor {
  private readonly ledger: RunLedger;
  private readonly locks: Set<string>;

  constructor(
    private readonly deps: {
      registry: AgentRegistry;
      messages: MessageStore;
      memory: MemoryStore;
      inbox: AgentInbox;
      builder: ContextBuilder;
      compactor: Compactor;
      compaction: CompactionStore;
      extractor: MemoryExtractor;
      agentService: AgentService;
      stopCoordinator: StopCoordinator;
      /** 收件箱积压时的消费入口（InboxProcessor） */
      drainInbox: (agentId: string, options: SendOptions) => Promise<unknown>;
      locks: Set<string>;
      ledger: RunLedger;
      /** 工具执行账本（E3.5）：先记意图再执行再记结果 */
      toolLedger: ToolInvocationPort;
      maxIterations?: number;
    },
  ) {
    this.ledger = deps.ledger;
    this.locks = deps.locks;
  }

  /** 回合执行入口：调度（抢占/排队）→ 组装 → 模型-工具循环 → 记忆收尾 */
  async runTurn(
    agentId: string,
    task: Message,
    turn: {
      brief?: string;
      extraTools?: Tool<any>[];
      toolContext?: { room?: { roomId: string; roomName: string; posts: string[]; limit: number }; agentChainDepth?: number };
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
    const existingTurnId = this.ledger.runningTurnOf(agentId);
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
      children: [],
      status: 'open',
      resumeCount: 0,
      createdAt: runtimeTurn.createdAt,
    };
    this.ledger.putTurn(runtimeTurn);
    this.ledger.putTree(tree);
    this.ledger.acquireRunning(agentId, turnId);
    this.locks.add(agentId);

    // 本回合自己的 abort 控制器：挂起（park）就掐这里；外部 close 信号并行生效
    const controller = new AbortController();
    this.ledger.jobsOf(treeId).push({ abort: () => controller.abort(), label: 'turn' });
    const externalSignal = turn.signal ?? options.signal;
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    try {
      const record = await this.deps.registry.get(agentId);
      if (!record) throw new Error(`Unknown agent: ${agentId}`);

      const model = this.deps.agentService.resolveModel(turn.model ?? options.model);
      const provider = this.deps.agentService.providerFor(model);

      if (!turn.skipPersist) {
        await this.deps.messages.append(task);
        options.onEvent?.({ type: 'message', message: task });
      }

      let agent = await this.deps.agentService.buildAgent(record);

      const compaction = await this.deps.compactor.maybeCompact(agent, provider).catch(() => null);
      if (compaction) {
        options.onEvent?.({
          type: 'compacted',
          coversUpTo: compaction.state.coversUpTo,
          messageCount: compaction.state.messageCount,
        });
        agent = await this.deps.agentService.buildAgent(record);
      }

      const buildOptions: { turnBrief?: string } = { turnBrief: turn.brief };
      const built = await this.deps.builder.build(agent, task, buildOptions);
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
            this.ledger.putTree(tree);
          }
        },
        registerJob: (abort, label) => this.ledger.jobsOf(treeId).push({ abort, label }),
        persistOutgoing: async (text) => {
          const message: Message = {
            id: randomUUID(),
            agentId,
            role: 'assistant',
            content: { type: 'text', text },
            createdAt: Date.now(),
            source: 'agent',
          };
          await this.deps.messages.append(message);
          options.onEvent?.({ type: 'message', message });
        },
      };

      const loop = new AgentLoop({
        provider,
        messages: this.deps.messages,
        maxIterations: this.deps.maxIterations,
        onEvent: options.onEvent,
        onDelta: turn.onDelta,
        signal,
        toolsOverride: registry,
        toolContext: { ...(turn.toolContext ?? {}), turnState, emit: options.onEvent },
        persistAssistantText: turn.persistAssistantText,
        stamp: task.roomId
          ? { roomId: task.roomId, roomName: task.roomName, speaker: task.speaker, source: 'room' }
          : { source: task.source },
        // E3.5：工具执行账本——先记意图，执行后回填结果，中断的留着给恢复核对
        invocations: this.deps.toolLedger,
        runId: turnId,
        treeId,
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
        await this.deps.registry.update(agentId, {});
        const exchange = await this.deps.messages.recent(agentId, 12, task.id);
        const extracted = await this.deps.extractor
          .extract(await this.deps.agentService.buildAgent(record), provider, [...exchange, task])
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
      if (this.ledger.runningTurnOf(agentId) === turnId) {
        this.ledger.releaseRunning(agentId, turnId);
        this.locks.delete(agentId);
      }
      if (runtimeTurn.status === 'running') {
        runtimeTurn.status = 'done';
        this.ledger.putTurn(runtimeTurn);
      }
      this.ledger.setJobs(
        treeId,
        this.ledger.jobsOf(treeId).filter((job) => job.label !== 'turn'),
      );

      // 收尾顺序（优先级）：停止令 → 欠账续跑 → 同事来信
      await this.deps.stopCoordinator.processPendingStops(agentId).catch(() => undefined);
      void this.resumeOwed(agentId).catch(() => undefined);
      const claimable = await this.deps.inbox.claimableCount(agentId).catch(() => 0);
      if (claimable > 0) {
        this.deps.drainInbox(agentId, { model: turn.model ?? options.model }).catch(() => undefined);
      }
    }
  }

  /** 把正在跑的回合断流挂起：旧树保持 open 记欠，等新回合结束再补跑 */
  private parkTurn(agentId: string, turnId: string): void {
    const rt = this.ledger.getTurn(turnId);
    if (!rt || rt.status !== 'running') return;
    rt.status = 'parked';
    this.ledger.putTurn(rt);
    const tree = this.ledger.getTree(rt.treeId);
    if (tree) {
      for (const job of this.ledger.jobsOf(tree.id)) job.abort();
    }
  }

  /** 欠账补跑：最早的、还没续过 3 次的 parked 树，接回去继续做 */
  private async resumeOwed(agentId: string): Promise<void> {
    if (this.ledger.runningTurnOf(agentId)) return;
    const tree = this.ledger
      .listTrees()
      .filter(
        (item) =>
          item.agentId === agentId &&
          item.status === 'open' &&
          item.resumeCount < 3 &&
          this.ledger.getTurn(item.rootTurnId)?.status === 'parked',
      )
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!tree) return;
    tree.resumeCount += 1;
    this.ledger.putTree(tree);
    const root = this.ledger.getTurn(tree.rootTurnId);
    // 先了结再跑：续跑回合自己的 finally 会再触发 resumeOwed，不改状态会立即再续一轮
    if (root && root.status === 'parked') {
      root.status = 'done';
      this.ledger.putTurn(root);
    }

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
        this.ledger.putTurn(root);
      }
    } catch {
      if (root && root.status === 'done') {
        root.status = 'parked';
        this.ledger.putTurn(root);
      }
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
      await this.deps.memory.touch(bucket.scope, bucket.ownerId, bucket.ids).catch(() => undefined);
    }
  }
}
