import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlocks, stripThinkingBlocks } from '../web/src/markdown.tsx';
import { stripThinkingBlocks as sharedStrip } from '../web/src/features/chat/thinking.ts';

test('markdown parser consumes hash-prefixed lines that are not supported headings', () => {
  assert.deepEqual(parseBlocks('#'), [{ type: 'paragraph', content: '#' }]);
  assert.deepEqual(parseBlocks('#no-space'), [{ type: 'paragraph', content: '#no-space' }]);
  assert.deepEqual(parseBlocks('##### level five'), [
    { type: 'paragraph', content: '##### level five' },
  ]);
});

test('markdown parser continues after an unsupported hash-prefixed line', () => {
  assert.deepEqual(parseBlocks('before\n#\nafter'), [
    { type: 'paragraph', content: 'before\n#\nafter' },
  ]);
});

test('markdown parser always advances on empty markdown markers', () => {
  for (const marker of ['# ', '##   ', '- ', '*\t', '+  ', '1. ', '99.   ']) {
    assert.deepEqual(parseBlocks(marker), [
      { type: 'paragraph', content: marker },
    ]);
  }
});

test('复制按钮用的 stripThinkingBlocks 与导出共用同一个函数，并真能去掉思考块', () => {
  assert.equal(stripThinkingBlocks, sharedStrip);
  assert.equal(stripThinkingBlocks('<think>先想想</think>\n可见正文'), '可见正文');
});
