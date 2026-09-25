import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EDIT_PROMPT_EVENT, outgoingRequest } from '../web/src/features/chat/send-view.js';

describe('outgoingRequest：发送前置校验', () => {
  it('去掉首尾空白，中间的空格保留', () => {
    assert.deepEqual(outgoingRequest('  看下这个  '), { text: '看下这个' });
    assert.deepEqual(outgoingRequest('看 下 这 个'), { text: '看 下 这 个' });
  });

  it('空文本与纯空白不发（返回 null）', () => {
    assert.equal(outgoingRequest(''), null);
    assert.equal(outgoingRequest('   '), null);
    assert.equal(outgoingRequest('\n\t '), null);
  });

  it('普通发送不带 clientMessageId，交给引擎生成', () => {
    const request = outgoingRequest('你好');
    assert.equal(request?.clientMessageId, undefined);
    assert.equal('clientMessageId' in (request ?? {}), false);
  });

  it('重试带上原来的 clientMessageId（服务端据此去重）', () => {
    assert.deepEqual(outgoingRequest('  原话  ', 'key-1'), {
      text: '原话',
      clientMessageId: 'key-1',
    });
  });

  it('重试时原文为空同样不发', () => {
    assert.equal(outgoingRequest('   ', 'key-1'), null);
  });
});

describe('EDIT_PROMPT_EVENT：「重新编辑」事件名', () => {
  it('与 Composer 监听的窗口事件一致（契约不能改）', () => {
    assert.equal(EDIT_PROMPT_EVENT, 'agentbot:use_prompt');
  });
});
