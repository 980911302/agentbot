import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isKnownAgentEvent, parseSendMessageInput } from '../src/shared/contracts/index.js';

/** E1.5：两个私聊发送入口共用的请求契约 */
describe('parseSendMessageInput', () => {
  it('标准形态：text + botId + model', () => {
    const parsed = parseSendMessageInput({ text: ' 你好 ', botId: 'b1', model: 'm1' });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, { text: '你好', botId: 'b1', model: 'm1' });
  });

  it('历史别名：message 等价 text，agentId 等价 botId', () => {
    const parsed = parseSendMessageInput({ message: ' 干活 ', agentId: 'a9' });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, { text: '干活', botId: 'a9' });
  });

  it('message 与 text 同时存在时 text 优先（会话路由的历史语义）', () => {
    const parsed = parseSendMessageInput({ text: '来自text', message: '来自message' });
    assert.ok(parsed.ok);
    assert.equal(parsed.value.text, '来自text');
  });

  it('缺字段 / 纯空白 → 一律 message is required', () => {
    for (const body of [{}, { text: '   ' }, { message: '' }]) {
      const parsed = parseSendMessageInput(body);
      assert.ok(!parsed.ok);
      assert.equal(parsed.error, 'message is required');
    }
  });

  it('非 JSON 对象 → 明确报「请求体必须是 JSON 对象」', () => {
    for (const body of ['not-an-object', null, 42, []]) {
      const parsed = parseSendMessageInput(body);
      assert.ok(!parsed.ok);
      assert.equal(parsed.error, '请求体必须是 JSON 对象');
    }
  });

  it('非字符串类型的字段被忽略，不抛异常', () => {
    const parsed = parseSendMessageInput({ text: 'hi', botId: 42, model: true });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, { text: 'hi' });
  });
});

/** E1.5：出站防线 —— 未知形状的事件不下发 */
describe('isKnownAgentEvent', () => {
  it('已知事件类型放行', () => {
    assert.ok(isKnownAgentEvent({ type: 'delta', text: '你' }));
    assert.ok(isKnownAgentEvent({ type: 'final', content: '好的' }));
    assert.ok(isKnownAgentEvent({ type: 'interaction_closed', id: 'x', answered: false }));
  });

  it('未知 / 缺 type / 非对象一律拒绝', () => {
    for (const event of [undefined, null, 42, {}, { kind: 'delta' }, { type: 'hax' }]) {
      assert.equal(isKnownAgentEvent(event), false, JSON.stringify(event));
    }
  });
});
