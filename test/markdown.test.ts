import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inlineImageSrc,
  parseBlocks,
  safeHref,
  splitTableRow,
  stripThinkingBlocks,
  tokenizeInline,
} from '../web/src/markdown.tsx';
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

test('GFM 表格：表头、对齐与数据行，列数不齐按表头补齐', () => {
  const blocks = parseBlocks('前言\n| 名字 | 数量 | 备注 |\n| :--- | ---: | :-: |\n| 苹果 | 3 | 红 |\n| 梨 | 5 |\n\n后记');
  assert.deepEqual(blocks, [
    { type: 'paragraph', content: '前言' },
    {
      type: 'table',
      header: ['名字', '数量', '备注'],
      align: ['left', 'right', 'center'],
      rows: [
        ['苹果', '3', '红'],
        ['梨', '5', ''],
      ],
    },
    { type: 'paragraph', content: '后记' },
  ]);
});

test('没有分隔行、或列数对不上的竖线文字仍是普通段落', () => {
  assert.deepEqual(parseBlocks('a | b\nc | d'), [{ type: 'paragraph', content: 'a | b\nc | d' }]);
  assert.equal(parseBlocks('a | b\n---')[0]?.type, 'paragraph');
});

test('splitTableRow 去掉首尾竖线并支持 \\| 转义', () => {
  assert.deepEqual(splitTableRow('| a | b\\|c |'), ['a', 'b|c']);
  assert.deepEqual(splitTableRow('x|y'), ['x', 'y']);
});

test('裸网址自动识别，末尾中英文标点不算进网址', () => {
  assert.deepEqual(tokenizeInline('看 https://example.com/a?b=1。然后'), [
    { kind: 'text', text: '看 ' },
    { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
    { kind: 'text', text: '。然后' },
  ]);
});

test('Markdown 链接只放行 http/https/mailto，javascript: 只留文字', () => {
  assert.deepEqual(tokenizeInline('[文档](https://a.dev)'), [{ kind: 'link', text: '文档', href: 'https://a.dev' }]);
  // 不安全的链接只留下文字，不生成 <a>
  assert.deepEqual(tokenizeInline('[点我](javascript:void0)'), [{ kind: 'text', text: '点我' }]);
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeHref('file:///etc/passwd'), null);
});

test('图片：只有 data:image 与同源路径直接显示，外链图片退化成链接', () => {
  assert.deepEqual(tokenizeInline('![图](/files/a.png)'), [{ kind: 'image', alt: '图', src: '/files/a.png' }]);
  assert.equal(inlineImageSrc('/files/a.png'), '/files/a.png');
  assert.equal(inlineImageSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(inlineImageSrc('https://cdn.example.com/a.png'), null);
  assert.equal(inlineImageSrc('//cdn.example.com/a.png'), null);
});

test('行内代码里的网址不被当成链接', () => {
  assert.deepEqual(tokenizeInline('`https://x.y`'), [{ kind: 'code', text: 'https://x.y' }]);
});
