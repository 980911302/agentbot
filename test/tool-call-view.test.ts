import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatToolDuration } from '../web/src/features/chat/tool-call-view.js';

describe('formatToolDuration：工具耗时', () => {
  it('不到 1 秒写毫秒', () => {
    assert.equal(formatToolDuration(0), '0 毫秒');
    assert.equal(formatToolDuration(320), '320 毫秒');
  });

  it('1 分钟内写秒，保留 1 位小数，整秒不带 .0', () => {
    assert.equal(formatToolDuration(1234), '1.2 秒');
    assert.equal(formatToolDuration(2000), '2 秒');
    assert.equal(formatToolDuration(12873), '12.9 秒');
  });

  it('四舍五入到 60 秒时进位成分钟', () => {
    assert.equal(formatToolDuration(59_960), '1 分');
  });

  it('更长的写「N 分 M 秒」', () => {
    assert.equal(formatToolDuration(125_000), '2 分 5 秒');
    assert.equal(formatToolDuration(180_000), '3 分');
  });

  it('缺省、负数、非有限值不显示', () => {
    assert.equal(formatToolDuration(undefined), '');
    assert.equal(formatToolDuration(-1), '');
    assert.equal(formatToolDuration(Number.NaN), '');
  });
});
