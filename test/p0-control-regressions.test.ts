import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, waitFor } from './fakes/test-env.js';
import { createSendToUserTool } from '../src/tools/builtin/send-to-user.js';
import { InteractionBroker } from '../src/interaction/broker.js';
import { SecretStore } from '../src/secret/store.js';
import { ArtifactService } from '../src/tools/services/artifact-service.js';

describe('P0 回归：ticket 结算、inbox 授权、假发送', () => {
  it('用户回合结束后 ticket 必须 settled，同事来信仍可处理', async () => {
    const env = await tempDataDir('p0-settle');
    try {
      const fake = new FakeProvider({ auto: () => FakeProvider.text('好') });
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
      await runtime.send(agent.id, '你好');
      const running = Object.values(runtime.activationSnapshot().tickets).filter(
        (item) => item.agentId === agent.id && item.state === 'running',
      );
      assert.equal(running.length, 0);
      await runtime.inbox.enqueue({
        toAgentId: agent.id,
        fromAgentId: 'peer',
        fromName: '乙',
        text: '后续来信',
        priority: false,
        depth: 0,
      });
      const before = fake.calls.length;
      await runtime.drainInbox(agent.id);
      assert.ok(fake.calls.length > before, 'settled 后同事来信应能进模型');
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('没有回执时中文“已经发到群里了”不能作为成功答复发布', async () => {
    const env = await tempDataDir('p0-fake-send');
    try {
      const sent: string[] = [];
      const tool = createSendToUserTool({
        rootDir: env.dir,
        broker: new InteractionBroker(),
        secrets: new SecretStore(env.dir),
        agentName: async () => '甲',
        artifacts: new ArtifactService({ roots: [env.dir] }),
      });
      await assert.rejects(
        tool.execute(
          { type: 'text', content: '我已经发到群里了', end_turn: true },
          {
            agentId: 'a',
            projectIds: [],
            turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 }, persistOutgoing: async (text) => { sent.push(text); } },
          },
        ),
        /没有本轮投递回执|不能确认/,
      );
      assert.deepEqual(sent, []);
    } finally {
      await env.cleanup();
    }
  });
});
