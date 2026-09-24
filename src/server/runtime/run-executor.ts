import { randomUUID } from 'node:crypto';
import type { RunContinuation } from '../../agent/continuation.js';
import { assertExecution } from '../../agent/execution-guard.js';
import { MemoryMaintenance } from '../../memory/maintenance.js';
import { AgentLoop } from '../../agent/agent-loop.js';
import type { AgentEventHandler, MemoryRef } from '../../agent/types.js';
import type { Message, RunResult } from '../../shared/contracts/sse.js';
import type { ContextBuilder, BuiltContext } from '../../context/builder.js';
import { composeResumeBrief } from '../../context/prompt-renderer.js';
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
import type { TaskProgressStore } from '../../storage/task-progress.js';
import type { ToolOutputStore } from '../../tools/services/tool-output-store.js';
import type { AgentService } from './agent-service.js';
import type { StopCoordinator } from './stop-coordinator.js';
import type { ChatRunCoordinator } from './chat-run-coordinator.js';
import { AgentBusyError } from './types.js';
import type { RuntimeTurn, SendOptions, SendResult, TaskTree, TurnResult } from './types.js';

/**
 * RunExecutor（E2.2 拆出，E3.3 记账改经 RunLedger）：一次回合的执行核心。
 *
 * 调度语义（E2.2）：
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
  private readonly maintenance: MemoryMaintenance;
  private readonly active = new Set<Promise<TurnResult>>();
  private closed = false;

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
      activation?: {
        ticketOf(id: string): import('../../shared/contracts/execution-control.js').ActivationTicket | undefined;
        settleTicket?(id: string): Promise<void>;
        tryActivate?(input: import('../../shared/contracts/execution-control.js').ActivationRequest): Promise<import('../../shared/contracts/execution-control.js').ActivationDecision>;
        markRunning?(ticket: import('../../shared/contracts/execution-control.js').ActivationTicket): Promise<void>;
      };
      effectRunner?: import('./effect-runner.js').EffectRunner;
      flowService?: import('./room-flow-service.js').RoomFlowService;
      /** 收件箱积压时的消费入口（InboxProcessor） */
      drainInbox: (agentId: string, options: SendOptions) => Promise<unknown>;
      canAutoActivate?: (agentId: string) => boolean;
      locks: Set<string>;
      ledger: RunLedger;
      /** 工具执行账本（E3.5）：先记意图再执行再记结果 */
      toolLedger: ToolInvocationPort;
      progress: TaskProgressStore;
      outputs: ToolOutputStore;
      maxIterations?: number;
      chatRuns: ChatRunCoordinator;
      canResumeRoom: (agentId: string, roomId: string) => Promise<boolean>;
      publishResumedPosts: (agentId: string, continuation: RunContinuation, posts: string[], options: SendOptions) => Promise<void>;
      onMemory: (agentId: string, runId: string, added: MemoryRef[], merged: number) => void;
    },
  ) {
    this.ledger = deps.ledger;
    this.locks = deps.locks;
    this.maintenance = new MemoryMaintenance(deps.extractor);
  }

  cancelMaintenance(agentId: string): void { this.maintenance.cancel(agentId); }
  async close(): Promise<void> {
    this.closed = true; this.maintenance.close();
    for (const tree of this.ledger.listTrees()) for (const job of this.ledger.jobsOf(tree.id)) job.abort();
    await Promise.allSettled(this.active);
  }

  /** 回合执行入口：调度（抢占/排队）→ 组装 → 模型-工具循环 → 记忆收尾 */
  async runTurn(
    agentId: string,
    task: Message,
    turn: Parameters<RunExecutor['executeTurn']>[2],
    options: SendOptions = {},
  ): Promise<TurnResult> {
    if (this.closed) throw new Error('运行时已关闭');
    const continuation = turn.resumeTaskId ? this.ledger.getTurn(turn.resumeTaskId)?.continuation : undefined;
    if (turn.resume && continuation) {
      const posts: string[] = [];
      task = { ...task, source: continuation.source, speaker: continuation.speaker, sender: continuation.sender, images: continuation.images,
        ...(continuation.room ? { roomId: continuation.room.roomId, roomName: continuation.room.roomName } : {}) };
      turn = { ...turn, model: continuation.model, continuation,
        brief: [continuation.brief, turn.brief].filter(Boolean).join('\n\n'),
        persistAssistantText: continuation.persistAssistantText, posts,
        toolContext: { agentChainDepth: continuation.agentChainDepth,
          ...(continuation.room ? { room: { ...continuation.room, posts } } : {}) } };
    }
    const parent = options.runId ? this.deps.chatRuns.get(options.runId) : undefined;
    const source = turn.resume ? 'resume' : task.source ?? 'user';
    const run = parent?.kind === 'agent' && parent.agentId === agentId && parent.messageId === task.id
      ? parent
      : this.deps.chatRuns.prepare({
        channelId: task.roomId ?? agentId, agentId, roomId: task.roomId, kind: 'agent', source,
        input: task.content.type === 'text' ? task.content.text : '',
        parentRunId: turn.resumeTaskId ?? parent?.runId,
        messageId: task.id,
      }).run;
    const scoped = this.deps.chatRuns.bind(run, options);
    if (turn.resume && turn.continuation?.room?.live && turn.toolContext?.room) {
      const continuation = turn.continuation;
      turn.toolContext.room.publish = text => this.deps.publishResumedPosts(agentId, continuation, [text], scoped);
    }
    const execution = this.deps.chatRuns.execute(run.runId,
      () => this.executeTurn(agentId, { ...task, runId: run.runId }, turn, scoped), result => result);
    this.active.add(execution);
    try { return await execution; } finally { this.active.delete(execution); }
  }

  private async executeTurn(
    agentId: string,
    task: Message,
    turn: {
      brief?: string;
      extraTools?: Tool<any>[];
      toolContext?: {
        room?: import('../../tools/tool.js').RoomTurnContext;
        agentChainDepth?: number;
        replyRoute?: import('../../shared/contracts/room-flow.js').RoomReplyRoute;
        flowContext?: import('../../shared/contracts/room-flow.js').FlowBriefContext;
        flowService?: import('./room-flow-service.js').RoomFlowService;
      };
      continuation?: RunContinuation;
      persistAssistantText?: boolean;
      skipPersist?: boolean;
      posts?: string[];
      model?: string;
      onEvent?: AgentEventHandler;
      /** 仅私聊传入：模型增量文本透传成 delta 事件 */
      onDelta?: (text: string) => void;
      /** 内部续跑回合（欠账补跑）：不算用户来源，忙时退避 */
      resume?: boolean;
      resumeTaskId?: string;
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

    const turnId = options.runId!;
    this.maintenance.cancel(agentId);
    const treeId = randomUUID();
    const progressScope = turn.resume && turn.resumeTaskId
      ? this.deps.progress.get(turn.resumeTaskId, agentId)?.scope ?? 'dm'
      : task.roomId ? `room:${task.roomId}` : task.source === 'agent' ? 'agent' : 'dm';
    const parentProgress = turn.resumeTaskId && this.deps.progress.get(turn.resumeTaskId, agentId) ? turn.resumeTaskId : undefined;
    this.deps.progress.begin(turnId, agentId, task.content.type === 'text' ? task.content.text : '', progressScope, parentProgress);
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
      rootFinished: false,
      resumeCount: 0,
      createdAt: runtimeTurn.createdAt,
    };
    this.ledger.putTurn(runtimeTurn);
    this.ledger.putTree(tree);
    // E3.6：取得执行位并让 epoch 前进；旧执行（被抢占的那次）迟到写回时凭执行位不符被拦
    runtimeTurn.leaseEpoch = this.ledger.beginRun(agentId, turnId);
    this.locks.add(agentId);

    // 本回合自己的 abort 控制器：挂起（park）就掐这里；外部 close 信号并行生效
    const controller = new AbortController();
    this.ledger.jobsOf(treeId).push({ abort: () => controller.abort(), label: 'turn' });
    const externalSignal = turn.signal ?? options.signal;
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    const guard = { signal, isCurrent: () => this.ledger.runningTurnOf(agentId) === turnId };
    let builtContext: BuiltContext = { agentId, system: '', messages: [], surfaced: [], droppedRecent: 0, droppedGroups: 0,
      stats: { sections: [], totalTokens: 0, budgetTokens: 0, generatedAt: Date.now() } };

    try {
      const savedRecord = await this.deps.registry.get(agentId);
      const record = savedRecord && turn.continuation ? { ...savedRecord,
        projectIds: savedRecord.projectIds.filter(id => turn.continuation!.authority.projectIds.includes(id)) } : savedRecord;
      if (!record) throw new Error(`Unknown agent: ${agentId}`);

      const model = this.deps.agentService.resolveModel(turn.model ?? options.model);
      const provider = this.deps.agentService.providerFor(model);

      if (!turn.skipPersist) {
        await this.deps.messages.append(task);
        options.onEvent?.({ type: 'message', message: task });
      }

      let agent = await this.deps.agentService.buildAgent(record);

      // 从当前注册表装配可执行工具；续跑快照只收紧授权上限，不能恢复已撤销的权限。
      const available = [...agent.tools, ...(turn.extraTools ?? [])];
      const registry = ToolRegistry.from(turn.continuation
        ? available.filter(tool => turn.continuation!.authority.toolNames.includes(tool.name)) : available);
      const authority = { toolNames: registry.list().map(tool => tool.name), projectIds: agent.memory.projectIds, model };
      runtimeTurn.continuation = { version: 1, source: task.source ?? 'user', model, authority,
        inputId: options.authorization?.inputId,
        chainId: options.authorization?.chainId,
        grantId: options.authorization?.grantId,
        flowId: options.authorization?.flowId,
        flowGrantId: options.authorization?.flowGrantId,
        replyRoute: options.authorization?.replyRoute,
        brief: turn.continuation?.brief ?? turn.brief, speaker: task.speaker, sender: task.sender, images: task.images,
        agentChainDepth: turn.toolContext?.agentChainDepth ?? 0, persistAssistantText: turn.persistAssistantText !== false,
        ...(turn.toolContext?.room ? { room: { roomId: turn.toolContext.room.roomId, roomName: turn.toolContext.room.roomName,
          roundId: turn.toolContext.room.roundId ?? options.runId!, limit: turn.toolContext.room.limit,
          live: turn.toolContext.room.live } } : {}) };
      this.ledger.putTurn(runtimeTurn);
      const compaction = await this.deps.compactor.maybeCompact(agent, provider, guard).catch(() => { assertExecution(guard); return null; });
      assertExecution(guard);
      if (compaction) {
        options.onEvent?.({
          type: 'compacted',
          coversUpTo: compaction.state.coversUpTo,
          messageCount: compaction.state.messageCount,
        });
        agent = await this.deps.agentService.buildAgent(record);
      }

      const built = await this.deps.builder.build(agent, task, {
        turnBrief: turn.brief, model, scope: progressScope, tools: registry.getSchemas(),
        systemSnapshot: turn.resumeTaskId ? this.deps.progress.getSystemSnapshot(turn.resumeTaskId, agentId) : undefined,
        latestUserMessage: turn.resume ? await this.deps.messages.latestUser(agentId) : undefined,
      });
      builtContext = built;
      assertExecution(guard);
      if (built.systemSnapshot) this.deps.progress.saveSystemSnapshot(turnId, built.systemSnapshot);
      if (turn.resumeTaskId) {
        // 历史数据不提升成 system；置于当前任务前，用户最新要求优先。
        built.messages.splice(Math.max(0, built.messages.length - 1), 0, { role: 'user', content: this.deps.progress.brief(turnId, agentId) });
      }
      options.onEvent?.({ type: 'context', stats: built.stats });
      await this.touchSurfaced(built.surfaced);

      // 本轮配额：工作台工具建多少同事/群，回合结束即失效；树记账挂同一份状态
      const completeChild = (child: { agentId: string; via: 'dm' | 'room'; roomId?: string }): void => {
        const target = tree.children.find(
          (item) =>
            item.agentId === child.agentId &&
            item.via === child.via &&
            (item.roomId ?? '') === (child.roomId ?? ''),
        );
        if (target) target.status = 'completed';
        this.finishTreeIfSettled(tree);
      };
      const turnState: TurnState = {
        workbench: { agentsCreated: 0, roomsCreated: 0 },
        treeId,
        registerChild: (child) => {
          if (!tree.children.some((item) => item.agentId === child.agentId && item.via === child.via)) {
            tree.children.push({ ...child, status: 'pending' });
            this.ledger.putTree(tree);
          }
        },
        completeChild,
        registerJob: (abort, label) => this.ledger.jobsOf(treeId).push({ abort, label }),
        persistOutgoing: async (text) => {
          signal.throwIfAborted();
          if (this.ledger.runningTurnOf(agentId) !== turnId) throw new DOMException('旧回合不再允许发送消息', 'AbortError');
          const message: Message = {
            id: randomUUID(),
            runId: turnId,
            agentId,
            role: 'assistant',
            content: { type: 'text', text },
            createdAt: Date.now(),
            source: 'agent',
            sender: { kind: 'agent', id: record.id, name: record.name, color: record.color, avatar: record.avatar },
          };
          await this.deps.messages.append(message);
          options.onEvent?.({ type: 'message', message });
        },
      };

      if (options.authorization) {
        const live = this.deps.activation?.ticketOf(options.authorization.ticketId);
        if (!live || (live.state !== 'admitted' && live.state !== 'running')) {
          throw new Error('STALE_ACTIVATION');
        }
      }

      const loop = new AgentLoop({
        provider,
        messages: this.deps.messages,
        maxIterations: this.deps.maxIterations,
        onEvent: options.onEvent,
        // 普通正文增量不直接外露：响应结束后才能判断这一轮是否调用过统一出口。
        // 完全没使用 SendToUser 时，最终正文仍会作为兼容兜底交付。
        onDelta: undefined,
        signal,
        toolsOverride: registry,
        toolContext: {
          ...(turn.toolContext ?? {}),
          authority,
          turnState: { ...turnState, acceptedDeliveryRefs: [] },
          emit: options.onEvent,
          outputs: this.deps.outputs,
          authorization: options.authorization,
          effectRunner: this.deps.effectRunner,
          replyRoute: options.authorization?.replyRoute ?? (turn.toolContext as any)?.replyRoute,
          flowContext: (turn.toolContext as any)?.flowContext,
          flowService: this.deps.flowService ?? (turn.toolContext as any)?.flowService,
        },
        progress: { store: this.deps.progress, id: turnId },
        persistAssistantText: turn.persistAssistantText,
        stamp: task.roomId
          ? { runId: turnId, roomId: task.roomId, roomName: task.roomName, speaker: record.name, source: 'room', sender: { kind: 'agent', id: record.id, name: record.name, color: record.color, avatar: record.avatar } }
          : { runId: turnId, source: task.source, sender: { kind: 'agent', id: record.id, name: record.name, color: record.color, avatar: record.avatar } },
        // E3.5：工具执行账本——先记意图，执行后回填结果，中断的留着给恢复核对
        invocations: this.deps.toolLedger,
        runId: turnId,
        treeId,
        // E3.6：执行位是否还是自己——被抢占后不再写对话线、不再发事件（迟到结果只留账本）
        isCurrent: () => this.ledger.runningTurnOf(agentId) === turnId,
      });

      let result: RunResult;
      try {
        result = await loop.run(agent, built);
      } catch (error) {
        if (runtimeTurn.status === 'parked' || this.ledger.getTurn(turnId)?.status === 'parked' || (this.ledger.runningTurnOf(agentId) !== turnId && tree.status === 'open')) {
          // 被新句插队：这不是故障，安静挂起，让位给新回合
          result = { content: '', iterations: 0, stopReason: 'parked' };
        } else if (signal.aborted) {
          result = { content: '', iterations: 0, stopReason: 'cancelled' };
        } else {
          throw error;
        }
      }

      // 被抢占的旧执行（执行位已经不在自己手里）不算完成：
      // 写入已被执行位栅栏拦住（E3.6），这里只如实收场（不进记忆抽取）
      const stillCurrent = this.ledger.runningTurnOf(agentId) === turnId;
      if (!stillCurrent && result.stopReason !== 'parked' && result.stopReason !== 'cancelled') {
        result = { content: '', iterations: result.iterations, stopReason: 'parked' };
      }

      // 挂起/中止的回合不再抽记忆——半截对话不值得记
      let memoryExchange: Message[] | undefined;
      if (result.stopReason === 'final_answer') {
        await this.deps.registry.update(agentId, {});
        memoryExchange = [task, ...(await this.deps.messages.list(agentId)).filter(message => message.id !== task.id && message.runId === turnId)];
        assertExecution(guard);
      }

      if (turn.resume && runtimeTurn.continuation?.room && !runtimeTurn.continuation.room.live && (turn.posts?.length ?? 0) > 0) {
        assertExecution(guard);
        await this.deps.publishResumedPosts(agentId, runtimeTurn.continuation, turn.posts!, { ...options, signal });
      }

      if (result.stopReason === 'final_answer') {
        assertExecution(guard);
        runtimeTurn.status = 'done';
        tree.rootFinished = true;
        this.finishTreeIfSettled(tree);
      } else if (result.stopReason === 'max_iterations' || result.stopReason === 'tool_limit') {
        runtimeTurn.status = 'incomplete';
        tree.status = 'incomplete';
        this.ledger.putTree(tree);
      } else if (result.stopReason === 'cancelled') {
        runtimeTurn.status = 'cancelled';
        tree.status = 'cancelled';
        this.ledger.putTree(tree);
      } else if (result.stopReason === 'parked') {
        runtimeTurn.status = 'parked';
      }
      this.ledger.putTurn(runtimeTurn);

      if (memoryExchange && result.stopReason === 'final_answer') {
        this.maintenance.start(agent, provider, memoryExchange, () => !signal.aborted && this.ledger.epochOf(agentId) === runtimeTurn.leaseEpoch,
          result => this.deps.onMemory(agentId, turnId, result.refs, result.merged));
      }

      return {
        ...result,
        agentId,
        agentName: record.name,
        context: built,
        posts: turn.posts ?? [],
        status: (turn.posts?.length ?? 0) > 0 ? 'spoke' : 'silent',
      };
    } catch (error) {
      // 包括模型前的压缩/装配、模型后的交付；取消不能只在 loop 内被识别。
      const parked = runtimeTurn.status === 'parked' || (!guard.isCurrent() && tree.status === 'open');
      if (parked || signal.aborted) {
        const reason = parked ? 'parked' : 'cancelled';
        runtimeTurn.status = reason;
        if (!parked) tree.status = 'cancelled';
        this.ledger.putTurn(runtimeTurn); this.ledger.putTree(tree);
        this.deps.progress.finish(turnId, reason, reason);
        return { agentId, agentName: agentId, content: '', iterations: 0, stopReason: reason,
          context: builtContext, posts: [], status: 'silent' };
      }
      if (runtimeTurn.status === 'running') {
        runtimeTurn.status = signal.aborted ? 'cancelled' : 'failed';
        tree.status = signal.aborted ? 'cancelled' : 'failed';
        this.deps.progress.finish(turnId, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
        this.ledger.putTurn(runtimeTurn);
        this.ledger.putTree(tree);
      }
      throw error;
    } finally {
      if (options.authorization?.ticketId) {
        await this.deps.activation?.settleTicket?.(options.authorization.ticketId).catch(() => undefined);
      }
      // 只有自己还占着坑才清；被插队时新回合已经接管了锁
      if (this.ledger.runningTurnOf(agentId) === turnId) {
        this.ledger.releaseRunning(agentId, turnId);
        this.locks.delete(agentId);
      }
      if (runtimeTurn.status === 'running') {
        runtimeTurn.status = 'failed';
        this.ledger.putTurn(runtimeTurn);
      }
      if (runtimeTurn.status === 'failed' && tree.status === 'open' && !tree.rootFinished) {
        tree.status = 'failed';
        this.ledger.putTree(tree);
      }
      this.ledger.setJobs(
        treeId,
        this.ledger.jobsOf(treeId).filter((job) => job.label !== 'turn'),
      );

      // 收尾顺序（优先级）：停止令 → 欠账续跑 → 同事来信
      await this.deps.stopCoordinator.processPendingStops(agentId).catch(() => undefined);
      if (!this.deps.canAutoActivate || this.deps.canAutoActivate(agentId)) {
        void this.resumeOwed(agentId).catch(() => undefined);
        const claimable = await this.deps.inbox.claimableCount(agentId).catch(() => 0);
        if (claimable > 0) {
          this.deps.drainInbox(agentId, { model: turn.model ?? options.model }).catch(() => undefined);
        }
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

  /** 欠账补跑：最早的 parked 树先接回去；只有真正的恢复失败才消耗三次预算。 */
  private async resumeOwed(agentId: string): Promise<void> {
    if (this.closed || this.ledger.runningTurnOf(agentId)) return;
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
    if (!tree) {
      await this.failExhaustedResume(agentId);
      return;
    }
    tree.resumeCount += 1;
    this.ledger.putTree(tree);
    const root = this.ledger.getTurn(tree.rootTurnId);
    if (root && ((root.source !== 'user' && !root.continuation) ||
      (root.continuation?.room && !await this.deps.canResumeRoom(agentId, root.continuation.room.roomId)))) {
      // 旧记录无法恢复来源，或已离群/解散：不能降级成私聊执行。
      root.status = 'cancelled'; tree.status = 'cancelled';
      this.ledger.putTurn(root); this.ledger.putTree(tree); return;
    }
    // 先了结再跑：续跑回合自己的 finally 会再触发 resumeOwed，不改状态会立即再续一轮
    if (root && root.status === 'parked') {
      root.status = 'resuming';
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
      const continuationAuth = root?.continuation;
      let resumeOptions: SendOptions = {};
      if (continuationAuth?.inputId && continuationAuth.chainId && this.deps.activation?.tryActivate) {
        const decision = await this.deps.activation.tryActivate({
          agentId,
          runId: randomUUID(),
          taskId: root?.id ?? tree.rootTurnId,
          inputId: continuationAuth.inputId,
          chainId: continuationAuth.chainId,
          source: 'resume',
          grantId: continuationAuth.grantId,
          flowId: continuationAuth.flowId,
          flowGrantId: continuationAuth.flowGrantId,
          replyRoute: continuationAuth.replyRoute,
        });
        if (decision.kind !== 'admitted') {
          root!.status = 'parked';
          this.ledger.putTurn(root!);
          return;
        }
        await this.deps.activation.markRunning?.(decision.ticket);
        resumeOptions = { authorization: decision.ticket };
      }
      const result = await this.runTurn(
        agentId,
        task,
        {
          resume: true,
          skipPersist: true,
          brief: composeResumeBrief(root?.text ?? ''),
          ...(root ? { resumeTaskId: root.id } : {}),
        },
        resumeOptions,
      );
      // 续跑本身又被插队 → 这笔账重新记欠
      if (result.stopReason === 'parked' && root && root.status === 'resuming') {
        // 用户插话不是恢复故障，不应把正常交互耗成“永久不再恢复”。
        tree.resumeCount = Math.max(0, tree.resumeCount - 1);
        this.ledger.putTree(tree);
        root.status = 'parked';
        this.ledger.putTurn(root);
      } else if (result.stopReason === 'final_answer') {
        if (root) { root.status = 'done'; this.ledger.putTurn(root); }
        tree.rootFinished = true;
        this.finishTreeIfSettled(tree);
      } else if (result.stopReason === 'max_iterations' || result.stopReason === 'tool_limit') {
        if (root) { root.status = 'incomplete'; this.ledger.putTurn(root); }
        tree.status = 'incomplete';
        this.ledger.putTree(tree);
      } else if (result.stopReason === 'cancelled') {
        if (root) { root.status = 'cancelled'; this.ledger.putTurn(root); }
        tree.status = 'cancelled';
        this.ledger.putTree(tree);
      }
    } catch {
      if (root && root.status === 'resuming') {
        root.status = 'parked';
        this.ledger.putTurn(root);
      }
      if (tree.resumeCount >= 3) await this.failExhaustedResume(agentId);
    }
  }

  /** 恢复连续失败到上限时明确收口，避免 open + parked 永久卡在账本里。 */
  private async failExhaustedResume(agentId: string): Promise<void> {
    const exhausted = this.ledger
      .listTrees()
      .filter(
        (item) =>
          item.agentId === agentId &&
          item.status === 'open' &&
          item.resumeCount >= 3 &&
          this.ledger.getTurn(item.rootTurnId)?.status === 'parked',
      );
    for (const item of exhausted) {
      const root = this.ledger.getTurn(item.rootTurnId);
      if (root) {
        root.status = 'cancelled';
        this.ledger.putTurn(root);
      }
      item.status = 'failed';
      this.ledger.putTree(item);
      const message: Message = {
        id: randomUUID(),
        agentId,
        role: 'assistant',
        content: {
          type: 'text',
          text: `之前被打断的任务连续恢复失败，已停止自动恢复。请重新发送任务：${root?.text ?? '未命名任务'}`,
        },
        createdAt: Date.now(),
        source: 'agent',
      };
      const { run } = this.deps.chatRuns.prepare({ channelId: agentId, agentId, kind: 'stop', source: 'resume',
        input: root?.text ?? '', parentRunId: root?.id });
      await this.deps.chatRuns.execute(run.runId, async () => {
        const notice = { ...message, runId: run.runId };
        await this.deps.messages.append(notice);
        this.deps.chatRuns.bind(run).onEvent?.({ type: 'message', message: notice });
      }, () => ({ stopReason: 'stopped' }));
    }
  }

  /** 服务启动时拉起上次强退留下的 parked 根回合。 */
  resumeRecovered(agentIds: string[]): void {
    for (const agentId of agentIds) {
      if (this.deps.canAutoActivate && !this.deps.canAutoActivate(agentId)) continue;
      void this.resumeOwed(agentId).catch(() => undefined);
    }
  }

  private finishTreeIfSettled(tree: TaskTree): void {
    const childrenDone = tree.children.every((child) => child.status === 'completed');
    if (tree.rootFinished && childrenDone) tree.status = 'completed';
    this.ledger.putTree(tree);
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
