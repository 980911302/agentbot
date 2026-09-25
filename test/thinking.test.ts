import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { stripThinkingBlocks } from '../web/src/features/chat/thinking.js';

describe('stripThinkingBlocks：复制与导出共用的思考块剥离', () => {
  it('去掉闭合的 <think>…</think>，只留正文', () => {
    assert.equal(
      stripThinkingBlocks('<think>先想想要不要重放</think>\n结论：不自动重放。'),
      '结论：不自动重放。',
    );
  });

  it('思考块跨多行也能去掉', () => {
    const text = [
      '<think>',
      '第一步：对比三种语义',
      '第二步：选领取-确认',
      '</think>',
      '',
      '用领取-确认。',
    ].join('\n');
    assert.equal(stripThinkingBlocks(text), '用领取-确认。');
  });

  it('多个思考块都去掉，中间的正文保留', () => {
    assert.equal(stripThinkingBlocks('<think>a</think>第一段\n<think>b</think>第二段'), '第一段\n第二段');
  });

  it('未闭合的思考块吃到末尾（与渲染侧 parseBlocks 一致）', () => {
    assert.equal(stripThinkingBlocks('正文在前\n<think>还没想完'), '正文在前');
  });

  it('没有思考块时原样返回（只去首尾空白）', () => {
    assert.equal(
      stripThinkingBlocks('  普通回复，包含 </think> 字样也不动  '),
      '普通回复，包含 </think> 字样也不动',
    );
  });
});
