import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { JsonToolInvocationLedger } from '../src/storage/tool-ledger.js';
import { operationKeyOf, planRecovery, replayPolicyOf } from '../src/tools/policy.js';
import { defineTool } from '../src/tools/tool.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, waitFor } from './fakes/test-env.js';

/**
 * E3.5 工具执行账本：
 *   先记意图（started）→ 执行 → 回填结果（ok/error/unknown）；
 *   有意图没结果 = 中断，恢复前必须按策略核对，shell 这类不许盲目重跑。
 */

const TEXT = { content: '好', toolCalls: [], finishReason: 'stop', usage: null };

describe('工具执行账本（E3.5）', () => {
  it('start → finish 回填结果；未完结的留在 unfinished', async () => {
    const env = await tempDataDir('tool-ledger');
    try {
      const ledger = new JsonToolInvocationLedger(env.dir);
      const done = await ledger.start({
        agentId: 'a1',
        runId: 'run-1',
        tool: 'Read',
        operationKey: 'k-read',
        args: '{"path":"/tmp/x"}',
        replayPolicy: 'rerun',
      });
      await ledger.finish(done.id, { status: 'ok', summary: '文件内容', durationMs: 12 });

      const open = await ledger.start({
        agentId: 'a1',
        runId: 'run-1',
        tool: 'Shell',
        operationKey: 'k-shell',
        args: '{"command":"echo hi"}',
        replayPolicy: 'manual',
      });

      assert.equal((await ledger.unfinished()).map((item) => item.id).join(','), open.id);

      const records = await ledger.list();
      const backfilled = records.find((item) => item.id === done.id)!;
      assert.equal(backfilled.status, 'ok');
      assert.equal(backfilled.resultSummary, '文件内容');
      assert.equal(backfilled.durationMs, 12);
      assert.ok(backfilled.endedAt);

      // 同一业务键能查到历史尝试（恢复时判断「是不是已经做过」）
      assert.equal((await ledger.attemptsOf('k-read')).length, 1);

      // 错误也回填
      await ledger.finish(open.id, { status: 'error', error: '命令失败' });
      const failed = (await ledger.list()).find((item) => item.id === open.id)!;
      assert.equal(failed.status, 'error');
      assert.equal(failed.error, '命令失败');
    } finally {
      await env.cleanup();
    }
  });

  it('重开存储仍在；保留上限只裁已完结的记录', async () => {
    const env = await tempDataDir('tool-ledger-prune');
    try {
      const ledger = new JsonToolInvocationLedger(env.dir, { limit: 3 });
      const open = await ledger.start({
        agentId: 'a',
        tool: 'Shell',
        operationKey: 'k-open',
        replayPolicy: 'manual',
      });
      for (let index = 0; index < 4; index += 1) {
        const record = await ledger.start({
          agentId: 'a',
          tool: 'Read',
          operationKey: `k-${index}`,
          replayPolicy: 'rerun',
        });
        await ledger.finish(record.id, { status: 'ok' });
      }

      const reopened = new JsonToolInvocationLedger(env.dir, { limit: 3 });
      const records = await reopened.list(100);
      assert.ok(records.length <= 3, `上限内，实际 ${records.length}`);
      assert.ok(
        records.some((item) => item.id === open.id && item.status === 'started'),
        '未完结的记录不能被裁掉',
      );
    } finally {
      await env.cleanup();
    }
  });

  it('参数截断落盘，不整包塞进账本', async () => {
    const env = await tempDataDir('tool-ledger-truncate');
    try {
      const ledger = new JsonToolInvocationLedger(env.dir);
      const long = 'x'.repeat(1000);
      const record = await ledger.start({
        agentId: 'a',
        tool: 'Shell',
        operationKey: 'k',
        args: `{"command":"${long}"}`,
        replayPolicy: 'manual',
      });
      assert.ok((record.args ?? '').length < 500);
      assert.ok((record.args ?? '').endsWith('…'));
    } finally {
      await env.cleanup();
    }
  });
});

describe('恢复策略（E3.5）', () => {
  it('operationKey 稳定：同一请求键序无关，参数变化换键', () => {
    const a = operationKeyOf({ agentId: 'a1', tool: 'Shell', args: '{"a":1,"b":2}' });
    const b = operationKeyOf({ agentId: 'a1', tool: 'Shell', args: '{ "b" : 2, "a" : 1 }' });
    const c = operationKeyOf({ agentId: 'a1', tool: 'Shell', args: '{"a":1,"b":3}' });
    const d = operationKeyOf({ agentId: 'a2', tool: 'Shell', args: '{"a":1,"b":2}' });
    assert.equal(a, b, '同一请求（键序/空白不同）要给同一个业务键');
    assert.notEqual(a, c, '参数不同要换键');
    assert.notEqual(a, d, '换个人/同事要换键');
  });

  it('分类：纯读取可重读，shell/外发不许盲目重跑', () => {
    assert.equal(replayPolicyOf('Read'), 'rerun');
    assert.equal(replayPolicyOf('WebSearch'), 'rerun');
    assert.equal(replayPolicyOf('update_state'), 'verify');
    assert.equal(replayPolicyOf('Shell'), 'manual');
    assert.equal(replayPolicyOf('SendToAgent'), 'manual');
    assert.equal(replayPolicyOf('从未见过的工具'), 'manual');
  });

  it('planRecovery：有结果的不用动，没结果的按策略走', () => {
    const base = {
      id: 'i1',
      agentId: 'a',
      tool: 'Shell',
      operationKey: 'k',
      status: 'started' as const,
      startedAt: 0,
    };
    assert.equal(planRecovery({ ...base, status: 'ok', replayPolicy: 'manual' }).action, 'none');
    assert.equal(planRecovery({ ...base, replayPolicy: 'rerun' }).action, 'rerun');
    assert.equal(planRecovery({ ...base, replayPolicy: 'idempotent' }).action, 'retry');
    assert.equal(planRecovery({ ...base, replayPolicy: 'verify' }).action, 'verify');
    assert.equal(planRecovery({ ...base, replayPolicy: 'manual' }).action, 'manual');
  });
});

