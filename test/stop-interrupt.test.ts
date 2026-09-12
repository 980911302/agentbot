import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_STOP_WORDS, isStopSentence } from '../src/config.js';
import { sortInboxForDrain, type InboxItem } from '../src/agent/inbox.js';

/** 《停止与插话.md》4.1：认停止词由运行时做，整句匹配 */
describe('停止词识别', () => {
  it('整句命中默认表', () => {
    for (const word of ['停', '停止', '取消', 'stop', 'cancel']) {
      assert.ok(isStopSentence(word, DEFAULT_STOP_WORDS), word);
    }
  });

  it('容忍尾部标点与空白，拉丁不区分大小写', () => {
    assert.ok(isStopSentence('停止。', DEFAULT_STOP_WORDS));
    assert.ok(isStopSentence('  Stop!! ', DEFAULT_STOP_WORDS));
    assert.ok(isStopSentence('先别做了——', DEFAULT_STOP_WORDS));
  });

  it('普通句子不算停止', () => {
    assert.equal(isStopSentence('停一下，然后帮我查个东西', DEFAULT_STOP_WORDS), false);
    assert.equal(isStopSentence('不要停下来', DEFAULT_STOP_WORDS), false);
    assert.equal(isStopSentence('停下来歇会吧', DEFAULT_STOP_WORDS), false);
  });

  it('词表可追加', () => {
    assert.ok(isStopSentence('收工', [...DEFAULT_STOP_WORDS, '收工']));
    assert.equal(isStopSentence('收工', DEFAULT_STOP_WORDS), false);
  });
});

function item(partial: Partial<InboxItem>): InboxItem {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    toAgentId: 'a',
    fromAgentId: 'b',
    fromName: 'b',
    text: 'x',
    priority: false,
    depth: 0,
    createdAt: 0,
    ...partial,
  };
}

describe('收件箱 drain 排序', () => {
  it('停止令排最前，其余保持到达顺序', () => {
    const ordered = sortInboxForDrain([
      item({ id: 'm1', text: '普通1' }),
      item({ id: 'm2', text: '普通2', priority: true }),
      item({ id: 's1', kind: 'stop', text: '停' }),
      item({ id: 'm3', text: '普通3' }),
    ]);
    assert.deepEqual(
      ordered.map((entry) => entry.id),
      ['s1', 'm1', 'm2', 'm3'],
    );
  });
});
