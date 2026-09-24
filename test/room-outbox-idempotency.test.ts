import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

describe('群 outbox 幂等投影', () => {
  it('同一逻辑动作重试只保留一条时间线和固定成员投递', async () => {
    const env = await tempDataDir('room-outbox-idempotency');
    try {
      const runtime = new AgentRuntime({
        tools: [],
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
      });
      const a = await runtime.registry.create({ name: '甲' });
      const b = await runtime.registry.create({ name: '乙' });
      const c = await runtime.registry.create({ name: '丙' });
      const room = await runtime.rooms.create({ name: '群', memberIds: [a.id, b.id, c.id] });
      const send = runtime.tools.find((tool) => tool.name === 'SendToAgent')!;
      const context = {
        agentId: a.id,
        projectIds: [],
        authorization: {
          ticketId: 'ticket', agentId: a.id, runId: 'run', taskId: 'task', inputId: 'input-1', chainId: 'chain-1',
          generation: 0, executionEpoch: 0, processEpoch: runtime.activation.processEpoch, admittedSeq: 1,
          source: 'user' as const, state: 'running' as const,
        },
        turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 }, acceptedDeliveryRefs: [] as string[] },
      };
      await send.execute({ target_id: room.id, message: '@乙 检查', priority: true }, context);
      const firstTimeline = await runtime.rooms.messages(room.id);
      const firstB = await runtime.inbox.peek(b.id);
      const firstC = await runtime.inbox.peek(c.id);
      await send.execute({ target_id: room.id, message: '@乙 检查', priority: true }, context);
      const secondTimeline = await runtime.rooms.messages(room.id);
      const secondB = await runtime.inbox.peek(b.id);
      const secondC = await runtime.inbox.peek(c.id);
      assert.equal(secondTimeline.length, firstTimeline.length);
      assert.equal(secondB.length, firstB.length);
      assert.equal(secondC.length, firstC.length);
      assert.equal(secondTimeline[0]?.id, firstTimeline[0]?.id);
      assert.equal(secondB[0]?.id, firstB[0]?.id);
      assert.equal(secondC[0]?.id, firstC[0]?.id);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });
});
