import { randomUUID } from 'node:crypto';
import { AgentLoop } from '../../agent/agent-loop.js';
import type { Message } from '../../shared/contracts/sse.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { MessageStore } from '../../store/messages.js';
import type { Tool } from '../tool.js';

/**
 * WorkerManager（E2.3）：Task 后台工人的生命周期与模型驱动。
 *
 * 工人是一次性执行者：自足 prompt、没有用户对话上下文、收尾文本=交付结果。
 * 生命周期：spawn → drive（可被 MessageSubagent 塞话续段）→ done/cancelled；
 * 停止令经任务树 registerJob 或 StopSubagent 都能杀掉同一个 kill()。
 */

export type WorkerStatus = 'running' | 'done' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/** 模型的多步待办板：按智能体内存隔离（E2.3 从 builtin/task.ts 抽出） */
export class TodoStore {
  private readonly byAgent = new Map<string, TodoItem[]>();

  set(agentId: string, todos: TodoItem[]): void {
    this.byAgent.set(agentId, todos);
  }

  get(agentId: string): TodoItem[] {
    return this.byAgent.get(agentId) ?? [];
  }
}

export interface Worker {
  id: string;
  description: string;
  prompt: string;
  status: WorkerStatus;
  output: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export class WorkerManager {
  private readonly workers = new Map<string, Worker>();
  private readonly histories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();
  private readonly pending = new Map<string, string[]>();
  private readonly kills = new Map<string, () => void>();

  constructor(
    private readonly deps: {
      provider: LLMProvider;
      messages: MessageStore;
      /** 工人可用工具（调用方负责滤掉用户面工具，如 SendToUser） */
      workerTools: () => Tool<any>[];
      maxIterations?: number;
      maxWorkers?: number;
    },
  ) {}

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
  spawn(description: string, prompt: string): Worker {
    const maxWorkers = this.deps.maxWorkers ?? 8;
    if (this.runningCount() >= maxWorkers) {
      throw new Error(`已有 ${this.runningCount()} 个工人在跑，先收几个再派`);
    }
    const id = randomUUID();
    const worker: Worker = {
      id,
      description,
      prompt,
      status: 'running',
      output: '',
      startedAt: Date.now(),
    };
    this.workers.set(id, worker);
    this.histories.set(id, []);
    this.pending.set(id, [prompt]);
    return worker;
  }

  stop(id: string): Worker | undefined {
    const worker = this.workers.get(id);
    if (!worker) return undefined;
    worker.status = 'cancelled';
    worker.endedAt = Date.now();
    this.kills.get(id)?.();
    return worker;
  }

  /** 给工人塞一段话；返回它当前是否在跑（没跑就由调用方决定何时 drive） */
  pushMessage(id: string, message: string): { queued: boolean; running: boolean } {
    const worker = this.workers.get(id);
    if (!worker) throw new Error('找不到这个 worker');
    const queue = this.pending.get(id) ?? [];
    queue.push(message);
    this.pending.set(id, queue);
    const running = worker.status === 'running';
    return { queued: true, running };
  }

  isRunning(id: string): boolean {
    return this.workers.get(id)?.status === 'running';
  }

  /** 停止并杀掉工人（停止令/StopSubagent 共用同一入口） */
  kill(id: string): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.status = 'cancelled';
    worker.endedAt = Date.now();
    this.kills.get(id)?.();
  }

  /** 驱动工人：消费 pending 里的每一段话，逐段跑模型-工具循环直到没有积压 */
  async drive(worker: Worker): Promise<void> {
    const controller = new AbortController();
    this.kills.set(worker.id, () => controller.abort());
    worker.status = 'running';
    try {
      let queue = this.pending.get(worker.id) ?? [];
      while (queue.length > 0 && worker.status === 'running') {
        const message = queue.shift()!;
        this.pending.set(worker.id, queue);

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

        const loop = new AgentLoop({
          provider: this.deps.provider,
          messages: this.deps.messages,
          maxIterations: this.deps.maxIterations,
          signal: controller.signal,
          stamp: { source: 'agent' },
        });
        const workerAgent = {
          id: worker.id,
          name: `工人：${worker.description}`,
          instructions: worker.prompt,
          tools: this.deps.workerTools(),
          memory: { projectIds: [] as string[] },
        };
        const built = {
          agentId: worker.id,
          system: worker.prompt,
          messages: [{ role: 'system' as const, content: worker.prompt }, ...history],
          stats: { sections: [], totalTokens: 0, budgetTokens: 0, generatedAt: Date.now() },
          surfaced: [],
          droppedRecent: 0,
          droppedGroups: 0,
        };
        const result = await loop.run(workerAgent as never, built as never);
        worker.output = result.content;
        history.push({ role: 'assistant', content: result.content || '' });
        if (result.stopReason === 'parked' || result.stopReason === 'cancelled') {
          worker.status = 'cancelled';
          return;
        }
        queue = this.pending.get(worker.id) ?? [];
      }
      if (worker.status === 'running') worker.status = 'done';
    } catch (error) {
      if (controller.signal.aborted) {
        worker.status = 'cancelled';
        return;
      }
      worker.status = 'done';
      worker.error = error instanceof Error ? error.message : String(error);
    } finally {
      worker.endedAt = Date.now();
    }
  }
}
