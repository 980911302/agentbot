import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlocks } from '../web/src/markdown.tsx';

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
