import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { AgentInbox } from '../src/agent/inbox.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import type { LLMProvider, LLMMessage } from '../src/llm/provider.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, waitFor } from './fakes/test-env.js';

/**
 * E3.3 投递领取与确认：
 *   领取带执行权与期限 → 处理形成持久检查点 → 确认出队；
 *   失败有限退避，超限进 failed 并可人工重试；
 *   保留每封信的作者与关联。
 */

const TEXT = { content: '收到', toolCalls: [], finishReason: 'stop', usage: null };

function letter(
  toAgentId: string,
  partial: Partial<Parameters<AgentInbox['enqueue']>[0]> = {},
): Parameters<AgentInbox['enqueue']>[0] {
  return {
    toAgentId,
    fromAgentId: 'sender',
    fromName: '张三',
    text: '来信',
    priority: false,
    depth: 1,
    kind: 'message',
    ...partial,
  };
}

describe('投递领取与确认（E3.3）', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });
  const make = async (): Promise<{ dir: string; inbox: AgentInbox }> => {
    const env = await tempDataDir('delivery');
    cleanups.push(env.cleanup);
    return { dir: env.dir, inbox: new AgentInbox(env.dir) };
  };

  it('领取带执行权与期限：活租约挡住第二次领取；确认后出队', async () => {
    const { inbox } = await make();
    const sent = await inbox.enqueue(letter('a', { correlationId: 'tree-1' }));

    const first = await inbox.claim('a', { owner: 'run-1', leaseMs: 60_000, maxAttempts: 3 });
    assert.equal(first.length, 1);
    assert.equal(first[0]!.id, sent.id);
    assert.equal(first[0]!.status, 'claimed');
    assert.equal(first[0]!.leaseOwner, 'run-1');
    assert.equal(first[0]!.correlationId, 'tree-1', '关联要随信保留');
    assert.ok((first[0]!.leaseEpoch ?? 0) >= 1);
    assert.ok((first[0]!.leaseUntil ?? 0) > Date.now());

    // 执行权还在 run-1 手里：别人领不走，也不算可领取
    assert.equal((await inbox.claim('a', { owner: 'run-2', leaseMs: 60_000, maxAttempts: 3 })).length, 0);
    assert.equal(await inbox.count('a'), 1);
    assert.equal(await inbox.claimableCount('a'), 0);

    await inbox.checkpoint('a', [sent.id], { messageId: 'msg-1' });
    assert.equal((await inbox.peek('a'))[0]!.checkpoint?.messageId, 'msg-1');

    assert.equal(await inbox.ack('a', [sent.id]), 1);
    assert.equal(await inbox.count('a'), 0);
    assert.equal((await inbox.peek('a')).length, 0);
    assert.equal((await inbox.claim('a', { owner: 'run-3', leaseMs: 1000, maxAttempts: 3 })).length, 0);
  });

  it('租约过期按一次失败尝试回收；重开存储仍在', async () => {
    const { dir, inbox } = await make();
    await inbox.enqueue(letter('b'));
    const first = await inbox.claim('b', { owner: 'run-1', leaseMs: 1_000, maxAttempts: 3 });
    assert.equal(first.length, 1);

    // 重新打开存储 = 模拟重启：领取状态与期限已经落盘
    const reopened = new AgentInbox(dir);
    const peeked = await reopened.peek('b');
    assert.equal(peeked.length, 1);
    assert.equal(peeked[0]!.status, 'claimed');
    assert.equal(peeked[0]!.leaseOwner, 'run-1');

    // 未到期领不走
    assert.equal((await reopened.claim('b', { owner: 'run-2', leaseMs: 1000, maxAttempts: 3 })).length, 0);

    // 到期回收：算一次失败尝试，换新 owner 与 epoch
    const beforeEpoch = peeked[0]!.leaseEpoch ?? 0;
    const later = (peeked[0]!.leaseUntil ?? 0) + 1;
    const reclaimed = await reopened.claim('b', { owner: 'run-2', leaseMs: 1000, maxAttempts: 3, now: later });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]!.attempts, 1);
    assert.equal(reclaimed[0]!.leaseOwner, 'run-2');
    assert.ok((reclaimed[0]!.lastError ?? '').includes('超时'));
    assert.ok((reclaimed[0]!.leaseEpoch ?? 0) > beforeEpoch);

    await reopened.ack('b', [reclaimed[0]!.id]);
    assert.equal(await reopened.count('b'), 0);
  });

  it('失败有限退避：到点前不领、到点再领；超限进 failed 且可人工重试', async () => {
    const { inbox } = await make();
    const sent = await inbox.enqueue(letter('c'));
    const claimed = await inbox.claim('c', { owner: 'r1', leaseMs: 1000, maxAttempts: 3 });
    const t0 = (claimed[0]!.leaseUntil ?? 0) + 1;

    const first = await inbox.nack('c', [sent.id], '模型超时', { maxAttempts: 3, baseDelayMs: 1000, now: t0 });
    assert.deepEqual(first.pending, [sent.id]);
    const afterFirst = (await inbox.peek('c'))[0]!;
    assert.equal(afterFirst.status, 'pending');
    assert.equal(afterFirst.attempts, 1);
    assert.equal(afterFirst.availableAt, t0 + 1000, '第一次失败等 1 个基数');
    assert.equal(await inbox.claimableCount('c', t0), 0);
    assert.equal(await inbox.claimableCount('c', t0 + 1000), 1);

    await inbox.claim('c', { owner: 'r2', leaseMs: 1000, maxAttempts: 3, now: t0 + 1000 });
    const t1 = t0 + 1000 + 1;
    await inbox.nack('c', [sent.id], '还是失败', { maxAttempts: 3, baseDelayMs: 1000, now: t1 });
    const afterSecond = (await inbox.peek('c'))[0]!;
    assert.equal(afterSecond.attempts, 2);
    assert.equal(afterSecond.availableAt, t1 + 2000, '第二次失败等 2 个基数');

    const t2 = t1 + 2000;
    await inbox.claim('c', { owner: 'r3', leaseMs: 1000, maxAttempts: 3, now: t2 });
    const third = await inbox.nack('c', [sent.id], '第三次失败', { maxAttempts: 3, baseDelayMs: 1000, now: t2 + 1 });
    assert.deepEqual(third.failed, [sent.id]);
    assert.equal(await inbox.failedCount('c'), 1);
    assert.equal(await inbox.count('c'), 0, 'failed 不算未处理');
    assert.equal((await inbox.peek('c')).length, 0);
    assert.equal((await inbox.claim('c', { owner: 'r4', leaseMs: 1000, maxAttempts: 3, now: t2 + 10 })).length, 0);

    // 人工重试：预算重置，回到可领取
    assert.equal(await inbox.retryFailed('c'), 1);
    const retried = await inbox.claim('c', { owner: 'r4', leaseMs: 1000, maxAttempts: 3, now: t2 + 20 });
    assert.equal(retried.length, 1);
    assert.equal(retried[0]!.attempts, 0);
  });

  it('归还领取（忙等非失败原因）不计次', async () => {
    const { inbox } = await make();
    await inbox.enqueue(letter('d'));
    const claimed = await inbox.claim('d', { owner: 'r1', leaseMs: 60_000, maxAttempts: 3 });
    await inbox.release('d', [claimed[0]!.id]);
    const item = (await inbox.peek('d'))[0]!;
    assert.equal(item.status, 'pending');
    assert.equal(item.attempts, 0);
    assert.equal(item.leaseOwner, undefined);
    assert.equal(await inbox.claimableCount('d'), 1);
  });

  it('E3.3 之前的纯数组文件按 pending 读入', async () => {
    const { dir } = await make();
    await mkdir(join(dir, 'inbox'), { recursive: true });
    await writeFile(
      join(dir, 'inbox', 'legacy.json'),
      JSON.stringify([
        {
          id: 'old-1',
          toAgentId: 'legacy',
          fromAgentId: 'a',
          fromName: '旧同事',
          text: '老数据',
          priority: false,
          depth: 0,
          createdAt: 1,
        },
      ]),
      'utf8',
    );
    const legacy = new AgentInbox(dir);
    const items = await legacy.peek('legacy');
    assert.equal(items.length, 1);
    assert.equal(items[0]!.status, 'pending');
    assert.equal(items[0]!.attempts, 0);
    assert.equal((await legacy.claim('legacy', { owner: 'r', leaseMs: 1000, maxAttempts: 3 })).length, 1);
  });
});