describe('回合里的工具记账（E3.5）', () => {
  it('执行前就能看到自己的意图；成功后回填结果与稳定业务键', async () => {
    const env = await tempDataDir('tool-ledger-turn');
    try {
      const fake = new FakeProvider();
      const duringExecution: string[] = [];
      const inspect = defineTool<{ note?: string }>({
        name: 'InspectLedger',
        description: '测试用：执行时看一眼账本里自己那条意图',
        parameters: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
        async execute() {
          const open = await runtime.toolLedger.unfinished();
          duringExecution.push(...open.map((item) => `${item.tool}:${item.status}`));
          return '账本已看过';
        },
      });
      const runtime = new AgentRuntime({
        tools: [inspect],
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

      const turn = runtime.send(agentId, '看看账本');
      await waitFor(() => fake.pendingCount >= 1, '第一次模型调用');
      fake.release(
        0,
        FakeProvider.toolCalls([{ id: 't1', name: 'InspectLedger', arguments: '{"note":"x"}' }]),
      );
      await waitFor(() => fake.pendingCount >= 2, '工具执行完的第二次调用');
      fake.release(1, TEXT);
      await turn;

      assert.deepEqual(duringExecution, ['InspectLedger:started'], '执行前必须先有意图');

      const records = await runtime.toolLedger.list();
      const record = records.find((item) => item.tool === 'InspectLedger')!;
      assert.equal(record.status, 'ok');
      assert.equal(record.agentId, agentId);
      assert.ok(record.runId, '要带回合 id');
      assert.ok(record.treeId, '要带任务树 id');
      assert.equal(record.replayPolicy, 'manual');
      assert.ok((record.resultSummary ?? '').includes('账本已看过'));
      assert.equal(
        record.operationKey,
        operationKeyOf({ agentId, tool: 'InspectLedger', args: '{"note":"x"}' }),
        '业务键要能算出来（恢复时复用）',
      );
    } finally {
      await env.cleanup();
    }
  });

  it('工具报错回填 error，仍留下核对依据', async () => {
    const env = await tempDataDir('tool-ledger-error');
    try {
      const fake = new FakeProvider();
      const broken = defineTool<Record<string, never>>({
        name: 'BrokenTool',
        description: '测试用：永远抛错',
        parameters: { type: 'object', properties: {}, required: [] },
        async execute() {
          throw new Error('磁盘炸了');
        },
      });
      const runtime = new AgentRuntime({
        tools: [broken],
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

      const turn = runtime.send(agentId, '用坏工具');
      await waitFor(() => fake.pendingCount >= 1, '第一次模型调用');
      fake.release(0, FakeProvider.toolCalls([{ id: 't1', name: 'BrokenTool', arguments: '{}' }]));
      await waitFor(() => fake.pendingCount >= 2, '工具报错后的第二次调用');
      fake.release(1, TEXT);
      await turn;

      const record = (await runtime.toolLedger.list()).find((item) => item.tool === 'BrokenTool')!;
      assert.equal(record.status, 'error');
      assert.ok((record.error ?? '').includes('磁盘炸了'));
      assert.equal((await runtime.toolLedger.unfinished()).length, 0);
    } finally {
      await env.cleanup();
    }
  });
});

describe('真实进程强退后的核对依据（E3.5）', () => {
  const fixture = fileURLToPath(new URL('./fixtures/invocation-and-crash.ts', import.meta.url));

  it('记了意图没回填结果：重开存储照样看得到，且分类为「先核对」', async () => {
    const env = await tempDataDir('tool-ledger-crash');
    try {
      const crashed = spawnSync(process.execPath, ['--import', 'tsx', fixture, env.dir, 'kid'], {
        encoding: 'utf8',
        cwd: process.cwd(),
      });
      assert.equal(crashed.status, 0, crashed.stderr);

      const reopened = new JsonToolInvocationLedger(env.dir);
      const open = await reopened.unfinished();
      assert.equal(open.length, 1, '有意图没结果的调用必须留着');
      assert.equal(open[0]!.tool, 'Shell');
      assert.equal(open[0]!.agentId, 'kid');
      assert.equal(open[0]!.replayPolicy, 'manual');

      const plan = planRecovery(open[0]!);
      assert.equal(plan.action, 'manual', 'shell 不许盲目重跑');
      assert.ok(plan.reason.includes('问用户'));
    } finally {
      await env.cleanup();
    }
  });
});
