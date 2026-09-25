import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  channelFromBot,
  channelFromRoom,
  failedAgentChannel,
  mergeBotIntoChannels,
  mergeRoomIntoChannels,
  nextActiveChannelId,
  prependChannel,
  removeChannel,
  renameChannelInList,
  replaceRoom,
  upsertRoomFirst,
} from '../web/src/features/workspace/channel-actions-view.js';
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

describe('failedAgentChannel：建同事失败', () => {
  it('说明原因、标红，id 与时间由调用方给', () => {
    assert.deepEqual(failedAgentChannel({ id: 'failed-1', time: '刚刚' }), {
      id: 'failed-1',
      name: '创建失败',
      time: '刚刚',
      lastMessage: '后端未连接，智能体没有创建成功',
      color: '#e24b4b',
    });
  });
});

describe('channelFromBot / channelFromRoom：新建频道条目', () => {
  it('智能体条目的时间恒为「刚刚」，职责当一句话简介，缺职责说准备就绪', () => {
    assert.deepEqual(channelFromBot({ id: 'b1', name: '小助手', role: '代码审查', color: '#111111' }), {
      id: 'b1',
      name: '小助手',
      time: '刚刚',
      lastMessage: '代码审查',
      color: '#111111',
      role: '代码审查',
      kind: 'agent',
    });
    assert.equal(channelFromBot({ id: 'b2', name: '无职责' }).lastMessage, '准备就绪');
  });

  it('群条目带成员表、人数与 isGroup，颜色取第一个成员、缺省回默认棕', () => {
    const withMembers = channelFromRoom(
      room({
        id: 'r1',
        name: '发布小组',
        updatedAt: 0,
        members: [
          { id: 'b1', name: '甲', color: '#111111' },
          { id: 'b2', name: '乙', color: '#222222' },
        ],
      }),
    );
    assert.deepEqual(withMembers, {
      id: 'r1',
      name: '发布小组',
      time: '刚刚',
      lastMessage: '还没有人说话',
      color: '#111111',
      role: '2 位成员',
      isGroup: true,
      kind: 'room',
      members: [
        { id: 'b1', name: '甲', color: '#111111' },
        { id: 'b2', name: '乙', color: '#222222' },
      ],
    });
    assert.equal(channelFromRoom(room({ id: 'r2' })).color, '#b89b6a');
    assert.equal(channelFromRoom(room({ id: 'r2' })).role, '0 位成员');
  });
});

describe('列表变换：新增 / 删除 / 选中', () => {
  const list = [channel({ id: 'a' }), channel({ id: 'b' })];

  it('新频道插到最前，已在列表里就不重复插', () => {
    assert.deepEqual(
      prependChannel(list, channel({ id: 'c' })).map((item) => item.id),
      ['c', 'a', 'b'],
    );
    assert.equal(prependChannel(list, channel({ id: 'a' })), list);
  });

  it('删除只摘掉对应一项', () => {
    assert.deepEqual(
      removeChannel(list, 'a').map((item) => item.id),
      ['b'],
    );
  });

  it('删的是当前频道就选剩下的第一个，删光了就空选中', () => {
    assert.equal(nextActiveChannelId('a', 'a', [channel({ id: 'b' })]), 'b');
    assert.equal(nextActiveChannelId('a', 'a', []), '');
  });

  it('删的不是当前频道时保持选中不变', () => {
    assert.equal(nextActiveChannelId('a', 'b', [channel({ id: 'a' })]), 'a');
  });
});

describe('房间列表变换', () => {
  it('建群插到最前并去掉同 id 旧项', () => {
    const rooms = [room({ id: 'r1' }), room({ id: 'r2' })];
    const next = upsertRoomFirst(rooms, room({ id: 'r2', name: '改名后' }));
    assert.deepEqual(
      next.map((item) => `${item.id}:${item.name}`),
      ['r2:改名后', 'r1:r1'],
    );
  });

  it('拉人踢人回来替换同一房间', () => {
    const rooms = [room({ id: 'r1' }), room({ id: 'r2' })];
    const updated = room({ id: 'r2', memberIds: ['b1'] });
    assert.equal(replaceRoom(rooms, updated)[1], updated);
    assert.equal(replaceRoom(rooms, updated)[0], rooms[0]);
  });
});

describe('mergeRoomIntoChannels：成员表变化同步侧栏', () => {
  it('人数 / 成员 / 最后一句都跟着服务端走', () => {
    const channels = [channel({ id: 'r1', role: '1 位成员', lastMessage: '旧' }), channel({ id: 'b1' })];
    const next = mergeRoomIntoChannels(
      channels,
      room({
        id: 'r1',
        members: [
          { id: 'b1', name: '甲', color: '#111111' },
          { id: 'b2', name: '乙', color: '#222222' },
        ],
        lastMessage: { text: '新的一句', senderName: '甲', createdAt: 1 },
      }),
    );
    assert.equal(next[0]?.role, '2 位成员');
    assert.equal(next[0]?.lastMessage, '新的一句');
    assert.equal(next[0]?.members?.length, 2);
    assert.equal(next[1], channels[1]);
  });

  it('房间还没有最后一句时保留原来的', () => {
    const channels = [channel({ id: 'r1', lastMessage: '旧' })];
    assert.equal(mergeRoomIntoChannels(channels, room({ id: 'r1' }))[0]?.lastMessage, '旧');
  });
});

describe('mergeBotIntoChannels / renameChannelInList：改名与资料', () => {
  it('资料保存回来同步名字与配色，职责为空时保留原值', () => {
    const channels = [channel({ id: 'b1', name: '旧名', color: '#000000', role: '旧职责' })];
    const next = mergeBotIntoChannels(channels, bot({ id: 'b1', name: '新名', color: '#ffffff', role: '' }));
    assert.equal(next[0]?.name, '新名');
    assert.equal(next[0]?.color, '#ffffff');
    assert.equal(next[0]?.role, '旧职责');
  });

  it('群改名只动那一项', () => {
    const channels = [channel({ id: 'r1', name: '旧名' }), channel({ id: 'b1', name: '别人' })];
    const next = renameChannelInList(channels, 'r1', '新名字');
    assert.deepEqual(
      next.map((item) => item.name),
      ['新名字', '别人'],
    );
  });
});
