import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ChannelItem } from '../web/src/components/Sidebar.js';
import {
  channelStatusDot,
  nextSearchCursor,
  sidebarSections,
  sidebarWidthByKey,
  snapSidebarWidth,
  unreadBadgeText,
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

  it('暂停盖过其它状态：停了就不会再自动干活', () => {
    const channel = agent('a', { status: 'working', paused: true, pendingMail: 3, failedMail: 1 });
    const dot = channelStatusDot(channel);
    assert.equal(dot.kind, 'paused');
    assert.match(dot.title, /已暂停/);
    assert.match(dot.title, /3 条消息等它处理/);
  });

  it('在干活不画点（只看脸）；没处理成功的消息优先于等待处理', () => {
    assert.equal(channelStatusDot(agent('a', { status: 'working' })).kind, null);
    assert.equal(channelStatusDot(agent('a', { failedMail: 2, pendingMail: 1 })).kind, 'failed');
    assert.equal(channelStatusDot(agent('a', { failedMail: 2 })).title, '有 2 条消息没处理成功');
  });

  it('有消息等处理是空心点', () => {
    const dot = channelStatusDot(agent('a', { pendingMail: 1 }));
    assert.equal(dot.kind, 'pending');
    assert.equal(dot.title, '有 1 条消息等它处理');
  });

  it('群里不显示暂停与消息状态点（群自己不会暂停）', () => {
    assert.equal(channelStatusDot(room('r', { paused: true, failedMail: 2 })).kind, null);
  });
});

describe('sidebarSections', () => {
  const channels = [room('r1'), agent('a1'), agent('a2')];
  const open: SidebarSectionState = { rooms: false, agents: false };
  const folded: SidebarSectionState = { rooms: true, agents: true };

  it('分成「群」「同事」两段，顺序固定', () => {
    const sections = sidebarSections(channels, open, '');
    assert.deepEqual(sections.map(section => section.title), ['群', '同事']);
    assert.deepEqual(sections[0]!.channels.map(item => item.id), ['r1']);
    assert.deepEqual(sections[1]!.channels.map(item => item.id), ['a1', 'a2']);
    assert.equal(sections[0]!.collapsed, false);
  });

  it('折叠只藏内容、不藏段头：段结构仍在，collapsed 标记为 true，频道数保留供段头计数', () => {
    const sections = sidebarSections(channels, folded, '');
    assert.deepEqual(sections.map(section => section.title), ['群', '同事'], '折叠后两段都还在，段头才点得到');
    const rooms = sections.find(section => section.id === 'rooms')!;
    assert.equal(rooms.collapsed, true);
    assert.deepEqual(rooms.channels.map(item => item.id), ['r1'], '频道仍随段返回，段头计数才准确');
    const agents = sections.find(section => section.id === 'agents')!;
    assert.equal(agents.collapsed, true);
    assert.equal(agents.channels.length, 2);
  });

  it('搜索时忽略折叠，两段都拿出来按名字过滤，且 collapsed 恒为 false', () => {
    const sections = sidebarSections(channels, folded, 'a2');
    assert.deepEqual(sections.map(section => section.title), ['同事']);
    assert.equal(sections[0]!.collapsed, false);
    assert.deepEqual(sections[0]!.channels.map(item => item.id), ['a2']);
  });

  it('搜索只按名字过滤，不搜正文；大小写不敏感', () => {
    const named = [agent('a1', { name: 'Alpha' }), agent('a2', { name: 'beta', lastMessage: 'Alpha 相关' })];
    const sections = sidebarSections(named, open, 'al');
    assert.deepEqual(sections[0]!.channels.map(item => item.id), ['a1']);
  });

  it('空段不渲染：没有群时只剩同事段（折叠与否都不造空段头）', () => {
    assert.deepEqual(sidebarSections([agent('a1')], open, '').map(section => section.title), ['同事']);
    assert.deepEqual(sidebarSections([agent('a1')], folded, '').map(section => section.title), ['同事']);
    assert.deepEqual(sidebarSections([room('r1')], folded, '').map(section => section.title), ['群']);
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

describe('unreadBadgeText：未读数徽标', () => {
  it('0 / 缺省 / 非法值不显示', () => {
    assert.equal(unreadBadgeText(0), '');
    assert.equal(unreadBadgeText(undefined), '');
    assert.equal(unreadBadgeText(Number.NaN), '');
  });

  it('显示条数，超过 99 显示 99+', () => {
    assert.equal(unreadBadgeText(3), '3');
    assert.equal(unreadBadgeText(99), '99');
    assert.equal(unreadBadgeText(120), '99+');
  });
});

describe('sidebarWidthByKey：拖拽手柄的键盘调宽', () => {
  it('左右方向键按 16px 步进，Shift 加速', () => {
    assert.equal(sidebarWidthByKey(260, 'ArrowRight'), 276);
    assert.equal(sidebarWidthByKey(260, 'ArrowLeft'), 244);
    assert.equal(sidebarWidthByKey(260, 'ArrowRight', true), 300);
  });

  it('和拖拽同一套吸附：窄到 160 以下收成迷你，迷你再按右键回到 200', () => {
    assert.equal(sidebarWidthByKey(200, 'ArrowLeft', true), 72);
    assert.equal(sidebarWidthByKey(72, 'ArrowRight'), 200);
    assert.equal(sidebarWidthByKey(300, 'ArrowRight'), 300);
  });

  it('Home / End 到两端，其它键不处理', () => {
    assert.equal(sidebarWidthByKey(260, 'Home'), 72);
    assert.equal(sidebarWidthByKey(260, 'End'), 300);
    assert.equal(sidebarWidthByKey(260, 'a'), null);
  });

  it('snapSidebarWidth 夹在 200–300', () => {
    assert.equal(snapSidebarWidth(100), 72);
    assert.equal(snapSidebarWidth(180), 200);
    assert.equal(snapSidebarWidth(999), 300);
  });
});
