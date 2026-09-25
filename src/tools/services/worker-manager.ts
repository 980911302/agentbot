import { randomUUID } from 'node:crypto';
import { AgentLoop } from '../../agent/agent-loop.js';
import type { Message } from '../../shared/contracts/sse.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { MessageStore } from '../../store/messages.js';
import type { Tool, ExecutionAuthority } from '../tool.js';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TaskProgressStore } from '../../storage/task-progress.js';
import { ToolOutputStore } from './tool-output-store.js';
import type { BackgroundProcesses } from './background-processes.js';
import type { StopReason } from '../../shared/contracts/sse.js';

/**
 * WorkerManager（E2.3）：Task 后台工人的生命周期与模型驱动。
 *
 * 工人是一次性执行者：自足 prompt、没有用户对话上下文、收尾文本=交付结果。
 * 生命周期：spawn → drive（可被 MessageSubagent 塞话续段）→ done/cancelled；
 * 停止令经任务树 registerJob 或 StopSubagent 都能杀掉同一个 kill()。
 */

export type WorkerStatus = 'running' | 'done' | 'cancelled' | 'incomplete' | 'failed' | 'timed_out' | 'interrupted';

/** 终态：收尾投递与「重启后不再是 running」都以它为准 */
const TERMINAL_STATUSES: readonly WorkerStatus[] = ['done', 'cancelled', 'incomplete', 'failed', 'timed_out', 'interrupted'];

/** 谁让工人停的：停止令、派工者回合被中止，或运行超时（E4.5 取消关系要能持久回答） */
export type WorkerCancelSource = 'stop_command' | 'parent_turn_aborted' | 'timeout';

/** 纠偏/补充消息的持久记录：重启后仍能看出派工者改过什么口、哪几条还没被消费 */
export interface WorkerCorrection {
  text: string;
  at: number;
  consumed: boolean;
}

export interface WorkerCancel {
  by: WorkerCancelSource;
  at: number;
  reason?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/**
 * 工人收尾来信（E4.5）：派工者读它 = 一次新回合，而不是靠 CheckSubagent 轮询。
 * 文本只陈述可审计的事实（状态、输出、下一步），不含隐藏推理。
 */
export function workerResultLetter(worker: Worker): string {
  const detail = worker.error
    ? `原因：${worker.error}`
    : worker.output
      ? `输出：\n${worker.output.slice(-3000)}`
      : '（没有收尾输出）';
  const next =
    worker.status === 'done'
      ? '已完成，但这是工人自述；需要独立验收时请核对产物再算数。'
      : worker.status === 'incomplete'
        ? '还没做完（到了轮数/工具上限）。要接着干就用 MessageSubagent 给它续一段。'
        : `未完成（${worker.status}）；先核对现场，再决定续跑还是换做法。`;
  return [
    '## [worker] 工人收尾',
    `worker_id: ${worker.id}`,
    `任务：${worker.description}`,
    `状态：${worker.status}${worker.stopReason ? `（停止原因：${worker.stopReason}）` : ''}`,
    ...(worker.workId ? [`关联工作：${worker.workId}`] : []),
    detail,
    next,
    '这只是结果投递：完整记录用 CheckSubagent 看。',
  ].join('\n');
}

/** 模型的多步待办板：按智能体内存隔离（E2.3 从 builtin/task.ts 抽出） */
export class TodoStore {
  private readonly byAgent = new Map<string, TodoItem[]>();

  constructor(private readonly dataDir?: string) {
    if (!dataDir) return;
    const file = this.file();
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, TodoItem[]>;
    for (const [agentId, todos] of Object.entries(parsed)) {
      if (Array.isArray(todos)) this.byAgent.set(agentId, todos);
    }
  }

  set(agentId: string, todos: TodoItem[]): void {
    this.byAgent.set(agentId, todos);
    this.persist();
  }

  get(agentId: string): TodoItem[] {
    return this.byAgent.get(agentId) ?? [];
  }

  private file(): string {
    return join(this.dataDir!, 'tasks', 'todos.json');
  }