describe('真实进程强退后的恢复（E3.3）', () => {
  const fixture = fileURLToPath(new URL('./fixtures/claim-and-crash.ts', import.meta.url));

  const crash = (dir: string, args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', fixture, dir, ...args], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });

  it('领取后强退：领取与期限落盘，到期由新进程回收重做', async () => {
    const env = await tempDataDir('delivery-crash');
    try {
      const crashed = crash(env.dir, ['kid', '60000']);
      assert.equal(crashed.status, 0, crashed.stderr);
      const output = JSON.parse(crashed.stdout.trim().split('\n').pop() ?? '{}') as {
        claimed?: string[];
      };
      assert.equal(output.claimed?.length, 1);

      const reopened = new AgentInbox(env.dir);
      const peeked = await reopened.peek('kid');
      assert.equal(peeked.length, 1, '强退不丢信');
      assert.equal(peeked[0]!.status, 'claimed');
      assert.equal(peeked[0]!.leaseOwner, 'crash-run');

      // 期限未到：救援进程也不能抢
      assert.equal((await reopened.claim('kid', { owner: 'rescue', leaseMs: 1000, maxAttempts: 3 })).length, 0);

      // 期限到了：回收为一次失败尝试，重新可处理
      const later = (peeked[0]!.leaseUntil ?? 0) + 1;
      const reclaimed = await reopened.claim('kid', {
        owner: 'rescue',
        leaseMs: 1000,
        maxAttempts: 3,
        now: later,
      });
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0]!.attempts, 1);
      assert.equal(reclaimed[0]!.text, '这条信要在强退后被找回来');
      await reopened.ack('kid', [reclaimed[0]!.id]);
      assert.equal(await reopened.count('kid'), 0);
    } finally {
      await env.cleanup();
    }
  });

  it('确认后强退：重开不会重复处理', async () => {
    const env = await tempDataDir('delivery-crash-ack');
    try {
      const done = crash(env.dir, ['kid', '60000', 'ack']);
      assert.equal(done.status, 0, done.stderr);
      const output = JSON.parse(done.stdout.trim().split('\n').pop() ?? '{}') as {
        claimed?: string[];
      };
      assert.equal(output.claimed?.length, 1);

      const reopened = new AgentInbox(env.dir);
      assert.equal((await reopened.peek('kid')).length, 0);
      assert.equal(
        (await reopened.claim('kid', { owner: 'rescue', leaseMs: 60_000, maxAttempts: 3 })).length,
        0,
      );
    } finally {
      await env.cleanup();
    }
  });
});

