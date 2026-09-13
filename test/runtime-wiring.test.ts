import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir, waitFor } from './fakes/test-env.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('二次修复主链路（R01/R02/R07）', () => {
  it('用户输入受理后，模型调用前 ticket 已 running', async () => {
    const env = await tempDataDir('r01-ticket');
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
      const turn = runtime.send(agent.id, '你好');
      await waitFor(() => fake.pendingCount >= 1, '进入模型');
      const tickets = Object.values(runtime.activationSnapshot().tickets).filter((item) => item.agentId === agent.id);
      assert.ok(tickets.some((item) => item.state === 'running' && item.source === 'user'));
      fake.release(0, FakeProvider.text('好'));
      await turn;
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('控制存储 faulted 时不调用模型', async () => {
    const env = await tempDataDir('r02-faulted');
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(env.dir, 'control'), { recursive: true });
      await writeFile(join(env.dir, 'control', 'state.json'), '{broken', 'utf8');
      const fake = new FakeProvider({ auto: () => FakeProvider.text('不该出现') });
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
      await assert.rejects(() => runtime.send(agent.id, '你好'), /CONTROL_FAULTED|损坏/);
      assert.equal(fake.calls.length, 0);
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });

  it('关闭再打开同一目录时 processEpoch 变化，旧 ticket 不能复用', async () => {
    const env = await tempDataDir('r07-epoch');
    try {
      const first = new AgentRuntime({
        tools: [],
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [{ name: '甲', color: '#a855f7', instructions: '测' }],
      });
      const agent = await first.ensureDefaultAgent();
      await first.send(agent.id, '你好');
      const epoch1 = first.activation.processEpoch;
      await first.close();
      const second = new AgentRuntime({
        tools: [],
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
        seed: [{ name: '甲', color: '#a855f7', instructions: '测' }],
      });
      assert.notEqual(second.activation.processEpoch, epoch1);
      const stale = Object.values(second.activationSnapshot().tickets).filter((item) => item.processEpoch === epoch1);
      assert.ok(stale.every((item) => item.state === 'revoked' || item.state === 'settled'));
      await second.close();
    } finally {
      await env.cleanup();
    }
  });
});
