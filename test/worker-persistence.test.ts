import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { MessageStore } from '../src/store/messages.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { defineTool } from '../src/tools/tool.js';
import { createTaskTools } from '../src/tools/builtin/task.js';
import { WorkerManager, workerResultLetter } from '../src/tools/services/worker-manager.js';
import type { LLMMessage } from '../src/llm/provider.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until, waitFor } from './fakes/test-env.js';

/**
 * E4.5 executor 工人收尾：持久状态、完成投递、纠偏与取消关系。
 *
 * 三条验收：
 *   1. 真 SIGKILL 重启后 CheckSubagent 仍列出上次工人并标 interrupted（子进程夹具）；
 *   2. 工人完成后派工者收到一条结果来信——走既有 inbox/Delivery 链路并真的开了新回合；
 *   3. 并发限制按「全局 + 按智能体」两个维度，且重启后工人仍不能递归派工。
 * 另覆盖纠偏记录、取消关系、收尾补送的幂等。
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/worker-and-crash.ts', import.meta.url));

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

function toolContext(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    agentId,
    projectIds: [],
    authority: { toolNames: [], projectIds: [] },
    turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 } },
    ...extra,
  };
}

function lastUserText(messages: LLMMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

async function readWorkers(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = JSON.parse(await readFile(join(dir, 'tasks', 'workers.json'), 'utf8')) as {
    workers?: Array<Record<string, unknown>>;
  };
  return raw.workers ?? [];
}

/** 手动放行的 manager：用来把工人精确停在 running / 跑完 */
function managerAt(dir: string, provider: FakeProvider, extra: Record<string, unknown> = {}) {
  return new WorkerManager({
    provider: provider as never,
    messages: new MessageStore(dir),
    workerTools: () => [],
    dataDir: dir,
    ...extra,
  });
}

// ── 验收 1：真 SIGKILL 重启后 CheckSubagent 仍能看到上次工人（标 interrupted）──

/** 起一个真子进程跑 phase，等它打印 marker 行后 SIGKILL —— 真强退，不是优雅退出 */
async function spawnAndKill(
  dir: string,
  phase: string,
  marker: string,
): Promise<{ line: string; signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, dir, phase], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await until(
    () => Promise.resolve(stdout.includes(`${marker} `) || child.exitCode !== null),
    `${phase} 打印 ${marker}`,
    20_000,
  );
  const line = stdout.split('\n').find((item) => item.startsWith(`${marker} `));
  if (!line) throw new Error(`${phase} 没有打印 ${marker}：${stdout}${stderr}`);

  const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (_code, signal) => resolve({ signal }));
  });
  child.kill('SIGKILL');
  const { signal } = await exited;
  return { line, signal };
}

