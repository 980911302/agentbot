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

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
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

  runningCount(): number {
    return [...this.workers.values()].filter((worker) => worker.status === 'running').length;
  }

  get(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  list(): Worker[] {
    return [...this.workers.values()].sort((left, right) => right.startedAt - left.startedAt);
  }

  /** 登记并开跑；返回前就把工人放进表里（后台模式立刻可 Check） */
  spawn(description: string, prompt: string, ownerId?: string, authority?: ExecutionAuthority): Worker {
    const maxWorkers = this.deps.maxWorkers ?? 8;
    if (this.runningCount() >= maxWorkers) {
      throw new Error(`已有 ${this.runningCount()} 个工人在跑，先收几个再派`);
    }
    if (this.workers.size >= 200) throw new Error('工人记录已达 200 个，请复用已有工人，不再新建');
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
    };
    this.workers.set(id, worker);
    this.histories.set(id, []);
    this.pending.set(id, [prompt]);
    this.persist();
    return worker;
  }

  stop(id: string): Worker | undefined {
    const worker = this.workers.get(id);
    if (!worker) return undefined;
    if (!this.active.has(id) && worker.status !== 'running') return worker;
    worker.status = 'cancelled';
    worker.stopReason = 'cancelled';
    worker.endedAt = Date.now();
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
    this.persist();
    const running = worker.status === 'running';
    return { queued: true, running };
  }

  isRunning(id: string): boolean {
    return this.active.has(id) || this.workers.get(id)?.status === 'running';
  }

  /** 停止并杀掉工人（停止令/StopSubagent 共用同一入口） */
  kill(id: string): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    if (!this.active.has(id) && worker.status !== 'running') return;
    worker.status = 'cancelled';
    worker.stopReason = 'cancelled';
    worker.endedAt = Date.now();
    this.kills.get(id)?.();
    this.persist();
  }

  /** 驱动工人：消费 pending 里的每一段话，逐段跑模型-工具循环直到没有积压 */
  async drive(worker: Worker): Promise<void> {
    if (this.active.has(worker.id)) return;
    if (worker.status !== 'running' && this.runningCount() >= this.maxWorkers) throw new Error('运行工人已达并发上限');
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
          tools: (await this.deps.workerTools(worker.ownerId)).filter(tool => worker.authority?.toolNames.includes(tool.name) && currentAuthority?.toolNames.includes(tool.name) && !['Task', 'MessageSubagent', 'CheckSubagent', 'StopSubagent', 'SendToAgent', 'SendToUser', 'CreateAgent', 'CreateChannel'].includes(tool.name)),
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
      this.persist();
    }
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
      }
      if (worker.status === 'done' && worker.error) { worker.status = 'failed'; worker.stopReason = 'failed'; }
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
