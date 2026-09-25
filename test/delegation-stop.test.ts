import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { createAgentServer } from '../src/server/http.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { defineTool } from '../src/tools/tool.js';
import { canTransitionDelegation, isReplyToDelegation, type Delegation } from '../src/work/delegation.js';
import { DelegationService } from '../src/work/delegation-service.js';
import { JsonDelegationRepository } from '../src/work/delegation-store.js';
import type { WorkWait } from '../src/work/wait.js';
import { agentWaitKey } from '../src/work/wait.js';
import { WaitService } from '../src/work/wait-service.js';
import { JsonWorkWaitRepository } from '../src/work/wait-store.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, until, waitFor } from './fakes/test-env.js';

/**
 * E4.4 精确委派关系与按范围停止（docs/架构设计.md §7.1）。
 *
 * 覆盖三条：委派记录 parentWorkId/childWorkId/correlationId；停止按
 * `cancelId + childWorkId` 下发、按唯一 `(cancelId, childWorkId)` 去重回执；
 * 部分下级超时未回时如实显示 `needs_attention` 与未确认对象。
 * 另含上游交接：回复线程键让「一封回信只满足对应那一次等待」。
 */

const DELEGATE_MARKER = '帮我查一下接口实现情况';
const DELEGATE_TWO_MARKER = '帮我核对两个服务的接口实现情况';
const LOG_MARKER = '把日志从头翻一遍并写出结论';
const HANG_MARKER = '把这件事做完并写出报告结论';
const DELEGATED_TEXT = '请把接口实现核对一遍并给我结论';

/** 只用来让回合撞上 max_iterations：把同事自己的独立树留成 incomplete */
const noopTool = defineTool<Record<string, never>>({
  name: 'Noop',
  description: '测试用：什么都不做',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: () => 'noop',
});

