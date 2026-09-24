import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { DisplayMessage } from '../web/src/types.js';
import {
  dateDividerLabel,
  groupTimelineMessages,
  jumpToBottomVisible,
  needsDateDivider,
  type TimelineEntry,
} from '../web/src/features/chat/timeline-view.js';

/** 造一条展示用消息：默认按 1 分钟步进的时间戳由调用方给 */
const msg = (
  id: string,
  role: 'user' | 'assistant',
  createdAt: number,
  over: Partial<DisplayMessage> = {},
): DisplayMessage => ({
  id,
  agentId: 'a1',
  role,
  content: `内容-${id}`,
  toolCalls: [],
  createdAt: new Date(createdAt).toISOString(),
  ...over,
});

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0); // 2026-09-25 10:00 UTC
const MIN = 60_000;

describe('groupTimelineMessages：同一发言者 3 分钟内合并', () => {
  it('同一发言者 3 分钟内的连续消息合成一组，只首条带头像名字时间', () => {
    const messages = [
      msg('m1', 'user', T0),
      msg('m2', 'user', T0 + 1 * MIN),
      msg('m3', 'user', T0 + 2 * MIN),
    ];
    const entries = groupTimelineMessages(messages, { isGroup: false, now: T0 });
    const groups = entries.filter((entry) => entry.kind === 'group');
    assert.equal(groups.length, 1, '三条连着的消息只该有一组');
    const group = groups[0] as Extract<TimelineEntry, { kind: 'group' }>;
    assert.equal(group.messages.length, 3);
    assert.equal(group.showSender, true, '首条要显示发送者');
    assert.equal(group.messages[1]?.id, 'm2');
  });

  it('超过 3 分钟就断开：不把跨时段的消息糊成一组', () => {
    const messages = [
      msg('m1', 'user', T0),
      msg('m2', 'user', T0 + 5 * MIN),
    ];
    const entries = groupTimelineMessages(messages, { isGroup: false, now: T0 });
    const groups = entries.filter((entry) => entry.kind === 'group');
    assert.equal(groups.length, 2, '跨过 3 分钟要断成两组');
  });

  it('正好 3 分钟边界算同一组（含端点）', () => {
    const messages = [
      msg('m1', 'user', T0),
      msg('m2', 'user', T0 + 3 * MIN),
    ];
    const entries = groupTimelineMessages(messages, { isGroup: false, now: T0 });
    assert.equal(entries.filter((entry) => entry.kind === 'group').length, 1, '正好 3 分钟算同一组');
  });

  it('换发言者就断开，即使时间相邻', () => {
    const messages = [
      msg('m1', 'user', T0),
      msg('m2', 'assistant', T0 + 10_000, { sender: { kind: 'agent', id: 'bot', name: '小审' } }),
    ];
    const entries = groupTimelineMessages(messages, { isGroup: false, now: T0 });
    const groups = entries.filter((entry) => entry.kind === 'group');
    assert.equal(groups.length, 2, '跨过 3 分钟要断成两组');
  });

  it('群聊里同一发言者同样合并，发言人身份跟着组', () => {
    const sender = { kind: 'agent' as const, id: 'bot', name: '小审' };
    const messages = [
      msg('m1', 'assistant', T0, { sender }),
      msg('m2', 'assistant', T0 + MIN, { sender }),
    ];
    const entries = groupTimelineMessages(messages, { isGroup: true, now: T0 });
    const groups = entries.filter((entry) => entry.kind === 'group');
    assert.equal(groups.length, 1);
    const group = groups[0] as Extract<TimelineEntry, { kind: 'group' }>;
    assert.equal(group.senderName, '小审');
  });

  it('中间夹了工具调用/思考块也断开：合并只针对纯文本连续发言', () => {
    const messages = [
      msg('m1', 'assistant', T0, { sender: { kind: 'agent', id: 'bot', name: '小审' } }),
      msg('m2', 'assistant', T0 + MIN, {
        sender: { kind: 'agent', id: 'bot', name: '小审' },
        content: '',
        toolCalls: [{ id: 'c1', name: 'Read', arguments: '{}', status: 'ok', result: 'x' }],
      }),
      msg('m3', 'assistant', T0 + 2 * MIN, { sender: { kind: 'agent', id: 'bot', name: '小审' } }),
    ];
    const entries = groupTimelineMessages(messages, { isGroup: false, now: T0 });
    assert.equal(entries.filter((entry) => entry.kind === 'group').length, 3, '工具调用不并进气泡');
  });

  it('空内容的消息不渲染（历史行为保持）', () => {
    const messages = [msg('m1', 'user', T0), msg('m2', 'user', T0 + MIN, { content: '  ' })];
    const entries = groupTimelineMessages(messages, { isGroup: false, now: T0 });
    const groups = entries.filter((entry) => entry.kind === 'group');
    assert.equal(groups.length, 1, '三条连着的消息只该有一组');
    const group = groups[0] as Extract<TimelineEntry, { kind: 'group' }>;
    assert.equal(group.messages.length, 1);
  });
});

