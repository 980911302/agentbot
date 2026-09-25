import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  CHANNEL_SKELETON_DELAY_MS,
  botSummaryFor,
  channelSkeletonVisible,
  controlInputFor,
  latestRoomRun,
  liveMembersOf,
  runningToolName,
  stopInFlightFor,
  withWorkingStatus,
  workingAgentIds,
} from '../web/src/features/chat/live-view.js';
import type { ChatRun } from '../src/shared/contracts/chat-state.js';
import type { BotSummary, DisplayMessage } from '../web/src/types.js';

function run(overrides: Partial<ChatRun> & { runId: string }): ChatRun {
  const channelId = overrides.channelId ?? 'c1';
  return {
    taskId: overrides.runId,
    channelId,
    // 停止探测看的是 agentId（原实现如此），默认让它等于频道 id
    agentId: channelId,
    kind: 'agent',
    source: 'user',
    input: '',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

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

function message(overrides: Partial<DisplayMessage> & { id: string }): DisplayMessage {
  return { role: 'assistant', content: '', toolCalls: [], createdAt: '', ...overrides };
}

describe('stopInFlightFor：停止中的运行', () => {
  it('只认同一频道、kind=stop 且还活着的 run', () => {
    const runs = [
      run({ runId: 'r1', channelId: 'c1', kind: 'stop', status: 'running' }),
      run({ runId: 'r2', channelId: 'c2', kind: 'stop', status: 'running' }),
      run({ runId: 'r3', channelId: 'c1', kind: 'agent', status: 'running' }),
    ];
    assert.equal(stopInFlightFor(runs, 'c1'), true);
    assert.equal(stopInFlightFor(runs, 'c2'), true);
    assert.equal(stopInFlightFor(runs, 'c3'), false);
  });

  it('queued / finalizing 也算在停止中，done 与 failed 不算', () => {
    const at = (status: ChatRun['status']) =>
      stopInFlightFor([run({ runId: status, kind: 'stop', status })], 'c1');
    assert.equal(at('queued'), true);
    assert.equal(at('running'), true);
    assert.equal(at('finalizing'), true);
    assert.equal(at('succeeded'), false);
    assert.equal(at('failed'), false);
    assert.equal(at('interrupted'), false);
  });
});

describe('latestRoomRun：群回合进行中', () => {
  it('取最后一个进行中的群成员 run（倒序找）', () => {
    const runs = [
      run({ runId: 'a', roomId: 'room', kind: 'agent', status: 'running', agentId: 'bot-a' }),
      run({ runId: 'b', roomId: 'room', kind: 'agent', status: 'queued', agentId: 'bot-b' }),
    ];
    assert.equal(latestRoomRun(runs, 'room')?.agentId, 'bot-b');
  });

  it('终态 / kind=stop / 别的房间都不算', () => {
    const runs = [
      run({ runId: 'a', roomId: 'room', kind: 'agent', status: 'succeeded', agentId: 'bot-a' }),
      run({ runId: 'b', roomId: 'room', kind: 'stop', status: 'running', agentId: 'bot-b' }),
      run({ runId: 'c', roomId: 'other', kind: 'agent', status: 'running', agentId: 'bot-c' }),
    ];
    assert.equal(latestRoomRun(runs, 'room'), undefined);
  });
});

describe('workingAgentIds / withWorkingStatus：谁在工作', () => {
  it('排队与执行中算工作中，finalizing 与终态不算', () => {
    const ids = workingAgentIds([
      run({ runId: 'a', agentId: 'bot-a', status: 'queued' }),
      run({ runId: 'b', agentId: 'bot-b', status: 'running' }),
      run({ runId: 'c', agentId: 'bot-c', status: 'finalizing' }),
      run({ runId: 'd', agentId: 'bot-d', status: 'succeeded' }),
      run({ runId: 'e', agentId: undefined, status: 'running' }),
    ]);
    assert.deepEqual([...ids].sort(), ['bot-a', 'bot-b']);
  });

  it('把工作状态合进频道与群成员，未在跑的保持原状态', () => {
    const channels: TestChannel[] = [
      channel({
        id: 'room',
        kind: 'room',
        members: [
          { id: 'bot-a', name: 'A', color: '#111111', status: 'idle' },
          { id: 'bot-b', name: 'B', color: '#222222', status: 'paused' },
        ],
      }),
      channel({ id: 'bot-a', status: 'idle' }),
      channel({ id: 'bot-c', status: 'error' }),
    ];
    const live = withWorkingStatus(channels, new Set(['bot-a', 'room']));
    assert.equal(live[0]?.status, 'working');
    assert.deepEqual(
      live[0]?.members?.map((member: { id: string; status?: string }) => `${member.id}:${member.status}`),
      ['bot-a:working', 'bot-b:paused'],
    );
    assert.equal(live[1]?.status, 'working');
    assert.equal(live[2]?.status, 'error');
  });
});

describe('liveMembersOf：当前频道的成员', () => {
  it('群返回成员表，私聊与未选中返回空数组', () => {
    const channels = [
      channel({ id: 'room', members: [{ id: 'bot-a', name: 'A', color: '#111111' }] }),
      channel({ id: 'bot-a' }),
    ];
    assert.deepEqual(liveMembersOf(channels, 'room'), [{ id: 'bot-a', name: 'A', color: '#111111' }]);
    assert.deepEqual(liveMembersOf(channels, 'bot-a'), []);
    assert.deepEqual(liveMembersOf(channels, ''), []);
  });
});

describe('controlInputFor：控制状态条输入', () => {
  const flags = {
    'bot-a': { paused: true, pendingMail: 2, failedMail: 1, held: 3, faulted: false },
  };

  it('私聊有快照才给输入，paused 映射成 paused', () => {
    assert.deepEqual(controlInputFor(flags, 'bot-a', 'agent', true), {
      autoActivation: 'paused',
      held: 3,
      faulted: false,
      pendingMail: 2,
      failedMail: 1,
      stopInFlight: true,
    });
  });

  it('群不显示（没有单智能体许可态），没快照也不显示', () => {
    assert.equal(controlInputFor(flags, 'bot-a', 'room', false), null);
    assert.equal(controlInputFor(flags, 'bot-b', 'agent', false), null);
    assert.equal(controlInputFor(flags, '', 'agent', false), null);
  });

  it('没暂停就是 enabled', () => {
    const enabled = { 'bot-a': { paused: false, pendingMail: 0, failedMail: 0, held: 0, faulted: true } };
    assert.equal(controlInputFor(enabled, 'bot-a', 'agent', false)?.autoActivation, 'enabled');
  });
});

describe('runningToolName：顶栏活动文字', () => {
  it('从最新消息往回找第一个还在跑的工具', () => {
    const messages = [
      message({
        id: 'm1',
        toolCalls: [
          { id: 't1', name: 'Read', arguments: '{}', status: 'ok' },
          { id: 't2', name: 'Shell', arguments: '{}', status: 'running' },
        ],
      }),
      message({ id: 'm2', toolCalls: [{ id: 't3', name: 'Write', arguments: '{}', status: 'running' }] }),
    ];
    assert.equal(runningToolName(messages), 'Write');
  });

  it('没有正在跑的工具就是 null', () => {
    assert.equal(runningToolName([]), null);
    assert.equal(
      runningToolName([
        message({ id: 'm1', toolCalls: [{ id: 't1', name: 'Read', arguments: '{}', status: 'error' }] }),
      ]),
      null,
    );
  });
});

describe('botSummaryFor：当前频道的 BotSummary', () => {
  it('后端记录优先，字段缺省时用频道条目兜底', () => {
    const summary = botSummaryFor({
      channel: channel({ id: 'bot-a', name: '频道名', role: '频道职责', color: '#abcabc' }),
      record: bot({ id: 'bot-a', name: '记录名', title: '标题', role: '记录职责', color: '#123456' }),
      messages: [],
      responding: false,
      liveText: '',
    });
    assert.equal(summary.name, '记录名');
    assert.equal(summary.title, '标题');
    assert.equal(summary.role, '记录职责');
    assert.equal(summary.color, '#123456');
    assert.equal(summary.status, 'idle');
  });

  it('没有记录时用频道条目，配色回默认棕', () => {
    const summary = botSummaryFor({
      channel: channel({ id: 'bot-a', name: '频道名' }),
      record: null,
      messages: [],
      responding: false,
      liveText: '',
    });
    assert.equal(summary.name, '频道名');
    assert.equal(summary.color, '#b89b6a');
    assert.equal(summary.role, '');
  });

  it('回复中统一说 working，有流式增量才是 thinking', () => {
    const base = {
      channel: channel({ id: 'bot-a' }),
      record: bot({ id: 'bot-a', status: 'error' }),
      messages: [],
    };
    assert.equal(botSummaryFor({ ...base, responding: true, liveText: '' }).status, 'working');
    assert.equal(botSummaryFor({ ...base, responding: true, liveText: '半句' }).status, 'thinking');
    assert.equal(botSummaryFor({ ...base, responding: false, liveText: '' }).status, 'error');
    assert.equal(botSummaryFor({ ...base, record: null, responding: false, liveText: '' }).status, 'idle');
  });

  it('活动取自本轮还在跑的工具，计数缺省归零', () => {
    const summary = botSummaryFor({
      channel: channel({ id: 'bot-a' }),
      record: null,
      messages: [
        message({ id: 'm1', toolCalls: [{ id: 't1', name: 'Shell', arguments: '{}', status: 'running' }] }),
      ],
      responding: true,
      liveText: '',
    });
    assert.equal(summary.activity, 'Shell');
    assert.equal(summary.conversationCount, 0);
  });
});

describe('channelSkeletonVisible：频道骨架', () => {
  it('只有「没拉到过快照 + 等过阈值 + 一条消息都没有」才显示', () => {
    assert.equal(channelSkeletonVisible(false, true, 0), true);
    assert.equal(channelSkeletonVisible(true, true, 0), false);
    assert.equal(channelSkeletonVisible(false, false, 0), false);
    assert.equal(channelSkeletonVisible(false, true, 1), false);
  });

  it('等待阈值是 300ms（bug_d2xiqthtxdmm 的行为契约）', () => {
    assert.equal(CHANNEL_SKELETON_DELAY_MS, 300);
  });
});
