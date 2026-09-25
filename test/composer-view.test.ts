import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MAX_ROWS,
  COMPOSER_MIN_HEIGHT,
  composerAreaSize,
  composerPlaceholder,
  createComposerDrafts,
  insertMentionText,
  nextMenuIndex,
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
      '它正在工作，发送会插话；打「停」可中止',
    );
    assert.equal(
      composerPlaceholder({ busy: true, isGroup: true, botName: '小白' }),
      '它正在工作，发送会插话；打「停」可中止',
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

describe('createComposerDrafts：草稿按频道分开', () => {
  it('每个频道各存各的，切回来还在', () => {
    const drafts = createComposerDrafts();
    drafts.save('agent-a', '给 A 的半句话');
    drafts.save('room-1', '@白泽 帮我看下');
    assert.equal(drafts.read('agent-a'), '给 A 的半句话');
    assert.equal(drafts.read('room-1'), '@白泽 帮我看下');
  });

  it('没存过的频道读到空串，不串用别的频道', () => {
    const drafts = createComposerDrafts();
    drafts.save('agent-a', '只属于 A');
    assert.equal(drafts.read('agent-b'), '');
  });

  it('发送后清空（存空串或纯空白）就删掉这一格', () => {
    const drafts = createComposerDrafts();
    drafts.save('agent-a', '草稿');
    drafts.save('agent-a', '');
    assert.equal(drafts.read('agent-a'), '');
    drafts.save('agent-a', '   ');
    assert.equal(drafts.read('agent-a'), '');
  });

  it('草稿原样保留（含换行与首尾空白），不做 trim', () => {
    const drafts = createComposerDrafts();
    drafts.save('agent-a', '第一行\n第二行 ');
    assert.equal(drafts.read('agent-a'), '第一行\n第二行 ');
  });
});

describe('insertMentionText：点名字插入 @', () => {
  it('空输入框直接插入并把光标放在空格后', () => {
    assert.deepEqual(insertMentionText('', 0, 0, '小白'), { text: '@小白 ', cursor: 4 });
  });

  it('紧挨着文字时先补一个空格', () => {
    assert.deepEqual(insertMentionText('你好', 2, 2, '小白'), { text: '你好 @小白 ', cursor: 7 });
  });

  it('已有空格不重复补，插在光标处不动后文', () => {
    assert.deepEqual(insertMentionText('嗨 看这里', 2, 2, '阿黄'), { text: '嗨 @阿黄 看这里', cursor: 6 });
  });

  it('有选区时替换选中的文字，越界的位置夹回文本范围', () => {
    assert.deepEqual(insertMentionText('abc', 1, 2, 'x'), { text: 'a @x c', cursor: 5 });
    assert.deepEqual(insertMentionText('ab', 9, 9, 'x'), { text: 'ab @x ', cursor: 6 });
  });
});

describe('nextMenuIndex：下拉菜单方向键', () => {
  it('上下循环', () => {
    assert.equal(nextMenuIndex(0, 3, 'ArrowDown'), 1);
    assert.equal(nextMenuIndex(2, 3, 'ArrowDown'), 0);
    assert.equal(nextMenuIndex(0, 3, 'ArrowUp'), 2);
  });

  it('没有焦点项时从两端进入，Home/End 跳到两端', () => {
    assert.equal(nextMenuIndex(-1, 3, 'ArrowDown'), 0);
    assert.equal(nextMenuIndex(-1, 3, 'ArrowUp'), 2);
    assert.equal(nextMenuIndex(1, 3, 'Home'), 0);
    assert.equal(nextMenuIndex(1, 3, 'End'), 2);
  });

  it('空菜单返回 -1，其他键不动', () => {
    assert.equal(nextMenuIndex(0, 0, 'ArrowDown'), -1);
    assert.equal(nextMenuIndex(1, 3, 'a'), 1);
  });
});
