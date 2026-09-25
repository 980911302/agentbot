import { defineTool } from '../tool.js';
import { TodoStore, WorkerManager } from '../services/worker-manager.js';
import type { TodoItem } from '../services/worker-manager.js';
import type { ToolResult } from '../result.js';

/**
 * Task 工人族 —— 对齐《内置工具清单.md》H 组（executor 一种）。
 *
 * Task 派一个后台工人做多步活；CheckSubagent 只读进度；MessageSubagent 塞话纠偏；
 * StopSubagent 杀工人。生命周期与模型驱动在 WorkerManager（services 层）；
 * 工具只做参数校验、记账（任务树）与展示。
 * TodoWrite 是模型自己的多步待办板（持久化、按智能体隔离）。
 */

export function createTaskTools(input: {
  provider: import('../../llm/provider.js').LLMProvider;
  messages: import('../../store/messages.js').MessageStore;
  /** 工人可用工具（调用方负责滤掉用户面工具，如 SendToUser） */
  workerTools: (
    ownerId?: string,
  ) => import('../../tools/tool.js').Tool<any>[] | Promise<import('../../tools/tool.js').Tool<any>[]>;
  providerFor?: (model: string) => import('../../llm/provider.js').LLMProvider;
  ownerAuthority?: (ownerId: string) => Promise<import('../tool.js').ExecutionAuthority | undefined>;
  maxIterations?: number;
  maxWorkers?: number;
  /** 工具执行账本（E3.5）：工人的工具调用同样要留核对依据 */
  invocations?: import('../../storage/ports.js').ToolInvocationPort;
  dataDir?: string;
  progress?: import('../../storage/task-progress.js').TaskProgressStore;
  outputs?: import('../services/tool-output-store.js').ToolOutputStore;
  /** TodoWrite 落步后回写「手头工作」的步骤（E4.1）；不传则不记录 */
  onTodoWrite?: (agentId: string, todos: TodoItem[]) => Promise<void>;
}) {
  const manager = new WorkerManager({
    provider: input.provider,
    providerFor: input.providerFor,
    ownerAuthority: input.ownerAuthority,
    messages: input.messages,
    workerTools: input.workerTools,
    maxIterations: input.maxIterations,
    maxWorkers: input.maxWorkers,
    invocations: input.invocations,
    dataDir: input.dataDir,
    progress: input.progress,
    outputs: input.outputs,
  });
  const todos = new TodoStore(input.dataDir);

  const format = (worker: import('../services/worker-manager.js').Worker): string => {
    const elapsed = Math.round(((worker.endedAt ?? Date.now()) - worker.startedAt) / 1000);
    const head = `worker_id: ${worker.id}\n任务：${worker.description}\n状态：${worker.status}（${elapsed}s）${worker.stopReason ? '\n停止原因：' + worker.stopReason : ''}${worker.taskId ? '\ntask_id: ' + worker.taskId : ''}${worker.status === 'done' ? '\n工人已答复，不代表独立验收通过。' : worker.status === 'running' ? '' : '\n尚未完成；先核对现场，再用 MessageSubagent 明确续跑。'}`;
    const tail = worker.error
      ? `\n错误：${worker.error}`
      : worker.output
        ? `\n输出：\n${worker.output.slice(-3000)}`
        : '\n（还没有收尾输出）';
    return `${head}${tail}`;
  };

  const outcome = (
    worker: import('../services/worker-manager.js').Worker,
    inspecting = false,
  ): ToolResult => ({
    status: inspecting || worker.status === 'done' ? 'ok' : worker.status === 'running' ? 'running' : 'error',
    content: format(worker),
    task: {
      workerId: worker.id,
      taskId: worker.taskId,
      state: worker.status === 'done' ? 'answered' : worker.status,
      stopReason: worker.stopReason,
    },
    ...(!inspecting && !['running', 'done'].includes(worker.status)
      ? {
          error: {
            code: `WORKER_${worker.status.toUpperCase()}`,
            message: worker.error ?? `工人未完成：${worker.status}`,
          },
        }
      : {}),
  });

  const task = defineTool<{
    description: string;
    prompt: string;
    subagent_type: string;
    run_in_background?: boolean;
  }>({
    name: 'Task',
    description: [
      '派一个后台工人做多步活。工人没有和用户的对话上下文，prompt 必须自洽（背景、目标、验收标准都写全）。',
      '简单事不要派；前台最多等 30 秒，之后转后台。工人单次最长 10 分钟，不允许递归派工；派出去之后用 CheckSubagent 看进度。',
      'subagent_type 只支持 executor。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '短标题，5~10 个字' },
        prompt: { type: 'string', description: '给工人的完整任务说明（自洽）' },
        subagent_type: { type: 'string', description: '只支持 executor' },
        run_in_background: {
          type: 'boolean',
          description: 'true = 立刻返回 worker_id；默认 false = 等它做完',
        },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
    async execute(args, context) {
      if (args.subagent_type !== 'executor') {
        throw new Error(`subagent_type 只支持 executor，收到：${args.subagent_type}`);
      }
      const description = args.description?.trim();
      const prompt = args.prompt?.trim();
      if (!description || !prompt) throw new Error('description 和 prompt 都不能为空');

      const worker = manager.spawn(description, prompt, context.agentId, context.authority);
      // 记账：停止令要能杀掉这个工人（见 docs/架构设计.md「插话、停止和等待」）
      context.turnState?.registerJob?.(() => manager.kill(worker.id), `worker:${worker.id.slice(0, 8)}`);
      const stop = () => manager.kill(worker.id);
      context.signal?.addEventListener('abort', stop, { once: true });
      const driving = manager.drive(worker).finally(() => context.signal?.removeEventListener('abort', stop));

      if (args.run_in_background) {
        void driving.catch(() => undefined);
        return {
          ...outcome(worker),
          content: `工人已开工。\nworker_id: ${worker.id}\n用 CheckSubagent 看进度，MessageSubagent 塞话纠偏，StopSubagent 杀掉。`,
        };
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          driving,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 30000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      context.signal?.throwIfAborted();
      return outcome(worker);
    },
  });

  const check = defineTool<{ subagent_id?: string; offset?: number; limit?: number }>({
    name: 'CheckSubagent',
    description: '只读看自己派出的工人的进度和末尾 3000 字符；不传 id 就分页列出，默认 20 条。',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      if (!args.subagent_id) {
        const all = manager.list().filter((worker) => worker.ownerId === context.agentId);
        if (all.length === 0) return '还没有派过工人。';
        const offset = args.offset ?? 0,
          limit = args.limit ?? 20;
        return (
          all
            .slice(offset, offset + limit)
            .map((worker) => `${worker.id} [${worker.status}] ${worker.description}`)
            .join('\n') + (offset + limit < all.length ? `\nnext_offset=${offset + limit}` : '')
        );
      }
      const worker = manager.get(args.subagent_id);
      if (!worker) throw new Error('找不到这个 worker_id（用 CheckSubagent 不带参数列出全部）');
      if (worker.ownerId !== context.agentId) throw new Error('不能访问其他智能体的工人');
      return outcome(worker, true);
    },
  });

  const message = defineTool<{ subagent_id: string; message: string }>({
    name: 'MessageSubagent',
    description: '往运行中的工人塞一句纠偏（不中止）；工人收尾后会把这段话并进它的下一段工作。',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: { type: 'string', description: '工人 id' },
        message: { type: 'string', description: '要塞给它的那句话' },
      },
      required: ['subagent_id', 'message'],
    },
    async execute(args, context) {
      if (manager.get(args.subagent_id)?.ownerId !== context.agentId)
        throw new Error('找不到自己派出的 worker_id');
      const wasRunning = manager.isRunning(args.subagent_id);
      if (!wasRunning && manager.runningCount() >= manager.maxWorkers)
        throw new Error('工人并发已满，请先等已有工人收尾');
      manager.pushMessage(args.subagent_id, args.message?.trim() ?? '');
      if (!wasRunning) {
        const worker = manager.get(args.subagent_id);
        if (worker) {
          const stop = () => manager.kill(worker.id);
          context.turnState?.registerJob?.(stop, `worker:${worker.id.slice(0, 8)}`);
          context.signal?.addEventListener('abort', stop, { once: true });
          void manager
            .drive(worker)
            .catch(() => undefined)
            .finally(() => context.signal?.removeEventListener('abort', stop));
        }
      }
      // 在跑：这段等它当前一步结束才被消费；已收尾/被停：这次是让它续跑一段
      return wasRunning
        ? '已塞给它；它做完手头这步就会看到。'
        : '工人已收尾，已用这条消息让它续跑一段；用 CheckSubagent 看结果。';
    },
  });

  const stop = defineTool<{ subagent_id: string }>({
    name: 'StopSubagent',
    description: '杀掉一个工人。已产出的中间结果会留在它的记录里。',
    parameters: {
      type: 'object',
      properties: { subagent_id: { type: 'string', description: '工人 id' } },
      required: ['subagent_id'],
    },
    async execute(args, context) {
      if (manager.get(args.subagent_id)?.ownerId !== context.agentId)
        throw new Error('找不到自己派出的 worker_id');
      // 先把状态存成字符串：manager.get 返回的是活对象，stop 会就地改它
      const beforeStatus = manager.get(args.subagent_id)?.status;
      const worker = manager.stop(args.subagent_id);
      if (!worker) throw new Error('找不到这个 worker_id');
      // 已结束的工人 stop 是空操作：如实说明，别谎报「已停止」
      if (beforeStatus && beforeStatus !== 'running' && worker.status === beforeStatus) {
        return `工人 ${worker.id.slice(0, 8)} 已经结束（当前状态：${worker.status}），无需停止；要接着干就给它发消息续跑。`;
      }
      return `工人 ${worker.id.slice(0, 8)} 已停止。`;
    },
  });

  const todoWrite = defineTool<{ todos: TodoItem[]; merge: boolean }>({
    name: 'TodoWrite',
    description: [
      '多步任务的内部待办板：开工前列计划，做完一项改一项，计划变了就重写。',
      '整体重写至少 2 条；merge=true 时可只更新 1 条（同 id 覆盖）；总计最多 100 条，每条最多 500 字符。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          maxItems: 100,
          description: '重写（merge=false）至少 2 条；merge=true 时按 id 合并、可只给 1 条',
          items: {
            type: 'object',
            required: ['id', 'content', 'status'],
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                description: '待办状态',
              },
            },
          },
        },
        merge: { type: 'boolean' },
      },
      required: ['todos', 'merge'],
    },
    async execute(args, context) {
      const incoming = Array.isArray(args.todos) ? args.todos : [];
      if (incoming.length < (args.merge ? 1 : 2)) throw new Error('重写至少给 2 条待办；合并至少 1 条');
      if (new Set(incoming.map((item) => item.id)).size !== incoming.length)
        throw new Error('待办 id 不得重复');
      const valid = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
      for (const item of incoming) {
        if (!item.id || !item.content?.trim()) throw new Error('每条待办都要有 id 和 content');
        if (!valid.has(item.status)) throw new Error(`status 不合法：${item.status}`);
      }
      // 步骤回写（E4.1）：把待办同步成当前工作的 WorkStep。与待办板本身解耦——
      // 没有正在进行的工作、或回写失败，都不影响 TodoWrite 的结果。
      const recordSteps = () => {
        void input.onTodoWrite?.(context.agentId, todos.get(context.agentId)).catch(() => undefined);
      };
      if (args.merge) {
        const current = todos.get(context.agentId);
        const merged: TodoItem[] = [...current];
        for (const item of incoming) {
          const index = merged.findIndex((existing) => existing.id === item.id);
          if (index >= 0) merged[index] = item;
          else merged.push(item);
        }
        if (merged.length > 100) throw new Error('待办总量不能超过 100 条，请整体重写以整理完成项');
        todos.set(context.agentId, merged);
      } else {
        todos.set(context.agentId, incoming);
      }
      recordSteps();
      const board = todos
        .get(context.agentId)
        .map((item) => `[${item.status}] ${item.content}`)
        .join('\n');
      return `待办板已更新：\n${board}`;
    },
  });

  return [task, check, message, stop, todoWrite];
}
