import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isSummoned, resolveMentions, stripMentions } from '../src/room/mentions.js';

/** 覆盖 docs/架构设计.md「群与同事协作」：解析失败当普通文本 */
describe('点名解析', () => {
  const members = [
    { id: 'a', name: '测试运维' },
    { id: 'b', name: '知识库服务' },
    { id: 'c', name: '知识库服务·备份' },
    { id: 'd', name: '白泽团队' },
  ];

  it('点单个成员', () => {
    const result = resolveMentions('@测试运维 看下 yaml', members);
    assert.deepEqual(result.ids, ['a']);
    assert.equal(result.everyone, false);
  });

  it('@everyone 命中全员座位', () => {
    const result = resolveMentions('@everyone 都看一眼', members);
    assert.equal(result.everyone, true);
    assert.deepEqual(result.ids, []);
  });

  it('中文全员别名', () => {
    for (const alias of ['@所有人', '@全体', '@全员', '@大家']) {
      assert.equal(resolveMentions(`${alias} 同步一下`, members).everyone, true, alias);
    }
  });

  it('没点名时不召唤任何人', () => {
    const result = resolveMentions('这个 yaml 有问题', members);
    assert.deepEqual(result.ids, []);
    assert.equal(result.everyone, false);
  });

  it('解析不到的名字当普通文本', () => {
    const result = resolveMentions('@不存在的人 你好', members);
    assert.deepEqual(result.ids, []);
    assert.equal(result.everyone, false);
  });

  it('长名优先，不被短名抢走', () => {
    const result = resolveMentions('@知识库服务·备份 看一下', members);
    assert.deepEqual(result.ids, ['c']);
  });

  it('同时点多个成员', () => {
    const result = resolveMentions('@测试运维 @白泽团队 你们确认下', members);
    assert.deepEqual(result.ids.sort(), ['a', 'd']);
  });

  it('isSummoned 判定：点名 / 全员 / 未点名', () => {
    const single = resolveMentions('@测试运维 来', members);
    assert.equal(isSummoned('a', single), true);
    assert.equal(isSummoned('b', single), false);

    const all = resolveMentions('@everyone', members);
    assert.equal(isSummoned('b', all), true);
  });

  it('stripMentions 去掉 @ 但保留名字', () => {
    const stripped = stripMentions('@测试运维 你看下 @知识库服务', members);
    assert.ok(!stripped.includes('@测试运维'));
    assert.ok(stripped.includes('测试运维'));
  });
});
