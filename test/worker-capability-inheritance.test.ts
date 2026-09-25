import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/server/runtime.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { selectWorkerTools } from '../src/tools/services/worker-manager.js';
import { defineTool } from '../src/tools/tool.js';
import type { Tool } from '../src/tools/tool.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/**
 * E5.3：Task 工人继承「受限能力」——不超过派工者。
 *
 * 规则 = 运行时可用 ∩ 派工时授予 ∩ 派工者当前授权，再减去工人禁区（派工/协作/出口/组织管理）。
 * 只靠固定黑名单是不够的：那样工人会拿到派工者根本没被授权、但运行时装着的工具。
 */

const stub = (name: string): Tool<unknown> =>
  defineTool({
    name,
    description: `测试工具 ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });

const authority = (toolNames: string[]) => ({ toolNames, projectIds: [] });

describe('工人工具 = 派工者授权取交集（E5.3）', () => {
  const available = [
    'Read',
    'ReadToolOutput',
    'Write',
    'Shell',
    'WebSearch',
    'Task',
    'SendToUser',
    'SendToAgent',
  ].map(stub);

  it('派工者没有的工具不给工人（不是只减黑名单）', () => {
    const picked = selectWorkerTools(
      available,
      authority(['Read', 'ReadToolOutput', 'Task']),
      authority(['Read', 'ReadToolOutput', 'Task']),
    );
    assert.deepEqual(
      picked.map((tool) => tool.name),
      ['Read', 'ReadToolOutput'],
    );
  });

  it('派工者被收回授权后，工人续跑也拿不到（授权只减不增）', () => {
    const granted = authority(['Read', 'Shell']);
    assert.deepEqual(
      selectWorkerTools(available, granted, authority(['Read', 'Shell'])).map((tool) => tool.name),
      ['Read', 'Shell'],
    );
    // 派工者当前只剩 Read：Shell 不能再出现在工人手里
    assert.deepEqual(
      selectWorkerTools(available, granted, authority(['Read'])).map((tool) => tool.name),
      ['Read'],
    );
  });

  it('工人禁区（派工/协作/出口/组织管理）永远不给，哪怕派工者有', () => {
    const both = authority([
      'Task',
      'MessageSubagent',
      'CheckSubagent',
      'StopSubagent',
      'SendToAgent',
      'SendToUser',
      'CreateAgent',
      'CreateChannel',
      'Read',
    ]);
    assert.deepEqual(
      selectWorkerTools(available, both, both).map((tool) => tool.name),
      ['Read'],
    );
  });

  it('缺任一侧授权时按没有权限处理（fail closed）', () => {
    assert.deepEqual(selectWorkerTools(available, undefined, authority(['Read'])), []);
    assert.deepEqual(selectWorkerTools(available, authority(['Read']), undefined), []);
  });

  it('端到端：真实派工一次，工人的工具面是派工者的子集（运行时装着 Write/Shell 也不给）', async () => {
    const env = await tempDataDir('worker-inherit');
    try {
      // 派工者只被授权 Read + Task：运行时装着的 Write / Shell / WebSearch 都与它无关
      const provider = new FakeProvider({
        auto: (messages) => {
          const isWorker = messages[0]?.content?.includes('把文件写完');
          if (isWorker) return FakeProvider.text('工人干完了');
          if (messages.some((message) => message.content?.includes('worker_id')))
            return FakeProvider.text('派完了');
          return {
            content: null,
            toolCalls: [
              {
                id: 'task-1',
                name: 'Task',
                arguments: JSON.stringify({
                  description: '写文件',
                  prompt: '把文件写完',
                  subagent_type: 'executor',
                }),
              },
            ],
            finishReason: 'tool_calls',
            usage: null,
          };
        },
      });
      const runtime = new AgentRuntime({
        tools: [stub('Read'), stub('Write'), stub('Shell'), stub('WebSearch'), stub('SendToUser')],
        createProvider: () => provider,
        dataDir: env.dir,
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: { ...DEFAULT_BUDGET, compactionTrigger: 9999 },
        memoryExtraction: false,
      });
      const owner = await runtime.createAgent({ name: '派工者' });
      await runtime.registry.update(owner.id, { toolNames: ['Read', 'Task'] });

      await runtime.send(owner.id, '派个活');

      // 第 1 次调用是派工者的回合，第 2 次是工人（prompt 自洽、首条 system 就是派工 prompt）
      const ownerTools = provider.offeredTools[0]!;
      const workerTools = provider.offeredTools[1]!;
      assert.ok(ownerTools.includes('Task'), `派工者这一回合应该能派工：${ownerTools.join(',')}`);
      assert.deepEqual(
        [...workerTools].sort(),
        ['Read', 'ReadToolOutput'],
        `工人只能拿派工者有的、且非禁区的工具，实际：${workerTools.join(',')}`,
      );
      for (const forbidden of ['Write', 'Shell', 'WebSearch', 'Task', 'SendToUser', 'SendToAgent']) {
        assert.ok(!workerTools.includes(forbidden), `工人不该拿到 ${forbidden}`);
      }
      assert.ok(
        workerTools.every((name) => ownerTools.includes(name)),
        '工人工具必须是派工者工具的子集',
      );
      assert.equal(
        runtime.tools.some((tool) => tool.name === 'Write'),
        true,
        '运行时确实装着 Write',
      );
      await runtime.close();
    } finally {
      await env.cleanup();
    }
  });
});