function runPhase(dir: string, phase: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, ['--import', 'tsx', FIXTURE, dir, phase], {
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${phase} 应当正常退出：${result.stderr}`);
  const line = (result.stdout ?? '').split('\n').find((item) => item.startsWith('CHECKED '));
  assert.ok(line, `${phase} 应当打印一行结果：${result.stdout}`);
  return JSON.parse(line.slice('CHECKED '.length)) as Record<string, unknown>;
}

describe('验收 1：真 SIGKILL 重启后 CheckSubagent 仍看到上次工人（E4.5）', () => {
  it('工人跑到一半进程被强杀：新进程重开数据目录后仍列出它并标 interrupted', async () => {
    const env = await tempDataDir('worker-restart');
    try {
      const spawned = await spawnAndKill(env.dir, 'run', 'WORKER_SPAWNED');
      // 关键：交接真的是「进程被强杀」——不是优雅退出，也不是「再 new 一个 manager」
      assert.equal(spawned.signal, 'SIGKILL', '夹具必须是被强杀的，不是优雅退出');
      const info = JSON.parse(spawned.line.slice('WORKER_SPAWNED '.length)) as {
        agentId: string;
        workerId: string;
        persistedStatus: string;
      };
      assert.equal(info.persistedStatus, 'running', '被杀之前工人是 running，才有 interrupted 可言');

      // 进程里没有任何活着的执行句柄：唯一的交接物是盘上的 tasks/workers.json
      const persisted = await readWorkers(env.dir);
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.id, info.workerId);
      assert.equal(persisted[0]?.status, 'running');

      // 全新进程：跑真实启动扫描（含收尾补送），再用真的 CheckSubagent 工具列工人
      const checked = runPhase(env.dir, 'check');
      const workers = checked.workers as Array<{
        id: string;
        status: string;
        error?: string;
        summary?: string;
      }>;
      assert.equal(workers.length, 1, '上次的工人记录还在，不是空的');
      assert.equal(workers[0]?.id, info.workerId, '认回的是同一个工人，不是新建的');
      assert.equal(workers[0]?.status, 'interrupted', 'running 的工人重启后标为 interrupted');
      assert.match(String(workers[0]?.error), /中断/, '如实说明是被中断的');
      assert.match(String(workers[0]?.summary), /中断/, '输出摘要也落盘');
      const checkOutput = String(checked.checkOutput);
      assert.match(
        checkOutput,
        new RegExp(`${info.workerId} \\[interrupted\\]`),
        'CheckSubagent 列表里能看见它',
      );
      assert.match(checkOutput, /上次进程中断时还有 1 个工人在跑/, '不带 id 查时先如实交代中断的工人');
      assert.equal(
        checked.turnSawInterrupted,
        true,
        `中断事实进了派工者的回合上下文，不是只在盘上：${JSON.stringify(checked.seenHeads)}`,
      );
      // 顺带覆盖验收 2 的跨进程半边：重启扫描把上次没收尾的工人结果补送进投递链
      assert.equal((checked.transfers as unknown[]).length, 1, '重启进程里结果信也投出去了');
      assert.equal(checked.consumed, true, '结果信被派工者领走并确认出队');
    } finally {
      await env.cleanup();
    }
  });
});

// ── 验收 2：工人完成后派工者收到一条结果来信（走 inbox/Delivery）──

describe('验收 2：工人收尾结果作为来信回到派工者（E4.5）', () => {
  it('工人收尾 → 走 Delivery 链路进收件箱 → 派工者真的开了一轮新回合', async () => {
    const env = await tempDataDir('worker-result-letter');
    const seen: string[] = [];
    let workerId = '';
    const provider = new FakeProvider({
      auto: (messages) => {
        seen.push(lastUserText(messages));
        // 工人的 prompt 与派工者的派工指令不一样：按标记区分两个角色
        if (lastUserText(messages).includes('把接口核对一遍'))
          return FakeProvider.text('接口核对完了：三处签名不一致。');
        return FakeProvider.text('收到工人的结果。');
      },
    });
    const runtime = runtimeAt(env.dir, provider);
    try {
      const owner = await runtime.createAgent({ name: '派工者' });
      const registry = ToolRegistry.from(runtime.tools);
      const started = await registry.execute(
        {
          id: 'task-1',
          name: 'Task',
          arguments: JSON.stringify({
            description: '核对接口',
            prompt: '把接口核对一遍并给出结论',
            subagent_type: 'executor',
            run_in_background: true,
          }),
        },
        toolContext(owner.id, { authority: { toolNames: [], projectIds: [] } }),
      );
      workerId = /worker_id: (\S+)/.exec(started)![1]!;

      // 派工者「收到」的硬证据：模型被真的叫起来一次，且这一轮的输入就是工人收尾
      await until(
        () => Promise.resolve(seen.some((text) => text.includes('工人收尾') && text.includes(workerId))),
        '派工者收到工人结果来信',
        10_000,
      );
      const letterText = seen.find((text) => text.includes('工人收尾'))!;
      assert.match(letterText, /状态：done/, '信里如实写了工人状态');
      assert.match(letterText, /接口核对完了/, '信里带上了工人的交付结果');
      assert.match(letterText, /独立验收/, '不把工人自述当验收通过');

      // 证据二：这不只是一条消息，它走的是可靠投递链——收件箱里有这条 Delivery，且已被消费确认
      const transfers = await runtime.correspondence.list(owner.id);
      assert.equal(transfers.length, 1, '往来档案里留了这条结果信');
      assert.equal(transfers[0]?.from.id, workerId, '发信人是那个工人');
      assert.match(transfers[0]!.text, /工人收尾/);
      await until(async () => (await runtime.inbox.count(owner.id)) === 0, '结果信已被领取并确认出队');
      assert.equal(await runtime.inbox.failedCount(owner.id), 0, '不存在投递失败');

      // 工人自己的经历线也留了收尾（审计不依赖收件箱是否已被消费）
      const workerLine = (await runtime.messages.list(workerId)).map((message) =>
        typeof message.content === 'object' && 'text' in message.content ? message.content.text : '',
      );
      assert.ok(
        workerLine.some((text) => text.includes('工人收尾')),
        '工人线上能查到它交了什么',
      );

      // 结果信只送一次：收尾标记已落盘
      const persisted = await readWorkers(env.dir);
      assert.equal(typeof persisted[0]?.resultDeliveredAt, 'number', '已投递的事实落盘，重启不会重复送');
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });

  it('workerResultLetter 只陈述可审计的事实，不吹成功', () => {
    const base = {
      id: 'w1',
      description: '核对接口',
      prompt: 'p',
      output: '三处签名不一致',
      startedAt: 1,
      status: 'done' as const,
    };
    const done = workerResultLetter(base);
    assert.match(done, /状态：done/);
    assert.match(done, /独立验收/, '工人自述不等于验收通过');
    assert.match(done, /三处签名不一致/, '带上输出');
    const failed = workerResultLetter({ ...base, status: 'failed', error: '模型请求失败' });
    assert.match(failed, /未完成（failed）/);
    assert.match(failed, /模型请求失败/);
    const incomplete = workerResultLetter({ ...base, status: 'incomplete' });
    assert.match(incomplete, /MessageSubagent/, '没做完时给明确下一步');
    const interrupted = workerResultLetter({
      ...base,
      status: 'interrupted',
      error: '上次进程在工人运行时中断',
    });
    assert.match(interrupted, /上次进程在工人运行时中断/, '中断也把事实写进信里');
  });

  it('补送幂等：启动扫描重复跑，派工者不会收到两封一样的结果信', async () => {
    const env = await tempDataDir('worker-redeliver');
    const seen: string[] = [];
    const provider = new FakeProvider({
      auto: (messages) => {
        seen.push(lastUserText(messages));
        return FakeProvider.text('收到。');
      },
    });
    const runtime = runtimeAt(env.dir, provider);
    try {
      const owner = await runtime.createAgent({ name: '派工者' });
      const registry = ToolRegistry.from(runtime.tools);
      await registry.execute(
        {
          id: 'task-1',
          name: 'Task',
          arguments: JSON.stringify({
            description: '快活',
            prompt: '把接口核对一遍',
            subagent_type: 'executor',
            run_in_background: true,
          }),
        },
        toolContext(owner.id),
      );
      await until(
        () => Promise.resolve(seen.some((text) => text.includes('工人收尾'))),
        '第一封结果信到达',
        10_000,
      );
      const manager = (
        runtime.tools.find((tool) => tool.name === 'Task') as unknown as { workerManager: WorkerManager }
      ).workerManager;
      assert.equal(manager.pendingResults().length, 0, '收尾已经记成已投递');
      // 等结果信真的走完投递链（被领取 → 处理 → 确认出队），再谈重复投递
      await until(async () => (await runtime.inbox.count(owner.id)) === 0, '结果信被消费确认');

      // 再跑一次启动扫描：已投递的收尾不该被重复投递
      await runtime.recover();
      assert.equal(manager.pendingResults().length, 0, '重复扫描不会把结果重新挂成待投递');
      const transfers = await runtime.correspondence.list(owner.id);
      assert.equal(transfers.length, 1, '往来档案仍只有一封结果信');
      const deliveries = (await runtime.inbox.peek(owner.id)).filter((item) => item.fromAgentId !== owner.id);
      assert.ok(deliveries.length <= 1, '收件箱里不会多出第二封结果信');
      for (const item of deliveries) {
        assert.equal(item.id, transfers[0]?.id, '即使还在队列里，也是同一封投递（同一 id），不是重新投递');
      }
    } finally {
      await runtime.close();
      await env.cleanup();
    }
  });
});

// ── 纠偏与取消关系持久化 ────────────────────────────────────────

describe('纠偏记录与取消关系（E4.5）', () => {
  it('纠偏消息落盘并可读回；已消费与待处理的条数区分得清', async () => {
    const env = await tempDataDir('worker-corrections');
    try {
      const manager = managerAt(env.dir, new FakeProvider({ auto: () => FakeProvider.text('照办') }));
      const worker = manager.spawn('长活', '慢慢干', 'owner-1', { toolNames: [], projectIds: [] });
      // 这两条会被 drive 依次消费；第三条在收尾之后才塞，没人消费它
      manager.pushMessage(worker.id, '先做登录');
      manager.pushMessage(worker.id, '完成后再看权限');
      await manager.drive(worker);
      assert.equal(worker.status, 'done');
      manager.pushMessage(worker.id, '另外把日志也翻一遍');

      const reopened = managerAt(env.dir, new FakeProvider());
      const recovered = reopened.get(worker.id)!;
      assert.deepEqual(
        recovered.corrections?.map((item) => [item.text, item.consumed]),
        [
          ['先做登录', true],
          ['完成后再看权限', true],
          ['另外把日志也翻一遍', false],
        ],
        '重启后看得出派工者改过什么口、哪几条还没被看到',
      );
      const board = await (async () => {
        const tools = createTaskTools({
          provider: new FakeProvider({ auto: () => FakeProvider.text('照办') }) as never,
          messages: new MessageStore(env.dir),
          workerTools: () => [],
          dataDir: env.dir,
        });
        return ToolRegistry.from(tools).execute(
          { id: 'c', name: 'CheckSubagent', arguments: JSON.stringify({ subagent_id: worker.id }) },
          toolContext('owner-1'),
        );
      })();
      assert.match(board, /纠偏记录：2\/3 条已被消费/, 'CheckSubagent 如实报出还有几条没被看到');
    } finally {
      await env.cleanup();
    }
  });

  it('取消关系落盘：谁因为什么让它停的，重启后答案还在', async () => {
    const env = await tempDataDir('worker-cancel');
    const fake = new FakeProvider();
    try {
      const manager = managerAt(env.dir, fake);
      const worker = manager.spawn('长活', '慢慢干', 'owner-1');
      // 先排队两段：第一段跑完留下输出，第二段跑到一半被杀
      manager.pushMessage(worker.id, '先做第一段');
      const driving = manager.drive(worker);
      await until(() => Promise.resolve(fake.pendingCount >= 1), '工人进模型');
      fake.releaseText(0, '半截输出：第一段做完了');
      await until(() => Promise.resolve(fake.pendingCount >= 2), '工人进第二段');
      manager.kill(worker.id, 'stop_command', '主人叫停');
      await driving;

      const reopened = managerAt(env.dir, new FakeProvider());
      const recovered = reopened.get(worker.id)!;
      assert.equal(recovered.status, 'cancelled');
      assert.equal(recovered.cancel?.by, 'stop_command');
      assert.equal(recovered.cancel?.reason, '主人叫停');
      assert.match(recovered.summary ?? '', /半截输出/, '取消也留下可审计的输出摘要');

      // 派工者回合被中止是另一种来源，不能混为一谈
      const other = manager.spawn('另一件', '慢慢干', 'owner-1');
      const otherDriving = manager.drive(other);
      await until(() => Promise.resolve(fake.pendingCount >= 3), '第二个工人进模型');
      manager.kill(other.id, 'parent_turn_aborted');
      await otherDriving;
      assert.equal(manager.get(other.id)?.cancel?.by, 'parent_turn_aborted');
      // 也要能跨重启读回：新开一个 manager 重读同一份文件
      const third = managerAt(env.dir, new FakeProvider());
      assert.equal(third.get(other.id)?.cancel?.by, 'parent_turn_aborted');
      assert.equal(third.get(worker.id)?.cancel?.by, 'stop_command');
    } finally {
      await env.cleanup();
    }
  });
});

// ── 并发上限两个维度 + 不允许递归派工（重启后仍然成立）─────────────

describe('工人并发上限两个维度（E4.5）', () => {
  it('全局满了谁都起不来；某个智能体满了只有它被拦住', async () => {
    const fake = new FakeProvider();
    const manager = new WorkerManager({
      provider: fake as never,
      messages: { append: async () => undefined } as never,
      workerTools: () => [],
      maxWorkers: 3,
      maxWorkersPerAgent: 1,
    });
    const a = manager.spawn('甲的活', '干', 'agent-a');
    assert.equal(manager.runningCount(), 1);
    assert.equal(manager.runningCount('agent-a'), 1);
    assert.throws(() => manager.spawn('甲的第二件', '干', 'agent-a'), /每个智能体最多 1 个/);
    // 同一维度只拦同一个智能体：别人照样起得来
    manager.spawn('乙的活', '干', 'agent-b');
    manager.spawn('丙的活', '干', 'agent-c');
    assert.equal(manager.runningCount(), 3);
    // 全局维度再拦：换一个智能体也起不来
    assert.throws(() => manager.spawn('丁的活', '干', 'agent-d'), /已有 3 个工人在跑/);
    manager.kill(a.id);
    manager.kill(manager.list().find((item) => item.ownerId === 'agent-b')!.id);
    manager.kill(manager.list().find((item) => item.ownerId === 'agent-c')!.id);
    assert.equal(manager.runningCount(), 0);
  });

  it('续跑（MessageSubagent 那条路）也要过并发两个维度', async () => {
    const env = await tempDataDir('worker-cap-tools');
    try {
      // 「慢慢干」永不返回：占住这个智能体的名额；其余立刻收尾
      const provider = new FakeProvider({
        auto: (messages) =>
          lastUserText(messages).includes('慢慢干')
            ? (new Promise(() => undefined) as never)
            : FakeProvider.text('干完了'),
      });
      const tools = createTaskTools({
        provider: provider as never,
        messages: new MessageStore(env.dir),
        workerTools: () => [],
        dataDir: env.dir,
        maxWorkers: 4,
        maxWorkersPerAgent: 1,
      });
      const registry = ToolRegistry.from(tools);
      const call = (name: string, args: unknown) =>
        registry.execute({ id: 't', name, arguments: JSON.stringify(args) }, toolContext('agent-a'));

      const first = await call('Task', {
        description: '快活',
        prompt: '干完',
        subagent_type: 'executor',
        run_in_background: true,
      });
      const firstId = /worker_id: (\S+)/.exec(first)![1]!;
      await until(async () => /\[done\]/.test(await call('CheckSubagent', {})), '第一个工人收尾');
      // 此刻没有在跑的工人，所以再起一个占住 agent-a 的唯一名额
      const running = await call('Task', {
        description: '长活',
        prompt: '慢慢干',
        subagent_type: 'executor',
        run_in_background: true,
      });
      const runningId = /worker_id: (\S+)/.exec(running)![1]!;
      assert.notEqual(runningId, firstId);

      // 已收尾的工人续跑也要过按智能体的并发上限（工具层把错误如实回给模型，不假装成功）
      const blocked = await call('MessageSubagent', { subagent_id: firstId, message: '再补一句' });
      assert.match(blocked, /^Error: .*工人并发已满/);
      // 名额没被多占：工人数仍是 1，续跑没有偷偷开跑
      const manager = (
        tools.find((tool) => tool.name === 'Task') as unknown as { workerManager: WorkerManager }
      ).workerManager;
      assert.equal(manager.runningCount('agent-a'), 1);
      assert.equal(manager.get(firstId)?.corrections?.length, 0, '被拦下的续跑没有塞进纠偏队列');
      manager.kill(runningId);
      assert.equal(manager.runningCount('agent-a'), 0);
      assert.doesNotThrow(() => manager.spawn('名额释放后', '干', 'agent-a'));
    } finally {
      await env.cleanup();
    }
  });

  it('重启后工人仍然不能递归派工（Task 不在它的工具面里）', async () => {
    const env = await tempDataDir('worker-no-recursion');
    const schemas: string[][] = [];
    const tool = (name: string) =>
      defineTool<Record<string, never>>({
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        execute: () => 'ok',
      });
    const provider = {
      name: 'fake',
      async chat(_messages: LLMMessage[], options?: { tools?: Array<{ name: string }> }) {
        schemas.push(options?.tools?.map((item) => item.name) ?? []);
        return FakeProvider.text('完成');
      },
    };
    const allWorkerTools = () => [
      tool('Task'),
      tool('Read'),
      tool('MessageSubagent'),
      tool('CheckSubagent'),
      tool('StopSubagent'),
    ];
    const authority = {
      toolNames: ['Task', 'Read', 'MessageSubagent', 'CheckSubagent', 'StopSubagent'],
      projectIds: [],
    };
    try {
      // 落一条「运行中」的工人记录（没有收尾），重启扫描会把它标成 interrupted
      const first = new WorkerManager({
        provider: provider as never,
        messages: new MessageStore(env.dir),
        workerTools: allWorkerTools,
        dataDir: env.dir,
      });
      const worker = first.spawn('检查', '只读检查', 'agent-a', authority);

      const reopened = new WorkerManager({
        provider: provider as never,
        messages: new MessageStore(env.dir),
        workerTools: allWorkerTools,
        dataDir: env.dir,
      });
      const recovered = reopened.get(worker.id)!;
      assert.equal(recovered.status, 'interrupted', '先确认走的是重启恢复出来的工人');
      assert.equal(typeof recovered.authority?.toolNames, 'object', '授权快照也读回来了');
      reopened.pushMessage(worker.id, '接着查');
      await reopened.drive(recovered);
      assert.ok(schemas.length >= 1);
      for (const names of schemas) {
        assert.ok(!names.includes('Task'), '工人不能递归派工');
        assert.ok(
          !names.includes('MessageSubagent') &&
            !names.includes('CheckSubagent') &&
            !names.includes('StopSubagent'),
          '工人不能反过来操作工人族',
        );
        assert.ok(names.includes('Read'), '该有的能力还在，不是一刀切');
      }
    } finally {
      await env.cleanup();
    }
  });

  it('重启后按描述认回中断的工人，不留下两条几乎一样的记录', async () => {
    const env = await tempDataDir('worker-resume-match');
    const fake = new FakeProvider();
    try {
      const first = new WorkerManager({
        provider: fake as never,
        messages: new MessageStore(env.dir),
        workerTools: () => [],
        dataDir: env.dir,
      });
      const worker = first.spawn('核对接口', '核对接口', 'agent-a');
      const driving = first.drive(worker);
      await until(() => Promise.resolve(fake.pendingCount >= 1), '工人进模型');
      // 让进程「死」：不再放行这次模型调用，直接开一个新 manager 模拟重启
      const reopened = new WorkerManager({
        provider: new FakeProvider({ auto: () => FakeProvider.text('核对完了') }) as never,
        messages: new MessageStore(env.dir),
        workerTools: () => [],
        dataDir: env.dir,
      });
      const resumed = reopened.interruptedMatching('核对接口', 'agent-a');
      assert.equal(resumed?.id, worker.id, '同一派工者 + 同一描述认回同一个工人');
      assert.equal(reopened.interruptedMatching('核对接口', 'agent-b'), undefined, '别的智能体不会认领');
      assert.equal(reopened.interruptedMatching('别的活', 'agent-a'), undefined);

      const tools = createTaskTools({
        provider: new FakeProvider({ auto: () => FakeProvider.text('核对完了') }) as never,
        messages: new MessageStore(env.dir),
        workerTools: () => [],
        dataDir: env.dir,
      });
      const registry = ToolRegistry.from(tools);
      const started = await registry.execute(
        {
          id: 't',
          name: 'Task',
          arguments: JSON.stringify({
            description: '核对接口',
            prompt: '核对接口',
            subagent_type: 'executor',
            run_in_background: true,
          }),
        },
        toolContext('agent-a'),
      );
      assert.match(started, /接着上次中断的那个工人续跑/, '重派是续跑，不是再开一个');
      const persisted = await readWorkers(env.dir);
      assert.equal(persisted.length, 1, '看板上不会留下两条几乎一样的工人记录');
      fake.releaseText(0, '半截');
      await driving.catch(() => undefined);
    } finally {
      await env.cleanup();
    }
  });
});

// ── Task 工具上的持久字段：关联工作与摘要 ───────────────────────

describe('工人状态里的关联工作与摘要（E4.5）', () => {
  it('派工者手头有工作就记在工人上，CheckSubagent 能看见', async () => {
    const env = await tempDataDir('worker-work-link');
    try {
      const fake = new FakeProvider({ auto: () => FakeProvider.text('做完了') });
      const tools = createTaskTools({
        provider: fake as never,
        messages: new MessageStore(env.dir),
        workerTools: () => [],
        dataDir: env.dir,
        workOf: async () => 'work-42',
      });
      const registry = ToolRegistry.from(tools);
      const started = await registry.execute(
        {
          id: 't',
          name: 'Task',
          arguments: JSON.stringify({
            description: '快活',
            prompt: '干完',
            subagent_type: 'executor',
            run_in_background: true,
          }),
        },
        toolContext('agent-a'),
      );
      const workerId = /worker_id: (\S+)/.exec(started)![1]!;
      await until(
        async () =>
          /\[done\]/.test(
            await registry.execute(
              { id: 'c', name: 'CheckSubagent', arguments: '{}' },
              toolContext('agent-a'),
            ),
          ),
        '工人收尾',
      );
      const output = await registry.execute(
        { id: 'c2', name: 'CheckSubagent', arguments: JSON.stringify({ subagent_id: workerId }) },
        toolContext('agent-a'),
      );
      assert.match(output, /关联工作：work-42/);
      assert.match(output, /输出：\n做完了/);
      const persisted = await readWorkers(env.dir);
      assert.equal(persisted[0]?.workId, 'work-42');
      assert.equal(typeof persisted[0]?.summary, 'string');
    } finally {
      await env.cleanup();
    }
  });

  it('Task 工具面里带着 workerManager（启动恢复要用，但不暴露给模型）', () => {
    const tools = createTaskTools({
      provider: new FakeProvider() as never,
      messages: { append: async () => undefined } as never,
      workerTools: () => [],
    });
    const task = tools.find((tool) => tool.name === 'Task') as unknown as { workerManager?: WorkerManager };
    assert.ok(task.workerManager instanceof WorkerManager);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['Task', 'CheckSubagent', 'MessageSubagent', 'StopSubagent', 'TodoWrite'],
    );
  });
});

// ── 工人记录数上限：全局与按智能体 ──────────────────────────────

describe('工人记录累计上限（E4.5）', () => {
  it('记录数也分两个维度，防一个人占满', async () => {
    const fake = new FakeProvider();
    const manager = new WorkerManager({
      provider: fake as never,
      messages: { append: async () => undefined } as never,
      workerTools: () => [],
      maxWorkers: 100,
      maxWorkersPerAgent: 100,
      maxWorkerRecords: 5,
      maxWorkerRecordsPerAgent: 2,
    });
    manager.spawn('a1', 'x', 'agent-a');
    manager.spawn('a2', 'x', 'agent-a');
    assert.throws(() => manager.spawn('a3', 'x', 'agent-a'), /你的工人记录已达 2 个/);
    manager.spawn('b1', 'x', 'agent-b');
    manager.spawn('b2', 'x', 'agent-b');
    manager.spawn('c1', 'x', 'agent-c');
    assert.throws(() => manager.spawn('c2', 'x', 'agent-c'), /工人记录已达 5 个/);
    await waitFor(() => manager.list().length === 5, '记录都在');
  });
});