  private persist(): void {
    if (!this.dataDir) return;
    atomicWrite(this.file(), Object.fromEntries(this.byAgent));
  }
}

export interface Worker {
  id: string;
  authority?: ExecutionAuthority;
  ownerId?: string;
  description: string;
  prompt: string;
  status: WorkerStatus;
  output: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  stopReason?: StopReason | 'failed' | 'timed_out' | 'interrupted';
  taskId?: string;
  /** 这次工人执行是为哪件工作干的（E4.1 WorkItem）；派工时从派工者手头工作取 */
  workId?: string;
  /** 派工者那一轮的协作链 id：结果来信记在同一链上，不另开一条绕过链预算 */
  chainId?: string;
  /** 派工时派工者的传话链深度，结果来信按同一深度送回 */
  chainDepth?: number;
  /** 收尾输出摘要（截断；全文在 output） */
  summary?: string;
  /** 纠偏与补充消息（E4.5）：重启后仍在，能看到哪几条已经被消费 */
  corrections?: WorkerCorrection[];
  /** 取消关系：谁因为什么让工人停的（E4.5） */
  cancel?: WorkerCancel;
  /** 结果来信已经过可靠投递链送出（落盘去重：重启补送不会重复） */
  resultDeliveredAt?: number;
}

/**
 * 工人不该持有的工具：派工 / 协作 / 出口 / 组织管理。
 * 工人是一次性执行者——不许递归派工，也不许代同事说话或改组织结构。
 */
const WORKER_EXCLUDED_TOOLS = new Set([
  'Task',
  'MessageSubagent',
  'CheckSubagent',
  'StopSubagent',
  'SendToAgent',
  'SendToUser',
  'CreateAgent',
  'CreateChannel',
]);

/**
 * 工人工具 = 运行时可用 ∩ 派工时授予（granted）∩ 派工者当前授权（current），再减去工人禁区。
 *
 * 「不超过派工者」靠这道交集保证：派工者后来被收回的工具（改 toolNames / 改默认集），
 * 工人续跑时同样拿不到——授权只减不增。缺任一侧授权时按「没有权限」处理（fail closed）。
 */
export function selectWorkerTools(
  available: readonly Tool<any>[],
  granted: ExecutionAuthority | undefined,
  current: ExecutionAuthority | undefined,
): Tool<any>[] {
  return available.filter(
    (tool) =>
      !WORKER_EXCLUDED_TOOLS.has(tool.name) &&
      (granted?.toolNames.includes(tool.name) ?? false) &&
      (current?.toolNames.includes(tool.name) ?? false),
  );
}

export class WorkerManager {
  private readonly workers = new Map<string, Worker>();
  private readonly histories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
  private readonly pending = new Map<string, string[]>();
  private readonly kills = new Map<string, () => void>();
  private readonly active = new Set<string>();
  private readonly progress?: TaskProgressStore;
  private readonly outputs?: ToolOutputStore;

  constructor(
    private readonly deps: {
      provider: LLMProvider;
      messages: MessageStore;
      /** 工人可用工具（调用方负责滤掉用户面工具，如 SendToUser） */
      workerTools: (ownerId?: string) => Tool<any>[] | Promise<Tool<any>[]>;
      providerFor?: (model: string) => LLMProvider;
      ownerAuthority?: (ownerId: string) => Promise<ExecutionAuthority | undefined>;
      maxIterations?: number;
      maxWorkers?: number;
      /** 同一智能体同时能跑几个（E4.5）：只有全局上限时，一个同事能占满所有工人额度 */
      maxWorkersPerAgent?: number;
      /** 工人记录累计上限（全局 / 按智能体） */
      maxWorkerRecords?: number;
      maxWorkerRecordsPerAgent?: number;
      /** 派工者手头那件工作（E4.1）：工人状态记下「为哪件工作执行」 */
      workOf?: (ownerId: string) => Promise<string | undefined>;
      /**
       * 收尾回调（E4.5）：由运行时装配成「结果来信」走可靠投递链。
       * 抛错就不记为已投递，重启后会补送（投递层按指纹幂等）。
       */
      onSettled?: (worker: Worker) => Promise<void>;
      /** 工具执行账本（E3.5）：工人的工具调用同样先记意图再执行 */
      invocations?: import('../../storage/ports.js').ToolInvocationPort;
      /** 传入时持久工人的身份、历史、待办与结果。 */
      dataDir?: string;
      progress?: TaskProgressStore;
      outputs?: ToolOutputStore;
      maxRuntimeMs?: number;
      /** E8.4：后台进程登记簿（停机时统一终止并写检查点） */
      background?: BackgroundProcesses;
    },
  ) {
    this.progress = deps.progress ?? (deps.dataDir ? new TaskProgressStore(deps.dataDir) : undefined);
    this.outputs = deps.outputs ?? (deps.dataDir ? new ToolOutputStore(deps.dataDir) : undefined);
    this.load();
  }

