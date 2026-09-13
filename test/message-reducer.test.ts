import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AgentEvent, DisplayMessage } from '../web/src/types.js';
import { applyEvent } from '../web/src/features/chat/message-reducer.js';

describe('前端工具消息归组', () => {
  it('新回合的工具调用按后端消息 id 建组，不挂到上一条回答', () => {
    const previous: DisplayMessage[] = [
      { id: 'old', role: 'assistant', content: '上一轮', toolCalls: [], createdAt: new Date(0).toISOString() },
    ];
    const event: AgentEvent = {
      type: 'message',
      message: {
        id: 'tool-owner',
        agentId: 'a1',
        role: 'assistant',
        content: {
          type: 'tool_calls',
          calls: [{ id: 'read-1', name: 'Read', arguments: '{"path":"a.ts"}' }],
        },
        createdAt: 1,
      },
    };

    const next = applyEvent(previous, event);
    assert.equal(next[0]?.toolCalls.length, 0);
    assert.equal(next[1]?.id, 'tool-owner');
    assert.equal(next[1]?.toolCalls[0]?.id, 'read-1');
  });

  it('工具结果按 callId 回填原归属消息，不受后续回答影响', () => {
    const messages: DisplayMessage[] = [
      {
        id: 'tool-owner',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'read-1', name: 'Read', arguments: '{}', status: 'running' }],
        createdAt: new Date(1).toISOString(),
      },
      { id: 'later', role: 'assistant', content: '后续文本', toolCalls: [], createdAt: new Date(2).toISOString() },
    ];
    const result: AgentEvent = {
      type: 'message',
      message: {
        id: 'result-1',
        agentId: 'a1',
        role: 'tool',
        content: {
          type: 'tool_result',
          callId: 'read-1',
          name: 'Read',
          result: 'ok',
          durationMs: 3,
          ok: true,
        },
        createdAt: 3,
      },
    };

    const next = applyEvent(messages, result);
    assert.equal(next[0]?.toolCalls[0]?.status, 'ok');
    assert.equal(next[0]?.toolCalls[0]?.result, 'ok');
    assert.equal(next[1]?.content, '后续文本');
  });
});
