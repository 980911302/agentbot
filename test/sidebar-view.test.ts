import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ChannelItem } from '../web/src/components/Sidebar.js';
import {
  channelStatusDot,
  nextSearchCursor,
  sidebarSections,
  type SidebarSectionState,
} from '../web/src/features/workspace/sidebar-view.ts';

const agent = (id: string, over: Partial<ChannelItem> = {}): ChannelItem => ({
  id,
  name: `同事-${id}`,
  time: '10:00',
  lastMessage: '预览',
  kind: 'agent',
  unread: 0,
  ...over,
});

const room = (id: string, over: Partial<ChannelItem> = {}): ChannelItem => ({
  id,
  name: `群-${id}`,
  time: '10:00',
  lastMessage: '预览',
  isGroup: true,
  kind: 'room',
  unread: 0,
  ...over,
});

describe('channelStatusDot', () => {
  it('什么都没有时不画点', () => {
    assert.equal(channelStatusDot(agent('a')).kind, null);
  });

  it('暂停盖过忙碌与来信：停了就不会再自动干活', () => {
    const channel = agent('a', { status: 'working', paused: true, pendingMail: 3, failedMail: 1 });
    const dot = channelStatusDot(channel);
    assert.equal(dot.kind, 'paused');
    assert.match(dot.title, /已暂停/);
    assert.match(dot.title, /3 条待处理来信/);
  });

  it('忙碌用信息色；有失败来信优先于普通待处理', () => {
    assert.equal(channelStatusDot(agent('a', { status: 'working' })).kind, 'busy');
    assert.equal(channelStatusDot(agent('a', { failedMail: 2 })).kind, 'failed');
    assert.equal(channelStatusDot(agent('a', { failedMail: 2 })).title, '有 2 条失败来信');
  });

  it('有待处理来信是空心点，只有一条时文案用单数语义', () => {
    const dot = channelStatusDot(agent('a', { pendingMail: 1 }));
    assert.equal(dot.kind, 'pending');
    assert.equal(dot.title, '有 1 条待处理来信');
  });

  it('群里不显示暂停与来信点（群自己不会暂停）', () => {
    assert.equal(channelStatusDot(room('r', { paused: true, failedMail: 2 })).kind, null);
  });
});

describe('sidebarSections', () => {
  const channels = [room('r1'), agent('a1'), agent('a2')];
  const open: SidebarSectionState = { rooms: false, agents: false };

  it('分成「群」「同事」两段，顺序固定', () => {
    const sections = sidebarSections(channels, open, '');
    assert.deepEqual(sections.map(section => section.title), ['群', '同事']);
    assert.deepEqual(sections[0]!.channels.map(item => item.id), ['r1']);
    assert.deepEqual(sections[1]!.channels.map(item => item.id), ['a1', 'a2']);
  });

  it('折叠后该段为空列表，不渲染', () => {
    const sections = sidebarSections(channels, { rooms: true, agents: false }, '');
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.title, '同事');
  });

  it('搜索时忽略折叠，两段都拿出来按名字过滤', () => {
    const sections = sidebarSections(channels, { rooms: true, agents: true }, 'a2');
    assert.deepEqual(sections.map(section => section.title), ['同事']);
    assert.deepEqual(sections[0]!.channels.map(item => item.id), ['a2']);
  });

  it('搜索只按名字过滤，不搜正文；大小写不敏感', () => {
    const named = [agent('a1', { name: 'Alpha' }), agent('a2', { name: 'beta', lastMessage: 'Alpha 相关' })];
    const sections = sidebarSections(named, open, 'al');
    assert.deepEqual(sections[0]!.channels.map(item => item.id), ['a1']);
  });

  it('空段不渲染：没有群时只剩同事段', () => {
    const sections = sidebarSections([agent('a1')], open, '');
    assert.deepEqual(sections.map(section => section.title), ['同事']);
  });
});

describe('nextSearchCursor', () => {
  it('从无选中开始向下走，越界回绕', () => {
    assert.equal(nextSearchCursor(-1, 3, 1), 0);
    assert.equal(nextSearchCursor(2, 3, 1), 0);
    assert.equal(nextSearchCursor(0, 3, -1), 2);
  });

  it('空结果保持无选中', () => {
    assert.equal(nextSearchCursor(1, 0, 1), -1);
  });
});
