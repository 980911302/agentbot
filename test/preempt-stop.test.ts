import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { FakeProvider } from './fakes/fake-provider.js';
import { until, waitFor } from './fakes/test-env.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AgentInbox } from '../src/agent/inbox.js';
import type { LLMMessage, LLMResponse } from '../src/llm/provider.js';
import { InteractionBroker } from '../src/interaction/broker.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { buildRoomBrief } from '../src/room/turn.js';
import { defineTool } from '../src/tools/tool.js';

type Pending = {
  resolve: (response: LLMResponse) => void;
  signal?: AbortSignal;
  messages: LLMMessage[];
};

const TEXT: LLMResponse = { content: '完成', toolCalls: [], finishReason: 'stop', usage: null };

describe('插话抢占式调度（见 docs/架构设计.md「插话、停止和等待」）', () => {
  let dir: string;
  let fake: FakeProvider;
  let runtime: AgentRuntime;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'preempt-'));
    fake = new FakeProvider();
    runtime = new AgentRuntime({
      tools: [],
      createProvider: () => fake,
      dataDir: dir,
      defaultModel: 'fake',
      knownModels: ['fake'],
      budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
      memoryExtraction: false,
      seed: [{ name: '测试员', color: '#a855f7', instructions: '测试' }],
    });
    await runtime.ensureDefaultAgent();
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('忙时新句不 409：旧的挂起、新句先跑、结束后补跑旧活', async () => {
    const agentId = (await runtime.registry.list())[0]!.id;

    const first = runtime.send(agentId, '任务一');
    await waitFor(() => fake.pendingCount >= 1, '第一次模型调用');

    const second = runtime.send(agentId, '任务二');
    await waitFor(() => fake.pendingCount >= 2, '第二次模型调用（新句立即开回合）');

    // 放行新句 → 完成
    fake.release(1, TEXT);
    const secondResult = await second;
    assert.equal(secondResult.stopReason, 'final_answer');

    // 旧回合收到 abort → parked；随后运行时自动补跑（出现第三次调用，带「续」）
    await waitFor(() => fake.pendingCount >= 3, '欠账补跑的模型调用');
    const resumeCall = fake.calls[2]!;
    const resumeText = JSON.stringify(resumeCall);
    assert.ok(resumeText.includes('任务一'), '续跑简报要带原任务原文');

    fake.release(2, TEXT);
    const firstResult = await first;
    assert.equal(firstResult.stopReason, 'parked');

    await until(async () => {
      const raw = JSON.parse(await readFile(join(dir, 'runs', 'ledger.json'), 'utf8')) as {
        trees: Array<{ agentId: string; status: string }>;
      };
      return raw.trees
        .filter((tree) => tree.agentId === agentId)
        .every((tree) => tree.status === 'completed');
    }, '原回合和续跑回合的任务树都已收口');

    // 续跑正常完成后不再出现新的调用
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(fake.pendingCount, 3, '不应继续补跑');
  });
});

describe('停止令（见 docs/架构设计.md「插话、停止和等待」）', () => {
  let dir: string;
  let fake: FakeProvider;
  let runtime: AgentRuntime;
  let inbox: AgentInbox;
  let broker: InteractionBroker;
  let agentId: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stop-'));
    fake = new FakeProvider();
    broker = new InteractionBroker();
    const delegate = defineTool<Record<string, never>>({
      name: 'delegate',
      description: '测试用：派活给 kid 并记账',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args, context) {
        context.turnState?.registerChild?.({ agentId: 'kid', via: 'dm' });
        return '已派给 kid';
      },
    });
    inbox = new AgentInbox(dir);
    runtime = new AgentRuntime({
      tools: [delegate],
      createProvider: () => fake,
      dataDir: dir,
      defaultModel: 'fake',
      knownModels: ['fake'],
      budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
      memoryExtraction: false,
      stopAckTimeoutMs: 300,
      broker,
      seed: [{ name: '测试员', color: '#a855f7', instructions: '测试' }],
    });
    await runtime.ensureDefaultAgent();
    agentId = (await runtime.registry.list())[0]!.id;
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('派活记账：回合里 delegate 过的同事进了任务树', async () => {
    const turn = runtime.send(agentId, '派个活');
    await waitFor(() => fake.pendingCount >= 1, '第一次模型调用');
    fake.release(0, {
      content: null,
      toolCalls: [{ id: 't1', name: 'delegate', arguments: '{}' }],
      finishReason: 'tool_calls',
      usage: null,
    });
    await waitFor(() => fake.pendingCount >= 2, '第二次模型调用');
    fake.release(1, TEXT);
    const result = await turn;
    assert.equal(result.stopReason, 'final_answer');

    // 发停止令：dm 下级应该收到 kind=stop 的紧急件
    const stopResult = await runtime.send(agentId, '停');
    assert.equal(stopResult.stopReason, 'stopped');
    const kidInbox = await inbox.peek('kid');
    assert.equal(kidInbox.length, 1);
    assert.equal(kidInbox[0]!.kind, 'stop');
    assert.equal(kidInbox[0]!.priority, true);
  });

  it('停止令撞上正在跑的用户回合：立即撤销，不等模型自然完成', async () => {
    const callIndex = fake.calls.length;
    const busy = runtime.send(agentId, '一件长活');
    await waitFor(() => fake.calls.length > callIndex, '长活开始');

    const stopResult = await runtime.send(agentId, '停');
    assert.equal(stopResult.stopReason, 'stopped');
    const busyResult = await busy;
    assert.notEqual(busyResult.stopReason, 'final_answer');
  });

  it('空闲时停止：回「在停/停完了」，没有树也照常收场', async () => {
    const before = (await inbox.peek('kid')).length;
    const result = await runtime.send(agentId, 'stop');
    assert.equal(result.stopReason, 'stopped');
    assert.equal((await inbox.peek('kid')).length, before, '没派新活，不再新增停止件');
  });

  it('用户新句作废未回答的选项卡', async () => {
    const asking = broker.request({
      kind: 'choice',
      question: '选哪个？',
      options: [{ value: 'a', label: 'A' }],
      agentId,
      agentName: '测试员',
    });
    assert.equal(broker.list({ agentId }).length, 1);

    // 先挂上拒绝预期再发消息：取消发生在 send 内部
    const rejected = assert.rejects(asking, (error: unknown) =>
      /没有回答|取消/.test(String(error)),
    );
    const callIndex = fake.calls.length;
    const turn = runtime.send(agentId, '换个话题');
    await waitFor(() => fake.calls.length > callIndex, '新回合开始');
    fake.release(callIndex, TEXT);
    await turn;
    await rejected;
    assert.equal(broker.list({ agentId }).length, 0);
  });
});

describe('群里的停止令（§3：下一轮才看见）', () => {
  it('被点名者简报带停止行，且要求确认', () => {
    const brief = buildRoomBrief({
      roomName: '测试群',
      members: [
        { id: 'self', name: '测试运维' },
        { id: 'other', name: '知识库服务' },
      ],
      selfId: 'self',
      speaker: '主人',
      summoned: true,
      everyone: false,
      postLimit: 3,
      stopRequested: true,
    });
    assert.ok(brief.includes('停止令'));
    assert.ok(brief.includes('先停下手上的活'));
  });

  it('普通回合简报不含停止行', () => {
    const brief = buildRoomBrief({
      roomName: '测试群',
      members: [{ id: 'self', name: '测试运维' }],
      selfId: 'self',
      speaker: '主人',
      summoned: false,
      everyone: false,
      postLimit: 3,
    });
    assert.ok(!brief.includes('停止令'));
  });
});
