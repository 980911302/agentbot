import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  clampPanelWidth,
  loadPanelWidth,
  panelLayoutKind,
  savePanelWidth,
  type PanelWidthStore,
} from '../web/src/features/chat/panel-view.js';

describe('clampPanelWidth：抽屉宽度限制', () => {
  it('320–480 之间原样保留', () => {
    assert.equal(clampPanelWidth(400), 400);
  });

  it('低于 320 收到下限', () => {
    assert.equal(clampPanelWidth(120), 320);
    assert.equal(clampPanelWidth(-5), 320);
  });

  it('高于 480 收到上限', () => {
    assert.equal(clampPanelWidth(900), 480);
  });
});

describe('loadPanelWidth：本地宽度读取', () => {
  const store = (raw: string | null): PanelWidthStore => ({
    getItem: (key: string) => (key === 'agentbot.panelWidth' ? raw : null),
    setItem: () => {},
  });

  it('没有存过时用默认 340', () => {
    assert.equal(loadPanelWidth(store(null)), 340);
  });

  it('存过的合法值读出来并夹紧', () => {
    assert.equal(loadPanelWidth(store('420')), 420);
    assert.equal(loadPanelWidth(store('50')), 320);
    assert.equal(loadPanelWidth(store('9999')), 480);
  });

  it('内容损坏（非数字/空串）时回默认，不抛', () => {
    assert.equal(loadPanelWidth(store('abc')), 340);
    assert.equal(loadPanelWidth(store('')), 340);
  });

  it('存储不可用时也不抛', () => {
    assert.equal(loadPanelWidth({ getItem: () => { throw new Error('blocked'); }, setItem: () => {} }), 340);
  });
});

describe('savePanelWidth：宽度持久化', () => {
  it('写入前先夹紧，存进去的永远是合法值', () => {
    let written: string | null = null;
    const store: PanelWidthStore = {
      getItem: () => null,
      setItem: (_key, value) => { written = value; },
    };
    savePanelWidth(store, 120);
    assert.equal(written, '320');
    savePanelWidth(store, 9999);
    assert.equal(written, '480');
  });

  it('存储不可用时静默失败，不影响拖拽', () => {
    assert.doesNotThrow(() => {
      savePanelWidth({ getItem: () => null, setItem: () => { throw new Error('full'); } }, 400);
    });
  });
});

describe('panelLayoutKind：面板何时变覆盖层', () => {
  it('≥1280 是常驻三栏', () => {
    assert.equal(panelLayoutKind(1440), 'dock');
    assert.equal(panelLayoutKind(1280), 'dock');
  });

  it('1024–1279 也是常驻，但该档两侧都让位', () => {
    assert.equal(panelLayoutKind(1100), 'dock');
  });

  it('<1280 且有右侧面板时按规范应为覆盖层', () => {
    assert.equal(panelLayoutKind(1100, true), 'overlay');
    assert.equal(panelLayoutKind(900, true), 'overlay');
  });
});
