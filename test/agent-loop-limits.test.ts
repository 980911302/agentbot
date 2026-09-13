import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent/agent-loop.js';
import type { Agent, LLMResponse } from '../src/agent/types.js';
import type { LLMProvider } from '../src/llm/provider.js';
import { MessageStore } from '../src/store/messages.js';
import { createFileTools } from '../src/tools/builtin/files.js';
import { defineTool, type TurnState } from '../src/tools/tool.js';
import { FakeProvider } from './fakes/fake-provider.js';

it('第 32 轮刚完成 Edit：预告剩余额度，之后只总结交接，不追加执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentbot-limit-handoff-'));
  try {
    const path = join(dir, 'page.html');
    await writeFile(path, '<div>before</div>');
    let requests = 0;
    const provider: LLMProvider = { name: 'fixture', chat: async (messages, options) => {
      requests++;
      if (requests <= 32) {
        const notices = messages.filter(message => message.role === 'system' && message.content?.startsWith('运行时执行额度提醒'));
        assert.equal(notices.length, requests >= 25 ? 1 : 0, '提醒不得逐轮累积');
        if (requests === 25) assert.match(notices[0]!.content!, /还剩 8 轮/);
        return FakeProvider.toolCalls([{ id: `call-${requests}`, name: requests === 32 ? 'Edit' : 'Read', arguments: JSON.stringify(requests === 32 ? { path, old_text: 'before', new_text: 'after' } : { path, limit: 1 }) }]);
      }
      assert.equal(requests, 33, '只额外允许一次总结');
      assert.deepEqual(options?.tools, [], '收尾不能开放工具');
      assert.equal(options?.onDelta, undefined, '未核对的总结不先流式交付');
      assert.ok(messages.some(message => message.role === 'tool' && message.content?.startsWith('已修改')));
      assert.match(messages.at(-1)!.content!, /未复验项/);
      return FakeProvider.text('已修改 page.html；尚未复验，下一步核对结构及浏览器表现。');
    } };
    const store = new MessageStore(dir);
    const result = await new AgentLoop({ provider, messages: store }).run({ id: 'a', tools: createFileTools(dir), memory: { projectIds: [] } } as unknown as Agent, { messages: [{ role: 'user', content: '优化网页' }] } as never);
    assert.equal(requests, 33); assert.equal(result.iterations, 32);
    assert.equal(result.stopReason, 'max_iterations');
    assert.equal(result.usedTools?.length, 32);
    assert.equal(await readFile(path, 'utf8'), '<div>after</div>');
    assert.match(result.content, /已修改 page.html；尚未复验/);
    const saved = await store.list('a');
    assert.equal(saved.filter(row => row.content.type === 'text').length, 1);
    assert.deepEqual(saved.at(-1)!.content, { type: 'text', text: result.content });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('总字符额度拒绝一个调用后，同批剩余工具不执行、回执成对，直接收尾', async () => {
  let executed = 0, requests = 0;
  const turnState: TurnState = { workbench: { agentsCreated: 0, roomsCreated: 0 }, toolOutputChars: 255000 };
  const edit = defineTool({ name: 'Edit', description: '', parameters: { type: 'object', properties: {} }, execute: () => { executed++; return 'changed'; } });
  const provider: LLMProvider = { name: 'fixture', chat: async (messages, options) => {
    requests++;
    if (requests === 1) return FakeProvider.toolCalls([{ id: 'c1', name: 'Edit', arguments: '{}' }, { id: 'c2', name: 'Edit', arguments: '{}' }]);
    assert.equal(requests, 2); assert.deepEqual(options?.tools, []);
    assert.deepEqual(messages.filter(row => row.role === 'tool').map(row => row.toolCallId), ['c1', 'c2']);
    assert.ok(messages.filter(row => row.role === 'tool').every(row => row.content?.includes('未执行')));
    return FakeProvider.text('额度不足，这一批未修改文件。');
  } };
  const result = await new AgentLoop({ provider, messages: { append: async () => undefined } as never, toolContext: { turnState } }).run({ id: 'a', tools: [edit], memory: { projectIds: [] } } as never, { messages: [] } as never);
  assert.equal(executed, 0); assert.equal(result.iterations, 1); assert.equal(requests, 2);
  assert.match(result.content, /额度不足/);
});

for (const mode of ['error', 'empty', 'length', 'tool_call'] as const) {
  it(`只读收尾 ${mode} 时保留已核实记录，不执行响应夹带的工具`, async () => {
    let requests = 0, executed = 0;
    const edit = defineTool({ name: 'Edit', description: '', parameters: { type: 'object', properties: {} }, execute: () => { executed++; return '已修改 /tmp/page.html；待复验'; } });
    const provider: LLMProvider = { name: 'fixture', chat: async () => {
      if (++requests === 1) return FakeProvider.toolCalls([{ id: 'c1', name: 'Edit', arguments: '{}' }]);
      if (mode === 'error') throw new Error('model offline');
      if (mode === 'empty') return FakeProvider.text('');
      if (mode === 'length') return { ...FakeProvider.text('不完整的交接'), finishReason: 'length' };
      return FakeProvider.toolCalls([{ id: 'must-not-run', name: 'Edit', arguments: '{}' }]);
    } };
    const result = await new AgentLoop({ provider, maxIterations: 1, messages: { append: async () => undefined } as never }).run({ id: 'a', tools: [edit], memory: { projectIds: [] } } as never, { messages: [] } as never);
    assert.equal(executed, 1); assert.equal(requests, 2);
    assert.match(result.content, /尚未取得最终验收结论/);
    assert.match(result.content, /已修改 \/tmp\/page.html；待复验/);
    assert.ok(!result.content.includes('不完整的交接'));
  });
}

it('总结期间取消，即使模型不配合也停止，不落下迟到交接气泡', async () => {
  const controller = new AbortController();
  let requests = 0, textMessages = 0;
  const edit = defineTool({ name: 'Edit', description: '', parameters: { type: 'object', properties: {} }, execute: () => 'done' });
  const provider: LLMProvider = { name: 'fixture', chat: async () => {
    if (++requests === 1) return FakeProvider.toolCalls([{ id: 'c1', name: 'Edit', arguments: '{}' }]);
    queueMicrotask(() => controller.abort());
    return new Promise<LLMResponse>(() => {});
  } };
  const loop = new AgentLoop({ provider, maxIterations: 1, signal: controller.signal, messages: { append: async (row: any) => { if (row.content.type === 'text') textMessages++; } } as never });
  await assert.rejects(() => loop.run({ id: 'a', tools: [edit], memory: { projectIds: [] } } as never, { messages: [] } as never), /abort/i);
  assert.equal(requests, 2); assert.equal(textMessages, 0);
});

it('总结超时只降级一次，仍然交接已完成的修改', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const edit = defineTool({ name: 'Edit', description: '', parameters: { type: 'object', properties: {} }, execute: () => '已修改 page.html' });
  const provider: LLMProvider = { name: 'fixture', chat: async () => {
    if (++requests === 1) return FakeProvider.toolCalls([{ id: 'c1', name: 'Edit', arguments: '{}' }]);
    queueMicrotask(() => t.mock.timers.tick(30001));
    return new Promise<LLMResponse>(() => {});
  } };
  const result = await new AgentLoop({ provider, maxIterations: 1, messages: { append: async () => undefined } as never }).run({ id: 'a', tools: [edit], memory: { projectIds: [] } } as never, { messages: [] } as never);
  assert.equal(requests, 2); assert.match(result.content, /已修改 page.html/);
  assert.match(result.content, /尚未取得最终验收结论/);
});

it('工具调用数上限不会误报 32 轮，越界批次不执行', async () => {
  let requests = 0, executed = 0;
  const read = defineTool({ name: 'Read', description: '', parameters: { type: 'object', properties: {} }, execute: () => { executed++; return 'ok'; } });
  const provider: LLMProvider = { name: 'fixture', chat: async (_messages, options) => {
    requests++;
    if (requests === 18) {
      assert.deepEqual(options?.tools, []);
      return FakeProvider.text('已完成部分检查，其余待继续。');
    }
    return FakeProvider.toolCalls(Array.from({ length: 8 }, (_, i) => ({ id: `${requests}-${i}`, name: 'Read', arguments: '{}' })));
  } };
  const result = await new AgentLoop({ provider, messages: { append: async () => undefined } as never }).run({ id: 'a', tools: [read], memory: { projectIds: [] } } as never, { messages: [] } as never);
  assert.equal(executed, 128); assert.equal(requests, 18); assert.equal(result.iterations, 17);
  assert.match(result.content, /128 次工具调用上限（最后一批未执行）/);
  assert.ok(!result.content.includes('32 轮'));
});
