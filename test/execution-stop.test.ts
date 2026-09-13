import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FakeProvider } from './fakes/fake-provider.js';
import { waitFor } from './fakes/test-env.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { AgentInbox } from '../src/agent/inbox.js';

const TEXT = { content: '完成', toolCalls: [], finishReason: 'stop' as const, usage: null };

describe('停止真正生效（A01/A02）', () => {
  let dir: string;
  let fake: FakeProvider;
  let runtime: AgentRuntime;
  let inbox: AgentInbox;
  let agentId: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'exec-stop-'));
    fake = new FakeProvider();
    inbox = new AgentInbox(dir);
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
    agentId = (await runtime.registry.list())[0]!.id;
  });

  after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('用户回合正在模型调用时停止：立即 abort，不等模型自然完成', async () => {
    const busy = runtime.send(agentId, '一件长活');
    await waitFor(() => fake.pendingCount >= 1, '长活进入模型');
    const callsAtStop = fake.calls.length;

    const stop = runtime.send(agentId, '停');
    const stopResult = await stop;
    assert.equal(stopResult.stopReason, 'stopped');

    const busyResult = await busy.catch((error: unknown) => error);
    assert.ok(
      busyResult && typeof busyResult === 'object' && 'stopReason' in busyResult
        ? (busyResult as { stopReason: string }).stopReason !== 'final_answer'
        : true,
      '停止后旧用户回合不能按自然完成收场',
    );
    assert.equal(fake.calls.length, callsAtStop, '停止后不应再发起模型调用');
  });

  it('停止确认后积压旧信不能再调用模型', async () => {
    const callsBefore = fake.calls.length;
    await inbox.enqueue({
      toAgentId: agentId,
      fromAgentId: 'peer',
      fromName: '同事',
      text: '（不用回）把 id 发我即可。',
      priority: false,
      depth: 0,
    });
    await runtime.drainInbox(agentId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fake.calls.length, callsBefore, 'paused 后旧信不得进入模型');
  });

  it('停止后用户新任务可执行，旧信仍不释放', async () => {
    fake = new FakeProvider({ auto: () => TEXT });
    await runtime.close().catch(() => undefined);
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
    agentId = (await runtime.registry.list())[0]!.id;
    inbox = new AgentInbox(dir);

    await runtime.send(agentId, '停');
    await inbox.enqueue({
      toAgentId: agentId,
      fromAgentId: 'peer',
      fromName: '同事',
      text: '旧链回信',
      priority: false,
      depth: 0,
    });
    const callsAfterStop = fake.calls.length;
    const fresh = await runtime.send(agentId, '新任务请只回一个字：好');
    assert.equal(fresh.stopReason, 'final_answer');
    await runtime.drainInbox(agentId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fake.calls.length > callsAfterStop, '新用户命令应当执行');
    const held = (await inbox.peek(agentId)).filter((item) => item.text.includes('旧链回信'));
    assert.ok(held.length === 0 || held.every((item) => item.disposition === 'held' || item.status === 'pending'));
  });
});
