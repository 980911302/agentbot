import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { chatRows, isChatRenderable } from '../web/src/features/chat/correspondence.js';
import type { DisplayMessage } from '../web/src/types.js';

describe('聊天可渲染选择器', () => {
  // 聊天里不展示执行过程（工具调用）：只有工具调用、正文为空的消息不占位，
  // 否则会剩下一个只有名字和时间的空行。
  it('只有工具调用的消息不上时间线', () => {
    const toolOnly: DisplayMessage = {
      id: 't1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}', status: 'running' }],
      createdAt: new Date(0).toISOString(),
    };
    assert.equal(isChatRenderable(toolOnly), false);
    assert.deepEqual(chatRows([toolOnly]), []);
    // 有正文的照常显示，调用记录只是不画出来
    assert.equal(isChatRenderable({ ...toolOnly, content: '改好了' }), true);
  });

  it('空正文的消息仍然不渲染', () => {
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
