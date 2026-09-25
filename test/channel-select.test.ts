import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  EMPTY_CHANNEL,
  activeAgentIdFor,
  activeRoomFor,
  selectActiveChannel,
} from '../web/src/features/workspace/channel-select.js';
import type { BotSummary, RoomView } from '../web/src/types.js';

/** ChannelItem 的结构化子集：测试里不 import .tsx（根 tsconfig 没有 jsx），只按形状对齐 */
type TestChannel = {
  id: string;
  name: string;
  time: string;
  lastMessage: string;
  color?: string;
  role?: string;
  isGroup?: boolean;
  kind?: 'room' | 'agent';
  members?: Array<{ id: string; name: string; color: string; status?: string }>;
  status?: 'idle' | 'thinking' | 'working' | 'error';
  unread?: number;
  paused?: boolean;
  pendingMail?: number;
  failedMail?: number;
};

function channel(overrides: Partial<TestChannel> & { id: string }): TestChannel {
  return { name: overrides.id, time: '', lastMessage: '', ...overrides };
}

function bot(overrides: Partial<BotSummary> & { id: string }): BotSummary {
  return {
    name: overrides.id,
    role: '',
    color: '#000000',
    status: 'idle',
    activity: '',
    conversationCount: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function room(overrides: Partial<RoomView> & { id: string }): RoomView {
  return {
    name: overrides.id,
    memberIds: [],
    members: [],
    messageCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('selectActiveChannel：当前该显示哪个频道', () => {
  const channels = [channel({ id: 'a' }), channel({ id: 'b' })];

  it('选中的在列表里就用它', () => {
    assert.equal(selectActiveChannel(channels, 'b').id, 'b');
  });

  it('选中的不在（被删/首屏）就用列表第一个', () => {
    assert.equal(selectActiveChannel(channels, 'gone').id, 'a');
    assert.equal(selectActiveChannel(channels, '').id, 'a');
  });

  it('一个频道都没有时用占位项', () => {
    assert.equal(selectActiveChannel([], ''), EMPTY_CHANNEL);
    assert.equal(EMPTY_CHANNEL.lastMessage, '点击左上方 + 创建智能体');
  });
});

describe('activeAgentIdFor：记忆面板看谁的记忆', () => {
  const members = [
    { id: 'm1', name: '甲', color: '#111111' },
    { id: 'm2', name: '乙', color: '#222222' },
  ];

  it('群用第一个成员', () => {
    assert.equal(activeAgentIdFor(channel({ id: 'r1', kind: 'room', members }), 'r1', []), 'm1');
  });

  it('群没有成员表就是 null', () => {
    assert.equal(activeAgentIdFor(channel({ id: 'r1', kind: 'room' }), 'r1', []), null);
  });

  it('私聊且确实存在这个智能体就用它', () => {
    const agents = [bot({ id: 'b2' }), bot({ id: 'b1' })];
    assert.equal(activeAgentIdFor(channel({ id: 'b2', kind: 'agent' }), 'b2', agents), 'b2');
  });

  it('私聊但选中项不是智能体（比如空选中）就用列表第一个', () => {
    const agents = [bot({ id: 'b1' }), bot({ id: 'b2' })];
    assert.equal(activeAgentIdFor(channel({ id: 'other', kind: 'agent' }), 'other', agents), 'b1');
    assert.equal(activeAgentIdFor(channel({ id: '', kind: 'agent' }), '', agents), 'b1');
  });

  it('一个智能体都没有就是 null', () => {
    assert.equal(activeAgentIdFor(channel({ id: '' }), '', []), null);
  });
});

describe('activeRoomFor：成员面板用哪个房间', () => {
  it('是群才给房间视图，否则 null', () => {
    const rooms = [room({ id: 'r1' }), room({ id: 'r2' })];
    assert.equal(activeRoomFor(rooms, 'r2')?.id, 'r2');
    assert.equal(activeRoomFor(rooms, 'b1'), null);
    assert.equal(activeRoomFor(rooms, ''), null);
  });
});
