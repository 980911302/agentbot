import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { chatRows, isChatRenderable } from '../web/src/features/chat/correspondence.js';
import type { DisplayMessage } from '../web/src/types.js';

describe('聊天可渲染选择器', () => {
  it('纯工具空内容不进入普通聊天行', () => {
    const toolOnly: DisplayMessage = {
      id: 't1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}', status: 'running' }],
      createdAt: new Date(0).toISOString(),
    };
    assert.equal(isChatRenderable(toolOnly), false);
    assert.deepEqual(chatRows([toolOnly]), []);
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
