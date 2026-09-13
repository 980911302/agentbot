import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { AgentRegistry } from '../src/agent/registry.js';
import { MessageStore } from '../src/store/messages.js';
import { ReceivedStore } from '../src/storage/received-store.js';
import { JsonRunLedger } from '../src/storage/run-ledger.js';
import { TodoStore, WorkerManager } from '../src/tools/services/worker-manager.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

describe('核心状态持久化', () => {
  it('接收幂等记录 await 返回时已可被新进程读取', async () => {
    const env = await tempDataDir('received-durable');
    try {
      const first = new ReceivedStore(env.dir);
      await Promise.all([
        first.record('client-1', { messageId: 'message-1', agentId: 'agent-1' }),
        first.record('client-2', { messageId: 'message-2', agentId: 'agent-2' }),
      ]);
      const second = new ReceivedStore(env.dir);
      assert.deepEqual(second.find('client-1'), { messageId: 'message-1', agentId: 'agent-1' });
      assert.deepEqual(second.find('client-2'), { messageId: 'message-2', agentId: 'agent-2' });
    } finally {
      await env.cleanup();
    }
  });

  it('任务账本跨重启保留，中断的 running 回合改为 parked', async () => {
    const env = await tempDataDir('run-ledger-durable');
    try {
      const first = new JsonRunLedger(env.dir);
      first.putTurn({
        id: 'turn-1',
        agentId: 'agent-1',
        source: 'user',
        kind: 'normal',
        text: '大任务',
        treeId: 'tree-1',
        status: 'running',
        createdAt: 1,
      });
      first.putTree({
        id: 'tree-1',
        rootTurnId: 'turn-1',
        agentId: 'agent-1',
        children: [],
        status: 'open',
        resumeCount: 0,
        createdAt: 1,
      });
      assert.equal(first.beginRun('agent-1', 'turn-1'), 1);

      const second = new JsonRunLedger(env.dir);
      assert.equal(second.getTurn('turn-1')?.status, 'parked');
      assert.equal(second.getTree('tree-1')?.status, 'open');
      assert.equal(second.epochOf('agent-1'), 1);
    } finally {
      await env.cleanup();
    }
  });

  it('Todo 和后台工人重启后不丢记录', async () => {
    const env = await tempDataDir('worker-durable');
    try {
      const todos = new TodoStore(env.dir);
      todos.set('agent-1', [
        { id: '1', content: '读架构', status: 'completed' },
        { id: '2', content: '修问题', status: 'in_progress' },
      ]);
      assert.equal(new TodoStore(env.dir).get('agent-1')[1]?.content, '修问题');

      const deps = {
        provider: new FakeProvider({ auto: () => FakeProvider.text('完成') }),
        messages: new MessageStore(env.dir),
        workerTools: () => [],
        dataDir: env.dir,
      };
      const first = new WorkerManager(deps);
      const worker = first.spawn('检查架构', '请检查项目架构');
      const second = new WorkerManager(deps);
      const recovered = second.get(worker.id);
      assert.equal(recovered?.description, '检查架构');
      assert.equal(recovered?.status, 'interrupted');
      assert.match(recovered?.error ?? '', /中断/);
    } finally {
      await env.cleanup();
    }
  });

  it('并发首次读取不会把注册表误当成空表', async () => {
    const env = await tempDataDir('registry-load');
    try {
      const seed = new AgentRegistry(env.dir);
      await seed.create({ name: '原有智能体' });
      const fresh = new AgentRegistry(env.dir);
      const [left, right] = await Promise.all([fresh.list(), fresh.list()]);
      assert.equal(left[0]?.name, '原有智能体');
      assert.equal(right[0]?.name, '原有智能体');
      const persisted = JSON.parse(await readFile(`${env.dir}/agents.json`, 'utf8')) as unknown[];
      assert.equal(persisted.length, 1);
    } finally {
      await env.cleanup();
    }
  });

  it('JSONL 只容忍强退撕裂的最后一行，中间损坏会显式报错', async () => {
    const env = await tempDataDir('jsonl-corruption');
    try {
      const dir = `${env.dir}/messages`;
      await mkdir(dir, { recursive: true });
      const valid = JSON.stringify({
        id: 'm1',
        agentId: 'agent-1',
        role: 'user',
        content: { type: 'text', text: '保留我' },
        createdAt: 1,
        source: 'user',
      });
      await writeFile(`${dir}/agent-1.jsonl`, `${valid}\n{"id":\n`, 'utf8');
      assert.equal((await new MessageStore(env.dir).list('agent-1')).length, 1);

      await writeFile(`${dir}/agent-2.jsonl`, `${valid}\n坏数据\n${valid}\n`, 'utf8');
      await assert.rejects(() => new MessageStore(env.dir).list('agent-2'));
    } finally {
      await env.cleanup();
    }
  });
});
