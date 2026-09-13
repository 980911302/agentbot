import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ROOM_SKILL, buildRoomBrief, decideRoomPosts } from '../src/room/turn.js';

/** 沉默是一等公民：开口与闭嘴的判定必须精确 */
describe('开口 / 沉默判定', () => {
  const members = [
    { id: 'self', name: '测试运维' },
    { id: 'other', name: '知识库服务' },
  ];

  it('没被点名 + 只写了收尾文本 → 沉默（防止刷屏）', () => {
    const posts = decideRoomPosts({
      sent: [],
    });
    assert.deepEqual(posts, []);
  });

  it('没被点名 + 显式 SendToUser → 开口', () => {
    const posts = decideRoomPosts({
      sent: ['我这边有补充：159 的 yaml 还缺一段'],
    });
    assert.deepEqual(posts, ['我这边有补充：159 的 yaml 还缺一段']);
  });

  it('被点名 + 只写了收尾文本 → 仍然沉默（普通文本只是草稿）', () => {
    const posts = decideRoomPosts({
      sent: [],
    });
    assert.deepEqual(posts, []);
  });

  it('被点名 + 什么都没说 → 沉默（空文本不算发言）', () => {
    assert.deepEqual(decideRoomPosts({ sent: [] }), []);
  });

  it('被点名 + SendToUser 发了多条 → 全部保留', () => {
    const posts = decideRoomPosts({
      sent: ['第一条', '第二条'],
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

  it('被点名时以必须回应覆盖一般沉默规则', () => {
    const brief = buildRoomBrief({ ...base, summoned: true, everyone: false });
    assert.ok(brief.includes('必须开口'));
    assert.ok(brief.includes('被点名了，必须按当前消息的意图'));
    assert.ok(brief.includes('SendToUser'));
  });

  it('未被点名时写清可以闭嘴', () => {
    const brief = buildRoomBrief({ ...base, summoned: false, everyone: false });
    assert.ok(brief.includes('没有人点名你'));
    assert.ok(brief.includes('零次出口就是沉默'));
    assert.ok(!brief.includes('stay_silent'));
    assert.ok(brief.includes('实质、未被说过且属于你的职责'));
  });

  it('面向全群的社交交流要求全员各回一次且不触发级联', () => {
    const brief = buildRoomBrief({ ...base, summoned: false, everyone: false });
    assert.ok(brief.includes('每位在场成员各回应一次'));
    assert.ok(brief.includes('面向全群的社交交流须回应一条短消息'));
    assert.ok(brief.includes('不得提出方案、分派工作、点名同事、汇报旧进展或发起后续议程'));
    assert.ok(!brief.includes('naturalResponder'));
  });

  it('稳定群规则保持精简且不依赖固定话术示例', () => {
    assert.ok(ROOM_SKILL.length < 900);
    assert.ok(buildRoomBrief({ ...base, summoned: false, everyone: false }).length < 1400);
    assert.ok(!ROOM_SKILL.includes('你们好'));
    assert.ok(!ROOM_SKILL.includes('大家好'));
  });

  it('群简报允许用自己的结论，但禁止贴私聊和带入保密内容', () => {
    const brief = buildRoomBrief({ ...base, summoned: false, everyone: false });
    assert.ok(brief.includes('自己私聊和记忆中的结论'));
    assert.ok(brief.includes('不得粘贴私聊原文'));
    assert.ok(brief.includes('主人标为私密的内容'));
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
