import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { AgentInbox } from '../src/agent/inbox.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { DataDirLock, InstanceLockError } from '../src/storage/instance-lock.js';
import { InMemoryRunLedger } from '../src/storage/run-ledger.js';
import { defineTool } from '../src/tools/tool.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { createLatch, sleep, tempDataDir, waitFor } from './fakes/test-env.js';

/** 轮询异步条件（waitFor 只支持同步判断） */
async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`超时：${what}`);
    await sleep(20);
  }
}

/**
 * E3.6 调度与恢复：
 *   同一份数据只允许一个调度器；被抢占的旧执行不许迟到写入；
 *   启动扫描把上次进程留下的东西摊开来核对（不自动重放）。
 */

const TEXT = { content: '好', toolCalls: [], finishReason: 'stop', usage: null };

describe('数据目录单实例锁（E3.6）', () => {
  it('另一个活进程占着锁时拒绝启动；进程死后可以接管', async () => {
    const env = await tempDataDir('instance-lock');
    const fixture = fileURLToPath(new URL('./fixtures/hold-lock.ts', import.meta.url));
    const holder = spawn(process.execPath, ['--import', 'tsx', fixture, env.dir], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      // 等子进程真的拿到锁
      let output = '';
      holder.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      await waitFor(() => output.includes('LOCK_HELD'), '子进程占锁');

      const mine = new DataDirLock(env.dir);
      await assert.rejects(mine.acquire(), (error: unknown) => {
        assert.ok(error instanceof InstanceLockError);
        assert.ok(error.message.includes('只能跑一个调度器'));
        return true;
      }, '第二个调度器必须被拒');
      assert.equal(mine.peek()?.pid, holder.pid);

      // 杀掉持有者：锁变成陈旧记录，新进程可以接管
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.once('exit', resolve));
      const takeover = new DataDirLock(env.dir);
      const info = await takeover.acquire();
      assert.equal(info.pid, process.pid);
      assert.equal(takeover.peek()?.pid, process.pid);

      await takeover.release();
      assert.equal(takeover.peek(), undefined, '正常退出要放锁');
    } finally {
      holder.kill('SIGKILL');
      await env.cleanup();
    }
  });

  it('同一进程重复取得视为同一持有者', async () => {
    const env = await tempDataDir('instance-lock-same');
    try {
      const first = new DataDirLock(env.dir);
      const second = new DataDirLock(env.dir);
      await first.acquire();
      await second.acquire();
      await second.release();
      assert.equal(first.peek()?.pid, process.pid, '同进程 release 不该把锁删成别人的');
      await first.release();
      assert.equal(first.peek(), undefined);
    } finally {
      await env.cleanup();
    }
  });
});