describe('来信回合：保留作者与关联、失败退避重试（E3.3）', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it('多封来信逐封署名，处理后确认出队', async () => {
    const env = await tempDataDir('delivery-runtime');
    cleanups.push(env.cleanup);
    const fake = new FakeProvider();
    const runtime = new AgentRuntime({
      tools: [],
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

    await runtime.inbox.enqueue(letter(agentId, { fromAgentId: 'ops', fromName: '测试运维', text: '登录接口好了', correlationId: 'tree-a' }));
    await runtime.inbox.enqueue(letter(agentId, { fromAgentId: 'kb', fromName: '知识库服务', text: '压测要等今晚', correlationId: 'tree-b' }));

    const draining = runtime.drainInbox(agentId);
    await waitFor(() => fake.pendingCount >= 1, '来信回合开始');
    const prompt = fake.lastCallText();
    assert.ok(prompt.includes('测试运维'), '第一封信的作者要在上下文里');
    assert.ok(prompt.includes('知识库服务'), '第二封信的作者也要在，不能被第一封盖掉');
    fake.release(0, TEXT);
    await draining;

    const batch = (await runtime.messages.list(agentId)).find(
      (message) => message.source === 'agent' && message.content.type === 'text',
    );
    assert.ok(batch, '来信要折成一条消息存进对话线');
    assert.equal(batch.content.type === 'text' && batch.content.text.includes('「测试运维」说：'), true);
    assert.equal(batch.content.type === 'text' && batch.content.text.includes('「知识库服务」说：'), true);
    assert.equal(batch.speaker, '测试运维、知识库服务');
    assert.equal(await runtime.pendingMail(agentId), 0, '处理完的投递要确认出队');
  });

  it('处理失败：有限退避后自动重试成功；检查点在进模型前已写下', async () => {
    const env = await tempDataDir('delivery-retry');
    cleanups.push(env.cleanup);
    let failing = true;
    const provider: LLMProvider = {
      name: 'flaky',
      async chat(_messages: LLMMessage[]) {
        if (failing) throw new Error('模型炸了');
        return { content: '好了', toolCalls: [], finishReason: 'stop', usage: null };
      },
    };
    const runtime = new AgentRuntime({
      tools: [],
      createProvider: () => provider,
      dataDir: env.dir,
      defaultModel: 'flaky',
      knownModels: ['flaky'],
      budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
      memoryExtraction: false,
      deliveryBaseDelayMs: 60,
      deliveryMaxAttempts: 3,
      deliveryLeaseMs: 60_000,
      seed: [{ name: '测试员', color: '#a855f7', instructions: '测试' }],
    });
    await runtime.ensureDefaultAgent();
    const agentId = (await runtime.registry.list())[0]!.id;
    await runtime.inbox.enqueue(letter(agentId, { fromName: '测试运维', text: '麻烦跟进一下' }));

    await assert.rejects(runtime.drainInbox(agentId), /模型炸了/);
    const failedAttempt = (await runtime.inbox.peek(agentId))[0]!;
    assert.equal(failedAttempt.status, 'pending', '失败退回不是丢弃');
    assert.equal(failedAttempt.attempts, 1);
    assert.equal(failedAttempt.checkpoint?.messageId !== undefined, true, '进模型前要有持久检查点');
    assert.ok((failedAttempt.lastError ?? '').includes('模型炸了'));

    // 退避期内不重复开回合
    assert.equal(await runtime.drainInbox(agentId), null);

    await waitFor(() => Date.now() >= (failedAttempt.availableAt ?? 0), '退避结束');
    failing = false;
    const retried = await runtime.drainInbox(agentId);
    assert.equal(retried?.stopReason, 'final_answer');
    assert.equal(await runtime.pendingMail(agentId), 0);
    assert.equal(await runtime.failedMail(agentId), 0);
  });

  it('自增 epoch 与停留时间：领取换手后 epoch 前进', async () => {
    const env = await tempDataDir('delivery-epoch');
    cleanups.push(env.cleanup);
    const inbox = new AgentInbox(env.dir);
    await inbox.enqueue(letter('e'));
    const first = await inbox.claim('e', { owner: 'r1', leaseMs: 10, maxAttempts: 3 });
    const firstEpoch = first[0]!.leaseEpoch ?? 0;
    const second = await inbox.claim('e', { owner: 'r2', leaseMs: 10, maxAttempts: 3, now: Date.now() + 100 });
    assert.equal(second.length, 1);
    assert.ok((second[0]!.leaseEpoch ?? 0) > firstEpoch);
  });
});
