import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { composeIdentity } from '../src/context/builder.js';
import { buildAgentBrief, buildRoomBrief } from '../src/room/turn.js';

/**
 * 回归：智能体必须知道「我是谁」。
 *
 * 曾经的问题：系统提示词第一块直接是职责，名字只出现在给界面看的统计里，
 * 于是问它「你叫什么」，它只能把职责复述一遍。
 */
describe('身份块', () => {
  it('包含名字与 id', () => {
    const text = composeIdentity({ id: 'abc-123', name: '紫色小助手' });
    assert.ok(text.includes('紫色小助手'), '必须写进名字');
    assert.ok(text.includes('abc-123'), '带上 id，便于它引用自己');
    assert.ok(text.startsWith('你是「紫色小助手」'), '应该是第一人称的身份陈述');
  });

  it('有简介就带上', () => {
    const text = composeIdentity({ id: 'x', name: '测试运维', title: '盯 159 部署' });
    assert.ok(text.includes('盯 159 部署'));
  });

  it('描述与简介相同时不重复', () => {
    const text = composeIdentity({
      id: 'x',
      name: 'A',
      title: '同一句话',
      description: '同一句话',
    });
    assert.equal(text.split('同一句话').length - 1, 1, '不该出现两次');
  });

  it('简介与描述不同则都带上', () => {
    const text = composeIdentity({
      id: 'x',
      name: 'A',
      title: '短简介',
      description: '更长的职责说明',
    });
    assert.ok(text.includes('短简介'));
    assert.ok(text.includes('更长的职责说明'));
  });

  it('没有简介 / 描述时也能用', () => {
    const text = composeIdentity({ id: 'x', name: '光杆司令' });
    assert.ok(text.includes('光杆司令'));
    assert.equal(text.split('\n').length, 1);
  });

  it('名字里的特殊字符不会破坏结构', () => {
    const text = composeIdentity({ id: 'x', name: 'A「B」C' });
    assert.ok(text.includes('A「B」C'));
  });
});

/**
 * 群回合里也要认得出自己：
 * 同事名单排除了自己，如果身份块再没有名字，它就不知道「我」是谁。
 */
describe('群回合里的自我认知', () => {
  const members = [
    { id: 'self', name: '测试运维' },
    { id: 'other', name: '知识库服务' },
  ];

  it('简报把自己从同事名单里排除，身份靠身份块补', () => {
    const brief = buildRoomBrief({
      roomName: '白泽联调',
      members,
      selfId: 'self',
      speaker: '主人',
      summoned: true,
      everyone: false,
      postLimit: 3,
    });
    assert.ok(!brief.includes('测试运维'), '名单里不该有自己');
    assert.ok(brief.includes('知识库服务'), '名单里该有同事');

    // 身份块负责告诉它「你是谁」
    const identity = composeIdentity({ id: 'self', name: '测试运维' });
    assert.ok(identity.includes('测试运维'));
  });

  it('被点名的措辞在二次叫醒时不同', () => {
    const base = {
      roomName: 'R',
      members,
      selfId: 'self',
      speaker: '主人',
      summoned: true,
      everyone: false,
      postLimit: 3,
    };
    // 用户直接点名
    assert.ok(buildRoomBrief(base).includes('**有人点名了你，你必须开口。**'));
    // 同事发言里点名（二次叫醒）
    const recalled = buildRoomBrief({ ...base, recallCount: 2 });
    assert.ok(recalled.includes('**有同事在发言里点名了你，你必须开口回应。**'));
    assert.ok(!recalled.includes('**有人点名了你，你必须开口。**'), '措辞应区分开');
  });

  it('同事来信的简报里说明对方是谁', () => {
    const brief = buildAgentBrief({ fromName: '知识库服务', depth: 1, maxDepth: 3 });
    assert.ok(brief.includes('知识库服务'));
    assert.ok(brief.includes('1/3'));
  });
});
