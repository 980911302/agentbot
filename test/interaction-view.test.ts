import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { answeredLabel, formatCountdown } from '../web/src/features/chat/interaction-view.ts';

describe('formatCountdown：交互卡倒计时', () => {
  it('分:秒，秒补两位', () => {
    assert.equal(formatCountdown(587), '9:47');
    assert.equal(formatCountdown(59), '0:59');
    assert.equal(formatCountdown(60), '1:00');
  });

  it('超过 1 小时带小时', () => {
    assert.equal(formatCountdown(3723), '1:02:03');
  });

  it('负数与非有限值按 0', () => {
    assert.equal(formatCountdown(-5), '0:00');
    assert.equal(formatCountdown(Number.NaN), '0:00');
  });
});

describe('answeredLabel：提交后回显', () => {
  const options = [
    { id: 'a', label: '继续' },
    { id: 'b', label: '先停下' },
  ];

  it('选项显示标签', () => {
    assert.equal(answeredLabel({ value: 'b' }, options), '已选：先停下');
  });

  it('自填显示原文，不带「自定义：」前缀', () => {
    assert.equal(answeredLabel({ value: '自定义：明天再说' }, options), '已选：明天再说');
  });

  it('密钥不回显值，跳过说已跳过', () => {
    assert.equal(answeredLabel({ secret: 'sk-xxx' }), '已提交密钥');
    assert.equal(answeredLabel({ cancelled: true }, options), '已跳过');
  });
});
