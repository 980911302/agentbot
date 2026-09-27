import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  baseURLError,
  newModelRecord,
  providerDraftErrors,
  THINKING_CHOICES,
  thinkingChoiceOf,
  thinkingPatch,
} from '../web/src/components/settings/model-settings-shared.js';

describe('模型设置页的纯函数', () => {
  it('思考强度：关/低/中/高 与存储字段互相对应', () => {
    assert.deepEqual(
      THINKING_CHOICES.map((choice) => choice.label),
      ['关', '低', '中', '高'],
    );
    assert.equal(thinkingChoiceOf({ thinkingEnabled: false, thinkingLevel: 'high' }), 'off');
    assert.equal(thinkingChoiceOf({ thinkingEnabled: true, thinkingLevel: 'low' }), 'low');
    assert.equal(thinkingChoiceOf({}), 'medium', '没配过就按「中」');
    assert.deepEqual(thinkingPatch('off'), { thinkingEnabled: false });
    assert.deepEqual(thinkingPatch('high'), { thinkingEnabled: true, thinkingLevel: 'high' });
  });

  it('添加服务商：名称、地址、模型必填，地址必须是 http(s)', () => {
    assert.deepEqual(providerDraftErrors({ name: ' ', baseURL: '', apiKey: '', model: '' }), {
      name: '填一个名称',
      baseURL: '填接口地址',
      model: '填一个模型名',
    });
    assert.equal(baseURLError('api.deepseek.com'), '地址要以 http:// 或 https:// 开头');
    assert.equal(baseURLError('https://api.deepseek.com/v1'), undefined);
    assert.deepEqual(
      providerDraftErrors({
        name: '本地',
        baseURL: 'http://127.0.0.1:8000/v1',
        apiKey: '',
        model: 'step-5-preview',
      }),
      {},
    );
  });

  it('新模型：显示名跟随模型名，思考按内置目录给默认值', () => {
    const chat = newModelRecord(' deepseek-chat ', 'm1');
    assert.deepEqual(chat, {
      id: 'm1',
      model: 'deepseek-chat',
      name: 'deepseek-chat',
      thinkingEnabled: false,
      thinkingLevel: 'medium',
    });
    assert.equal(newModelRecord('step-5-preview', 'm2').thinkingEnabled, true, '不认识的模型默认开思考');
    assert.match(newModelRecord('x').id, /^m_/);
  });
});
