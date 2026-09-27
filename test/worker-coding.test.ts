import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { WorkerManager } from '../src/tools/services/worker-manager.js';
import { defineTool } from '../src/tools/tool.js';
import { FakeProvider } from './fakes/fake-provider.js';

const bigRead = () =>
  defineTool({
    name: 'Read',
    description: '',
    parameters: { type: 'object', properties: {} },
    execute: () => 'x'.repeat(13_000),
  });

/** 工人连读 12 次大文件后收尾；记录每次请求里第一条工具结果是否还是原文 */
function readingProvider(firstIntact: boolean[]) {
  let requests = 0;
  return new FakeProvider({
    auto: (messages) => {
      requests++;
      const firstTool = messages.find((message) => message.role === 'tool');
      if (firstTool) firstIntact.push((firstTool.content ?? '').length >= 13_000);
      return requests <= 12
        ? FakeProvider.toolCalls([{ id: `r${requests}`, name: 'Read', arguments: '{}' }])
        : FakeProvider.text('读完了，交付结果。');
    },
  });
}

describe('后台工人的写代码能力', () => {
  it('工人的系统提示先给执行纪律（定位→修改→验证→如实交付），再给派工说明', async () => {
    const provider = new FakeProvider({ auto: () => FakeProvider.text('完成') });
    const manager = new WorkerManager({
      provider,
      messages: { append: async () => undefined } as never,
      workerTools: () => [],
    });
    const worker = manager.spawn(
      '修复按钮',
      '把 src/Button.tsx 的点击事件修好，并跑 npm test 验证。',
      'owner',
      { toolNames: [], projectIds: [] },
    );
    await manager.drive(worker);
    const system = provider.calls[0]!.find((message) => message.role === 'system')!.content!;
    assert.match(system, /工人纪律/);
    assert.match(system, /验证/);
    assert.match(system, /把 src\/Button\.tsx 的点击事件修好/);
    assert.ok(system.indexOf('工人纪律') < system.indexOf('src/Button.tsx'), '纪律在前、派工说明在后');
  });

  it('工人的上下文预算跟随模型窗口：大窗口下早先读到的原文不被过早压缩', async () => {
    const small: boolean[] = [];
    const smallManager = new WorkerManager({
      provider: readingProvider(small),
      messages: { append: async () => undefined } as never,
      workerTools: () => [bigRead()],
    });
    const smallWorker = smallManager.spawn('读文件', '连续读文件', 'owner', {
      toolNames: ['Read'],
      projectIds: [],
    });
    await smallManager.drive(smallWorker);
    assert.ok(small.includes(false), '默认 60K 预算下，读到后面早先的结果会被压短');

    const large: boolean[] = [];
    const largeManager = new WorkerManager({
      provider: readingProvider(large),
      messages: { append: async () => undefined } as never,
      workerTools: () => [bigRead()],
      contextTokensFor: () => 200_000,
    });
    const largeWorker = largeManager.spawn('读文件', '连续读文件', 'owner', {
      toolNames: ['Read'],
      projectIds: [],
    });
    await largeManager.drive(largeWorker);
    assert.ok(large.length >= 12 && large.every(Boolean), '200K 预算下 12 次读取的原文都还在');
  });
});