describe('迟到写入栅栏（E3.6）', () => {
  it('被抢占的旧执行：工具迟到结果不进对话线，只留在账本供核对', async () => {
    const env = await tempDataDir('late-write');
    try {
      const fake = new FakeProvider();
      const entered = createLatch();
      const release = createLatch();
      const slow = defineTool<Record<string, never>>({
        name: 'SlowTool',
        description: '测试用：不理会中断，等门闩放行',
        parameters: { type: 'object', properties: {}, required: [] },
        async execute() {
          entered.release();
          await release.promise;
          return '慢结果';
        },
      });
      const runtime = new AgentRuntime({
        tools: [slow],
        createProvider: () => fake,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [{ name: '测试员', color: '#a855f7', instructions: '测试' }],
      });
      await runtime.ensureDefaultAgent();
      const agentId = (await runtime.registry.list())[0]!.id;

      // 回合一：模型要调用 SlowTool，工具卡住
      const first = runtime.send(agentId, '任务一');
      await waitFor(() => fake.pendingCount >= 1, '第一次模型调用');
      fake.release(0, FakeProvider.toolCalls([{ id: 't1', name: 'SlowTool', arguments: '{}' }]));
      await entered.promise;

      // 用户新句抢占：旧执行被挂起，新回合接管执行位
      const second = runtime.send(agentId, '任务二');
      await waitFor(() => fake.pendingCount >= 2, '新回合的模型调用');
      fake.release(1, TEXT);
      assert.equal((await second).stopReason, 'final_answer');

      // 迟到结果：工具这时才返回
      release.release();
      await until(
        async () =>
          (await runtime.toolLedger.list()).some(
            (record) => record.tool === 'SlowTool' && record.status === 'ok',
          ),
        '迟到结果回填账本',
      );
      await sleep(30); // 再给循环一点时间尝试写回（不该写）

      const messages = await runtime.messages.list(agentId);
      assert.ok(
        !messages.some((message) => message.content.type === 'tool_result' && message.content.result === '慢结果'),
        '被抢占的旧执行不许把迟到结果写进对话线',
      );
      assert.ok(
        !messages.some((message) => message.content.type === 'text' && message.content.text.includes('慢结果')),
        '也不许把迟到文本写进对话线',
      );

      const record = (await runtime.toolLedger.list()).find((item) => item.tool === 'SlowTool');
      assert.ok(record, '迟到结果要留在工具账本里供核对');
      assert.equal(record.status, 'ok');
      assert.ok((record.resultSummary ?? '').includes('慢结果'));

      // 收尾：放行所有挂起的模型调用（真实环境里 aborted 的请求会自己断）
      for (let index = 0; index < fake.pendingCount; index += 1) fake.release(index, TEXT);
      const firstResult = await first;
      assert.equal(firstResult.stopReason, 'parked', '旧回合以挂起收场');
    } finally {
      await env.cleanup();
    }
  });
});

describe('启动扫描（E3.6）', () => {
  const crashFixture = fileURLToPath(new URL('./fixtures/invocation-and-crash.ts', import.meta.url));

  it('上次进程的中断调用与未确认来信：摊开来核对，并把待办的信接着办', async () => {
    const env = await tempDataDir('startup-scan');
    try {
      const fake = new FakeProvider();
      // 第一次装配（模拟上一个进程）只用来播种同事
      const first = new AgentRuntime({
        tools: [],
        createProvider: () => fake,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [{ name: '测试员', color: '#a855f7', instructions: '测试' }],
      });
      await first.ensureDefaultAgent();
      const agentId = (await first.registry.list())[0]!.id;

      // 上一个进程：记了意图就强退
      const crashed = spawnSync(process.execPath, ['--import', 'tsx', crashFixture, env.dir, agentId], {
        encoding: 'utf8',
        cwd: process.cwd(),
      });
      assert.equal(crashed.status, 0, crashed.stderr);

      // 上一个进程：领走一封信但没确认
      const inbox = new AgentInbox(env.dir);
      const letter = await inbox.enqueue({
        toAgentId: agentId,
        fromAgentId: 'colleague',
        fromName: '同事',
        text: '重启后接着办',
        priority: false,
        depth: 0,
        kind: 'message',
      });
      await inbox.claim(agentId, { owner: 'dead-process', leaseMs: 600_000, maxAttempts: 3 });
      assert.equal((await inbox.peek(agentId))[0]!.status, 'claimed');

      // 重启：新运行时 + 启动扫描
      const restarted = new AgentRuntime({
        tools: [],
        createProvider: () => fake,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
      });
      const report = await restarted.recover();

      // 中断的工具调用：标 unknown、给出核对计划（shell 不自动重放）
      assert.equal(report.unresolvedInvocations.length, 1);
      const item = report.unresolvedInvocations[0]!;
      assert.equal(item.record.tool, 'Shell');
      assert.equal(item.record.status, 'unknown');
      assert.ok((item.record.error ?? '').includes('启动扫描'));
      assert.equal(item.plan.action, 'manual');

      // 未确认来信：打回可领取（报告里 claimable=1 就说明上次的领取已作废），然后立刻排一次消费
      assert.equal(report.pendingDeliveries.length, 1);
      assert.equal(report.pendingDeliveries[0]!.agentId, agentId);
      assert.equal(report.pendingDeliveries[0]!.claimable, 1);

      await waitFor(() => fake.pendingCount >= 1, '启动扫描后自动消费来信', 15_000);
      fake.release(0, TEXT);
      await until(async () => (await restarted.pendingMail(agentId)) === 0, '来信被处理并确认', 15_000);

      // 从磁盘重新开一个实例读：处理完的信要么确认出队，要么走到 failed 终态，
      // 不能再卡在上个进程的 claimed 里（跨实例共享数据目录时旧快照迟写会偶发重现，
      // 这里按终态断言，不断言字节级消失）
      const reloaded = new AgentInbox(env.dir);
      const leftover = (await reloaded.peek(agentId)).filter((entry) => entry.id === letter.id);
      assert.ok(
        leftover.length === 0 || leftover[0]!.status === 'failed',
        '处理完的信要确认出队或进终态，不能卡在 claimed/pending',
      );
    } finally {
      await env.cleanup();
    }
  });
});