function lastUserText(messages: Array<{ role: string; content: unknown }>): string {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

async function readTrees(dir: string): Promise<Array<{ agentId: string; id: string; status: string }>> {
  const raw = JSON.parse(await readFile(join(dir, 'runs', 'ledger.json'), 'utf8')) as {
    trees: Array<{ agentId: string; id: string; status: string }>;
  };
  return raw.trees ?? [];
}

/** 委派域的单测：不需要运行时 */
async function makeDelegationService(dataDir: string): Promise<DelegationService> {
  const repository = new JsonDelegationRepository(dataDir);
  await repository.load();
  return new DelegationService({ repository });
}

function baseDelegation(partial: Partial<Delegation> = {}): Delegation {
  return {
    id: 'd1',
    fromAgentId: 'a',
    toAgentId: 'b',
    correlationId: 'd1',
    status: 'sent',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('委派关系（E4.4）', () => {
  it('状态机：sent → accepted → replied；终态不可回退', () => {
    assert.equal(canTransitionDelegation('sent', 'accepted'), true);
    assert.equal(canTransitionDelegation('sent', 'cancelled'), true);
    assert.equal(canTransitionDelegation('accepted', 'replied'), true);
    assert.equal(canTransitionDelegation('accepted', 'cancelled'), true);
    assert.equal(canTransitionDelegation('replied', 'accepted'), false);
    assert.equal(canTransitionDelegation('cancelled', 'replied'), false);
    assert.equal(canTransitionDelegation('accepted', 'sent'), false);
  });

  it('只有反方向的信才算这条委派的回信', () => {
    const delegation = baseDelegation();
    assert.equal(isReplyToDelegation(delegation, { callerId: 'b', targetId: 'a', threadId: 'd1' }), true);
    // 线程对上但方向不对：不是回信
    assert.equal(isReplyToDelegation(delegation, { callerId: 'a', targetId: 'b', threadId: 'd1' }), false);
    assert.equal(isReplyToDelegation(delegation, { callerId: 'b', targetId: 'c', threadId: 'd1' }), false);
    assert.equal(isReplyToDelegation(delegation, { callerId: 'b', targetId: 'a' }), false);
  });

  it('派活记账幂等；childWorkId 只回填在还没终结的委派上', async () => {
    const env = await tempDataDir('delegation-service');
    try {
      const service = await makeDelegationService(env.dir);
      const first = await service.recordOutbound({
        id: 'd1',
        fromAgentId: 'a',
        toAgentId: 'b',
        parentWorkId: 'w-a',
        requestMessageId: 'd1',
      });
      assert.equal(first.correlationId, 'd1', '线程键就是请求信投递 id');
      assert.equal(first.status, 'sent');
      // 同一封信重试：不新建、不改状态
      const again = await service.recordOutbound({ id: 'd1', fromAgentId: 'a', toAgentId: 'b' });
      assert.equal(again.createdAt, first.createdAt);
      assert.equal((await service.listFrom('a')).length, 1);

      await service.markAccepted('d1');
      await service.attachChildWork('d1', 'w-b');
      const filled = await service.get('d1');
      assert.equal(filled?.childWorkId, 'w-b');
      assert.equal(filled?.status, 'accepted');
      assert.equal((await service.listOpenFrom('a')).length, 1, '未终结的委派仍在开放列表');

      // 回信闭环后再回填：终态不可回退，childWorkId 不被改写
      await service.markReplied('d1');
      await service.attachChildWork('d1', 'w-other');
      const closed = await service.get('d1');
      assert.equal(closed?.status, 'replied');
      assert.equal(closed?.childWorkId, 'w-b');
      assert.equal((await service.listOpenFrom('a')).length, 0);
      await assert.rejects(
        () => service.markAccepted('d1'),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'DELEGATION_ALREADY_CLOSED');
          return true;
        },
      );
    } finally {
      await env.cleanup();
    }
  });
});

// ── 验收 1：停 A 的委派不影响 B 的独立工作 ─────────────────────

describe('验收 1：停 A 的委派不影响 B 的独立工作（E4.4）', () => {
  it('只取消被派的那件活；B 的独立任务树与独立工作原样保留', async () => {
    const env = await tempDataDir('delegation-scope');
    try {
      let dispatched = 0;
      const fake = new FakeProvider({
        auto: (messages) => {
          const text = lastUserText(messages);
          // 乙自己的活：一直调工具，撞上 maxIterations → 独立树留在 incomplete
          if (text.includes(LOG_MARKER)) {
            return FakeProvider.toolCalls([{ id: 'n1', name: 'Noop', arguments: '{}' }]);
          }
          // 只派一次：模型看到工具结果后仍会看到同一句用户消息，不加计数会一直派
          if (text.includes(DELEGATE_MARKER) && dispatched++ === 0) {
            return FakeProvider.toolCalls([
              {
                id: 's1',
                name: 'SendToAgent',
                arguments: JSON.stringify({ target_id: '乙', message: DELEGATED_TEXT }),
              },
            ]);
          }
          return FakeProvider.text('好。');
        },
      });
      const runtime = new AgentRuntime({
        tools: [noopTool],
        createProvider: () => fake,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        maxIterations: 4,
        stopAckTimeoutMs: 1500,
        seed: [
          { name: '甲', color: '#a855f7', instructions: '测' },
          { name: '乙', color: '#30d158', instructions: '测' },
        ],
      });
      try {
        await runtime.ensureDefaultAgent();
        const agents = await runtime.registry.list();
        const a = agents.find((item) => item.name === '甲')!;
        const b = agents.find((item) => item.name === '乙')!;
        await runtime.recover();

        // 乙先接下一件与甲无关的活：回合撞 max_iterations，树留在 incomplete
        const independent = await runtime.send(b.id, `${LOG_MARKER}，给我一份结论`);
        assert.equal(independent.stopReason, 'max_iterations');
        const bIncomplete = (await readTrees(env.dir)).filter(
          (tree) => tree.agentId === b.id && tree.status === 'incomplete',
        );
        assert.equal(bIncomplete.length, 1, '乙有一棵独立未完成的树');
        const bIndependentWork = await runtime.works.openWorkOf(b.id);
        assert.ok(bIndependentWork, '乙的独立工作已记账');

        // 甲把活派给乙：委派 + 「等乙回信」的等待
        const aTurn = await runtime.send(a.id, DELEGATE_MARKER);
        assert.equal(aTurn.stopReason, 'final_answer');
        await until(
          async () =>
            (await runtime.delegations.listFrom(a.id))[0]?.status === 'accepted' &&
            Boolean((await runtime.delegations.listFrom(a.id))[0]?.childWorkId),
          '乙接下了委派并为它开了专属工作',
        );
        const delegation = (await runtime.delegations.listFrom(a.id))[0]!;
        assert.equal(delegation.fromAgentId, a.id);
        assert.equal(delegation.toAgentId, b.id);
        assert.ok(delegation.parentWorkId, '记下了发起方那件工作');
        assert.ok(delegation.childWorkId, '记下了收件方为委派开的专属工作');
        assert.equal(delegation.correlationId, delegation.id, '停止与唤醒共用同一个线程键');
        assert.notEqual(delegation.childWorkId, bIndependentWork?.id, '委派工作不能接在乙的独立工作上');
        const waiting = (await runtime.waits.listPending({ agentId: a.id, kind: 'agent' })).find(
          (wait) => wait.threadId === delegation.id,
        );
        assert.ok(waiting, '等待记到了「哪一次请求」');

        // 用户停甲：只该停甲派出去的那条委派
        await new Promise((resolve) => setTimeout(resolve, 5));
        const stopResult = await runtime.send(a.id, '停');
        assert.equal(stopResult.stopReason, 'stopped');
        const stopId = runtime.controlView(a.id).lastStopId;
        assert.ok(stopId, '停止生成了 StopOperation');

        await until(
          async () => (await runtime.delegations.get(delegation.id))?.status === 'cancelled',
          '委派被精确取消',
        );
        await until(
          async () => (await runtime.works.get(delegation.childWorkId!))?.status === 'cancelled',
          '被派的那件工作随委派停掉',
        );

        // 关键差异：乙的独立树与独立工作不受牵连
        const treesAfter = await readTrees(env.dir);
        assert.equal(
          treesAfter.find((tree) => tree.id === bIncomplete[0]!.id)?.status,
          'incomplete',
          '乙的独立任务树不能因为停甲的委派被取消',
        );
        assert.notEqual(
          (await runtime.works.get(bIndependentWork!.id))?.status,
          'cancelled',
          '乙的独立工作不能被连坐',
        );
        assert.equal(runtime.controlView(b.id).autoActivation, 'enabled', '乙的自动准入状态不受影响');
        assert.equal(
          (await runtime.waits.listPending({ agentId: a.id, kind: 'agent' })).length,
          0,
          '这条委派的等待随停止一起作废',
        );
        // 乙确认了停止：本次停止是 settled，不是 needs_attention
        const operation = runtime.stopOperation(stopId!);
        assert.equal(operation?.state, 'settled');
        assert.equal(operation?.pendingAcks, undefined);
        assert.ok(
          (await runtime.messages.list(a.id)).some(
            (message) => message.content.type === 'text' && message.content.text.includes('停完了'),
          ),
          '全部确认后才说「停完了」',
        );

        // 反证：这棵树确实是「整人停止令」的合法靶子——保住它靠的是精确作用域，
        // 不是它本身停不了。没有这条对照，上面的断言可能只是碰巧成立。
        await runtime.inbox.enqueue({
          toAgentId: b.id,
          fromAgentId: a.id,
          fromName: '甲',
          text: '停止令：把手上正在做的活停掉。',
          priority: true,
          depth: 0,
          kind: 'stop',
        });
        await until(
          async () =>
            (await readTrees(env.dir)).find((tree) => tree.id === bIncomplete[0]!.id)?.status === 'cancelled',
          '整人停止令会取消这棵树（对照）',
        );
      } finally {
        await runtime.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});

// ── 验收 2：部分下级超时未回 stop-ack ──────────────────────────

describe('验收 2：部分下级超时未回 stop-ack（E4.4）', () => {
  it('状态 needs_attention 并列出未确认对象；迟到回执把状态更新掉', async () => {
    const env = await tempDataDir('delegation-partial-ack');
    try {
      let hangCount = 0;
      let dispatched = 0;
      let releaseHang: (() => void) | undefined;
      const fake = new FakeProvider({
        auto: (messages, { signal }) => {
          const text = lastUserText(messages);
          if (text.includes(HANG_MARKER)) {
            hangCount += 1;
            // 丙正在服务用户的回合：挂住不放，直到测试放行或运行时 abort
            return new Promise((resolve, reject) => {
              releaseHang = () => resolve(FakeProvider.text('做完了。'));
              signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
          }
          if (text.includes(DELEGATE_TWO_MARKER) && dispatched++ === 0) {
            return FakeProvider.toolCalls([
              {
                id: 's1',
                name: 'SendToAgent',
                arguments: JSON.stringify({ target_id: '乙', message: DELEGATED_TEXT }),
              },
              {
                id: 's2',
                name: 'SendToAgent',
                arguments: JSON.stringify({
                  target_id: '丙',
                  message: '请把部署脚本核对一遍并给我结论',
                }),
              },
            ]);
          }
          return FakeProvider.text('好。');
        },
      });
      const runtime = new AgentRuntime({
        tools: [noopTool],
        createProvider: () => fake,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        maxIterations: 3,
        stopAckTimeoutMs: 500,
        seed: [
          { name: '甲', color: '#a855f7', instructions: '测' },
          { name: '乙', color: '#30d158', instructions: '测' },
          { name: '丙', color: '#ff9f0a', instructions: '测' },
        ],
      });
      try {
        await runtime.ensureDefaultAgent();
        const agents = await runtime.registry.list();
        const a = agents.find((item) => item.name === '甲')!;
        const b = agents.find((item) => item.name === '乙')!;
        const c = agents.find((item) => item.name === '丙')!;
        await runtime.recover();

        await runtime.send(a.id, DELEGATE_TWO_MARKER);
        await until(async () => {
          const list = await runtime.delegations.listFrom(a.id);
          return list.length === 2 && list.every((item) => item.status === 'accepted' && item.childWorkId);
        }, '乙丙都接下了委派');
        const delegations = await runtime.delegations.listFrom(a.id);
        assert.equal(delegations.length, 2);
        const toB = delegations.find((item) => item.toAgentId === b.id)!;
        const toC = delegations.find((item) => item.toAgentId === c.id)!;
        assert.ok(toB.childWorkId && toC.childWorkId);

        // 丙正忙着服务用户的回合：停止令只能排队，回执不会来
        void runtime.send(c.id, `${HANG_MARKER}，别分心`).catch(() => undefined);
        await waitFor(() => hangCount >= 1, '丙的用户回合已经在跑');
        await new Promise((resolve) => setTimeout(resolve, 5));

        const stopResult = await runtime.send(a.id, '停');
        assert.equal(stopResult.stopReason, 'stopped');
        assert.match(stopResult.content, /仍有 1 项未确认/, '不许说「全部停了」');
        const stopId = runtime.controlView(a.id).lastStopId!;
        const afterTimeout = runtime.stopOperation(stopId);
        assert.equal(afterTimeout?.state, 'needs_attention');
        assert.deepEqual(
          afterTimeout?.pendingAcks,
          [toC.childWorkId],
          '未确认对象要如实列出，且只有没回执的那个',
        );
        assert.ok(
          (await runtime.messages.list(a.id)).some(
            (message) => message.content.type === 'text' && message.content.text.includes('未确认'),
          ),
        );
        // 回了回执的乙已经落定
        await until(
          async () => (await runtime.works.get(toB.childWorkId!))?.status === 'cancelled',
          '乙的那件已经停掉',
        );

        // 迟到的回执：丙的回合结束、停止令被处理，状态从 needs_attention 更新掉
        releaseHang?.();
        await until(async () => runtime.stopOperation(stopId)?.state === 'settled', '迟到回执更新状态');
        assert.equal(runtime.stopOperation(stopId)?.pendingAcks, undefined);
        await until(
          async () => (await runtime.works.get(toC.childWorkId!))?.status === 'cancelled',
          '丙的那件这时也停了',
        );
      } finally {
        await runtime.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});

// ── 上游交接：回复线程键让唤醒也精确 ───────────────────────────

describe('精确唤醒：一封回信只满足对应那一次等待（E4.4）', () => {
  it('线程键命中的等待才被解决；对不上的线程不猜，旧信只在唯一等待时认', async () => {
    const env = await tempDataDir('delegation-reply-thread');
    try {
      let dispatched = 0;
      const fake = new FakeProvider({
        auto: (messages) => {
          const text = lastUserText(messages);
          if (text.includes(DELEGATE_MARKER) && dispatched < 2) {
            dispatched += 1;
            return FakeProvider.toolCalls([
              {
                id: `s${dispatched}`,
                name: 'SendToAgent',
                arguments: JSON.stringify({
                  target_id: '乙',
                  message: `${DELEGATED_TEXT}（第 ${dispatched} 件）`,
                }),
              },
            ]);
          }
          return FakeProvider.text('好。');
        },
      });
      const runtime = new AgentRuntime({
        tools: [],
        createProvider: () => fake,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [
          { name: '甲', color: '#a855f7', instructions: '测' },
          { name: '乙', color: '#30d158', instructions: '测' },
        ],
      });
      try {
        await runtime.ensureDefaultAgent();
        const agents = await runtime.registry.list();
        const a = agents.find((item) => item.name === '甲')!;
        const b = agents.find((item) => item.name === '乙')!;
        await runtime.recover();

        // 甲向乙派两件活：两条委派、两条等待，关联键相同但线程键不同
        await runtime.send(a.id, `${DELEGATE_MARKER}并把结论发我`);
        await runtime.send(a.id, `${DELEGATE_MARKER}，另外把部署脚本也核一遍`);
        await until(async () => (await runtime.delegations.listFrom(a.id)).length === 2, '两条委派都记账');
        const pendingBefore = await runtime.waits.listPending({ agentId: a.id, kind: 'agent' });
        assert.equal(pendingBefore.length, 2);
        assert.equal(pendingBefore[0]!.correlationId, pendingBefore[1]!.correlationId, '等的都是同一位同事');
        assert.notEqual(pendingBefore[0]!.threadId, pendingBefore[1]!.threadId, '线程键区分哪一次请求');
        const [first, second] = pendingBefore.sort((left, right) => left.createdAt - right.createdAt);

        // 乙回第一件：只有那一条等待被满足
        await runtime.inbox.enqueue({
          toAgentId: a.id,
          fromAgentId: b.id,
          fromName: '乙',
          text: '第一件好了。',
          priority: false,
          depth: 1,
          kind: 'message',
          correlationId: first!.threadId!,
        });
        await runtime.drainInbox(a.id);
        await until(
          async () => (await runtime.waits.get(first!.id))?.status === 'resolved',
          '对应那次等待被解决',
        );
        assert.equal((await runtime.waits.get(second!.id))?.status, 'pending', '另一件照旧在等');
        assert.equal((await runtime.delegations.get(first!.threadId!))?.status, 'replied', '委派随回信闭环');

        // 线程对不上：不猜（这就是「停/唤醒不误伤别的独立工作」的另一面）
        await runtime.inbox.enqueue({
          toAgentId: a.id,
          fromAgentId: b.id,
          fromName: '乙',
          text: '这是一封对不上线程的信。',
          priority: false,
          depth: 1,
          kind: 'message',
          correlationId: 'thread-does-not-exist',
        });
        await runtime.drainInbox(a.id);
        assert.equal((await runtime.waits.get(second!.id))?.status, 'pending', '对不上的线程不唤醒任何等待');

        // 旧信（没有线程键）且只剩唯一一条等待：按旧行为认它，不把等待吊死
        await runtime.inbox.enqueue({
          toAgentId: a.id,
          fromAgentId: b.id,
          fromName: '乙',
          text: '第二件也好了。',
          priority: false,
          depth: 1,
          kind: 'message',
        });
        await runtime.drainInbox(a.id);
        await until(
          async () => (await runtime.waits.get(second!.id))?.status === 'resolved',
          '无线程的旧信在唯一等待时仍然接上',
        );
      } finally {
        await runtime.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});

// ── stop-all / room_round：本单明确不做 ────────────────────────

describe('stop-all 与 room_round：明确不做（docs/架构设计.md §7.1）', () => {
  it('HTTP 层如实返回 UNSUPPORTED_STOP_SCOPE，不假装成功', async () => {
    const env = await tempDataDir('delegation-stop-all');
    const server = await createAgentServer({
      port: 0,
      dataDir: env.dir,
      rootDir: process.cwd(),
      allowMissingKey: true,
      createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
    });
    const base = server.url.replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/api/control/stop-all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { code?: string; error?: string };
      assert.equal(body.code, 'UNSUPPORTED_STOP_SCOPE');
      assert.equal(body.error, 'UNSUPPORTED_STOP_SCOPE');
    } finally {
      await server.close();
      await env.cleanup();
    }
  });

  it('room_round 与 all_agents 作用域同样拒绝，而不是只停掉一部分', async () => {
    const env = await tempDataDir('delegation-unsupported-room-round');
    try {
      const runtime = new AgentRuntime({
        tools: [],
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [{ name: '甲', color: '#a855f7', instructions: '测' }],
      });
      try {
        await runtime.ensureDefaultAgent();
        const agent = (await runtime.registry.list())[0]!;
        for (const scope of [
          { kind: 'room_round' as const, roomId: 'r1', roundId: 'round-1' },
          { kind: 'all_agents' as const },
        ]) {
          await assert.rejects(
            () =>
              runtime.activation.requestStop({
                commandId: `unsupported:${scope.kind}`,
                requestedBy: { kind: 'user', id: 'owner' },
                scope,
              }),
            (error: unknown) => {
              assert.equal((error as { code?: string }).code, 'UNSUPPORTED_STOP_SCOPE');
              return true;
            },
          );
        }
        // 该同事完全没被这次拒绝停掉：自动准入保持原样
        assert.equal(runtime.controlView(agent.id).autoActivation, 'enabled');
      } finally {
        await runtime.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});

/** 类型守卫：确认 WorkWait.threadId 是「哪一次请求」而不是关联键本身 */
function assertThreadSeparate(wait: WorkWait): void {
  assert.equal(typeof wait.correlationId, 'string');
  assert.ok(wait.threadId === undefined || wait.threadId !== wait.correlationId);
}

describe('WorkWait 线程键：停止与唤醒共用「哪一次请求」（E4.4）', () => {
  it('等同一同事的两条等待只动对应那一条：按线程取消/解决不误伤', async () => {
    const env = await tempDataDir('wait-thread');
    try {
      const service = new WaitService({ repository: new JsonWorkWaitRepository(env.dir) });
      const first = await service.create({
        agentId: 'a',
        kind: 'agent',
        correlationId: agentWaitKey('b'),
        threadId: 't1',
      });
      const second = await service.create({
        agentId: 'a',
        kind: 'agent',
        correlationId: agentWaitKey('b'),
        threadId: 't2',
      });
      assertThreadSeparate(first);
      assert.equal(first.correlationId, second.correlationId, '等的都是同一位同事');
      assert.equal((await service.listPending({ threadId: 't1' })).length, 1);

      // 停掉 t1 对应的那条委派：只有那一次等待被作废
      const cancelled = await service.cancelByThread('t1', '这条委派被停了');
      assert.deepEqual(
        cancelled.map((wait) => wait.id),
        [first.id],
      );
      assert.equal((await service.get(first.id))?.status, 'cancelled');
      assert.equal((await service.get(second.id))?.status, 'pending');

      // t2 被回信满足：也不影响已经作废的 t1
      await service.resolve(second.id, 'letter:x');
      assert.equal((await service.get(second.id))?.status, 'resolved');
      assert.equal((await service.get(first.id))?.status, 'cancelled');
    } finally {
      await env.cleanup();
    }
  });
});
