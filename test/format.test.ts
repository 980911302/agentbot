import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatRelativeTime } from '../web/src/format.ts';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('formatRelativeTime：侧栏相对时间', () => {
  const now = at(2026, 9, 25, 15, 30);

  it('一分钟内是「刚刚」，时钟漂到未来也算刚刚', () => {
    assert.equal(formatRelativeTime(now - 20_000, now), '刚刚');
    assert.equal(formatRelativeTime(now + 5_000, now), '刚刚');
  });

  it('一小时内按分钟', () => {
    assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 分钟前');
    assert.equal(formatRelativeTime(now - 59 * 60_000, now), '59 分钟前');
  });

  it('今天更早的按小时', () => {
    assert.equal(formatRelativeTime(at(2026, 9, 25, 9, 0), now), '6 小时前');
    assert.equal(formatRelativeTime(at(2026, 9, 25, 0, 5), now), '15 小时前');
  });

  it('昨天、今年更早、跨年', () => {
    assert.equal(formatRelativeTime(at(2026, 9, 24, 23, 59), now), '昨天');
    assert.equal(formatRelativeTime(at(2026, 9, 23, 12, 0), now), '9/23');
    assert.equal(formatRelativeTime(at(2025, 12, 31, 12, 0), now), '2025/12/31');
  });

  it('缺时间按「刚刚」（与 formatClock 一致）', () => {
    assert.equal(formatRelativeTime(Number.NaN, now), '刚刚');
    assert.equal(formatRelativeTime(0, now), '刚刚');
  });
});