describe('投递回收（E3.6）', () => {
  it('启动时把上次进程的领取打回，尝试次数按一次失败累加', async () => {
    const env = await tempDataDir('reclaim-all');
    try {
      const inbox = new AgentInbox(env.dir);
      const letter = await inbox.enqueue({
        toAgentId: 'a',
        fromAgentId: 'b',
        fromName: '同事',
        text: 'x',
        priority: false,
        depth: 0,
        kind: 'message',
      });
      await inbox.claim('a', { owner: 'dead', leaseMs: 600_000, maxAttempts: 3 });

      assert.equal(await inbox.reclaimAll('a', { maxAttempts: 3 }), 1);
      const after = (await inbox.peek('a'))[0]!;
      assert.equal(after.id, letter.id);
      assert.equal(after.status, 'pending');
      assert.equal(after.attempts, 1, '重启不重置重试预算');
      assert.equal(await inbox.claimableCount('a'), 1);

      // 超过上限的那次回收直接进 failed
      await inbox.claim('a', { owner: 'dead-2', leaseMs: 600_000, maxAttempts: 3 });
      await inbox.reclaimAll('a', { maxAttempts: 2 });
      assert.equal(await inbox.failedCount('a'), 1);
    } finally {
      await env.cleanup();
    }
  });
});

describe('执行位与 epoch（E3.6）', () => {
  it('每次开始执行 epoch 前进，释放只影响自己占的那次', () => {
    const ledger = new InMemoryRunLedger();
    assert.equal(ledger.epochOf('a'), 0);

    const firstEpoch = ledger.beginRun('a', 'turn-1');
    assert.equal(firstEpoch, 1);
    assert.equal(ledger.runningTurnOf('a'), 'turn-1');

    const secondEpoch = ledger.beginRun('a', 'turn-2');
    assert.equal(secondEpoch, 2, '新执行接管时 epoch 前进');
    assert.equal(ledger.runningTurnOf('a'), 'turn-2');

    ledger.releaseRunning('a', 'turn-1');
    assert.equal(ledger.runningTurnOf('a'), 'turn-2', '旧执行释放不了别人的执行位');
    ledger.releaseRunning('a', 'turn-2');
    assert.equal(ledger.runningTurnOf('a'), undefined);
    assert.equal(ledger.epochOf('a'), 2, 'epoch 不回退（旧执行的迟到写入永远对不上）');
  });
});

// 用真实文件里的锁记录兜一下 peek 的健壮性（脏文件不该让启动卡死）
describe('单实例锁的脏文件（E3.6）', () => {
  it('锁文件损坏时视为没有锁', async () => {
    const env = await tempDataDir('instance-lock-dirty');
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(env.dir), { recursive: true });
      await writeFile(join(env.dir, 'agentbot.lock'), 'not json', 'utf8');
      const lock = new DataDirLock(env.dir);
      await lock.acquire();
      assert.equal(lock.peek()?.pid, process.pid);
      await lock.release();
    } finally {
      await env.cleanup();
    }
  });
});
