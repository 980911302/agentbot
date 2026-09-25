import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { drawerTabs, drawerTarget } from '../web/src/features/workspace/drawer-view.js';

describe('drawerTabs：右侧面板页签', () => {
  it('私聊：资料 / 工作 / 记忆，没有「屏幕」', () => {
    assert.deepEqual(
      drawerTabs(false).map((tab) => tab.label),
      ['资料', '工作', '记忆'],
    );
  });

  it('群：工作 / 记忆 / 成员', () => {
    assert.deepEqual(
      drawerTabs(true).map((tab) => tab.id),
      ['work', 'memory', 'members'],
    );
  });
});

describe('drawerTarget：记忆 / 工作看的是谁', () => {
  const members = [
    { id: 'a', name: '阿黄' },
    { id: 'b', name: '小白' },
  ];

  it('私聊就是这位同事，标题用频道名', () => {
    assert.deepEqual(
      drawerTarget({ isGroup: false, members: [], focusId: null, fallbackId: 'x', channelName: '小审' }),
      { id: 'x', name: '小审' },
    );
  });

  it('群里默认第一个成员，标题写成员名而不是群名', () => {
    assert.deepEqual(
      drawerTarget({ isGroup: true, members, focusId: null, fallbackId: 'a', channelName: '发布小组' }),
      { id: 'a', name: '阿黄' },
    );
  });

  it('群里选了别的成员就看他', () => {
    assert.deepEqual(
      drawerTarget({ isGroup: true, members, focusId: 'b', fallbackId: 'a', channelName: '发布小组' }),
      { id: 'b', name: '小白' },
    );
  });

  it('选的人已不在群里：回到默认成员；空群没有可读对象', () => {
    assert.deepEqual(
      drawerTarget({ isGroup: true, members, focusId: 'gone', fallbackId: null, channelName: '发布小组' }),
      { id: 'a', name: '阿黄' },
    );
    assert.deepEqual(
      drawerTarget({ isGroup: true, members: [], focusId: null, fallbackId: null, channelName: '空群' }),
      { id: null, name: '空群' },
    );
  });
});
