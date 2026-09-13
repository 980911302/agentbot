import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fitContextWindow, RESPONSE_RESERVE } from '../src/context/window.js';
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from '../src/context/budget.js';
import { groupMessages, trimRecentGroups } from '../src/context/history-selector.js';
import { ContextBuilder } from '../src/context/builder.js';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { Compactor, CompactionStore } from '../src/memory/compact.js';
import { MessageStore } from '../src/store/messages.js';
import type { Message, Agent, ToolSchema } from '../src/agent/types.js';
import type { LLMMessage } from '../src/llm/provider.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { defineTool } from '../src/tools/tool.js';

it('混合中英文与 emoji 截断不会超过估算预算', () => {
  for (const text of ['abc'.repeat(1000) + '中文'.repeat(1000), '中文'.repeat(1000) + 'abc'.repeat(1000), '😀'.repeat(5000)]) {
    for (const max of [1, 2, 50, 200, 1000]) assert.ok(estimateTokens(truncateToTokens(text, max)) <= max);
  }
});

it('不完整调用组不会变成非法请求，最大的一组也不能突破预算', () => {
  const messages = [
    { id: 'a', content: { type: 'tool_calls', calls: [{ id: 'c1', name: 'Read', arguments: '{}' }, { id: 'c2', name: 'Read', arguments: '{}' }] } },
    { id: 'b', content: { type: 'tool_result', callId: 'c1', name: 'Read', result: 'x'.repeat(40000), ok: true } },
    { id: 'c', content: { type: 'tool_result', callId: 'orphan', result: 'orphan' } },
  ] as Message[];
  const groups = groupMessages(messages);
  assert.equal(groups.length, 1);
  assert.equal((groups[0]!.messages[0]!.content as any).calls.length, 1);
  const trimmed = trimRecentGroups(messages, 100);
  assert.ok(trimmed.tokens <= 100); assert.equal(trimmed.messages.length, 0);
});

it('连续工具链按消息+schema 总预算裁剪，调用结果成对，任务和稳定规则保留', () => {
  const input: LLMMessage[] = [{ role: 'system', content: '固定规则' }, { role: 'user', content: '当前任务' }];
  for (let index = 0; index < 50; index++) input.push(
    { role: 'assistant', content: null, toolCalls: [{ id: `c${index}`, name: 'Read', arguments: JSON.stringify({ path: '/source/file.ts', content: 'code'.repeat(5000) }) }] },
    { role: 'tool', toolCallId: `c${index}`, content: '字'.repeat(14000) },
  );
  const schemas: ToolSchema[] = [{ name: 'Read', description: 'schema'.repeat(1000), parameters: { type: 'object', properties: {} } }];
  const snapshot = JSON.stringify(input);
  const result = fitContextWindow(input, schemas, 20000, '当前任务');
  const tokens = estimateTokens(JSON.stringify(result)) + estimateTokens(JSON.stringify(schemas)) + 128;
  assert.ok(tokens <= Math.floor(20000 * 0.85) - RESPONSE_RESERVE);
  assert.equal(result[0]!.content, '固定规则'); assert.ok(result.some(message => message.content === '当前任务'));
  assert.equal(snapshot, JSON.stringify(input), '不能修改持久原文/调用方数组');
  for (let index = 0; index < result.length; index++) {
    const message = result[index]!;
    if (message.toolCalls) assert.equal(result[index + 1]?.toolCallId, message.toolCalls[0]!.id);
    if (message.role === 'tool') assert.equal(result[index - 1]?.toolCalls?.[0]?.id, message.toolCallId);
  }
});

it('固定规则/用户任务本身超限时明确报错，不静默丢掉任务', () => {
  assert.throws(() => fitContextWindow([{ role: 'user', content: '字'.repeat(100000) }], [], 60000), /任务本身超过/);
});

it('续跑后上下文再次满时保留原目标快照，不能只剩一句继续', () => {
  const recovery = '任务恢复快照：原目标是修复导航，已修改 page.html，待验证';
  const input = [{ role: 'user' as const, content: recovery }, { role: 'user' as const, content: '继续' },
    ...Array.from({ length: 30 }, () => ({ role: 'assistant' as const, content: '历史资料'.repeat(2000) }))];
  const result = fitContextWindow(input, [], 20000, '继续', [recovery]);
  assert.ok(result.some(message => message.content === recovery));
  assert.ok(result.some(message => message.content === '继续'));
});

