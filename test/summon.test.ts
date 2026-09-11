import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SummonQueue } from '../src/room/summon.js';

const MEMBERS = ['a', 'b', 'c'];
const MAX_RUNS = 2;

/**
 * 覆盖《调整建议》1.1：成员发言里 @ 同事，也要能把人叫起来。
 */
describe('召唤队列', () => {
  it('用户点名 → 只把被点的放进第一波', () => {
    const queue = new SummonQueue(MEMBERS, { ids: ['a'], everyone: false }, MAX_RUNS);
    assert.deepEqual(queue.initiallySummoned(), ['a']);
    assert.equal(queue.isSummoned('a'), true);
    assert.equal(queue.isSummoned('b'), false);
    assert.deepEqual(queue.bystanders(), ['b', 'c']);
  });

  it('@everyone → 全员进第一波且都必须开口', () => {
    const queue = new SummonQueue(MEMBERS, { ids: [], everyone: true }, MAX_RUNS);
    assert.deepEqual(queue.initiallySummoned(), ['a', 'b', 'c']);
    for (const id of MEMBERS) assert.equal(queue.isSummoned(id), true);
    assert.deepEqual(queue.bystanders(), []);
  });

  it('成员发言 @ 同事 → 把人排进后续波次', () => {
    const queue = new SummonQueue(MEMBERS, { ids: [], everyone: false }, MAX_RUNS);
    // 假设 a 已经跑过一轮，它在发言里点了 b
    queue.reserve('a');
    const queued = queue.summonFrom({ ids: ['b'], everyone: false }, 'a');

    assert.deepEqual(queued, ['b']);
    assert.equal(queue.hasWaiting, true);
    assert.equal(queue.next(), 'b');
    // b 被叫到时必须开口
    assert.equal(queue.isSummoned('b'), true);
  });

  it('成员发言 @everyone → 其余人全部入队', () => {
    const queue = new SummonQueue(MEMBERS, { ids: [], everyone: false }, MAX_RUNS);
    queue.reserve('a');
    const queued = queue.summonFrom({ ids: [], everyone: true }, 'a');
    assert.deepEqual(queued.sort(), ['b', 'c']);
  });

  it('防环：同一人一轮内最多跑 MAX_RUNS 次', () => {
    const queue = new SummonQueue(MEMBERS, { ids: ['a'], everyone: false }, MAX_RUNS);

    assert.equal(queue.reserve('a'), 1);
    assert.equal(queue.canRun('a'), true);

    // a 已经跑过一次，被 b 再次点名
    assert.deepEqual(queue.summonFrom({ ids: ['a'], everyone: false }), ['a']);
    assert.equal(queue.next(), 'a');
    assert.equal(queue.reserve('a'), 2);
    assert.equal(queue.canRun('a'), false, '达到上限后不能再跑');

    // 第三次点名应被忽略
    assert.deepEqual(queue.summonFrom({ ids: ['a'], everyone: false }), []);
  });

  it('已经在队列里等待的人不重复入队', () => {
    const queue = new SummonQueue(MEMBERS, { ids: [], everyone: false }, MAX_RUNS);
    queue.reserve('a');
    assert.deepEqual(queue.summonFrom({ ids: ['b'], everyone: false }, 'a'), ['b']);
    assert.deepEqual(queue.summonFrom({ ids: ['b'], everyone: false }, 'a'), [], '第二次不该重复入队');
  });

  it('并行派发：同波次的人互相 @ 也能各自二次叫醒', () => {
    const queue = new SummonQueue(MEMBERS, { ids: [], everyone: false }, MAX_RUNS);

    // 模拟并行波次：派发前同步占名额
    queue.reserve('a');
    queue.reserve('b');

    // a 的发言点了 b，b 的发言点了 a
    assert.deepEqual(queue.summonFrom({ ids: ['b'], everyone: false }, 'a'), ['b']);
    assert.deepEqual(queue.summonFrom({ ids: ['a'], everyone: false }, 'b'), ['a']);

    assert.equal(queue.hasWaiting, true);
    const order = [queue.next(), queue.next()].sort();
    assert.deepEqual(order, ['a', 'b']);
  });

  it('召唤信号取并集：多次被点仍然必须开口', () => {
    const queue = new SummonQueue(MEMBERS, { ids: [], everyone: false }, MAX_RUNS);
    queue.summonFrom({ ids: ['c'], everyone: false });
    queue.summonFrom({ ids: ['c'], everyone: true });

    const mentions = queue.mentionsFor('c');
    assert.equal(mentions.everyone, true, '一旦出现全员信号就应保持');
  });

  it('不存在的成员不会被召唤', () => {
    const queue = new SummonQueue(MEMBERS, { ids: [], everyone: false }, MAX_RUNS);
    assert.deepEqual(queue.summonFrom({ ids: ['zzz'], everyone: false }), []);
  });
});