  get maxWorkers(): number {
    return this.deps.maxWorkers ?? 8;
  }

  get maxWorkersPerAgent(): number {
    return this.deps.maxWorkersPerAgent ?? 3;
  }

  /** 在跑的工人数：给 ownerId 就只数它派的 */
  runningCount(ownerId?: string): number {
    const running = [...this.workers.values()].filter((worker) => worker.status === 'running');
    return ownerId ? running.filter((worker) => worker.ownerId === ownerId).length : running.length;
  }

  /** 还能不能再起一个（全局与按智能体两个维度；MessageSubagent 续跑也用它） */
  canStart(ownerId?: string): boolean {
    if (this.runningCount() >= this.maxWorkers) return false;
    return !(ownerId && this.runningCount(ownerId) >= this.maxWorkersPerAgent);
  }

  get(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  list(): Worker[] {
    return [...this.workers.values()].sort((left, right) => right.startedAt - left.startedAt);
  }

  /** 派工者手头那件工作（E4.1）；没有就不关联 */
  async workOf(ownerId: string): Promise<string | undefined> {
    return this.deps.workOf ? await this.deps.workOf(ownerId).catch(() => undefined) : undefined;
  }

  /** 登记并开跑；返回前就把工人放进表里（后台模式立刻可 Check） */
  spawn(
    description: string,
    prompt: string,
    ownerId?: string,
    authority?: ExecutionAuthority,
    context: { chainId?: string; chainDepth?: number; workId?: string } = {},
  ): Worker {
    // 并发两个维度：全局上限 + 同一个派工者的在跑数（E4.5）
    if (this.runningCount() >= this.maxWorkers) {
      throw new Error(`已有 ${this.runningCount()} 个工人在跑，先收几个再派`);
    }
    if (ownerId && this.runningCount(ownerId) >= this.maxWorkersPerAgent) {
      throw new Error(
        `你手头已有 ${this.runningCount(ownerId)} 个工人在跑（每个智能体最多 ${this.maxWorkersPerAgent} 个），先等几个收尾再派`,
      );
    }
    // 记录数也分两个维度：总量上限防无限堆积，单智能体上限防一个人占满
    const maxRecords = this.deps.maxWorkerRecords ?? 200;
    const maxRecordsPerAgent = this.deps.maxWorkerRecordsPerAgent ?? 50;
    if (this.workers.size >= maxRecords) {
      throw new Error(`工人记录已达 ${maxRecords} 个，请复用已有工人，不再新建`);
    }
    if (ownerId && this.list().filter((worker) => worker.ownerId === ownerId).length >= maxRecordsPerAgent) {
      throw new Error(`你的工人记录已达 ${maxRecordsPerAgent} 个，请复用已有工人，不再新建`);
    }
    if (description.length > 200 || prompt.length > 12000) throw new Error('工人标题最多 200 字符，任务最多 12000 字符');
    const id = randomUUID();
    const worker: Worker = {
      id,
      ownerId,
      authority: authority ? structuredClone(authority) : { toolNames: [], projectIds: [] },
      description,
      prompt,
      status: 'running',
      output: '',
      startedAt: Date.now(),
      ...(context.chainId ? { chainId: context.chainId } : {}),
      ...(context.chainDepth !== undefined ? { chainDepth: context.chainDepth } : {}),
      ...(context.workId ? { workId: context.workId } : {}),
      corrections: [],
    };
    this.workers.set(id, worker);
    this.histories.set(id, []);
    this.pending.set(id, [prompt]);
    this.persist();
    return worker;
  }

  /** 停止（派工者显式下令 / 父回合被中止共用入口；取消关系落盘） */
  stop(id: string, source: WorkerCancelSource = 'stop_command', reason?: string): Worker | undefined {
    return this.cancel(id, source, reason);
  }

  /** 停止并杀掉工人（停止令/StopSubagent/回合中止共用同一入口） */
  kill(id: string, source: WorkerCancelSource = 'stop_command', reason?: string): void {
    this.cancel(id, source, reason);
  }

  private cancel(id: string, source: WorkerCancelSource, reason?: string): Worker | undefined {
    const worker = this.workers.get(id);
    if (!worker) return undefined;
    if (!this.active.has(id) && worker.status !== 'running') return worker;
    worker.status = 'cancelled';
    worker.stopReason = 'cancelled';
    worker.endedAt = Date.now();
    worker.cancel = { by: source, at: Date.now(), ...(reason ? { reason } : {}) };
    this.kills.get(id)?.();
    this.persist();
    return worker;
  }

  /** 给工人塞一段话；返回它当前是否在跑（没跑就由调用方决定何时 drive） */
  pushMessage(id: string, message: string): { queued: boolean; running: boolean } {
    const worker = this.workers.get(id);
    if (!worker) throw new Error('找不到这个 worker');
    const queue = this.pending.get(id) ?? [];
    if (!message.trim() || message.length > 12000) throw new Error('纠偏消息不能为空或超过 12000 字符');
    if (queue.length >= 8 || queue.join('').length + message.length > 32000) throw new Error('工人待处理消息已达上限（8 条/32000 字符），请等待处理');
    if (worker.status === 'cancelled' && this.active.has(id)) throw new Error('工人正在停止，请等退出后再续跑');
    queue.push(message);
    this.pending.set(id, queue);
    // 纠偏也持久化（E4.5）：重启后仍能看出派工者改过什么口、哪几条还没被消费
    worker.corrections = [...(worker.corrections ?? []), { text: message, at: Date.now(), consumed: false }];
    this.persist();
    const running = worker.status === 'running';
    return { queued: true, running };
  }

  isRunning(id: string): boolean {
    return this.active.has(id) || this.workers.get(id)?.status === 'running';
  }

  /** 驱动工人：消费 pending 里的每一段话，逐段跑模型-工具循环直到没有积压 */
  async drive(worker: Worker): Promise<void> {
    if (this.active.has(worker.id)) return;
    if (worker.status !== 'running' && !this.canStart(worker.ownerId)) throw new Error('运行工人已达并发上限');
    this.active.add(worker.id);
    const controller = new AbortController();
    const jobs = new Set<() => void>();
    const stop = () => { controller.abort(); for (const kill of jobs) kill(); };
    this.kills.set(worker.id, stop);
    // E8.4：登记进停机清单；本次 drive 收尾时注销
    const untrack = this.deps.background?.track({
      kind: 'worker',
      id: worker.id,
      label: worker.description,
      kill: () => stop(),
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.min(this.deps.maxRuntimeMs ?? 10 * 60 * 1000, 10 * 60 * 1000));
    timer.unref();
    worker.status = 'running';
    delete worker.error;
    delete worker.stopReason;
    delete worker.endedAt;
    try {
      this.persist();
      let queue = this.pending.get(worker.id) ?? [];
      while (queue.length > 0 && worker.status === 'running') {
        const message = queue.shift()!;
        this.pending.set(worker.id, queue);
        this.persist();

        const persisted: Message = {
          id: randomUUID(),
          agentId: worker.id,
          role: 'user',
          content: { type: 'text', text: message },
          createdAt: Date.now(),
          source: 'agent',
        };
        await this.deps.messages.append(persisted);
        const history = this.histories.get(worker.id)!;
        history.push({ role: 'user', content: message });
        // 这条纠偏/补充消息已经被消费：落盘留在工人记录里，重启后能看出还剩哪几条没被看到
        for (const correction of worker.corrections ?? []) if (!correction.consumed && correction.text === message) correction.consumed = true;
        this.persist();

        const previousTaskId = worker.taskId && this.progress?.get(worker.taskId, worker.id) ? worker.taskId : undefined;
        const runId = randomUUID();
        this.progress?.begin(runId, worker.id, worker.prompt, 'worker', previousTaskId);
        worker.taskId = runId;
        this.persist();
        const loop = new AgentLoop({
          provider: worker.authority?.model && this.deps.providerFor ? this.deps.providerFor(worker.authority.model) : this.deps.provider,
          messages: this.deps.messages,
          maxIterations: this.deps.maxIterations,
          signal: controller.signal,
          toolContext: { outputs: this.outputs, turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 }, registerJob: abort => { jobs.add(abort); if (controller.signal.aborted) abort(); } } },
          ...(this.progress ? { progress: { store: this.progress, id: runId } } : {}),
          stamp: { source: 'agent' },
          // E3.5：工人的工具调用也记账（runId 用工人 id）
          invocations: this.deps.invocations,
          runId,
        });
        const currentAuthority = this.deps.ownerAuthority && worker.ownerId
          ? await this.deps.ownerAuthority(worker.ownerId) : worker.authority;
        const projectIds = (worker.authority?.projectIds ?? []).filter(id => currentAuthority?.projectIds.includes(id));
        const workerAgent = {
          id: worker.id,
          name: `工人：${worker.description}`,
          instructions: worker.prompt,
          tools: selectWorkerTools(await this.deps.workerTools(worker.ownerId), worker.authority, currentAuthority),
          memory: { projectIds },
        };
        const built = {
          agentId: worker.id,
          system: worker.prompt,
          messages: [{ role: 'system' as const, content: worker.prompt }, ...history.slice(0, -1),
            ...(previousTaskId && this.progress ? [{ role: 'user' as const, content: this.progress.brief(runId, worker.id) }] : []), ...history.slice(-1)],
          stats: { sections: [], totalTokens: 0, budgetTokens: 0, generatedAt: Date.now() },
          surfaced: [],
          droppedRecent: 0,
          droppedGroups: 0,
        };
        const result = await loop.run(workerAgent as never, built as never);
        worker.output = result.content;
        worker.stopReason = result.stopReason;
        history.push({ role: 'assistant', content: result.content || '' });
        while (history.length > 2 && history.reduce((size, item) => size + item.content.length, 0) > 48000) history.splice(0, 2);
        this.persist();
        if (result.stopReason === 'max_iterations' || result.stopReason === 'tool_limit') {
          worker.status = 'incomplete';
          return; // 保存排队纠偏，但不以队列为由自动绕过本次额度。
        }
        if (result.stopReason === 'parked' || result.stopReason === 'cancelled' || result.stopReason === 'stopped') {
          worker.status = 'cancelled';
          return;
        }
        queue = this.pending.get(worker.id) ?? [];
      }
      if (worker.status === 'running') worker.status = 'done';
    } catch (error) {
      if (controller.signal.aborted) {
        worker.status = timedOut ? 'timed_out' : 'cancelled';
        worker.stopReason = timedOut ? 'timed_out' : 'cancelled';
        // 取消关系（E4.5）：停止令已经记过就保留，否则记下是父回合中止还是超时
        worker.cancel ??= { by: timedOut ? 'timeout' : 'parent_turn_aborted', at: Date.now() };
        if (worker.taskId && this.progress) this.progress.finish(worker.taskId, timedOut ? 'incomplete' : 'cancelled', timedOut ? 'interrupted' : 'cancelled', timedOut ? '工人运行超时，尚未完成；先核对未回填调用和产物。' : undefined);
        return;
      }
      worker.status = 'failed';
      worker.stopReason = 'failed';
      worker.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      for (const kill of jobs) kill();
      untrack?.();
      this.active.delete(worker.id);
      this.kills.delete(worker.id);
      worker.endedAt = Date.now();
      if (worker.status !== 'running') worker.summary = workerOutputSummary(worker);
      this.persist();
      // 收尾结果送回去（E4.5）：只有真的收尾了才送，重试时投递层按指纹幂等
      if (worker.status !== 'running') {
        await this.settle(worker).catch((error) => {
          console.warn(`工人收尾投递未送出（重启补送）：${messageOf(error)}`);
        });
      }
    }
  }

