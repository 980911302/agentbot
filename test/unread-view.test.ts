import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  READ_MARKS_KEY,
  UNREAD_CAP,
  loadReadMarks,
  reconcileUnread,
  sameUnread,
  saveReadMarks,
  type ReadMarksStore,
} from '../web/src/features/workspace/unread-view.js';

function store(initial: Record<string, string> = {}): ReadMarksStore & { written: Record<string, string> } {
  const written: Record<string, string> = { ...initial };
  return {
    written,
    getItem: (key) => written[key] ?? null,
    setItem: (key, value) => {
      written[key] = value;
    },
  };
}

describe('reconcileUnread：群与私聊一套未读', () => {
  it('首次加载没有任何记录：当前条数全当已读，不满屏红点', () => {
    const result = reconcileUnread({ counts: { room1: 12, agentA: 30 }, marks: {}, readThrough: [] });
    assert.deepEqual(result.unread, {});
    assert.deepEqual(result.marks, { room1: 12, agentA: 30 });
    assert.equal(result.changed, true, '基线要落盘');
  });

  it('私聊也算未读：条数超过已读位置的差值就是未读', () => {
    const result = reconcileUnread({
      counts: { room1: 12, agentA: 33 },
      marks: { room1: 10, agentA: 30 },
      readThrough: [],
    });
    assert.deepEqual(result.unread, { room1: 2, agentA: 3 });
    assert.equal(result.changed, false, '只是算未读，不动已读位置');
  });

  it('正在看的频道不算未读，已读位置跟到当前条数', () => {
    const result = reconcileUnread({
      counts: { agentA: 33, agentB: 5 },
      marks: { agentA: 30, agentB: 4 },
      readThrough: ['agentA'],
    });
    assert.deepEqual(result.unread, { agentB: 1 });
    assert.equal(result.marks.agentA, 33);
    assert.equal(result.changed, true);
  });

  it('上次同步后刚离开的频道：离开前来的消息算看过', () => {
    const result = reconcileUnread({
      counts: { agentA: 33, room1: 8 },
      marks: { agentA: 30, room1: 8 },
      readThrough: ['room1', 'agentA'],
    });
    assert.deepEqual(result.unread, {});
    assert.equal(result.marks.agentA, 33);
  });

  it('重启后（已读位置从存储恢复）照样算出离线期间的未读', () => {
    const saved = store();
    saveReadMarks(saved, { agentA: 30, room1: 8 });
    const result = reconcileUnread({
      counts: { agentA: 34, room1: 8 },
      marks: loadReadMarks(saved),
      readThrough: [],
    });
    assert.deepEqual(result.unread, { agentA: 4 });
  });

  it('新出现的频道当已读；条数变少（清空历史）已读位置跟着降，不出负数', () => {
    const result = reconcileUnread({
      counts: { agentA: 2, agentNew: 7 },
      marks: { agentA: 30 },
      readThrough: [],
    });
    assert.deepEqual(result.unread, {});
    assert.deepEqual(result.marks, { agentA: 2, agentNew: 7 });
  });

  it('未读封顶 99', () => {
    const result = reconcileUnread({ counts: { room1: 500 }, marks: { room1: 0 }, readThrough: [] });
    assert.equal(result.unread.room1, UNREAD_CAP);
    assert.equal(UNREAD_CAP, 99);
  });

  it('全量同步时清掉已删除频道的记录；非全量时不清', () => {
    const partial = reconcileUnread({
      counts: { agentA: 3 },
      marks: { agentA: 3, gone: 5 },
      readThrough: [],
    });
    assert.equal(partial.marks.gone, 5, '一边拉取失败时不能误删');
    const full = reconcileUnread({
      counts: { agentA: 3 },
      marks: { agentA: 3, gone: 5 },
      readThrough: [],
      complete: true,
    });
    assert.deepEqual(full.marks, { agentA: 3 });
    assert.equal(full.changed, true);
  });

  it('不改传入的 marks 对象', () => {
    const marks = { agentA: 1 };
    reconcileUnread({ counts: { agentA: 5 }, marks, readThrough: ['agentA'] });
    assert.deepEqual(marks, { agentA: 1 });
  });
});

describe('loadReadMarks / saveReadMarks：已读位置落 localStorage', () => {
  it('没存过读到空记录', () => {
    assert.deepEqual(loadReadMarks(store()), {});
  });

  it('存了再读回来一致', () => {
    const saved = store();
    saveReadMarks(saved, { room1: 3, agentA: 0 });
    assert.equal(saved.written[READ_MARKS_KEY], JSON.stringify({ room1: 3, agentA: 0 }));
    assert.deepEqual(loadReadMarks(saved), { room1: 3, agentA: 0 });
  });

  it('损坏 / 非对象 / 非法条目都不抛，非法条目丢掉', () => {
    assert.deepEqual(loadReadMarks(store({ [READ_MARKS_KEY]: '{坏了' })), {});
    assert.deepEqual(loadReadMarks(store({ [READ_MARKS_KEY]: '[1,2]' })), {});
    assert.deepEqual(
      loadReadMarks(store({ [READ_MARKS_KEY]: JSON.stringify({ ok: 2, neg: -1, str: '3', nan: null }) })),
      { ok: 2 },
    );
  });

  it('存储不可用（读写都抛）时静默，不打断界面', () => {
    const broken: ReadMarksStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    assert.deepEqual(loadReadMarks(broken), {});
    assert.doesNotThrow(() => saveReadMarks(broken, { a: 1 }));
  });
});

describe('sameUnread：未读表没变就不触发重渲染', () => {
  it('键值都相同才算一样', () => {
    assert.equal(sameUnread({ a: 1 }, { a: 1 }), true);
    assert.equal(sameUnread({}, {}), true);
    assert.equal(sameUnread({ a: 1 }, { a: 2 }), false);
    assert.equal(sameUnread({ a: 1 }, { a: 1, b: 1 }), false);
  });
});
