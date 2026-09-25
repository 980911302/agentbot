import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  headerMemberStack,
  memberPauseTag,
  roomFlowPhaseLabel,
  type FlowActor,
  type StackMember,
} from '../web/src/features/chat/group-view.js';

const member = (id: string, name: string, status?: string): StackMember => ({ id, name, status });

describe('headerMemberStack：群顶栏成员叠放', () => {
  it('最多露出 4 个，其余折算成 +N', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => member(id, `成员${id}`));
    const stack = headerMemberStack(many);
    assert.deepEqual(stack.visible.map((m) => m.id), ['a', 'b', 'c', 'd']);
    assert.equal(stack.more, 2);
  });

  it('正好 4 个不给 +N', () => {
    const four = ['a', 'b', 'c', 'd'].map((id) => member(id, `成员${id}`));
    const stack = headerMemberStack(four);
    assert.equal(stack.visible.length, 4);
    assert.equal(stack.more, 0);
  });

  it('可改上限', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => member(id, `成员${id}`));
    const stack = headerMemberStack(six, 3);
    assert.equal(stack.visible.length, 3);
    assert.equal(stack.more, 3);
  });

  it('没有成员时不出叠放', () => {
    const stack = headerMemberStack([]);
    assert.deepEqual(stack.visible, []);
    assert.equal(stack.more, 0);
  });
});

describe('memberPauseTag：暂停成员在群里显示「暂停」', () => {
  it('暂停的成员给「暂停」标记', () => {
    assert.equal(memberPauseTag(member('a', '甲', 'paused')), '暂停');
  });

  it('没暂停的不给标记（沉默就是沉默，不冒充暂停）', () => {
    assert.equal(memberPauseTag(member('a', '甲', 'working')), null);
    assert.equal(memberPauseTag(member('a', '甲', 'idle')), null);
    assert.equal(memberPauseTag(member('a', '甲')), null);
  });

  it('paused 盖过 running：停了就不会还在干活', () => {
    assert.equal(memberPauseTag(member('a', '甲', 'paused')), '暂停');
  });
});

describe('roomFlowPhaseLabel：受控流程条文案', () => {
  const actor = (kind: 'user' | 'agent', id: string, name: string): FlowActor => ({ kind, id, name });

  it('进行中显示行动者名字', () => {
    const label = roomFlowPhaseLabel({
      status: 'active',
      phase: 'round_1',
      actors: [actor('agent', 'a', '同事甲')],
    });
    assert.equal(label.text, '进行中 · 行动方：同事甲');
    assert.equal(label.warn, false);
  });

  it('等待用户时只说是等用户，不编造行动者', () => {
    const label = roomFlowPhaseLabel({ status: 'awaiting_user', phase: 'round_2', actors: [] });
    assert.equal(label.text, '等待用户行动');
    assert.equal(label.warn, false);
  });

  it('暂停用 warn 语义（--warn-weak 底色）', () => {
    const label = roomFlowPhaseLabel({ status: 'paused', phase: 'round_1', actors: [] });
    assert.equal(label.warn, true);
    assert.match(label.text, /已暂停/);
  });

  it('多个行动者都列出来', () => {
    const label = roomFlowPhaseLabel({
      status: 'active',
      phase: 'round_1',
      actors: [actor('agent', 'a', '甲'), actor('agent', 'b', '乙')],
    });
    assert.match(label.text, /甲/);
    assert.match(label.text, /乙/);
  });

  it('用户行动者显示「用户」而不是 id', () => {
    const label = roomFlowPhaseLabel({ status: 'active', phase: 'round_1', actors: [actor('user', 'owner', '主人')] });
    assert.match(label.text, /用户/);
    assert.doesNotMatch(label.text, /owner/);
  });
});