  /**
   * 收尾送达（E4.5）：交给运行时装配的 onSettled，走既有 inbox/Delivery 可靠投递链。
   * 送回失败不吞掉事实：worker 保持未标记已投递，下次启动扫描补送。
   */
  private async settle(worker: Worker): Promise<void> {
    if (worker.resultDeliveredAt || !worker.ownerId || !this.deps.onSettled) return;
    await this.deps.onSettled(worker);
    worker.resultDeliveredAt = Date.now();
    this.persist();
  }

  /** 上次进程留下的收尾结果还没送回去的工人（启动扫描补送，E4.5） */
  pendingResults(): Worker[] {
    return this.list().filter((worker) => worker.ownerId && !worker.resultDeliveredAt && TERMINAL_STATUSES.includes(worker.status));
  }

  /** 启动扫描补送结果来信；返回补送条数 */
  async deliverPendingResults(): Promise<number> {
    let delivered = 0;
    for (const worker of this.pendingResults()) {
      try {
        await this.settle(worker);
        delivered += 1;
      } catch (error) {
        console.warn(`工人结果补送失败（${worker.id}）：${messageOf(error)}`);
      }
    }
    return delivered;
  }

  /**
   * 重启恢复提示（E4.5）：中断的工人不是「还在跑」，也不是「做完了」，
   * 必须让模型看到「上次进程在这里断了、结果可能只做了一半」。
   */
  recoveryNote(): string {
    const interrupted = this.list().filter((worker) => worker.status === 'interrupted');
    if (interrupted.length === 0) return '';
    return [
      `## [recovery] 上次进程中断时还有 ${interrupted.length} 个工人在跑`,
      ...interrupted.slice(0, 5).map((worker) => `- ${worker.id}（${worker.description}）：上次进程退出时仍在运行；可能有半截产物，先核对再用 MessageSubagent 续跑`),
      '这些工人不会被自动重放：核对现场后再决定继续还是重做。',
    ].join('\n');
  }