it('同一 Agent 多轮调用每次都限制上下文，模型 length 响应不执行半截工具', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-loop-limit-'));
  try {
    let requests = 0, executed = 0;
    const provider = new FakeProvider({ auto: messages => {
      requests++;
      assert.ok(estimateTokens(JSON.stringify(messages)) < 42808);
      if (requests === 1) return { ...FakeProvider.toolCalls([{ id: 'bad', name: 'Read', arguments: '{}' }]), finishReason: 'length' };
      if (messages.at(-1)?.content?.includes('现在进入“只总结、不执行工具”阶段')) return FakeProvider.text('已读取部分内容，尚未完成，需核对后继续。');
      return FakeProvider.toolCalls([{ id: String(requests), name: 'Read', arguments: '{}' }]);
    } });
    const tool = defineTool({ name: 'Read', description: '', parameters: { type: 'object', properties: {} }, execute: () => { executed++; return '字'.repeat(14000); } });
    const loop = new AgentLoop({ provider, messages: new MessageStore(dir) });
    const agent = { id: 'a1', tools: [tool], memory: { projectIds: [] } } as unknown as Agent;
    const result = await loop.run(agent, { messages: [{ role: 'user', content: '当前任务' }], stats: { budgetTokens: 60000 } } as never);
    assert.match(result.content, /已读取部分内容，尚未完成/);
    assert.equal(result.stopReason, 'tool_limit');
    assert.equal(executed, 18, '剩余额度不足时拒绝额外读取，不突破 256000 字符总量');
    assert.equal(requests, 21, '额度耗尽后直接只读收尾，不继续空转');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('被抢占后同一批剩余工具不再执行，迟到结果仍回填账本', async () => {
  let current = true, second = 0, completed = 0;
  const firstTool = defineTool({ name: 'First', description: '', parameters: { type: 'object', properties: {} }, execute: () => { current = false; return 'done'; } });
  const secondTool = defineTool({ name: 'Second', description: '', parameters: { type: 'object', properties: {} }, execute: () => { second++; return 'bad'; } });
  const provider = new FakeProvider({ auto: () => FakeProvider.toolCalls([{ id: '1', name: 'First', arguments: '{}' }, { id: '2', name: 'Second', arguments: '{}' }]) });
  const loop = new AgentLoop({ provider, messages: { append: async () => undefined } as never, isCurrent: () => current, invocations: { start: async () => ({ id: 'log' }), finish: async () => { completed++; } } as never });
  await assert.rejects(() => loop.run({ id: 'a', tools: [firstTool, secondTool], memory: { projectIds: [] } } as never, { messages: [] } as never), /抢占/);
  assert.equal(second, 0); assert.equal(completed, 1);
});

it('压缩水位只覆盖实际送入摘要的完整时间戳批次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-limit-'));
  try {
    const older: Message[] = Array.from({ length: 15 }, (_, i) => ({ id: String(i), agentId: 'a', createdAt: Math.floor(i / 2) + 1, role: 'user', content: { type: 'text', text: `msg-${i}:` + 'x'.repeat(5000) } }));
    const provider = new FakeProvider({ auto: messages => {
      const prompt = messages[1]!.content!;
      assert.ok(prompt.includes('msg-7:')); assert.ok(!prompt.includes('msg-8:'));
      return FakeProvider.text('前八条消息摘要');
    } });
    const compactor = new Compactor({ olderThan: async () => older } as never, new CompactionStore(dir), 1, 0);
    const result = await compactor.maybeCompact({ id: 'a', memory: { compaction: null } } as never, provider);
    assert.equal(result?.state.messageCount, 8); assert.equal(result?.state.coversUpTo, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('动态记忆变化不改写稳定 system 前缀', async () => {
  const task: Message = { id: 'm', agentId: 'a', createdAt: 1, role: 'user', content: { type: 'text', text: 'hi' } };
  const builder = new ContextBuilder({ recent: async () => [] } as never, DEFAULT_BUDGET);
  const agent = { id: 'a', name: 'Test', instructions: '固定职责', memory: { refs: [], compaction: null, projectIds: [] } } as unknown as Agent;
  const first = await builder.build(agent, task, { turnBrief: '第一轮简报' });
  const second = await builder.build(agent, task, { turnBrief: '第二轮简报' });
  assert.equal(first.messages[0]!.content, second.messages[0]!.content);
  assert.notEqual(first.messages[1]!.content, second.messages[1]!.content);
});