describe('dateDividerLabel：日期分隔的文案', () => {
  const label = (ms: number) => dateDividerLabel(ms, { now: T0 });

  it('当天显示「今天」', () => {
    assert.equal(label(T0), '今天');
  });

  it('前一天显示「昨天」', () => {
    assert.equal(label(T0 - 24 * 60 * MIN), '昨天');
  });

  it('更早显示 M/D', () => {
    assert.equal(label(Date.UTC(2026, 8, 20, 8, 0, 0)), '9/20');
  });

  it('跨年也走 M/D', () => {
    assert.equal(label(Date.UTC(2025, 11, 31, 8, 0, 0)), '12/31');
  });
});

describe('needsDateDivider：跨天才插', () => {
  it('没有上一条（第一条）就插，给时间线一个起点', () => {
    assert.equal(needsDateDivider(T0, null), true);
  });

  it('同一天不插', () => {
    assert.equal(needsDateDivider(T0, T0 - MIN), false);
    assert.equal(needsDateDivider(T0 + 5 * MIN, T0), false);
  });

  it('跨天插', () => {
    assert.equal(needsDateDivider(T0, T0 - 24 * 60 * MIN), true);
  });
});

describe('groupTimelineMessages：跨天插分隔行', () => {
  it('第一天与次日的消息之间插一个「昨天」', () => {
    const messages = [msg('m1', 'user', T0), msg('m2', 'user', T0 + 24 * 60 * MIN)];
    const entries = groupTimelineMessages(messages, { isGroup: false, now: T0 + 48 * 60 * MIN });
    const kinds = entries.map((entry) => entry.kind);
    assert.deepEqual(kinds, ['divider', 'group', 'divider', 'group']);
    assert.equal((entries[0] as Extract<TimelineEntry, { kind: 'divider' }>).label, '9/25');
    assert.equal((entries[2] as Extract<TimelineEntry, { kind: 'divider' }>).label, '昨天');
  });

  it('同一天的多组消息之间不插分隔', () => {
    const messages = [
      msg('m1', 'user', T0),
      msg('m2', 'assistant', T0 + 10 * MIN, { sender: { kind: 'agent', id: 'bot', name: '小审' } }),
    ];
    const entries = groupTimelineMessages(messages, { isGroup: false, now: T0 });
    assert.equal(entries.filter((entry) => entry.kind === 'group').length, 2);
    // 只为第一条插一个起点分隔，两条之间不再插
    assert.equal(entries.filter((entry) => entry.kind === 'divider').length, 1);
  });

  it('空时间线不给分隔', () => {
    assert.deepEqual(groupTimelineMessages([], { isGroup: false, now: T0 }), []);
  });
});

describe('jumpToBottomVisible：离底部 >200px 才显示浮钮', () => {
  it('贴着底部不显示', () => {
    assert.equal(jumpToBottomVisible({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }), false);
  });

  it('正好 200px 算贴着，不显示', () => {
    assert.equal(jumpToBottomVisible({ scrollHeight: 1000, scrollTop: 600, clientHeight: 200 }), false);
  });

  it('超过 200px 显示', () => {
    assert.equal(jumpToBottomVisible({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 }), true);
  });

  it('容器还没布局出来时不显示', () => {
    assert.equal(jumpToBottomVisible({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 }), false);
  });
});