  /** 按描述认回「刚中断的那个工人」（重启后 Task 重派时避免留下僵尸记录） */
  interruptedMatching(description: string, ownerId?: string): Worker | undefined {
    return this.list().find(
      (worker) => worker.status === 'interrupted' && worker.description === description && worker.ownerId === ownerId,
    );
  }

  private file(): string | undefined {
    return this.deps.dataDir ? join(this.deps.dataDir, 'tasks', 'workers.json') : undefined;
  }

  private load(): void {
    const file = this.file();
    if (!file || !existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      workers?: Worker[];
      histories?: Record<string, Array<{ role: 'user' | 'assistant'; content: string }>>;
      pending?: Record<string, string[]>;
    };
    for (const worker of parsed.workers ?? []) {
      // 不盲目重放可能含副作用的半截工作；保留现场，后续 MessageSubagent 可显式续跑。
      if (worker.status === 'running') {
        worker.status = 'interrupted';
        worker.stopReason = 'interrupted';
        worker.endedAt = Date.now();
        worker.error = '上次进程在工人运行时中断，已保留历史；请核对后续跑';
        worker.summary = workerOutputSummary(worker);
      }
      if (worker.status === 'done' && worker.error) { worker.status = 'failed'; worker.stopReason = 'failed'; }
      worker.corrections ??= [];
      this.workers.set(worker.id, worker);
      if (!this.histories.has(worker.id)) this.histories.set(worker.id, []);
      if (!this.pending.has(worker.id)) this.pending.set(worker.id, []);
    }
    for (const [id, history] of Object.entries(parsed.histories ?? {})) this.histories.set(id, history);
    for (const [id, queue] of Object.entries(parsed.pending ?? {})) this.pending.set(id, queue);
    this.persist();
  }

  private persist(): void {
    const file = this.file();
    if (!file) return;
    atomicWrite(file, {
      workers: [...this.workers.values()],
      histories: Object.fromEntries(this.histories),
      pending: Object.fromEntries(this.pending),
    });
  }
}

function atomicWrite(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 收尾输出摘要（可审计的事实；全文仍在 output 里） */
function workerOutputSummary(worker: Worker): string {
  const text = worker.error ?? worker.output ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat;
}

/**
 * 从工具面里取回工人账本（E4.5）：Task 工具带着它的 WorkerManager，启动扫描要用。
 *
 * 放在这里而不是组合根：门面与装配层都要用它，谁都不必反向 import 对方。
 */
export function workerManagerOf(tools: readonly Tool<any>[]): WorkerManager {
  const task = tools.find((tool) => tool.name === 'Task') as
    | (Tool<unknown> & { workerManager?: WorkerManager })
    | undefined;
  if (!task?.workerManager) throw new Error('工具面里没有装配 Task 工人族，工人恢复无法进行');
  return task.workerManager;
}
