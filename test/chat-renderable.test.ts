import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { chatRows, isChatRenderable } from '../web/src/features/chat/correspondence.js';
import type { DisplayMessage } from '../web/src/types.js';

describe('聊天可渲染选择器', () => {
  // 工具卡接入后（UI-04），只有工具调用、正文为空的消息也要渲染：
  // 它是工具卡的载体。藏起来会让整段工具过程从时间线消失。
  it('纯工具消息也渲染——它是工具卡的载体', () => {
    const toolOnly: DisplayMessage = {
      id: 't1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}', status: 'running' }],
      createdAt: new Date(0).toISOString(),
    };
    assert.equal(isChatRenderable(toolOnly), true);
    assert.equal(chatRows([toolOnly])[0]?.kind, 'message');
  });

  it('既无正文也无工具可看的空消息仍然不渲染', () => {
    const empty: DisplayMessage = {
      id: 't0',
      role: 'assistant',
      content: '   ',
      toolCalls: [],
      createdAt: new Date(0).toISOString(),
    };
    assert.equal(isChatRenderable(empty), false);
    assert.deepEqual(chatRows([empty]), []);
  });

  it('有正文的助手消息仍渲染', () => {
    const text: DisplayMessage = {
      id: 'm1',
      role: 'assistant',
      content: '你好',
      toolCalls: [],
      createdAt: new Date(0).toISOString(),
    };
    assert.equal(isChatRenderable(text), true);
    assert.equal(chatRows([text])[0]?.kind, 'message');
  });
});
