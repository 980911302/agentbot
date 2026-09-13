import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { FakeProvider } from './fakes/fake-provider.js';
import type { Agent } from '../src/agent/types.js';
import type { BuiltContext } from '../src/context/builder.js';
import type { ChatOptions, LLMMessage, LLMResponse } from '../src/llm/provider.js';
import { MessageStore } from '../src/store/messages.js';
import { defineTool, type TurnState } from '../src/tools/tool.js';

/** delta 事件必须先于持久化的 message 事件，前端才能「增量追加 → 收到全文即替换」 */
describe('AgentLoop 流式 delta', () => {
  it('delta 先于 message 到达，且聚合文本一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbot-loop-delta-'));
    const provider = new FakeProvider({
      auto: (_messages, options) => {
        options?.onDelta?.('你');
        options?.onDelta?.('好');
        return { content: '你好', toolCalls: [], finishReason: 'stop', usage: null };
      },
    });
    const events: string[] = [];
    const loop = new AgentLoop({
      provider,
      messages: new MessageStore(dir),
      onEvent: (event) => events.push(event.type),
      onDelta: (text) => events.push(`delta:${text}`),
    });
    const agent = { id: 'a1', name: '测试', tools: [] } as unknown as Agent;
    const built = { messages: [] } as unknown as BuiltContext;

    await loop.run(agent, built);

    const deltaIndex = events.indexOf('delta:你');
    const messageIndex = events.indexOf('message');
    assert.ok(deltaIndex >= 0, `应有 delta 事件，实际：${events.join(',')}`);
    assert.ok(messageIndex > deltaIndex, 'message 必须在 delta 之后');
    assert.ok(events.includes('final'));
  });
});

describe('AgentLoop 统一出口收尾', () => {
  it('普通工具调用前的过程正文不落成聊天气泡', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbot-loop-draft-'));
    let calls = 0;
    const provider = new FakeProvider({
      auto: () => {
        calls += 1;
        return calls === 1
          ? {
              content: '我先读几个文件，再开始修改。',
              toolCalls: [{ id: 'read-1', name: 'Read', arguments: '{}' }],
              finishReason: 'tool_calls',
              usage: null,
            }
          : {
              content: '修改完成。',
              toolCalls: [],
              finishReason: 'stop',
              usage: null,
            };
      },
    });
    const read = defineTool({
      name: 'Read',
      description: '测试读取',
      parameters: { type: 'object' },
      execute: () => '文件内容',
    });
    const messages = new MessageStore(dir);
    const loop = new AgentLoop({ provider, messages });
    const agent = {
      id: 'a1',
      name: '测试',
      tools: [read],
      memory: { projectIds: [] },
    } as unknown as Agent;

    await loop.run(agent, { messages: [] } as unknown as BuiltContext);
    const persisted = await messages.list('a1');
    const textMessages = persisted.filter((message) => message.content.type === 'text');
    assert.deepEqual(textMessages.map((message) => message.content), [
      { type: 'text', text: '修改完成。' },
    ]);
  });

  it('SendToUser 标记 end_turn 后立即结束，不再请求模型，也不落草稿文本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbot-loop-end-turn-'));
    let calls = 0;
    const provider = new FakeProvider({
      auto: () => {
        calls += 1;
        return {
          content: '这段只是草稿，不应落盘',
          toolCalls: [{ id: 'out-1', name: 'SendToUser', arguments: '{"end_turn":true}' }],
          finishReason: 'tool_calls',
          usage: null,
        };
      },
    });
    const turnState: TurnState = { workbench: { agentsCreated: 0, roomsCreated: 0 } };
    const outlet = defineTool({
      name: 'SendToUser',
      description: '测试出口',
      parameters: { type: 'object', properties: { end_turn: { type: 'boolean' } } },
      ephemeral: true,
      execute: () => {
        turnState.lastVisibleText = '已经交付';
        turnState.endTurnRequested = true;
        return '已发送';
      },
    });
    const messages = new MessageStore(dir);
    const loop = new AgentLoop({ provider, messages, toolContext: { turnState } });
    const agent = {
      id: 'a1',
      name: '测试',
      tools: [outlet],
      memory: { projectIds: [] },
    } as unknown as Agent;
    const built = { messages: [] } as unknown as BuiltContext;

    const result = await loop.run(agent, built);

    assert.equal(calls, 1);
    assert.equal(result.content, '已经交付');
    assert.equal((await messages.list('a1')).length, 0, '出口调用和同轮草稿都不应落盘');
  });

  it('SendToUser 失败后仍会持久化后续最终文本，不产生黑洞', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbot-loop-outlet-fallback-'));
    let calls = 0;
    const provider = new FakeProvider({
      auto: () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: '这段是草稿',
            toolCalls: [{ id: 'bad-outlet', name: 'SendToUser', arguments: '{}' }],
            finishReason: 'tool_calls',
            usage: null,
          };
        }
        return {
          content: '这才是最终答案',
          toolCalls: [],
          finishReason: 'stop',
          usage: null,
        };
      },
    });
    const outlet = defineTool({
      name: 'SendToUser',
      description: '测试出口',
      parameters: { type: 'object', required: ['type'] },
      ephemeral: true,
      execute: () => '不应执行',
    });
    const messages = new MessageStore(dir);
    const turnState: TurnState = { workbench: { agentsCreated: 0, roomsCreated: 0 } };
    const loop = new AgentLoop({ provider, messages, toolContext: { turnState } });
    const agent = {
      id: 'a1',
      name: '测试',
      tools: [outlet],
      memory: { projectIds: [] },
    } as unknown as Agent;

    const result = await loop.run(agent, { messages: [] } as unknown as BuiltContext);
    const persisted = await messages.list('a1');

    assert.equal(result.content, '这才是最终答案');
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0]?.content, { type: 'text', text: '这才是最终答案' });
  });
});
