import { defineTool } from '../tool.js';
import { TodoStore, WorkerManager } from '../services/worker-manager.js';
import type { TodoItem } from '../services/worker-manager.js';

/**
 * Task 工人族 —— 对齐《内置工具清单.md》H 组（executor 一种）。
 *
 * Task 派一个后台工人做多步活；CheckSubagent 只读进度；MessageSubagent 塞话纠偏；
 * StopSubagent 杀工人。生命周期与模型驱动在 WorkerManager（services 层）；
 * 工具只做参数校验、记账（任务树）与展示。
 * TodoWrite 是模型自己的多步待办板（内存态，按智能体隔离）。
 */

export function createTaskTools(input: {
  provider: import('../../llm/provider.js').LLMProvider;
  messages: import('../../store/messages.js').MessageStore;
  /** 工人可用工具（调用方负责滤掉用户面工具，如 SendToUser） */
  workerTools: () => import('../../tools/tool.js').Tool<any>[];
  maxIterations?: number;
  maxWorkers?: number;
}) {
  const manager = new WorkerManager({
    provider: input.provider,
    messages: input.messages,
    workerTools: input.workerTools,
    maxIterations: input.maxIterations,
  });
  const todos = new TodoStore();

  const format = (worker: import('../services/worker-manager.js').Worker): string => {
    const elapsed = Math.round(((worker.endedAt ?? Date.now()) - worker.startedAt) / 1000);
    const head = `worker_id: ${worker.id}\n任务：${worker.description}\n状态：${worker.status}（${elapsed}s）`;
    const tail = worker.error
      ? `\n错误：${worker.error}`
      : worker.output
        ? `\n输出：\n${worker.output.slice(-3000)}`
        : '\n（还没有收尾输出）';
    return `${head}${tail}`;
  };

  const task = defineTool<{
    description: string;
    prompt: string;
    subagent_type: string;
    run_in_background?: boolean;
  }>({
    name: 'Task',
    description: [
      '派一个后台工人做多步活。工人没有和用户的对话上下文，prompt 必须自洽（背景、目标、验收标准都写全）。',
      '简单事不要派；派出去之后用 CheckSubagent 看进度。',
      'subagent_type 只支持 executor。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '短标题，5~10 个字' },
        prompt: { type: 'string', description: '给工人的完整任务说明（自洽）' },
        subagent_type: { type: 'string', description: '只支持 executor' },
        run_in_background: { type: 'boolean', description: 'true = 立刻返回 worker_id；默认 false = 等它做完' },
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

      const worker = manager.spawn(description, prompt);
      // 记账：停止令要能杀掉这个工人（《停止与插话.md》§8）
      context.turnState?.registerJob?.(() => manager.kill(worker.id), `worker:${worker.id.slice(0, 8)}`);

      if (args.run_in_background) {
        void manager.drive(worker);
        return `工人已开工。\nworker_id: ${worker.id}\n用 CheckSubagent 看进度，MessageSubagent 塞话纠偏，StopSubagent 杀掉。`;
      }
      await manager.drive(worker);
      return format(worker);
    },
  });

  const check = defineTool<{ subagent_id?: string }>({
    name: 'CheckSubagent',
    description: '只读看工人的进度和输出；不传 id 就列出全部工人。',
    parameters: {
      type: 'object',
      properties: { subagent_id: { type: 'string' } },
    },
    async execute(args) {
      if (!args.subagent_id) {
        const all = manager.list();
        if (all.length === 0) return '还没有派过工人。';
        return all.map((worker) => `${worker.id.slice(0, 8)} [${worker.status}] ${worker.description}`).join('\n');
      }
      const worker = manager.get(args.subagent_id);
      if (!worker) throw new Error('找不到这个 worker_id（用 CheckSubagent 不带参数列出全部）');
      return format(worker);
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
    async execute(args) {
      const push = manager.pushMessage(args.subagent_id, args.message?.trim() ?? '');
      if (!manager.isRunning(args.subagent_id)) {
        const worker = manager.get(args.subagent_id);
        if (worker) void manager.drive(worker);
      }
      return push.queued ? '已塞给它；它做完手头这步就会看到。' : '没有投递成功。';
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
    async execute(args) {
      const worker = manager.stop(args.subagent_id);
      if (!worker) throw new Error('找不到这个 worker_id');
      return `工人 ${worker.id.slice(0, 8)} 已停止。`;
    },
  });

  const todoWrite = defineTool<{ todos: TodoItem[]; merge: boolean }>({
    name: 'TodoWrite',
    description: [
      '多步任务的内部待办板：开工前列计划，做完一项改一项，计划变了就重写。',
      '至少 2 条；merge=true 表示在现有列表上合并（同 id 覆盖），false 表示整体重写。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '至少 2 条',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', description: 'pending | in_progress | completed | cancelled' },
          },
        },
        merge: { type: 'boolean' },
      },
      required: ['todos', 'merge'],
    },
    async execute(args, context) {
      const incoming = Array.isArray(args.todos) ? args.todos : [];
      if (incoming.length < 2) throw new Error('至少给 2 条待办');
      const valid = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
      for (const item of incoming) {
        if (!item.id || !item.content?.trim()) throw new Error('每条待办都要有 id 和 content');
        if (!valid.has(item.status)) throw new Error(`status 不合法：${item.status}`);
      }
      if (args.merge) {
        const current = todos.get(context.agentId);
        const merged: TodoItem[] = [...current];
        for (const item of incoming) {
          const index = merged.findIndex((existing) => existing.id === item.id);
          if (index >= 0) merged[index] = item;
          else merged.push(item);
        }
        todos.set(context.agentId, merged);
      } else {
        todos.set(context.agentId, incoming);
      }
      const board = todos
        .get(context.agentId)
        .map((item) => `[${item.status}] ${item.content}`)
        .join('\n');
      return `待办板已更新：\n${board}`;
    },
  });

  return [task, check, message, stop, todoWrite];
}
