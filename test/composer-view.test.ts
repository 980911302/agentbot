import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MAX_ROWS,
  COMPOSER_MIN_HEIGHT,
  composerAreaSize,
  composerPlaceholder,
} from '../web/src/features/chat/composer-view.js';

describe('composerAreaSize：输入框 1~8 行自适应（UI-07）', () => {
  it('一行内容就是一行高', () => {
    assert.deepEqual(composerAreaSize(COMPOSER_LINE_HEIGHT + 8), { height: 32, scrolls: false });
  });

  it('三行内容长到三行', () => {
    assert.deepEqual(composerAreaSize(3 * COMPOSER_LINE_HEIGHT + 8), { height: 80, scrolls: false });
  });

  it('正好八行不滚动', () => {
    const exactlyEight = COMPOSER_MAX_ROWS * COMPOSER_LINE_HEIGHT + 8;
    assert.equal(exactlyEight, COMPOSER_MAX_HEIGHT);
    assert.deepEqual(composerAreaSize(exactlyEight), { height: COMPOSER_MAX_HEIGHT, scrolls: false });
  });

  it('连续输入 10 行停在 8 行高并转内部滚动', () => {
    const tenLines = 10 * COMPOSER_LINE_HEIGHT + 8;
    const size = composerAreaSize(tenLines);
    assert.equal(size.height, COMPOSER_MAX_HEIGHT);
    // 高度减去内边距正好是 8 行
    assert.equal((size.height - 8) / COMPOSER_LINE_HEIGHT, COMPOSER_MAX_ROWS);
    assert.equal(size.scrolls, true);
  });

  it('再长也还是封在 8 行', () => {
    assert.deepEqual(composerAreaSize(100 * COMPOSER_LINE_HEIGHT + 8), {
      height: COMPOSER_MAX_HEIGHT,
      scrolls: true,
    });
  });

  it('空内容与非法值回落到最小高度', () => {
    assert.deepEqual(composerAreaSize(0), { height: COMPOSER_MIN_HEIGHT, scrolls: false });
    assert.deepEqual(composerAreaSize(Number.NaN), { height: COMPOSER_MIN_HEIGHT, scrolls: false });
    assert.deepEqual(composerAreaSize(Number.POSITIVE_INFINITY), {
      height: COMPOSER_MIN_HEIGHT,
      scrolls: false,
    });
  });

  it('小于一行的内容也撑到一行', () => {
    assert.deepEqual(composerAreaSize(10), { height: COMPOSER_MIN_HEIGHT, scrolls: false });
  });
});

describe('composerPlaceholder：占位文案', () => {
  it('忙碌时说明发送会插话（优先于群聊提示）', () => {
    assert.equal(
      composerPlaceholder({ busy: true, isGroup: false, botName: '小白' }),
      '它正在工作，发送会插话',
    );
    assert.equal(
      composerPlaceholder({ busy: true, isGroup: true, botName: '小白' }),
      '它正在工作，发送会插话',
    );
  });

  it('群里提示 @ 唤醒成员', () => {
    assert.equal(
      composerPlaceholder({ busy: false, isGroup: true, botName: '' }),
      '在群聊中发消息，输入 @ 唤醒指定成员…',
    );
  });

  it('私聊用同事名字，没有名字时回落到 Bot', () => {
    assert.equal(composerPlaceholder({ busy: false, isGroup: false, botName: '小白' }), '给 小白 发消息');
    assert.equal(composerPlaceholder({ busy: false, isGroup: false, botName: '' }), '给 Bot 发消息');
  });
});
