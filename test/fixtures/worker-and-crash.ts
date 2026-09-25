/**
 * 真实重启夹具（E4.5）：子进程派一个后台工人，然后被父进程 SIGKILL。
 *
 * 用法：node --import tsx test/fixtures/worker-and-crash.ts <dataDir> <phase>
 *
 *   run    起运行时 → 用真的 Task 工具派一个后台工人（假模型让工人一直挂在模型调用上）
 *          → 打印 WORKER_SPAWNED {json} 后一直挂住，等着被杀。
 *   check  新进程重开同一份数据目录：启动扫描（补送收尾结果）→ 用 CheckSubagent 列出工人
 *          → 打印 CHECKED {json}（盘上状态、CheckSubagent 输出、收尾来信、派工者是否真的开了新回合）。
 *
 * 关键点：两个 phase 之间是**真 SIGKILL**（不是优雅退出、也不是「再 new 一个 manager」），
 * 数据目录里的 tasks/workers.json 是唯一交接物。只写 <dataDir>（调用方给临时目录）；
 * 不联网、不碰真实模型。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRuntime } from '../../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../../src/context/budget.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { FakeProvider } from '../fakes/fake-provider.js';
import type { LLMMessage } from '../../src/llm/provider.js';

const [dir, phase] = process.argv.slice(2);
if (!dir || !phase) {
  console.error('用法：worker-and-crash.ts <dataDir> <run|check>');
  process.exit(2);
}

/** 工人收到的任务标记：假模型见到它就永远不返回，制造「进程被杀时工人正在跑」 */
const WORKER_MARKER = '把长活一直干下去（夹具专用标记）';

function runtimeAt(dir: string, provider: FakeProvider): AgentRuntime {
  return new AgentRuntime({
    dataDir: dir,
    tools: [],
    createProvider: () => provider,
    defaultModel: 'fake',
    knownModels: ['fake'],
    budget: DEFAULT_BUDGET,
    memoryExtraction: false,
  });
}

function lastUserText(messages: LLMMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

async function readWorkers(dir: string): Promise<
  Array<{
    id: string;
    status: string;
    stopReason?: string;
    error?: string;
    ownerId?: string;
    resultDeliveredAt?: number;
  }>
> {
  const raw = JSON.parse(await readFile(join(dir, 'tasks', 'workers.json'), 'utf8')) as {
    workers?: Array<{
      id: string;
      status: string;
      stopReason?: string;
      error?: string;
      ownerId?: string;
      resultDeliveredAt?: number;
    }>;
  };
  return raw.workers ?? [];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

if (phase === 'run') {
  // 工人一问模型就挂住；派工者那一侧不走模型（夹具直接调 Task 工具）
  const provider = new FakeProvider({
    auto: (messages) =>
      lastUserText(messages).includes(WORKER_MARKER)
        ? (new Promise(() => undefined) as never)
        : FakeProvider.text('好'),
  });
  const runtime = runtimeAt(dir, provider);
  const agent = await runtime.createAgent({ name: '派工者' });
  const registry = ToolRegistry.from(runtime.tools);
  const started = await registry.execute(
    {
      id: 'task-1',
      name: 'Task',
      arguments: JSON.stringify({
        description: '长活',
        prompt: WORKER_MARKER,
        subagent_type: 'executor',
        run_in_background: true,
      }),
    },
    {
      agentId: agent.id,
      projectIds: [],
      authority: { toolNames: [], projectIds: [] },
      turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 } },
    },
  );
  const workerId = /worker_id: (\S+)/.exec(started)?.[1];
  if (!workerId) throw new Error(`Task 没有给出 worker_id：${started}`);
  // 等工人真的进了模型调用（此刻进程里有一个活的执行句柄），再让父进程杀
  for (let i = 0; provider.calls.length === 0 && i < 300; i++) await sleep(20);
  if (provider.calls.length === 0) throw new Error('工人没有进模型调用，夹具不成立');
  const persisted = await readWorkers(dir);
  console.log(
    `WORKER_SPAWNED ${JSON.stringify({ agentId: agent.id, workerId, persistedStatus: persisted.find((item) => item.id === workerId)?.status })}`,
  );
  // 挂住等 SIGKILL：必须是「进程真的还活着、被父进程强杀」。
  // 工人那一侧的定时器是 unref 的，光 await 一个空 Promise 会让 Node 事件循环空转后自己退出，
  // 那样就不是中断而是正常退出——用一个非 unref 的句柄把进程钉住。
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}

if (phase === 'check') {
  const seen: string[] = [];
  const provider = new FakeProvider({
    auto: (messages) => {
      seen.push(lastUserText(messages));
      return FakeProvider.text('收到工人的结果，先核对现场。');
    },
  });
  const runtime = runtimeAt(dir, provider);
  // 启动扫描：上次进程留下的工人收尾结果在这里补送（走 inbox/Delivery 链路）
  await runtime.recover();
  const agent = (await runtime.registry.list())[0]!;
  const registry = ToolRegistry.from(runtime.tools);
  const listed = await registry.execute(
    { id: 'check-1', name: 'CheckSubagent', arguments: '{}' },
    { agentId: agent.id, projectIds: [] },
  );
  const persisted = await readWorkers(dir);
  // 结果信作为新回合回到派工者：投递链走完的硬标志是收件箱被消费掉（ack 出队）。
  // 给足时间：并行跑门禁时 tsx 启动与调度都可能被拖慢，这里等的是「事实发生」，不是猜时序。
  let consumed = false;
  for (let i = 0; i < 1500; i++) {
    consumed = (await runtime.inbox.count(agent.id)) === 0;
    if (consumed && seen.some((text) => text.includes('工人收尾'))) break;
    await sleep(20);
  }
  const transfers = (await runtime.correspondence.list(agent.id)).map((item) => ({
    id: item.id,
    fromId: item.from.id,
    text: item.text.slice(0, 60),
  }));
  const inbox = (await runtime.inbox.peek(agent.id)).map((item) => ({
    fromId: item.fromAgentId,
    text: item.text.slice(0, 60),
  }));
  console.log(
    `CHECKED ${JSON.stringify({
      agentId: agent.id,
      workers: persisted,
      checkOutput: listed,
      transfers,
      inbox,
      turnSawLetter: seen.some((text) => text.includes('工人收尾')),
      turnSawInterrupted: seen.some((text) => text.includes('上次进程')),
      consumed,
      seenHeads: seen.map((text) => text.split('\n').slice(0, 3).join(' | ')),
    })}`,
  );
  await runtime.close();
  process.exit(0);
}

console.error(`未知 phase：${phase}`);
process.exit(2);
