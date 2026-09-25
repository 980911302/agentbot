import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_KEY,
  loadSidebarWidth,
  saveSidebarWidth,
  type SidebarWidthStore,
} from '../web/src/features/workspace/sidebar-width.js';

function store(
  initial: Record<string, string> = {},
): SidebarWidthStore & { written: Record<string, string> } {
  const written: Record<string, string> = { ...initial };
  return {
    written,
    getItem: (key) => written[key] ?? null,
    setItem: (key, value) => {
      written[key] = value;
    },
  };
}

describe('loadSidebarWidth：读本地宽度', () => {
  it('没存过就用默认宽度', () => {
    assert.equal(loadSidebarWidth(store()), SIDEBAR_DEFAULT_WIDTH);
    assert.equal(loadSidebarWidth(store()), 260);
  });

  it('存过且在 64–500 之间就照用（含端点）', () => {
    assert.equal(loadSidebarWidth(store({ [SIDEBAR_WIDTH_KEY]: '300' })), 300);
    assert.equal(loadSidebarWidth(store({ [SIDEBAR_WIDTH_KEY]: '64' })), 64);
    assert.equal(loadSidebarWidth(store({ [SIDEBAR_WIDTH_KEY]: '500' })), 500);
  });

  it('越界 / 损坏 / 空串都回默认值，不抛', () => {
    assert.equal(loadSidebarWidth(store({ [SIDEBAR_WIDTH_KEY]: '63' })), SIDEBAR_DEFAULT_WIDTH);
    assert.equal(loadSidebarWidth(store({ [SIDEBAR_WIDTH_KEY]: '501' })), SIDEBAR_DEFAULT_WIDTH);
    assert.equal(loadSidebarWidth(store({ [SIDEBAR_WIDTH_KEY]: '宽一点' })), SIDEBAR_DEFAULT_WIDTH);
    assert.equal(loadSidebarWidth(store({ [SIDEBAR_WIDTH_KEY]: '' })), SIDEBAR_DEFAULT_WIDTH);
  });

  it('存储读不了（隐私模式）也回默认值', () => {
    const broken: SidebarWidthStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    assert.equal(loadSidebarWidth(broken), SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('saveSidebarWidth：写本地宽度', () => {
  it('按用户拖出来的值原样存（宽度由档位决定时调用方不会写）', () => {
    const target = store();
    saveSidebarWidth(target, 321.5);
    assert.equal(target.written[SIDEBAR_WIDTH_KEY], '321.5');
  });

  it('存储写不了时静默失败，不打断用户', () => {
    const broken: SidebarWidthStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    assert.doesNotThrow(() => saveSidebarWidth(broken, 300));
  });
});
