import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildRoomBrief, decideRoomPosts } from '../src/room/turn.js';

/** 沉默是一等公民：开口与闭嘴的判定必须精确 */
describe('开口 / 沉默判定', () => {
  const members = [
    { id: 'self', name: '测试运维' },
    { id: 'other', name: '知识库服务' },
  ];

  it('没被点名 + 只写了收尾文本 → 沉默（防止刷屏）', () => {
    const posts = decideRoomPosts({
      said: [],
      summoned: false,
      finalText: '我看了下，没什么要补充的。',
    });
    assert.deepEqual(posts, []);
  });

  it('没被点名 + 显式 say → 开口', () => {
    const posts = decideRoomPosts({
      said: ['我这边有补充：159 的 yaml 还缺一段'],
      summoned: false,
      finalText: '不应该被采用',
    });
    assert.deepEqual(posts, ['我这边有补充：159 的 yaml 还缺一段']);
  });

  it('被点名 + 只写了收尾文本 → 仍算开口（模型没走工具不该被惩罚）', () => {
    const posts = decideRoomPosts({
      said: [],
      summoned: true,
      finalText: '我这边确认一下：Redis 是 171:6379 的 db1。',
    });
    assert.equal(posts.length, 1);
    assert.ok(posts[0]?.includes('171:6379'));
  });

  it('被点名 + 什么都没说 → 沉默（空文本不算发言）', () => {
    assert.deepEqual(decideRoomPosts({ said: [], summoned: true, finalText: '   ' }), []);
  });

  it('被点名 + say 了多条 → 全部保留，不追加收尾文本', () => {
    const posts = decideRoomPosts({
      said: ['第一条', '第二条'],
      summoned: true,
      finalText: '第三条（不该被追加）',
    });
    assert.deepEqual(posts, ['第一条', '第二条']);
  });
});

describe('群回合简报', () => {
  const base = {
    roomName: '白泽联调',
    members: [
      { id: 'self', name: '测试运维' },
      { id: 'other', name: '知识库服务' },
    ],
    selfId: 'self',
    speaker: '主人',
    postLimit: 3,
  };

  it('被点名时写清必须开口，且不提供沉默选项', () => {
    const brief = buildRoomBrief({ ...base, summoned: true, everyone: false });
    assert.ok(brief.includes('必须开口'));
    assert.ok(!brief.includes('沉默是正常结果'));
  });

  it('未被点名时写清可以闭嘴', () => {
    const brief = buildRoomBrief({ ...base, summoned: false, everyone: false });
    assert.ok(brief.includes('没有人点名你'));
    assert.ok(brief.includes('沉默是正常结果'));
  });

  it('@everyone 的措辞区别于单人点名', () => {
    const brief = buildRoomBrief({ ...base, summoned: true, everyone: true });
    assert.ok(brief.includes('@everyone'));
  });

  it('被同事二次叫醒时措辞不同', () => {
    const brief = buildRoomBrief({ ...base, summoned: true, everyone: false, recallCount: 2 });
    assert.ok(brief.includes('同事'), '应说明是同事点的名');
  });

  it('带上本轮已公开的发言，供后开口者参考', () => {
    const brief = buildRoomBrief({
      ...base,
      summoned: false,
      everyone: false,
      roundPosts: [{ speaker: '知识库服务', text: '我这边 yaml 已经核完了' }],
    });
    assert.ok(brief.includes('这一轮已经有人说过'));
    assert.ok(brief.includes('yaml 已经核完了'));
    assert.ok(brief.includes('不要复述'), '应提醒不要重复别人');
  });

  it('房间名与同事名单出现在简报里', () => {
    const brief = buildRoomBrief({ ...base, summoned: false, everyone: false });
    assert.ok(brief.includes('白泽联调'));
    assert.ok(brief.includes('知识库服务'));
    assert.ok(!brief.includes('测试运维'), '不应把自己列进同事名单');
  });
});
