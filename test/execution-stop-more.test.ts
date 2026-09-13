import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentInbox } from '../src/agent/inbox.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, waitFor } from './fakes/test-env.js';
import { defineTool } from '../src/tools/tool.js';

describe('停止协议补充（A03/A08/A11/A12）', () => {
  it('同 commandId 重复 stop 同一 stopId，generation 只加一次', async () => {
    const env = await tempDataDir('stop-idempotent');
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
      const agent = (await runtime.ensureDefaultAgent());
      const first = await runtime.requestAgentStop(agent.id, 'stop-dup');
      const second = await runtime.requestAgentStop(agent.id, 'stop-dup');
      assert.equal(first.stopId, second.stopId);
      assert.equal(runtime.controlView(agent.id).generation, 1);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('已 claim 未进模型时 stop：不调用模型，失败次数不增加', async () => {
    const env = await tempDataDir('stop-claimed');
    try {
      const fake = new FakeProvider();
      const runtime = new AgentRuntime({
        tools: [],
        createProvider: () => fake,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [{ name: '甲', color: '#a855f7', instructions: '测' }],
      });
      const agent = await runtime.ensureDefaultAgent();
      const inbox = new AgentInbox(env.dir);
      await inbox.enqueue({
        toAgentId: agent.id,
        fromAgentId: 'peer',
        fromName: '乙',
        text: '积压信',
        priority: false,
        depth: 0,
      });
      await inbox.claim(agent.id, { owner: 'test', leaseMs: 60_000, maxAttempts: 3 });
      await runtime.send(agent.id, '停');
      const before = fake.calls.length;
      await runtime.drainInbox(agent.id);
      assert.equal(fake.calls.length, before);
      const remaining = await inbox.peek(agent.id);
      assert.ok(remaining.every((item) => (item.attempts ?? 0) === 0));
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('独立同事不被本地 stop 级联取消', async () => {
    const env = await tempDataDir('stop-independent');
    try {
      const fake = new FakeProvider({ auto: () => FakeProvider.text('同事还在') });
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
      await runtime.ensureDefaultAgent();
      const agents = await runtime.registry.list();
      const a = agents.find((item) => item.name === '甲')!;
      const b = agents.find((item) => item.name === '乙')!;
      await runtime.send(a.id, '停');
      const peer = await runtime.send(b.id, '还在吗');
      assert.equal(peer.stopReason, 'final_answer');
      assert.equal(runtime.controlView(b.id).autoActivation, 'enabled');
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('Task 工人在 stop 时被取消', async () => {
    const env = await tempDataDir('stop-worker');
    try {
      let killed = false;
      const spawn = defineTool<Record<string, never>>({
        name: 'Spawn',
        description: '派工人',
        parameters: { type: 'object', properties: {}, required: [] },
        async execute(_args, context) {
          context.turnState?.registerJob?.(() => { killed = true; }, 'worker:test');
          return '已派';
        },
      });
      const fake = new FakeProvider();
      const runtime = new AgentRuntime({
        tools: [spawn],
        createProvider: () => fake,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [{ name: '甲', color: '#a855f7', instructions: '测' }],
      });
      const agent = await runtime.ensureDefaultAgent();
      const turn = runtime.send(agent.id, '派个工人');
      await waitFor(() => fake.pendingCount >= 1, '模型开始');
      fake.release(0, {
        content: null,
        toolCalls: [{ id: 't1', name: 'Spawn', arguments: '{}' }],
        finishReason: 'tool_calls',
        usage: null,
      });
      await waitFor(() => fake.pendingCount >= 2, '工具后下一轮');
      await runtime.send(agent.id, '停');
      await turn.catch(() => undefined);
      assert.equal(killed, true);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });
});
